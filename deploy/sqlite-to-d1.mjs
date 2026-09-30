// Export a Splitwise SQLite database (e.g. the VPS copy) as SQL INSERTs for Cloudflare D1.
//   node deploy/sqlite-to-d1.mjs path/to/splitwise.db > data.sql
//   npx wrangler d1 execute splitwise --remote --file data.sql
// Sessions and login failures are not copied: everyone simply logs in again.

import { open } from '../lib/db.js'; // also upgrades older layouts before exporting

const file = process.argv[2];
if (!file) {
  console.error('usage: node deploy/sqlite-to-d1.mjs <sqlite file>');
  process.exit(1);
}

const db = open(file);
// Parents before children, so foreign keys hold at every step.
const TABLES = ['users', 'groups', 'group_members', 'expenses', 'expense_shares', 'payments'];

const literal = v => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};

const out = [];
for (const table of TABLES) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  for (const row of db.prepare(`SELECT ${cols.join(', ')} FROM ${table}`).all()) {
    out.push(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(c => literal(row[c])).join(', ')});`);
  }
  console.error(`${table}: ${db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n} rows`);
}
console.log(out.join('\n'));
