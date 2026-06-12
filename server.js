import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
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
