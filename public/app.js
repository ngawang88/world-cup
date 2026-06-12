// ---- DOM ----
const $ = (sel) => document.querySelector(sel);
const addForm = $('#add-form');
const nameInput = $('#name-input');
const addError = $('#add-error');
const select = $('#participant-select');
const spinBtn = $('#spin-btn');
const spinAllBtn = $('#spin-all-btn');
const spinStatus = $('#spin-status');
const counter = $('#counter');
const resetBtn = $('#reset-btn');
const printBtn = $('#print-btn');
const printArea = $('#print-area');
const sponsor = $('#sponsor');
const canvas = $('#wheel');
const ctx = canvas.getContext('2d');
const wheelEmpty = $('#wheel-empty');
const resultEl = $('#result');
const assignmentList = $('#assignment-list');

// ---- State ----
let state = null;          // latest state from server
let wheelPool = [];        // countries currently drawn on the wheel
let rotation = 0;          // current wheel rotation in radians
let spinning = false;

const SLICE_COLORS = ['#2f3b78', '#3a478f', '#26315f', '#434f9c'];

// ---- API ----
async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ---- Rendering ----
function applyState(s) {
  state = s;
  sponsor.textContent = s.sponsorMessage;
  renderSelect();
  renderAssignments();
  renderCounter();
  // Only redraw the wheel when not mid-spin (a spin animates its own pool)
  if (!spinning) {
    wheelPool = s.available;
    drawWheel(rotation);
    toggleEmpty();
  }
  updateSpinEnabled();
}

function renderSelect() {
  const eligible = state.participants.filter((p) => p.remaining > 0);
  const prev = select.value;
  select.innerHTML = '';
  if (eligible.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = state.participants.length ? 'Everyone is full 🎉' : 'Add a participant first';
    opt.value = '';
    select.appendChild(opt);
    return;
  }
  for (const p of eligible) {
    const opt = document.createElement('option');
    opt.value = String(p.id);
    opt.textContent = `${p.name}  (${p.countries.length}/${p.quota})`;
    select.appendChild(opt);
  }
  // keep previous selection if still valid
  if (eligible.some((p) => String(p.id) === prev)) select.value = prev;
}

function renderAssignments() {
  assignmentList.innerHTML = '';
  if (state.participants.length === 0) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="chips"><span class="empty">No participants yet.</span></span>';
    assignmentList.appendChild(li);
    return;
  }
  for (const p of state.participants) {
    const li = document.createElement('li');
    const done = p.remaining === 0;
    const chips = p.countries.length
      ? p.countries
          .map((c) => `<span class="chip">${c.flag} ${escapeHtml(c.name)} <span class="chip-rank">#${c.rank}</span></span>`)
          .join('')
      : '<span class="empty">nothing drawn yet</span>';
    li.innerHTML = `
      <div class="li-head">
        <span class="who"></span>
        <span class="progress ${done ? 'done' : ''}">${p.countries.length}/${p.quota}${done ? ' ✓' : ''}</span>
        <button class="del" title="Remove" data-id="${p.id}">✕</button>
      </div>
      <div class="chips">${chips}</div>`;
    li.querySelector('.who').textContent = p.name;
    assignmentList.appendChild(li);
  }
}

function renderCounter() {
  counter.textContent = `${state.assignedCount} / ${state.totalCountries} drawn`;
}

function toggleEmpty() {
  const empty = wheelPool.length === 0;
  wheelEmpty.hidden = !empty;
}

function updateSpinEnabled() {
  const hasPick = select.value !== '';
  const noneLeft = state && state.available.length === 0;
  spinBtn.disabled = spinning || !hasPick || noneLeft;
  spinAllBtn.disabled = spinning || !hasPick || noneLeft;
}

