import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as db from '../lib/db.js';
import { nodeStore } from '../lib/store.js';
import { createApp, ensureAdmin } from '../lib/app.js';
import { nodeHandler } from '../lib/node-http.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Spin up the real Node server on a random port with an in-memory database.
async function listen({ trustProxy = false } = {}) {
  const store = nodeStore(db.open(':memory:'));
  await ensureAdmin(store, { password: 'adminpass' });
  const server = http.createServer(nodeHandler(createApp(store), { publicDir: PUBLIC_DIR, trustProxy })).listen(0);
  await new Promise(r => server.once('listening', r));
  return server;
}

async function start() {
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;

  const client = () => {
    let cookie = '';
    return async (method, path, body, { csrf = true } = {}) => {
      const res = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-Requested-With': 'fetch' } : {}), ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, body: await res.json().catch(() => null) };
    };
  };
  return { server, client };
}

test('full flow: admin creates users, expenses, balances, payments, deletes', async t => {
  const { server, client } = await start();
  t.after(() => server.close());

  const admin = client();
  assert.equal((await admin('GET', '/api/state')).status, 401);
  assert.equal((await admin('POST', '/api/login', { username: 'admin', password: 'nope' })).status, 401);
  assert.equal((await admin('POST', '/api/login', { username: 'admin', password: 'adminpass' })).status, 200);

  // CSRF header required on writes
  assert.equal((await admin('POST', '/api/admin/users', { username: 'x', name: 'x', password: 'xxxxxx' }, { csrf: false })).status, 403);

  const mk = async (username, name) => (await admin('POST', '/api/admin/users', { username, name, password: 'secret1' })).body.id;
  const alice = await mk('alice', 'Alice');
  const bob = await mk('bob', 'Bob');
  const carol = await mk('carol', 'Carol');
  assert.equal((await admin('POST', '/api/admin/users', { username: 'Alice', name: 'dup', password: 'secret1' })).status, 400);

  const a = client();
  assert.equal((await a('POST', '/api/login', { username: 'ALICE', password: 'secret1' })).status, 200);
  assert.equal((await a('GET', '/api/admin/users')).status, 403);

  // Alice makes a group for the three of them.
  const g = (await a('POST', '/api/groups', { name: 'Trip', currency: 'USD', memberIds: [alice, bob, carol] })).body.id;
  const gs = () => a('GET', `/api/groups/${g}/state`);

  // Alice pays $90 dinner split equally between the three of them.
  const dinner = await a('POST', '/api/expenses', {
    groupId: g, description: 'Dinner', amount: '90', paidBy: alice, splitType: 'equal',
    split: [{ userId: alice }, { userId: bob }, { userId: carol }],
  });
  assert.equal(dinner.status, 201);

  // Bob pays $40 taxi, 75% Carol / 25% Bob.
  assert.equal((await a('POST', '/api/expenses', {
    groupId: g, description: 'Taxi', amount: 40, paidBy: bob, splitType: 'percent',
    split: [{ userId: bob, value: 25 }, { userId: carol, value: 75 }],
  })).status, 201);

  // Bad percent is rejected with a helpful message.
  const badPct = await a('POST', '/api/expenses', {
    groupId: g, description: 'x', amount: 10, paidBy: alice, splitType: 'percent', split: [{ userId: alice, value: 50 }],
  });
  assert.equal(badPct.status, 400);
  assert.match(badPct.body.error, /100%/);

  let s = (await gs()).body;
  // Bob: paid 40, owes 10 taxi + 30 dinner = 0. Carol owes 30 + 30.
  assert.deepEqual(s.balances, { [alice]: 6000, [bob]: 0, [carol]: -6000 });
  assert.equal((await a('GET', '/api/state')).body.groups[0].myBalance, 6000);
  assert.deepEqual(s.settlements, [{ from: carol, to: alice, amount: 6000 }]);

  // Carol records paying Alice.
  const c = client();
  await c('POST', '/api/login', { username: 'carol', password: 'secret1' });
  const pay = await c('POST', '/api/payments', { groupId: g, fromUser: carol, toUser: alice, amount: 50 });
  assert.equal(pay.status, 201);
  // Carol can't record a payment between two other people.
  assert.equal((await c('POST', '/api/payments', { groupId: g, fromUser: bob, toUser: alice, amount: 5 })).status, 403);

  s = (await c('GET', `/api/groups/${g}/state`)).body;
  assert.equal(s.balances[carol], -1000);

  // Edit dinner to exact amounts, then delete it.
  assert.equal((await c('PUT', `/api/expenses/${dinner.body.id}`, {
    description: 'Dinner!', amount: 90, paidBy: alice, splitType: 'exact',
    split: [{ userId: alice, value: 30 }, { userId: bob, value: 30 }, { userId: carol, value: 30 }],
  })).status, 200);
  assert.equal((await c('DELETE', `/api/expenses/${dinner.body.id}`)).status, 200);
  s = (await c('GET', `/api/groups/${g}/state`)).body;
  assert.equal(s.expenses.length, 1);
  assert.equal(s.balances[alice], -5000); // only the payment remains for alice

  // Admin: users with history can't be deleted, only deactivated.
  assert.equal((await admin('DELETE', `/api/admin/users/${carol}`)).status, 400);
  assert.equal((await admin('PATCH', `/api/admin/users/${carol}`, { active: false })).status, 200);
  assert.equal((await c('GET', '/api/state')).status, 401); // their session was killed
  assert.equal((await client()('POST', '/api/login', { username: 'carol', password: 'secret1' })).status, 401);

  // Admin can't demote themselves.
  assert.equal((await admin('PATCH', '/api/admin/users/1', { isAdmin: false })).status, 400);

  // Password change
  assert.equal((await a('POST', '/api/me/password', { current: 'wrong', next: 'newpass1' })).status, 400);
  assert.equal((await a('POST', '/api/me/password', { current: 'secret1', next: 'newpass1' })).status, 200);
  assert.equal((await client()('POST', '/api/login', { username: 'alice', password: 'newpass1' })).status, 200);

  // Logout
  await a('POST', '/api/logout');
  assert.equal((await a('GET', '/api/me')).status, 401);
});

