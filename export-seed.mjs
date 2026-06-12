// One-off: dump the current draw to seed.json so the deployed site can load it.
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(join(dir, 'world_cup.db'));

const rows = db.prepare('SELECT id, name FROM participants ORDER BY id ASC').all();
const assignments = db
  .prepare('SELECT participant_id, country FROM assignments ORDER BY id ASC')
  .all();

const byId = new Map();
for (const a of assignments) {
  if (!byId.has(a.participant_id)) byId.set(a.participant_id, []);
  byId.get(a.participant_id).push(a.country);
}

const seed = {
  participants: rows.map((p) => ({ name: p.name, countries: byId.get(p.id) || [] })),
};

writeFileSync(join(dir, 'seed.json'), JSON.stringify(seed, null, 2));
console.log(`Wrote seed.json: ${seed.participants.length} participants, ${assignments.length} teams.`);