// ---- Wheel drawing ----
function drawWheel(rot) {
  const n = wheelPool.length;
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const r = Math.min(cx, cy) - 6;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (n === 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#0e1430';
    ctx.fill();
    return;
  }

  const slice = (Math.PI * 2) / n;
  for (let i = 0; i < n; i++) {
    const start = i * slice + rot;
    const end = start + slice;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, start, end);
    ctx.closePath();
    ctx.fillStyle = SLICE_COLORS[i % SLICE_COLORS.length];
    ctx.fill();

    // flag emoji at mid radius (only label when slices are big enough for text)
    const mid = start + slice / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(mid);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const fontSize = n <= 16 ? 26 : n <= 30 ? 20 : 15;
    ctx.font = `${fontSize}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
    ctx.fillText(wheelPool[i].flag, r - 12, 0);
    if (n <= 16) {
      ctx.font = `600 13px system-ui, sans-serif`;
      ctx.fillStyle = '#eef2ff';
      ctx.fillText(wheelPool[i].name, r - 46, 0);
    }
    ctx.restore();
  }

  // hub
  ctx.beginPath();
  ctx.arc(cx, cy, 34, 0, Math.PI * 2);
  ctx.fillStyle = '#ffd34d';
  ctx.fill();
  ctx.font = '26px "Segoe UI Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('⚽', cx, cy);

  // rim
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#0b1020';
  ctx.stroke();
}

// Compute the final rotation so that segment `index` (of n) lands under the
// top pointer, after several full turns.
function targetRotationFor(index, n, turns = 6) {
  const slice = (Math.PI * 2) / n;
  const pointer = -Math.PI / 2; // straight up
  // segment center in screen space = index*slice + slice/2 + rotation == pointer (mod 2π)
  let base = pointer - (index * slice + slice / 2);
  // normalise base into [0, 2π)
  base = ((base % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  // continue forward from current rotation, adding full turns
  const current = ((rotation % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  let delta = base - current;
  if (delta < 0) delta += Math.PI * 2;
  return rotation + turns * Math.PI * 2 + delta;
}

function easeOutQuart(t) {
  return 1 - Math.pow(1 - t, 4);
}

function animateTo(finalRotation, duration = 4200) {
  return new Promise((resolve) => {
    const startRot = rotation;
    const startTime = performance.now();
    function frame(now) {
      const t = Math.min((now - startTime) / duration, 1);
      rotation = startRot + (finalRotation - startRot) * easeOutQuart(t);
      drawWheel(rotation);
      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        rotation = finalRotation;
        drawWheel(rotation);
        resolve();
      }
    }
    requestAnimationFrame(frame);
  });
}

// ---- Actions ----
addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  addError.textContent = '';
  const name = nameInput.value.trim();
  if (!name) return;
  try {
    const s = await api('/api/participants', { method: 'POST', body: JSON.stringify({ name }) });
    nameInput.value = '';
    applyState(s);
    nameInput.focus();
  } catch (err) {
    addError.textContent = err.message;
  }
});

select.addEventListener('change', updateSpinEnabled);

spinBtn.addEventListener('click', async () => {
  if (spinning) return;
  const id = Number(select.value);
  if (!id) return;
  const participant = state.participants.find((p) => p.id === id);

  spinning = true;
  updateSpinEnabled();
  resultEl.hidden = true;
  spinStatus.textContent = 'Spinning the wheel…';

  // Freeze the pool the wheel is spinning over.
  wheelPool = state.available.slice();
  toggleEmpty();

  try {
    const data = await api('/api/spin', { method: 'POST', body: JSON.stringify({ id }) });
    if (data.pot) spinStatus.textContent = `Drawing from ${data.pot.label}…`;
    // Land on the country the server chose, within the frozen pool.
    let index = data.pool.findIndex((c) => c.name === data.pick.name);
    if (index < 0) index = 0;
    // Make sure the wheel shows the same pool (pot) the server spun over.
    wheelPool = data.pool;
    drawWheel(rotation);

    const final = targetRotationFor(index, wheelPool.length);
    await animateTo(final);

    // Reveal result
    const updated = data.state.participants.find((p) => p.id === id);
    const tally = updated ? `${updated.countries.length}/${updated.quota}` : '';
    const potTxt = data.pot ? ` · ${escapeHtml(data.pot.label)}` : '';
    resultEl.innerHTML = `<span class="flag">${data.pick.flag}</span>${escapeHtml(
      participant.name
    )} gets <strong>${escapeHtml(data.pick.name)}</strong> <span class="rank">#${data.pick.rank}</span>!<br><span class="tally">${tally}${potTxt}</span>`;
    resultEl.hidden = false;
    spinStatus.textContent = '';
    burstConfetti();

    spinning = false;
    applyState(data.state);
  } catch (err) {
    spinning = false;
    spinStatus.textContent = '';
    addError.textContent = err.message;
    applyState(state);
  }
});

