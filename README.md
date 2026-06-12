# ⚽ World Cup 2026 Office Sweepstake Spinner

Spin a wheel to assign each teammate one of the 48 World Cup 2026 countries — no repeats.
**Prize: cold hard cash, sponsored by our CEO Jai and Co-Founder G.** 💰

## Run it

```bash
cd world_cup
npm start          # or: node server.js
```

Then open **http://localhost:3000**. To use a different port: `PORT=8080 npm start`.

No `npm install` needed — it uses Node's built-in `node:sqlite` and `http` modules.
Requires **Node 22.5+** (you have v26).

## How to use

1. **Add participants** — type each employee's name and hit *Add*.
2. **Pick who's spinning** from the dropdown.
3. Hit **🎡 SPIN!** — the wheel lands on a random country, which is then locked to that person.
4. Repeat for the next person. Each country can only be drawn once.

- **Reset draws** clears all assignments but keeps the participant list.
- The **✕** next to a name removes that participant.

## Data

Everything is stored in `world_cup.db` (SQLite) in this folder, so draws persist
across restarts and are shared by anyone hitting the same server. Delete that file
to start completely fresh.

## Files

- `server.js` — HTTP server, SQLite DB, and the JSON API (`/api/state`, `/api/participants`, `/api/spin`, `/api/reset`).
- `public/index.html`, `public/style.css`, `public/app.js` — the single-page UI and canvas wheel.
