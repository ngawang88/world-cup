import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// ----- The 48-team field for the 2026 World Cup (hosts + likely qualifiers) -----
// `rank` is an approximate strength ranking (1 = most likely to win). It's used
// to balance the draw into pots so nobody gets all the favourites or all the
// underdogs. Tweak these numbers to match your own opinion of the teams.
const COUNTRIES = [
  { name: 'Argentina', flag: '🇦🇷', rank: 1 },   { name: 'France', flag: '🇫🇷', rank: 2 },
  { name: 'Spain', flag: '🇪🇸', rank: 3 },       { name: 'England', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', rank: 4 },
  { name: 'Brazil', flag: '🇧🇷', rank: 5 },      { name: 'Portugal', flag: '🇵🇹', rank: 6 },
  { name: 'Netherlands', flag: '🇳🇱', rank: 7 }, { name: 'Belgium', flag: '🇧🇪', rank: 8 },
  { name: 'Italy', flag: '🇮🇹', rank: 9 },       { name: 'Germany', flag: '🇩🇪', rank: 10 },
  { name: 'Croatia', flag: '🇭🇷', rank: 11 },    { name: 'Morocco', flag: '🇲🇦', rank: 12 },
  { name: 'Uruguay', flag: '🇺🇾', rank: 13 },    { name: 'Colombia', flag: '🇨🇴', rank: 14 },
  { name: 'Switzerland', flag: '🇨🇭', rank: 15 },{ name: 'USA', flag: '🇺🇸', rank: 16 },
  { name: 'Mexico', flag: '🇲🇽', rank: 17 },     { name: 'Japan', flag: '🇯🇵', rank: 18 },
  { name: 'Senegal', flag: '🇸🇳', rank: 19 },    { name: 'Denmark', flag: '🇩🇰', rank: 20 },
  { name: 'South Korea', flag: '🇰🇷', rank: 21 },{ name: 'Iran', flag: '🇮🇷', rank: 22 },
  { name: 'Australia', flag: '🇦🇺', rank: 23 },  { name: 'Ecuador', flag: '🇪🇨', rank: 24 },
  { name: 'Austria', flag: '🇦🇹', rank: 25 },    { name: 'Ukraine', flag: '🇺🇦', rank: 26 },
  { name: 'Sweden', flag: '🇸🇪', rank: 27 },     { name: 'Serbia', flag: '🇷🇸', rank: 28 },
  { name: 'Poland', flag: '🇵🇱', rank: 29 },     { name: 'Egypt', flag: '🇪🇬', rank: 30 },
  { name: 'Nigeria', flag: '🇳🇬', rank: 31 },    { name: 'Ivory Coast', flag: '🇨🇮', rank: 32 },
  { name: 'Norway', flag: '🇳🇴', rank: 33 },     { name: 'Canada', flag: '🇨🇦', rank: 34 },
  { name: 'Peru', flag: '🇵🇪', rank: 35 },       { name: 'Chile', flag: '🇨🇱', rank: 36 },
  { name: 'Tunisia', flag: '🇹🇳', rank: 37 },    { name: 'Cameroon', flag: '🇨🇲', rank: 38 },
  { name: 'Algeria', flag: '🇩🇿', rank: 39 },    { name: 'Paraguay', flag: '🇵🇾', rank: 40 },
  { name: 'Turkey', flag: '🇹🇷', rank: 41 },     { name: 'Costa Rica', flag: '🇨🇷', rank: 42 },
  { name: 'Ghana', flag: '🇬🇭', rank: 43 },      { name: 'Qatar', flag: '🇶🇦', rank: 44 },
  { name: 'Saudi Arabia', flag: '🇸🇦', rank: 45 },{ name: 'Panama', flag: '🇵🇦', rank: 46 },
  { name: 'Jamaica', flag: '🇯🇲', rank: 47 },    { name: 'New Zealand', flag: '🇳🇿', rank: 48 },
];

// Ranked strongest -> weakest, used to build balanced pots.
const RANKED = [...COUNTRIES].sort((a, b) => a.rank - b.rank);
const RANK_BY_NAME = new Map(COUNTRIES.map((c) => [c.name, c.rank]));

const SPONSOR_MESSAGE =
  '💰 The prize is COLD HARD 500 DOLLAR CASH — generously sponsored by our CEO Jai and our Co-Founder G! and MJ 💰';

// ----- Database -----
const db = new DatabaseSync(join(__dirname, 'world_cup.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS participants (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );
  CREATE TABLE IF NOT EXISTS assignments (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    participant_id INTEGER NOT NULL,
    country        TEXT NOT NULL UNIQUE,
    flag           TEXT NOT NULL,
    assigned_at    TEXT NOT NULL,
    FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE
  );
`);
db.exec('PRAGMA foreign_keys = ON;');

// If the database is empty and a seed.json exists, load the saved draw. This
// keeps a deployed instance (whose disk may reset) populated with the real draw,
// and never overwrites a database that already has people in it.
function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM participants').get().c;
  if (count > 0) return;
  const seedPath = join(__dirname, 'seed.json');
  if (!existsSync(seedPath)) return;
  let seed;
  try {
    seed = JSON.parse(readFileSync(seedPath, 'utf8'));
  } catch {
    console.error('seed.json is not valid JSON — skipping seed.');
    return;
  }
  const insP = db.prepare('INSERT INTO participants (name) VALUES (?)');
  const insA = db.prepare(
    'INSERT OR IGNORE INTO assignments (participant_id, country, flag, assigned_at) VALUES (?, ?, ?, ?)'
  );
  const stamp = new Date().toISOString();
  let people = 0;
  let teams = 0;
  for (const p of seed.participants || []) {
    if (!p.name) continue;
    const info = insP.run(p.name);
    const pid = info.lastInsertRowid;
    people++;
    for (const countryName of p.countries || []) {
      const c = COUNTRIES.find((x) => x.name === countryName);
      if (!c) continue;
      const r = insA.run(pid, c.name, c.flag, stamp);
      if (r.changes) teams++;
    }
  }
  console.log(`  🌱 Seeded draw from seed.json: ${people} participants, ${teams} teams.`);
}
seedIfEmpty();

// ----- Data helpers -----
// All 48 countries are split as evenly as possible across the participants.
// e.g. 2 people -> 24 each; 5 people -> 10,10,10,9,9 (extras go to the
// earliest-added participants). Quota is computed live from the current roster.
function quotaFor(orderedParticipants) {
  const map = new Map();
  const n = orderedParticipants.length;
  if (n === 0) return map;
  const base = Math.floor(COUNTRIES.length / n);
  let remainder = COUNTRIES.length % n;
  for (const p of orderedParticipants) {
    map.set(p.id, base + (remainder > 0 ? 1 : 0));
    if (remainder > 0) remainder--;
  }
  return map;
}

function getAvailableCountries() {
  const taken = new Set(db.prepare('SELECT country FROM assignments').all().map((r) => r.country));
  return COUNTRIES.filter((c) => !taken.has(c.name));
}

// Split the ranked field into pots so the draw is balanced by strength.
// Pot k holds one slot for every participant whose quota reaches pick #k, so
// each participant draws exactly one team from each pot, strongest pots first.
// Returns an array of pots; each pot is { index, total, countries: [...] }.
function buildPots(orderedParticipants) {
  const quotas = quotaFor(orderedParticipants);
  const quotaList = [...quotas.values()];
  const maxQuota = quotaList.length ? Math.max(...quotaList) : 0;

  const pots = [];
  let cursor = 0;
  for (let k = 1; k <= maxQuota; k++) {
    const size = quotaList.filter((q) => q >= k).length; // participants reaching pick #k
    pots.push({ index: k, total: maxQuota, countries: RANKED.slice(cursor, cursor + size) });
    cursor += size;
  }
  return pots;
}

function potLabel(index, total) {
  if (total <= 1) return `Pot ${index}`;
  if (index === 1) return `Pot 1 · top seeds`;
  if (index === total) return `Pot ${index} · underdogs`;
  return `Pot ${index} of ${total}`;
}

function buildState() {
  const rows = db.prepare('SELECT id, name FROM participants ORDER BY id ASC').all();
  const quotas = quotaFor(rows);
  const assignments = db
    .prepare('SELECT participant_id, country, flag FROM assignments ORDER BY id ASC')
    .all();
  const byParticipant = new Map();
  for (const a of assignments) {
    if (!byParticipant.has(a.participant_id)) byParticipant.set(a.participant_id, []);
    byParticipant
      .get(a.participant_id)
      .push({ name: a.country, flag: a.flag, rank: RANK_BY_NAME.get(a.country) });
  }
  // show each person's teams strongest-first
  for (const list of byParticipant.values()) list.sort((a, b) => a.rank - b.rank);

  const participants = rows.map((p) => {
    const countries = byParticipant.get(p.id) || [];
    const quota = quotas.get(p.id) || 0;
    return {
      id: p.id,
      name: p.name,
      quota,
      countries,
      remaining: Math.max(0, quota - countries.length),
    };
  });

  return {
    participants,
    available: getAvailableCountries(),
    totalCountries: COUNTRIES.length,
    assignedCount: assignments.length,
    sponsorMessage: SPONSOR_MESSAGE,
  };
}

// Draw one country for `id` from the pot matching their next pick, so the draw
// stays balanced by strength. Returns the picked country plus the pot it came
// from (the pool the wheel should spin over), or an {error,status} to forward.
function drawOne(id) {
  const participant = db.prepare('SELECT id, name FROM participants WHERE id = ?').get(id);
  if (!participant) return { error: 'Participant not found.', status: 404 };

  const rows = db.prepare('SELECT id, name FROM participants ORDER BY id ASC').all();
  const quota = quotaFor(rows).get(id) || 0;
  const have = db.prepare('SELECT COUNT(*) AS c FROM assignments WHERE participant_id = ?').get(id).c;
  if (have >= quota)
    return { error: `${participant.name} already has their full share (${quota}).`, status: 409 };

  const taken = new Set(db.prepare('SELECT country FROM assignments').all().map((r) => r.country));
  if (taken.size >= COUNTRIES.length) return { error: 'No countries left to assign!', status: 409 };

  const pots = buildPots(rows);
  const potIndex = have; // 0-based: this person's next pick is pick #(have+1) -> pots[have]

  // Draw from the target pot; if it's empty (only possible after a mid-draw
  // roster change), fall back to the nearest pots, then anything left.
  let candidates = (pots[potIndex]?.countries || []).filter((c) => !taken.has(c.name));
  let sourcePot = pots[potIndex];
  for (let d = 1; d < pots.length && candidates.length === 0; d++) {
    for (const j of [potIndex - d, potIndex + d]) {
      if (j >= 0 && j < pots.length) {
        const c = pots[j].countries.filter((x) => !taken.has(x.name));
        if (c.length) { candidates = c; sourcePot = pots[j]; break; }
      }
    }
  }
  if (candidates.length === 0) {
    candidates = COUNTRIES.filter((c) => !taken.has(c.name));
    sourcePot = { index: potIndex + 1 };
  }

  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  db.prepare(
    'INSERT INTO assignments (participant_id, country, flag, assigned_at) VALUES (?, ?, ?, ?)'
  ).run(id, pick.name, pick.flag, new Date().toISOString());

  return {
    pick: { name: pick.name, flag: pick.flag, rank: pick.rank },
    pool: candidates,
    pot: { index: sourcePot.index, total: pots.length, label: potLabel(sourcePot.index, pots.length) },
  };
}

// ===== Live tournament tracking (football-data.org) =====
// Set FOOTBALL_DATA_TOKEN in the environment (free key from football-data.org).
// One request fetches every World Cup match; we cache it so we stay well within
// the free tier's rate limit no matter how many people open the results page.
const FD_TOKEN = process.env.FOOTBALL_DATA_TOKEN || process.env.FD_TOKEN || '';
const FD_COMPETITION = process.env.FOOTBALL_DATA_COMPETITION || 'WC';
const FD_BASE = 'https://api.football-data.org/v4';
const FD_CACHE_MS = 60 * 1000;

// Points a team accrues as it progresses; a person's score sums across their teams.
const SCORING = {
  groupWin: 3,
  groupDraw: 1,
  reachR32: 4, // i.e. advanced out of the group
  reachR16: 6,
  reachQF: 8,
  reachSF: 10,
  reachFinal: 12,
  champion: 15,
};

// football-data stage codes -> our ordered ladder.
const STAGES = [
  { key: 'GROUP_STAGE', label: 'Group stage', order: 0, bonus: 0 },
  { key: 'LAST_32', label: 'Round of 32', order: 1, bonus: SCORING.reachR32 },
  { key: 'LAST_16', label: 'Round of 16', order: 2, bonus: SCORING.reachR16 },
  { key: 'QUARTER_FINALS', label: 'Quarter-final', order: 3, bonus: SCORING.reachQF },
  { key: 'SEMI_FINALS', label: 'Semi-final', order: 4, bonus: SCORING.reachSF },
  { key: 'THIRD_PLACE', label: 'Third-place play-off', order: 5, bonus: 0 },
  { key: 'FINAL', label: 'Final', order: 6, bonus: SCORING.reachFinal },
];
const STAGE_BY_KEY = new Map(STAGES.map((s) => [s.key, s]));

// Map football-data team names to our country names (accent/wording differences).
function normalizeName(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}
const COUNTRY_BY_NORM = new Map(COUNTRIES.map((c) => [normalizeName(c.name), c]));
const NAME_ALIASES = {
  unitedstates: 'USA',
  usa: 'USA',
  korearepublic: 'South Korea',
  republicofkorea: 'South Korea',
  iriran: 'Iran',
  cotedivoire: 'Ivory Coast',
  turkiye: 'Turkey',
  czechia: 'Czechia',
};
function matchCountry(apiName) {
  const norm = normalizeName(apiName);
  if (COUNTRY_BY_NORM.has(norm)) return COUNTRY_BY_NORM.get(norm);
  if (NAME_ALIASES[norm]) return COUNTRY_BY_NAME_DIRECT(NAME_ALIASES[norm]);
  return null;
}
const COUNTRY_BY_PLAIN = new Map(COUNTRIES.map((c) => [c.name, c]));
function COUNTRY_BY_NAME_DIRECT(name) {
  return COUNTRY_BY_PLAIN.get(name) || null;
}

let fdCache = { at: 0, matches: null };
async function fetchMatches() {
  // Dev/preview hook: load matches from a local JSON file instead of the live API.
  if (process.env.FD_MOCK_FILE) {
    try {
      const raw = await readFile(process.env.FD_MOCK_FILE, 'utf8');
      const json = JSON.parse(raw);
      fdCache = { at: Date.now(), matches: json.matches || [] };
      return { matches: fdCache.matches };
    } catch (e) {
      return { error: 'mock_unreadable' };
    }
  }
  if (!FD_TOKEN) return { error: 'not_configured' };
  const now = Date.now();
  if (fdCache.matches && now - fdCache.at < FD_CACHE_MS) return { matches: fdCache.matches };
  try {
    const resp = await fetch(`${FD_BASE}/competitions/${FD_COMPETITION}/matches`, {
      headers: { 'X-Auth-Token': FD_TOKEN },
    });
    if (!resp.ok) {
      // Serve stale data on transient errors rather than going blank.
      if (fdCache.matches) return { matches: fdCache.matches, stale: true };
      return { error: `api_${resp.status}` };
    }
    const json = await resp.json();
    fdCache = { at: now, matches: json.matches || [] };
    return { matches: fdCache.matches };
  } catch (e) {
    if (fdCache.matches) return { matches: fdCache.matches, stale: true };
    return { error: 'api_unreachable' };
  }
}

// Crunch raw matches + the roster into a results payload for the page.
function computeTournament(matches) {
  // team(name) -> owner participant name
  const rows = db.prepare('SELECT id, name FROM participants ORDER BY id ASC').all();
  const assignments = db.prepare('SELECT participant_id, country FROM assignments').all();
  const nameById = new Map(rows.map((r) => [r.id, r.name]));
  const ownerByCountry = new Map();
  for (const a of assignments) ownerByCountry.set(a.country, nameById.get(a.participant_id));

  // Index matches per team (by our country name).
  const perTeam = new Map(); // country name -> { matches:[], stagesReached:Set, ... }
  const ensure = (c) => {
    if (!perTeam.has(c.name)) perTeam.set(c.name, { country: c, matches: [] });
    return perTeam.get(c.name);
  };

  const knockoutTeams = new Set(); // teams that appear in any knockout match (bracket drawn)
  const normMatches = [];
  for (const m of matches) {
    const home = matchCountry(m.homeTeam?.name);
    const away = matchCountry(m.awayTeam?.name);
    const stage = STAGE_BY_KEY.get(m.stage) || { key: m.stage, label: m.stage, order: -1, bonus: 0 };
    const nm = {
      id: m.id,
      utcDate: m.utcDate,
      status: m.status, // SCHEDULED|TIMED|IN_PLAY|PAUSED|FINISHED|...
      stage,
      home,
      away,
      homeName: m.homeTeam?.name,
      awayName: m.awayTeam?.name,
      homeScore: m.score?.fullTime?.home,
      awayScore: m.score?.fullTime?.away,
      winner: m.score?.winner, // HOME_TEAM|AWAY_TEAM|DRAW|null
    };
    normMatches.push(nm);
    for (const c of [home, away]) {
      if (!c) continue;
      ensure(c).matches.push(nm);
      if (stage.order >= 1) knockoutTeams.add(c.name);
    }
  }

  const bracketDrawn = knockoutTeams.size > 0;

  function teamStatus(name) {
    const t = perTeam.get(name);
    if (!t) return { points: 0, stageLabel: 'Awaiting fixtures', stageOrder: 0, eliminated: false, playingNow: false, champion: false };
    let points = 0;
    let furthest = 0;
    let playingNow = false;
    let lostKnockout = false;
    let champion = false;
    let allGroupFinished = true;
    let hasGroup = false;

    for (const m of t.matches) {
      if (m.status === 'IN_PLAY' || m.status === 'PAUSED') playingNow = true;
      furthest = Math.max(furthest, m.stage.order);

      const isHome = m.home && m.home.name === name;
      if (m.stage.key === 'GROUP_STAGE') {
        hasGroup = true;
        if (m.status === 'FINISHED') {
          if (m.winner === 'DRAW') points += SCORING.groupDraw;
          else if ((m.winner === 'HOME_TEAM' && isHome) || (m.winner === 'AWAY_TEAM' && !isHome))
            points += SCORING.groupWin;
        } else {
          allGroupFinished = false;
        }
      } else if (m.status === 'FINISHED') {
        const won = (m.winner === 'HOME_TEAM' && isHome) || (m.winner === 'AWAY_TEAM' && !isHome);
        if (!won && m.winner && m.winner !== 'DRAW') lostKnockout = true;
        if (m.stage.key === 'FINAL' && won) champion = true;
      }
    }

    // Stage-reached bonuses (cumulative up the ladder).
    for (const s of STAGES) if (s.order >= 1 && s.order <= furthest) points += s.bonus;
    if (champion) points += SCORING.champion;

    const reachedKnockout = furthest >= 1;
    let eliminated = false;
    if (champion) eliminated = false;
    else if (lostKnockout) eliminated = true;
    else if (!reachedKnockout && hasGroup && allGroupFinished && bracketDrawn && !knockoutTeams.has(name))
      eliminated = true;

    const stageLabel = STAGES.find((s) => s.order === furthest)?.label || 'Group stage';
    return { points, stageLabel, stageOrder: furthest, eliminated, playingNow, champion };
  }

  // Leaderboard
  const leaderboard = rows
    .map((p) => {
      const teams = assignments
        .filter((a) => a.participant_id === p.id)
        .map((a) => {
          const c = COUNTRY_BY_PLAIN.get(a.country);
          const st = teamStatus(a.country);
          return { name: a.country, flag: c?.flag || '', rank: c?.rank, ...st };
        })
        .sort((x, y) => y.points - x.points || (x.rank || 99) - (y.rank || 99));
      const points = teams.reduce((s, t) => s + t.points, 0);
      const allOut = teams.length > 0 && teams.every((t) => t.eliminated);
      const anyChampion = teams.some((t) => t.champion);
      const bestStage = teams.reduce((m, t) => Math.max(m, t.stageOrder), 0);
      const playingNow = teams.some((t) => t.playingNow);
      return { name: p.name, points, teams, status: allOut ? 'out' : 'in', anyChampion, bestStage, playingNow };
    })
    .sort((a, b) => b.points - a.points || b.bestStage - a.bestStage || a.name.localeCompare(b.name));

  // annotate a match side with flag + owner
  const side = (country, rawName, score) => ({
    name: country?.name || rawName || 'TBD',
    flag: country?.flag || '',
    owner: country ? ownerByCountry.get(country.name) || null : null,
    score: score ?? null,
  });
  const dressMatch = (m) => ({
    id: m.id,
    utcDate: m.utcDate,
    status: m.status,
    stageLabel: m.stage.label,
    home: side(m.home, m.homeName, m.homeScore),
    away: side(m.away, m.awayName, m.awayScore),
  });
  const involvesOwned = (m) =>
    (m.home && ownerByCountry.has(m.home.name)) || (m.away && ownerByCountry.has(m.away.name));

  const live = normMatches
    .filter((m) => m.status === 'IN_PLAY' || m.status === 'PAUSED')
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate))
    .map(dressMatch);

  const recent = normMatches
    .filter((m) => m.status === 'FINISHED')
    .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
    .slice(0, 12)
    .map(dressMatch);

  const upcoming = normMatches
    .filter((m) => (m.status === 'SCHEDULED' || m.status === 'TIMED') && involvesOwned(m))
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate))
    .slice(0, 10)
    .map(dressMatch);

  return { leaderboard, live, recent, upcoming, totalMatches: matches.length };
}

// ----- HTTP helpers -----
function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

async function serveStatic(res, urlPath) {
  // Default to index.html
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  // Prevent path traversal
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(__dirname, 'public', safe);
  if (!filePath.startsWith(join(__dirname, 'public'))) {
    return sendJSON(res, 403, { error: 'Forbidden' });
  }
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  } catch {
    sendJSON(res, 404, { error: 'Not found' });
  }
}

// ----- API handlers -----
async function handleApi(req, res, pathname) {
  // GET /api/state
  if (req.method === 'GET' && pathname === '/api/state') {
    return sendJSON(res, 200, buildState());
  }

  // GET /api/tournament -> live results, eliminations & points leaderboard
  if (req.method === 'GET' && pathname === '/api/tournament') {
    const result = await fetchMatches();
    if (result.error === 'not_configured') {
      return sendJSON(res, 200, {
        configured: false,
        message:
          'Live results are not set up yet. Add a free football-data.org API key as the FOOTBALL_DATA_TOKEN environment variable.',
      });
    }
    if (result.error) {
      return sendJSON(res, 200, {
        configured: true,
        ok: false,
        message: `Could not reach the football data service (${result.error}). It may be a rate limit — try again shortly.`,
      });
    }
    const data = computeTournament(result.matches);
    return sendJSON(res, 200, {
      configured: true,
      ok: true,
      stale: !!result.stale,
      lastUpdated: new Date(fdCache.at || Date.now()).toISOString(),
      scoring: SCORING,
      competition: FD_COMPETITION,
      ...data,
    });
  }

  // POST /api/participants  { name }
  if (req.method === 'POST' && pathname === '/api/participants') {
    const body = await readBody(req);
    const name = String(body.name ?? '').trim();
    if (!name) return sendJSON(res, 400, { error: 'Name is required.' });
    if (name.length > 60) return sendJSON(res, 400, { error: 'Name is too long.' });
    try {
      db.prepare('INSERT INTO participants (name) VALUES (?)').run(name);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return sendJSON(res, 409, { error: `"${name}" has already been added.` });
      }
      throw e;
    }
    return sendJSON(res, 201, buildState());
  }

  // POST /api/spin  { id }  -> draws ONE random country for the participant
  if (req.method === 'POST' && pathname === '/api/spin') {
    const body = await readBody(req);
    const id = Number(body.id);
    if (!Number.isInteger(id)) return sendJSON(res, 400, { error: 'A valid participant id is required.' });

    // Server is authoritative about which country is drawn.
    const result = drawOne(id);
    if (result.error) return sendJSON(res, result.status, { error: result.error });

    return sendJSON(res, 200, {
      pick: result.pick,
      // the pot the wheel spun over (before removal) so the client can land on `pick`
      pool: result.pool,
      pot: result.pot,
      state: buildState(),
    });
  }

  // POST /api/spin-all  { id }  -> fills the rest of the participant's share at once
  if (req.method === 'POST' && pathname === '/api/spin-all') {
    const body = await readBody(req);
    const id = Number(body.id);
    if (!Number.isInteger(id)) return sendJSON(res, 400, { error: 'A valid participant id is required.' });

    const picks = [];
    let lastPool = null;
    // Keep drawing until the participant hits their quota or the pool is empty.
    while (true) {
      const result = drawOne(id);
      if (result.error) {
        // Stop quietly once they're full / pool empty, but surface a hard error
        // (e.g. participant not found) if nothing was drawn at all.
        if (picks.length === 0) return sendJSON(res, result.status, { error: result.error });
        break;
      }
      picks.push(result.pick);
      lastPool = result.pool;
    }

    return sendJSON(res, 200, { picks, lastPool, state: buildState() });
  }

  // POST /api/reset -> clear all draws (keeps the participant list)
  if (req.method === 'POST' && pathname === '/api/reset') {
    db.exec('DELETE FROM assignments');
    return sendJSON(res, 200, buildState());
  }

  // DELETE /api/participants/:id
  const delMatch = pathname.match(/^\/api\/participants\/(\d+)$/);
  if (req.method === 'DELETE' && delMatch) {
    db.prepare('DELETE FROM participants WHERE id = ?').run(Number(delMatch[1]));
    return sendJSON(res, 200, buildState());
  }

  return sendJSON(res, 404, { error: 'Unknown API endpoint.' });
}

// ----- Server -----
const server = createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
    } else {
      await serveStatic(res, pathname);
    }
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { error: err.message || 'Internal server error.' });
  }
});

server.listen(PORT, () => {
  console.log(`\n  ⚽  World Cup Spinner running at  http://localhost:${PORT}\n`);
});
