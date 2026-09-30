// Local SQLite files for the Node server (Cloudflare uses D1 + lib/schema.sql instead).

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8');

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);

// Opens (creating if needed) a database file and brings older layouts up to date.
export function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

  // Databases from before groups: expenses/payments lack group_id (must exist before the schema's indexes).
  for (const table of ['expenses', 'payments']) {
    const cols = columns(db, table);
    if (cols.length && !cols.includes('group_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN group_id INTEGER REFERENCES groups(id)`);
  }
  db.exec(SCHEMA);
  moveOrphansToGeneralGroup(db);
  // Invite links were added after telegram_codes existed.
  if (!columns(db, 'telegram_codes').includes('kind')) db.exec("ALTER TABLE telegram_codes ADD COLUMN kind TEXT NOT NULL DEFAULT 'connect'");
  // Groups briefly had a year; they're now open-ended.
  if (columns(db, 'groups').includes('year')) db.exec('ALTER TABLE groups DROP COLUMN year');
  return db;
}

// Expenses and payments from before groups existed go into one "General" group with everyone in it.
function moveOrphansToGeneralGroup(db) {
  const { n } = db.prepare(`SELECT
    (SELECT COUNT(*) FROM expenses WHERE group_id IS NULL) + (SELECT COUNT(*) FROM payments WHERE group_id IS NULL) AS n`).get();
  if (!n) return;
  const currency = db.prepare("SELECT value FROM settings WHERE key = 'currency'").get()?.value || 'USD';
  db.exec('BEGIN');
  try {
    const hasYear = columns(db, 'groups').includes('year');
    const r = hasYear
      ? db.prepare('INSERT INTO groups (name, year, currency) VALUES (?, ?, ?)').run('General', new Date().getFullYear(), currency)
      : db.prepare('INSERT INTO groups (name, currency) VALUES (?, ?)').run('General', currency);
    const groupId = Number(r.lastInsertRowid);
    db.prepare('INSERT INTO group_members (group_id, user_id) SELECT ?, id FROM users').run(groupId);
    db.prepare('UPDATE expenses SET group_id = ? WHERE group_id IS NULL').run(groupId);
    db.prepare('UPDATE payments SET group_id = ? WHERE group_id IS NULL').run(groupId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