test('static files are served and traversal is blocked', async t => {
  const { server } = await start();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<div id="app">/);
  const evil = await fetch(base + '/%2e%2e/package.json');
  assert.ok(evil.status === 403 || !(await evil.text()).includes('"scripts"'));
});

test('groups: visibility, members, currency, archive', async t => {
  const { server, client } = await start();
  t.after(() => server.close());
  const admin = client();
  await admin('POST', '/api/login', { username: 'admin', password: 'adminpass' });
  const mk = async u => (await admin('POST', '/api/admin/users', { username: u, name: u, password: 'secret1' })).body.id;
  const ann = await mk('ann'), ben = await mk('ben'), cat = await mk('cat');
  const as = async u => { const c = client(); await c('POST', '/api/login', { username: u, password: 'secret1' }); return c; };
  const A = await as('ann'), B = await as('ben'), C = await as('cat');

  // Any member can create a group, but must be in it.
  assert.equal((await A('POST', '/api/groups', { name: 'x', currency: 'USD', memberIds: [ben] })).status, 400);
  assert.equal((await A('POST', '/api/groups', { name: 'x', currency: 'ZZZ', memberIds: [ann] })).status, 400);
  const g1 = (await A('POST', '/api/groups', { name: 'Ski', currency: 'eur', memberIds: [ann, ben] })).body.id;
  const g2 = (await A('POST', '/api/groups', { name: 'Ski', currency: 'USD', memberIds: [ann, ben] })).body.id; // names may repeat
  const g3 = (await B('POST', '/api/groups', { name: 'Flat', currency: 'JPY', memberIds: [ben, cat] })).body.id;

  // Visibility: only your groups; admins see all.
  const names = async c => (await c('GET', '/api/state')).body.groups.map(g => g.name).sort();
  assert.deepEqual(await names(A), ['Ski', 'Ski']);
  assert.deepEqual(await names(B), ['Flat', 'Ski', 'Ski']);
  assert.deepEqual(await names(C), ['Flat']);
  assert.equal((await admin('GET', '/api/state')).body.groups.length, 3);
  assert.equal((await C('GET', `/api/groups/${g1}/state`)).status, 404);
  assert.equal((await admin('GET', `/api/groups/${g1}/state`)).body.group.currency, 'EUR');

  // Split must be group members; outsiders can't add expenses.
  const exp = (g, paidBy, split, amount = 30) => ({ groupId: g, description: 'x', amount, paidBy, splitType: 'equal', split: split.map(userId => ({ userId })) });
  assert.equal((await A('POST', '/api/expenses', exp(g1, ann, [ann, cat]))).status, 400);
  assert.equal((await C('POST', '/api/expenses', exp(g1, cat, [cat]))).status, 404);
  assert.equal((await A('POST', '/api/expenses', exp(g1, ann, [ann, ben]))).status, 201);

  // Balances are per group: ben owes ann 15 in g1, nothing in g2.
  const st = (await B('GET', '/api/state')).body.groups;
  assert.equal(st.find(g => g.id === g1).myBalance, -1500);
  assert.equal(st.find(g => g.id === g2).myBalance, 0);
  assert.deepEqual((await A('GET', `/api/groups/${g1}/state`)).body.settlements, [{ from: ben, to: ann, amount: 1500 }]);

  // Yen group: whole amounts only.
  assert.equal((await B('POST', '/api/expenses', exp(g3, ben, [ben, cat], '10.5'))).status, 400);
  assert.equal((await B('POST', '/api/expenses', exp(g3, ben, [ben, cat], '1001'))).status, 201);
  const flat = (await C('GET', `/api/groups/${g3}/state`)).body;
  assert.deepEqual(flat.expenses[0].shares.map(x => x.cents).sort(), [50000, 50100]);

  // Members: ben has history in g1 so becomes a past member; cat can join and leave cleanly.
  let m = (await A('PUT', `/api/groups/${g1}/members`, { memberIds: [ann, cat] })).body.members;
  assert.deepEqual(m.map(x => [x.userId, x.past]).sort(), [[ann, false], [ben, true], [cat, false]]);
  assert.equal((await B('GET', `/api/groups/${g1}/state`)).status, 200); // past members can still look
  assert.equal((await B('POST', '/api/expenses', exp(g1, ben, [ben]))).status, 403);
  // ...and can still settle up what they owe
  assert.equal((await A('POST', '/api/payments', { groupId: g1, fromUser: ben, toUser: ann, amount: 15 })).status, 201);
  m = (await A('PUT', `/api/groups/${g1}/members`, { memberIds: [ann] })).body.members;
  assert.deepEqual(m.map(x => x.userId).sort(), [ann, ben].sort()); // cat removed outright, ben stays past

  // Archive: read-only until unarchived.
  assert.equal((await A('PATCH', `/api/groups/${g1}`, { archived: true })).status, 200);
  assert.equal((await A('POST', '/api/expenses', exp(g1, ann, [ann]))).status, 400);
  assert.equal((await A('PATCH', `/api/groups/${g1}`, { archived: false, name: 'Ski trip' })).body.name, 'Ski trip');

  // Delete: empty groups by any member; groups with history only by their creator or an admin,
  // and everything in them goes too.
  assert.equal((await B('DELETE', `/api/groups/${g2}`)).status, 200); // empty; ben didn't create it
  assert.equal((await C('DELETE', `/api/groups/${g3}`)).status, 403); // has history; ben created it
  assert.equal((await B('DELETE', `/api/groups/${g3}`)).status, 200);
  assert.equal((await admin('DELETE', `/api/groups/${g1}`)).status, 200);
  assert.equal((await admin('GET', '/api/state')).body.groups.length, 0);
  assert.equal((await admin('GET', `/api/groups/${g1}/state`)).status, 404);
});

