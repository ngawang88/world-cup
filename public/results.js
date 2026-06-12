const $ = (s) => document.querySelector(s);
const fmt = (iso) =>
  iso
    ? new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ownerTag(o) {
  return o ? `<span class="owner">${esc(o)}</span>` : '';
}

function matchCard(m, opts = {}) {
  const live = m.status === 'IN_PLAY' || m.status === 'PAUSED';
  const sc = (s) => (s.score === null || s.score === undefined ? '' : `<b>${s.score}</b>`);
  return `
    <div class="match ${live ? 'is-live' : ''}">
      <div class="m-stage">${esc(m.stageLabel || '')}${opts.showDate && m.utcDate ? ' · ' + fmt(m.utcDate) : ''}${live ? ' · 🔴 LIVE' : ''}</div>
      <div class="m-row">
        <span class="m-team">${m.home.flag} ${esc(m.home.name)} ${ownerTag(m.home.owner)}</span>
        <span class="m-score">${sc(m.home)}${m.home.score != null || m.away.score != null ? ' – ' : ''}${sc(m.away)}</span>
        <span class="m-team right">${ownerTag(m.away.owner)} ${esc(m.away.name)} ${m.away.flag}</span>
      </div>
    </div>`;
}

function render(d) {
  const notice = $('#notice');

  if (!d.configured) {
    notice.hidden = false;
    notice.innerHTML = `⚙️ <strong>Live results aren't switched on yet.</strong><br>${esc(d.message)}`;
    return;
  }
  if (d.ok === false) {
    notice.hidden = false;
    notice.innerHTML = `⚠️ ${esc(d.message)}`;
    return;
  }
  notice.hidden = true;

  $('#updated').textContent =
    `Updated ${fmt(d.lastUpdated)}${d.stale ? ' (showing last good data)' : ''} · ${d.totalMatches} matches tracked`;

  // Live
  const livePanel = $('#live-panel');
  if (d.live.length) {
    livePanel.hidden = false;
    $('#live').innerHTML = d.live.map((m) => matchCard(m)).join('');
  } else {
    livePanel.hidden = true;
  }

  // Leaderboard
  const leader = d.leaderboard[0];
  $('#leaderboard').innerHTML = d.leaderboard
    .map((p, i) => {
      const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
      const lead = i === 0 && p.points > 0 ? ' leading' : '';
      const teams = p.teams
        .map((t) => {
          const cls = t.champion ? 'champion' : t.eliminated ? 'eliminated' : t.playingNow ? 'live' : 'alive';
          const icon = t.champion ? '👑' : t.eliminated ? '❌' : t.playingNow ? '🔴' : '🟢';
          return `<span class="team-pill ${cls}" title="${esc(t.stageLabel)} · ${t.points} pts">${icon} ${t.flag} ${esc(t.name)} <b>${t.points}</b></span>`;
        })
        .join('');
      return `
        <li class="lb-row${lead}${p.status === 'out' ? ' is-out' : ''}">
          <div class="lb-head">
            <span class="lb-rank">${medal}</span>
            <span class="lb-name">${esc(p.name)}${p.status === 'out' ? ' <span class="out-badge">OUT</span>' : ''}${p.playingNow ? ' <span class="liveing">🔴 live</span>' : ''}</span>
            <span class="lb-points">${p.points} <small>pts</small></span>
          </div>
          <div class="lb-teams">${teams}</div>
        </li>`;
    })
    .join('');

  // Recent + upcoming
  $('#recent').innerHTML = d.recent.length
    ? d.recent.map((m) => matchCard(m, { showDate: true })).join('')
    : '<p class="empty">No finished matches yet.</p>';
  $('#upcoming').innerHTML = d.upcoming.length
    ? d.upcoming.map((m) => matchCard(m, { showDate: true })).join('')
    : '<p class="empty">No upcoming fixtures for your teams.</p>';

  // Scoring blurb
  const s = d.scoring;
  $('#scoring-text').innerHTML =
    `Each of your teams earns points as it goes: <b>${s.groupWin}</b> per group win, <b>${s.groupDraw}</b> per draw, ` +
    `then bonuses for reaching the Round of 32 (<b>+${s.reachR32}</b>), R16 (<b>+${s.reachR16}</b>), ` +
    `quarter-final (<b>+${s.reachQF}</b>), semi (<b>+${s.reachSF}</b>), final (<b>+${s.reachFinal}</b>), ` +
    `and <b>+${s.champion}</b> for lifting the trophy 👑. Your score is the total across all your teams — highest wins the $500.`;
}

async function load() {
  try {
    const r = await fetch('/api/tournament');
    render(await r.json());
  } catch {
    const n = $('#notice');
    n.hidden = false;
    n.textContent = 'Could not load results — is the server running?';
  }
}

load();
setInterval(load, 45000); // refresh every 45s; the server caches, so this is cheap