// Fill the rest of a participant's share in one go (a short spin, then reveal all).
spinAllBtn.addEventListener('click', async () => {
  if (spinning) return;
  const id = Number(select.value);
  if (!id) return;
  const participant = state.participants.find((p) => p.id === id);

  spinning = true;
  updateSpinEnabled();
  resultEl.hidden = true;
  spinStatus.textContent = `Drawing the rest of ${participant.name}'s share…`;

  wheelPool = state.available.slice();
  toggleEmpty();

  try {
    const data = await api('/api/spin-all', { method: 'POST', body: JSON.stringify({ id }) });
    if (!data.picks.length) {
      spinning = false;
      spinStatus.textContent = '';
      applyState(data.state);
      return;
    }
    // One quick spin landing on the last country drawn, just for flair.
    wheelPool = data.lastPool;
    drawWheel(rotation);
    const last = data.picks[data.picks.length - 1];
    let index = wheelPool.findIndex((c) => c.name === last.name);
    if (index < 0) index = 0;
    await animateTo(targetRotationFor(index, wheelPool.length, 4), 2200);

    const flags = data.picks
      .slice()
      .sort((a, b) => a.rank - b.rank)
      .map((c) => `<span class="chip">${c.flag} ${escapeHtml(c.name)} <span class="chip-rank">#${c.rank}</span></span>`)
      .join('');
    resultEl.innerHTML = `<strong>${escapeHtml(participant.name)}</strong> drew ${data.picks.length} countries:<div class="chips" style="justify-content:center;margin-top:10px">${flags}</div>`;
    resultEl.hidden = false;
    spinStatus.textContent = '';
    burstConfetti();

    spinning = false;
    applyState(data.state);
  } catch (err) {
    spinning = false;
    spinStatus.textContent = '';
    addError.textContent = err.message;
    applyState(state);
  }
});

printBtn.addEventListener('click', () => {
  if (!state || state.participants.length === 0) {
    addError.textContent = 'Add some participants before printing.';
    return;
  }
  const now = new Date();
  const stamp = now.toLocaleString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const people = state.participants
    .map((p) => {
      const list = p.countries.length
        ? p.countries.map((c) => `<div>${c.flag} ${escapeHtml(c.name)} (#${c.rank})</div>`).join('')
        : '<div><em>nothing drawn yet</em></div>';
      const avg = p.countries.length
        ? ' · avg rank ' + (p.countries.reduce((s, c) => s + c.rank, 0) / p.countries.length).toFixed(1)
        : '';
      return `
        <div class="p-person">
          <h2><span>${escapeHtml(p.name)}</span><span class="p-count">${p.countries.length} / ${p.quota}${avg}</span></h2>
          <div class="p-countries">${list}</div>
        </div>`;
    })
    .join('');

  printArea.innerHTML = `
    <h1>⚽ World Cup 2026 Sweepstake — Official Draw</h1>
    <p class="p-meta">Drawn ${escapeHtml(stamp)} · ${state.assignedCount} of ${state.totalCountries} countries assigned</p>
    <div class="p-sponsor">${escapeHtml(state.sponsorMessage)}</div>
    ${people}
    <p class="p-foot">Each country is drawn once and split evenly between participants. Good luck!</p>`;

  window.print();
});

resetBtn.addEventListener('click', async () => {
  if (spinning) return;
  if (!confirm('Unassign every country? Participants are kept, draws are cleared.')) return;
  const s = await api('/api/reset', { method: 'POST' });
  resultEl.hidden = true;
  rotation = 0;
  applyState(s);
});

assignmentList.addEventListener('click', async (e) => {
  const btn = e.target.closest('.del');
  if (!btn || spinning) return;
  const id = btn.dataset.id;
  if (!confirm('Remove this participant?')) return;
  const s = await api(`/api/participants/${id}`, { method: 'DELETE' });
  applyState(s);
});

// ---- Confetti ----
function burstConfetti() {
  const root = $('#confetti-root');
  const colors = ['#ffd34d', '#38e0a6', '#ff8a3d', '#6db3ff', '#ff6b9d'];
  for (let i = 0; i < 90; i++) {
    const c = document.createElement('div');
    c.className = 'confetti';
    c.style.left = Math.random() * 100 + 'vw';
    c.style.background = colors[i % colors.length];
    c.style.animationDuration = 2 + Math.random() * 2 + 's';
    c.style.animationDelay = Math.random() * 0.4 + 's';
    c.style.transform = `rotate(${Math.random() * 360}deg)`;
    root.appendChild(c);
    setTimeout(() => c.remove(), 4500);
  }
}

// ---- utils ----
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// ---- init ----
(async function init() {
  try {
    const s = await api('/api/state');
    applyState(s);
  } catch (err) {
    spinStatus.textContent = 'Could not reach the server.';
  }
})();