test('upgrading an old database moves everything into a General group', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-')), 'old.db');
  // A pre-groups schema with one expense and one payment.
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
      password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE expenses (id INTEGER PRIMARY KEY, description TEXT NOT NULL, amount INTEGER NOT NULL, paid_by INTEGER NOT NULL,
      split_type TEXT NOT NULL, date TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);
    CREATE TABLE expense_shares (expense_id INTEGER NOT NULL, user_id INTEGER NOT NULL, cents INTEGER NOT NULL, value REAL,
      PRIMARY KEY (expense_id, user_id));
    CREATE TABLE payments (id INTEGER PRIMARY KEY, from_user INTEGER NOT NULL, to_user INTEGER NOT NULL, amount INTEGER NOT NULL,
      date TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES ('currency', 'GBP');
    INSERT INTO users (id, username, name, password_hash) VALUES (1, 'a', 'A', 'x'), (2, 'b', 'B', 'x');
    INSERT INTO expenses (id, description, amount, paid_by, split_type, date, created_by) VALUES (1, 'Old', 1000, 1, 'equal', '2026-01-01', 1);
    INSERT INTO expense_shares VALUES (1, 1, 500, NULL), (1, 2, 500, NULL);
    INSERT INTO payments (from_user, to_user, amount, date, created_by) VALUES (2, 1, 200, '2026-01-02', 2);
  `);
  old.close();

  const migrated = db.open(file);
  const groups = migrated.prepare('SELECT * FROM groups').all();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, 'General');
  assert.equal(groups[0].currency, 'GBP');
  assert.equal('year' in groups[0], false);
  assert.equal(migrated.prepare('SELECT COUNT(*) AS n FROM group_members').get().n, 2);
  assert.equal(migrated.prepare('SELECT COUNT(*) AS n FROM expenses WHERE group_id = ?').get(groups[0].id).n, 1);
  assert.equal(migrated.prepare('SELECT COUNT(*) AS n FROM payments WHERE group_id = ?').get(groups[0].id).n, 1);
  migrated.close();
  // Opening again is a no-op.
  assert.equal(db.open(file).prepare('SELECT COUNT(*) AS n FROM groups').get().n, 1);
});

test('behind a proxy, failed-login limits apply per real client IP', async t => {
  const server = await listen({ trustProxy: true });
  t.after(() => server.close());
  const login = (ip, password) => fetch(`http://127.0.0.1:${server.address().port}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', 'X-Forwarded-For': ip },
    body: JSON.stringify({ username: 'admin', password }),
  }).then(r => r.status);

  for (let i = 0; i < 10; i++) await login('6.6.6.6', 'wrong');
  assert.equal(await login('6.6.6.6', 'adminpass'), 429); // the attacker is blocked…
  assert.equal(await login('1.2.3.4', 'adminpass'), 200); // …but the real admin isn't
  // A spoofed first entry doesn't help: only the proxy-appended last address counts.
  assert.equal(await login('1.2.3.4, 6.6.6.6', 'adminpass'), 429);
});

test('passwords hashed by the first version (scrypt) still work and are upgraded', async t => {
  const { scryptSync, randomBytes } = await import('node:crypto');
  const sqlite = db.open(':memory:');
  const salt = randomBytes(16);
  const legacy = `scrypt$${salt.toString('hex')}$${scryptSync('oldpass1', salt, 64).toString('hex')}`;
  sqlite.prepare("INSERT INTO users (username, name, password_hash, is_admin) VALUES ('old', 'Old', ?, 1)").run(legacy);
  const server = http.createServer(nodeHandler(createApp(nodeStore(sqlite)), { publicDir: PUBLIC_DIR })).listen(0);
  await new Promise(r => server.once('listening', r));
  t.after(() => server.close());
  const login = pw => fetch(`http://127.0.0.1:${server.address().port}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: JSON.stringify({ username: 'old', password: pw }),
  }).then(r => r.status);

  assert.equal(await login('wrongpass'), 401);
  assert.equal(await login('oldpass1'), 200);
  assert.match(sqlite.prepare("SELECT password_hash FROM users WHERE username = 'old'").get().password_hash, /^pbkdf2\$100000\$/);
  assert.equal(await login('oldpass1'), 200); // and the new hash works
});

test('people can change their own display name, not their username or anyone else\'s', async t => {
  const { server, client } = await start();
  t.after(() => server.close());
  const admin = client();
  await admin('POST', '/api/login', { username: 'admin', password: 'adminpass' });
  const bo = (await admin('POST', '/api/admin/users', { username: 'bo', name: 'Bo', password: 'secret1' })).body.id;
  const B = client();
  await B('POST', '/api/login', { username: 'bo', password: 'secret1' });

  assert.equal((await B('PATCH', '/api/me', { name: '  Bo Peep  ' })).body.name, 'Bo Peep');
  assert.equal((await B('GET', '/api/me')).body.name, 'Bo Peep');
  assert.equal((await B('GET', '/api/me')).body.username, 'bo');
  assert.equal((await admin('GET', '/api/state')).body.users.find(u => u.id === bo).name, 'Bo Peep');
  assert.equal((await B('PATCH', '/api/me', { name: '   ' })).status, 400);
  assert.equal((await B('PATCH', '/api/me', { name: 'x'.repeat(61) })).status, 400);
  // Only their own: there's no way to pass someone else's id, and the admin is untouched.
  await B('PATCH', '/api/me', { name: 'Hacker', id: 1, username: 'admin' });
  assert.equal((await admin('GET', '/api/me')).body.name, 'Admin');
  assert.equal((await B('GET', '/api/me')).body.username, 'bo');
  // Must be logged in.
  assert.equal((await client()('PATCH', '/api/me', { name: 'Nope' })).status, 401);
});
