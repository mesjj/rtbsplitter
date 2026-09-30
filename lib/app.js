// JSON API as a web-standard fetch handler: (Request) → Response. Runs on Node (server.js)
// and Cloudflare Workers (worker.js). `db` is an async store from lib/store.js.

import * as auth from './auth.js';
import * as money from './money.js';
import { expenseSnapshot, paymentSnapshot, groupSnapshot, expenseMessages, paymentMessages, groupDeletedMessages } from './notify.js';
import { escapeHtml, telegramDisplayName } from './telegram.js';

const COOKIE = 'sw_session';
const MAX_BODY = 100_000;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = msg => new HttpError(400, msg);

// --- validation helpers ----------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const USERNAME_RE = /^[a-z0-9._-]{2,32}$/i;
const ARCHIVED = 'This group is archived. Unarchive it to make changes.';
const NO_PASSWORD = '!';                   // password_hash for Telegram-only accounts; never matches
const INVITE_TTL_MS = 7 * 86400_000;

function str(v, field, { max = 200, required = true } = {}) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw bad(`${field} is required.`);
  if (s.length > max) throw bad(`${field} is too long (max ${max} characters).`);
  return s;
}
function date(v) {
  if (v === undefined || v === null || v === '') return new Date().toISOString().slice(0, 10);
  if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) throw bad('Date must be YYYY-MM-DD.');
  return v;
}
function cents(v, field = 'Amount', unit = 1) {
  const c = money.toCents(v);
  if (!Number.isInteger(c) || c <= 0) throw bad(`${field} must be greater than zero.`);
  if (c > money.MAX_CENTS) throw bad(`${field} is too large.`);
  if (c % unit) throw bad(`${field} must be a whole number in this currency.`);
  return c;
}
function password(v) {
  if (typeof v !== 'string' || v.length < 6) throw bad('Password must be at least 6 characters.');
  if (v.length > 200) throw bad('Password is too long.');
  return v;
}
function id(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad('Invalid id.');
  return n;
}
const placeholders = n => Array(n).fill('?').join(',');

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore bad cookie */ }
    }
  }
  return out;
}

// --- domain queries ----------------------------------------------------------

async function getGroup(db, groupId) {
  const g = await db.get('SELECT * FROM groups WHERE id = ?', groupId);
  if (!g) throw new HttpError(404, 'Group not found.');
  return g;
}

// Current (not past) members of a group.
async function currentMemberIds(db, groupId) {
  const rows = await db.all('SELECT user_id FROM group_members WHERE group_id = ? AND left_at IS NULL', groupId);
  return new Set(rows.map(r => r.user_id));
}

// Members see groups they belong (or belonged) to; admins see every group.
async function canSeeGroup(db, user, groupId) {
  if (user.isAdmin) return true;
  return !!(await db.get('SELECT 1 AS x FROM group_members WHERE group_id = ? AND user_id = ?', groupId, user.id));
}
async function assertCanSee(db, user, groupId) {
  const g = await getGroup(db, groupId);
  if (!(await canSeeGroup(db, user, groupId))) throw new HttpError(404, 'Group not found.');
  return g;
}
// Changing a group or its expenses: admins, or current members.
async function assertCanManage(db, user, groupId) {
  const g = await assertCanSee(db, user, groupId);
  if (!user.isAdmin && !(await currentMemberIds(db, groupId)).has(user.id)) {
    throw new HttpError(403, "You're no longer a member of this group.");
  }
  return g;
}
async function assertWritable(db, user, groupId) {
  const g = await assertCanManage(db, user, groupId);
  if (g.archived) throw bad(ARCHIVED);
  return g;
}

async function groupHasActivity(db, groupId, userId) {
  if (userId === undefined) {
    return !!(await db.get('SELECT EXISTS(SELECT 1 FROM expenses WHERE group_id = ?) OR EXISTS(SELECT 1 FROM payments WHERE group_id = ?) AS x',
      groupId, groupId)).x;
  }
  return !!(await db.get(`SELECT
    EXISTS(SELECT 1 FROM expenses WHERE group_id = ? AND (paid_by = ? OR created_by = ?))
    OR EXISTS(SELECT 1 FROM expense_shares s JOIN expenses e ON e.id = s.expense_id WHERE e.group_id = ? AND s.user_id = ?)
    OR EXISTS(SELECT 1 FROM payments WHERE group_id = ? AND (from_user = ? OR to_user = ? OR created_by = ?)) AS x`,
  groupId, userId, userId, groupId, userId, groupId, userId, userId, userId)).x;
}

const toMember = m => ({ userId: m.user_id, past: !!m.left_at });

function groupSummary(g, memberRows) {
  return {
    id: g.id, name: g.name, currency: g.currency, description: g.description,
    archived: !!g.archived, createdBy: g.created_by, createdAt: g.created_at,
    members: memberRows.map(toMember),
  };
}

// Everything on one group's page, in four parallel queries.
async function loadGroupState(db, g) {
  const [memberRows, expenseRows, shareRows, paymentRows] = await Promise.all([
    db.all('SELECT user_id, left_at FROM group_members WHERE group_id = ?', g.id),
    db.all(`SELECT id, description, amount, paid_by, split_type, date, notes, created_by, created_at, updated_at
      FROM expenses WHERE group_id = ? ORDER BY date DESC, id DESC`, g.id),
    db.all(`SELECT s.expense_id, s.user_id, s.cents, s.value FROM expense_shares s
      JOIN expenses e ON e.id = s.expense_id WHERE e.group_id = ?`, g.id),
    db.all(`SELECT id, from_user, to_user, amount, date, notes, created_by, created_at
      FROM payments WHERE group_id = ? ORDER BY date DESC, id DESC`, g.id),
  ]);
  const sharesByExpense = new Map();
  for (const s of shareRows) {
    if (!sharesByExpense.has(s.expense_id)) sharesByExpense.set(s.expense_id, []);
    sharesByExpense.get(s.expense_id).push({ userId: s.user_id, cents: s.cents, value: s.value });
  }
  const expenses = expenseRows.map(e => ({
    id: e.id, groupId: g.id, description: e.description, amount: e.amount, paidBy: e.paid_by, splitType: e.split_type,
    date: e.date, notes: e.notes, createdBy: e.created_by, createdAt: e.created_at, updatedAt: e.updated_at,
    shares: sharesByExpense.get(e.id) || [],
  }));
  const payments = paymentRows.map(p => ({
    id: p.id, groupId: g.id, fromUser: p.from_user, toUser: p.to_user, amount: p.amount, date: p.date,
    notes: p.notes, createdBy: p.created_by, createdAt: p.created_at,
  }));
  const net = money.netBalances(expenses, payments);
  const summary = groupSummary(g, memberRows);
  const balances = Object.fromEntries(summary.members.map(m => [m.userId, net.get(m.userId) || 0]));
  for (const [uid, c] of net) balances[uid] = c; // anyone with history, even if no longer a member
  return {
    group: { ...summary, hasActivity: expenses.length + payments.length > 0 },
    expenses, payments, balances, settlements: money.simplifyDebts(net),
  };
}

// The app shell: people, and the groups this user can see with their balance in each.
async function loadState(db, user) {
  const visible = user.isAdmin ? '' : 'WHERE id IN (SELECT group_id FROM group_members WHERE user_id = ?)';
  const visibleMembers = user.isAdmin ? '' : 'WHERE group_id IN (SELECT group_id FROM group_members WHERE user_id = ?)';
  const scope = user.isAdmin ? [] : [user.id];
  const [userRows, groupRows, memberRows, balanceRows] = await Promise.all([
    db.all('SELECT id, username, name, is_admin, active FROM users ORDER BY name COLLATE NOCASE'),
    db.all(`SELECT * FROM groups ${visible} ORDER BY name COLLATE NOCASE, id`, ...scope),
    db.all(`SELECT group_id, user_id, left_at FROM group_members ${visibleMembers}`, ...scope),
    // Your net per group: what you paid − your shares + payments you sent − payments you received.
    db.all(`SELECT group_id, SUM(c) AS bal FROM (
        SELECT group_id, amount AS c FROM expenses WHERE paid_by = ?
        UNION ALL SELECT e.group_id, -s.cents FROM expense_shares s JOIN expenses e ON e.id = s.expense_id WHERE s.user_id = ?
        UNION ALL SELECT group_id, amount FROM payments WHERE from_user = ?
        UNION ALL SELECT group_id, -amount FROM payments WHERE to_user = ?
      ) GROUP BY group_id`, user.id, user.id, user.id, user.id),
  ]);
  const membersByGroup = new Map();
  for (const m of memberRows) {
    if (!membersByGroup.has(m.group_id)) membersByGroup.set(m.group_id, []);
    membersByGroup.get(m.group_id).push(m);
  }
  const balanceByGroup = new Map(balanceRows.map(r => [r.group_id, r.bal]));
  return {
    users: userRows.map(u => ({ id: u.id, username: u.username, name: u.name, isAdmin: !!u.is_admin, active: !!u.active })),
    groups: groupRows.map(g => ({ ...groupSummary(g, membersByGroup.get(g.id) || []), myBalance: balanceByGroup.get(g.id) || 0 })),
  };
}

// Validate an expense body for a group and return a normalized record + computed shares.
// People must be active, current members; `alsoAllowed` lets an edit keep people already on it.
async function parseExpense(db, g, body, alsoAllowed = []) {
  const description = str(body.description, 'Description', { max: 100 });
  const unit = money.currencyUnit(g.currency);
  const amount = cents(body.amount, 'Amount', unit);
  const paidBy = id(body.paidBy);
  const rows = await db.all(`SELECT m.user_id FROM group_members m JOIN users u ON u.id = m.user_id
    WHERE m.group_id = ? AND m.left_at IS NULL AND u.active = 1`, g.id);
  const allowed = new Set(rows.map(r => r.user_id));
  for (const u of alsoAllowed) allowed.add(u);
  if (!allowed.has(paidBy)) throw bad('The person who paid must be an active member of this group.');
  const entries = Array.isArray(body.split) ? body.split.map(s => ({ userId: id(s && s.userId), value: s && s.value })) : [];
  if (entries.some(e => !allowed.has(e.userId))) throw bad('Everyone in the split must be an active member of this group.');
  let shares;
  try { shares = money.computeShares(amount, body.splitType, entries, { unit }); }
  catch (err) { throw bad(err.message); }
  return {
    description, amount, paidBy, shares,
    splitType: body.splitType,
    date: date(body.date),
    notes: str(body.notes, 'Notes', { max: 500, required: false }),
  };
}

// Who may edit/delete an expense: admins, whoever created it, or anyone involved —
// and only while its group isn't archived. Returns the expense's group.
async function canModifyExpense(db, user, expenseId) {
  const e = await db.get('SELECT paid_by, created_by, group_id FROM expenses WHERE id = ?', expenseId);
  if (!e || !(await canSeeGroup(db, user, e.group_id))) throw new HttpError(404, 'Expense not found.');
  const g = await getGroup(db, e.group_id);
  if (g.archived) throw bad(ARCHIVED);
  if (user.isAdmin || e.paid_by === user.id || e.created_by === user.id) return g;
  const involved = await db.get('SELECT 1 AS x FROM expense_shares WHERE expense_id = ? AND user_id = ?', expenseId, user.id);
  if (!involved) throw new HttpError(403, 'Only people involved in this expense (or an admin) can change it.');
  return g;
}

// Validate group fields shared by create and update.
function parseGroupFields(body, { partial }) {
  const out = {};
  if (!partial || body.name !== undefined) out.name = str(body.name, 'Group name', { max: 60 });
  if (!partial || body.currency !== undefined) {
    const code = String(body.currency || '').toUpperCase();
    if (!money.isValidCurrency(code)) throw bad('Unknown currency code.');
    out.currency = code;
  }
  if (!partial || body.description !== undefined) out.description = str(body.description, 'Description', { max: 200, required: false });
  return out;
}

// Statements that make a group's current members exactly `wanted`. People with history
// in the group become past members instead of being removed, so balances stay intact.
async function setMembersStatements(db, groupId, wanted) {
  const rows = await db.all('SELECT user_id, left_at FROM group_members WHERE group_id = ?', groupId);
  const existing = new Map(rows.map(r => [r.user_id, r]));
  const out = [];
  for (const uid of wanted) {
    const row = existing.get(uid);
    if (!row) out.push(['INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', groupId, uid]);
    else if (row.left_at) out.push(['UPDATE group_members SET left_at = NULL WHERE group_id = ? AND user_id = ?', groupId, uid]);
  }
  for (const row of rows) {
    if (wanted.has(row.user_id) || row.left_at) continue;
    out.push(await groupHasActivity(db, groupId, row.user_id)
      ? ["UPDATE group_members SET left_at = datetime('now') WHERE group_id = ? AND user_id = ?", groupId, row.user_id]
      : ['DELETE FROM group_members WHERE group_id = ? AND user_id = ?', groupId, row.user_id]);
  }
  return out;
}

async function parseMemberIds(db, list, { mustInclude } = {}) {
  if (!Array.isArray(list)) throw bad('Members must be a list of people.');
  const ids = new Set(list.map(id));
  if (!ids.size) throw bad('A group needs at least one member.');
  if (ids.size > 90) throw bad('A group can have at most 90 members.');
  const { n } = await db.get(`SELECT COUNT(*) AS n FROM users WHERE id IN (${placeholders(ids.size)})`, ...ids);
  if (n !== ids.size) throw bad('Unknown person in the member list.');
  if (mustInclude && !ids.has(mustInclude)) throw bad('You need to be a member of groups you create.');
  return ids;
}

const shareInserts = (expenseIdSql, shares) => shares.map(s =>
  [`INSERT INTO expense_shares (expense_id, user_id, cents, value) VALUES (${expenseIdSql}, ?, ?, ?)`, s.userId, s.cents, s.value]);

// --- routes ------------------------------------------------------------------

function buildRoutes(db, telegram, loadAsset) {
  const routes = [];
  const route = (method, pattern, opts, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, ...opts });
  };
  const PUBLIC = { public: true };
  const WEBHOOK = { public: true, noCsrf: true };
  const USER = {};
  const ADMIN = { admin: true };

  // Auth
  route('POST', '/api/login', PUBLIC, async ({ body, clientIp }) => {
    const username = str(body.username, 'Username', { max: 64 }).toLowerCase();
    const pw = typeof body.password === 'string' ? body.password : '';
    const key = `${clientIp}|${username}`;
    if (await auth.loginBlocked(db, key)) throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
    const u = await db.get('SELECT id, password_hash, active FROM users WHERE username = ?', username);
    const check = u && u.active ? await auth.verifyPassword(pw, u.password_hash) : { ok: false };
    if (!check.ok) {
      await auth.recordLoginFailure(db, key);
      throw new HttpError(401, 'Wrong username or password.');
    }
    await auth.clearLoginFailures(db, key);
    if (check.rehash) await db.run('UPDATE users SET password_hash = ? WHERE id = ?', await auth.hashPassword(pw), u.id);
    const session = await auth.createSession(db, u.id);
    // Inside Telegram's in-app browser cookies can be blocked, so the app asks for the
    // session token and sends it as a header instead. Otherwise it stays cookie-only.
    return { body: body.wantToken ? { ok: true, token: session.token } : { ok: true }, cookie: session };
  });

  route('POST', '/api/logout', PUBLIC, async ({ token }) => {
    await auth.destroySession(db, token);
    return { body: { ok: true }, cookie: { token: '', maxAge: 0 } };
  });

  route('GET', '/api/me', USER, async ({ user }) => ({ body: user }));

  // Anyone can change their own display name (shown everywhere, including Telegram messages).
  // The username they log in with doesn't change.
  route('PATCH', '/api/me', USER, async ({ user, body }) => {
    const name = str(body.name, 'Display name', { max: 60 });
    await db.run('UPDATE users SET name = ? WHERE id = ?', name, user.id);
    return { body: { ...user, name } };
  });

  route('POST', '/api/me/password', USER, async ({ user, body, token }) => {
    const row = await db.get('SELECT password_hash FROM users WHERE id = ?', user.id);
    if (!(await auth.verifyPassword(String(body.current || ''), row.password_hash)).ok) throw bad('Current password is wrong.');
    const hash = await auth.hashPassword(password(body.next));
    await db.batch([
      ['UPDATE users SET password_hash = ? WHERE id = ?', hash, user.id],
      await auth.destroyUserSessionsStatement(user.id, token), // log out other devices
    ]);
    return { body: { ok: true } };
  });

  // App shell: people + your groups (with your balance in each).
  route('GET', '/api/state', USER, async ({ user }) => ({ body: await loadState(db, user) }));

  // Groups
  route('POST', '/api/groups', USER, async ({ user, body }) => {
    const f = parseGroupFields(body, { partial: false });
    const members = await parseMemberIds(db, body.memberIds, { mustInclude: user.isAdmin ? undefined : user.id });
    // One transaction; the new group's id is MAX(id) inside it.
    const [[created]] = await db.batch([
      ['INSERT INTO groups (name, currency, description, created_by) VALUES (?, ?, ?, ?) RETURNING id', f.name, f.currency, f.description, user.id],
      ...[...members].map(uid => ['INSERT INTO group_members (group_id, user_id) VALUES ((SELECT MAX(id) FROM groups), ?)', uid]),
    ]);
    return { status: 201, body: { id: created.id } };
  });

  route('GET', '/api/groups/:id/state', USER, async ({ user, params }) => {
    const g = await assertCanSee(db, user, id(params.id));
    return { body: await loadGroupState(db, g) };
  });

  route('PATCH', '/api/groups/:id', USER, async ({ user, body, params }) => {
    const groupId = id(params.id);
    await assertCanManage(db, user, groupId);
    const f = parseGroupFields(body, { partial: true });
    const statements = Object.entries(f).map(([col, v]) => [`UPDATE groups SET ${col} = ? WHERE id = ?`, v, groupId]);
    if (body.archived !== undefined) statements.push(['UPDATE groups SET archived = ? WHERE id = ?', body.archived ? 1 : 0, groupId]);
    await db.batch(statements);
    const g = await getGroup(db, groupId);
    return { body: groupSummary(g, await db.all('SELECT user_id, left_at FROM group_members WHERE group_id = ?', groupId)) };
  });

  route('PUT', '/api/groups/:id/members', USER, async ({ user, body, params }) => {
    const groupId = id(params.id);
    await assertWritable(db, user, groupId);
    const members = await parseMemberIds(db, body.memberIds);
    await db.batch(await setMembersStatements(db, groupId, members));
    const g = await getGroup(db, groupId);
    return { body: groupSummary(g, await db.all('SELECT user_id, left_at FROM group_members WHERE group_id = ?', groupId)) };
  });

  // Deleting a group also deletes its expenses and payments. Empty groups: any current
  // member. Groups with history: only admins or whoever created the group.
  route('DELETE', '/api/groups/:id', USER, async ({ user, params, notify }) => {
    const groupId = id(params.id);
    const g = await assertCanManage(db, user, groupId);
    if (await groupHasActivity(db, groupId) && !user.isAdmin && g.created_by !== user.id) {
      throw new HttpError(403, 'This group has expenses or payments. Only its creator or an admin can delete it.');
    }
    const snapshot = telegram ? await groupSnapshot(db, groupId) : null;
    await db.batch([
      ['DELETE FROM expense_shares WHERE expense_id IN (SELECT id FROM expenses WHERE group_id = ?)', groupId],
      ['DELETE FROM expenses WHERE group_id = ?', groupId],
      ['DELETE FROM payments WHERE group_id = ?', groupId],
      ['DELETE FROM group_members WHERE group_id = ?', groupId],
      ['DELETE FROM groups WHERE id = ?', groupId],
    ]);
    notify(() => groupDeletedMessages({ actor: user, group: snapshot }));
    return { body: { ok: true } };
  });

  // Expenses
  route('POST', '/api/expenses', USER, async ({ user, body, notify, appUrl }) => {
    const g = await assertWritable(db, user, id(body.groupId));
    const e = await parseExpense(db, g, body);
    const [[created]] = await db.batch([
      [`INSERT INTO expenses (group_id, description, amount, paid_by, split_type, date, notes, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, g.id, e.description, e.amount, e.paidBy, e.splitType, e.date, e.notes, user.id],
      ...shareInserts('(SELECT MAX(id) FROM expenses)', e.shares),
    ]);
    notify(async () => expenseMessages(db, { action: 'added', actor: user, before: null, after: await expenseSnapshot(db, created.id), appUrl }));
    return { status: 201, body: { id: created.id } };
  });

  route('PUT', '/api/expenses/:id', USER, async ({ user, body, params, notify, appUrl }) => {
    const expenseId = id(params.id);
    const g = await canModifyExpense(db, user, expenseId);
    const before = telegram ? await expenseSnapshot(db, expenseId) : null;
    const already = (await db.all('SELECT user_id FROM expense_shares WHERE expense_id = ? UNION SELECT paid_by FROM expenses WHERE id = ?',
      expenseId, expenseId)).map(r => r.user_id);
    const e = await parseExpense(db, g, body, already);
    await db.batch([
      [`UPDATE expenses SET description = ?, amount = ?, paid_by = ?, split_type = ?, date = ?, notes = ?,
        updated_at = datetime('now') WHERE id = ?`, e.description, e.amount, e.paidBy, e.splitType, e.date, e.notes, expenseId],
      ['DELETE FROM expense_shares WHERE expense_id = ?', expenseId],
      ...shareInserts('?', e.shares).map(([sql, ...rest]) => [sql, expenseId, ...rest]),
    ]);
    notify(async () => expenseMessages(db, { action: 'edited', actor: user, before, after: await expenseSnapshot(db, expenseId), appUrl }));
    return { body: { ok: true } };
  });

  route('DELETE', '/api/expenses/:id', USER, async ({ user, params, notify, appUrl }) => {
    const expenseId = id(params.id);
    await canModifyExpense(db, user, expenseId);
    const before = telegram ? await expenseSnapshot(db, expenseId) : null;
    await db.batch([
      ['DELETE FROM expense_shares WHERE expense_id = ?', expenseId],
      ['DELETE FROM expenses WHERE id = ?', expenseId],
    ]);
    notify(() => expenseMessages(db, { action: 'deleted', actor: user, before, after: null, appUrl }));
    return { body: { ok: true } };
  });

  // Payments ("settle up"), always within one group.
  route('POST', '/api/payments', USER, async ({ user, body, notify, appUrl }) => {
    const g = await assertWritable(db, user, id(body.groupId));
    const fromUser = id(body.fromUser);
    const toUser = id(body.toUser);
    if (fromUser === toUser) throw bad('Pick two different people.');
    const involved = new Set((await db.all('SELECT user_id FROM group_members WHERE group_id = ?', g.id)).map(r => r.user_id));
    if (!involved.has(fromUser) || !involved.has(toUser)) throw bad('Both people must be in this group.');
    if (!user.isAdmin && user.id !== fromUser && user.id !== toUser) {
      throw new HttpError(403, 'You can only record payments you sent or received.');
    }
    const created = await db.get('INSERT INTO payments (group_id, from_user, to_user, amount, date, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
      g.id, fromUser, toUser, cents(body.amount, 'Amount', money.currencyUnit(g.currency)), date(body.date),
      str(body.notes, 'Notes', { max: 500, required: false }), user.id);
    notify(async () => paymentMessages(db, { action: 'added', actor: user, payment: await paymentSnapshot(db, created.id), appUrl }));
    return { status: 201, body: { id: created.id } };
  });

  route('DELETE', '/api/payments/:id', USER, async ({ user, params, notify, appUrl }) => {
    const paymentId = id(params.id);
    const p = await db.get('SELECT from_user, to_user, created_by, group_id FROM payments WHERE id = ?', paymentId);
    if (!p || !(await canSeeGroup(db, user, p.group_id))) throw new HttpError(404, 'Payment not found.');
    if ((await getGroup(db, p.group_id)).archived) throw bad(ARCHIVED);
    if (!user.isAdmin && ![p.from_user, p.to_user, p.created_by].includes(user.id)) {
      throw new HttpError(403, 'Only the people in this payment (or an admin) can delete it.');
    }
    const payment = telegram ? await paymentSnapshot(db, paymentId) : null;
    await db.run('DELETE FROM payments WHERE id = ?', paymentId);
    notify(() => paymentMessages(db, { action: 'deleted', actor: user, payment, appUrl }));
    return { body: { ok: true } };
  });

  // Admin: user management
  route('GET', '/api/admin/users', ADMIN, async () => {
    const rows = await db.all(`
      SELECT u.id, u.username, u.name, u.is_admin, u.active, u.created_at, u.password_hash != '${NO_PASSWORD}' AS has_password,
        EXISTS(SELECT 1 FROM telegram_links t WHERE t.user_id = u.id) AS has_telegram,
        (SELECT COUNT(*) FROM expenses e WHERE e.paid_by = u.id OR e.created_by = u.id)
        + (SELECT COUNT(*) FROM expense_shares s WHERE s.user_id = u.id)
        + (SELECT COUNT(*) FROM payments p WHERE p.from_user = u.id OR p.to_user = u.id OR p.created_by = u.id) AS refs
      FROM users u ORDER BY u.active DESC, u.name COLLATE NOCASE`);
    return {
      body: rows.map(u => ({
        id: u.id, username: u.username, name: u.name, isAdmin: !!u.is_admin, active: !!u.active,
        createdAt: u.created_at, hasActivity: u.refs > 0, hasPassword: !!u.has_password, hasTelegram: !!u.has_telegram,
      })),
    };
  });

  route('POST', '/api/admin/users', ADMIN, async ({ body }) => {
    const username = str(body.username, 'Username', { max: 32 }).toLowerCase();
    if (!USERNAME_RE.test(username)) throw bad('Username can only use letters, numbers, dots, dashes and underscores (2–32 characters).');
    if (await db.get('SELECT 1 AS x FROM users WHERE username = ?', username)) throw bad('That username is taken.');
    const name = str(body.name, 'Name', { max: 60 });
    // No password = Telegram only: nobody can log in with a password until an admin sets one.
    const hash = body.password ? await auth.hashPassword(password(body.password)) : NO_PASSWORD;
    const created = await db.get('INSERT INTO users (username, name, password_hash, is_admin) VALUES (?, ?, ?, ?) RETURNING id',
      username, name, hash, body.isAdmin ? 1 : 0);
    return { status: 201, body: { id: created.id } };
  });

  // A personal link that connects someone's Telegram to their account when they tap Start —
  // no website or password needed. Valid 7 days, single use; making a new one cancels the old.
  route('POST', '/api/admin/users/:id/telegram-invite', ADMIN, async ({ params }) => {
    const tg = needTelegram();
    const u = await db.get('SELECT id, name, active FROM users WHERE id = ?', id(params.id));
    if (!u) throw new HttpError(404, 'User not found.');
    if (!u.active) throw bad('Reactivate this person first.');
    const [bot, code] = await Promise.all([tg.username(), tg.createLinkCode(u.id, INVITE_TTL_MS, 'invite')]);
    return { body: { url: `https://t.me/${bot}?start=${code}`, expiresAt: Date.now() + INVITE_TTL_MS, name: u.name } };
  });

  route('PATCH', '/api/admin/users/:id', ADMIN, async ({ user, body, params }) => {
    const target = id(params.id);
    if (!(await db.get('SELECT id FROM users WHERE id = ?', target))) throw new HttpError(404, 'User not found.');
    const isSelf = target === user.id;
    if (isSelf && (body.isAdmin === false || body.active === false)) {
      throw bad("You can't remove your own admin access or deactivate yourself.");
    }
    const statements = [];
    if (body.name !== undefined) statements.push(['UPDATE users SET name = ? WHERE id = ?', str(body.name, 'Name', { max: 60 }), target]);
    if (body.isAdmin !== undefined) statements.push(['UPDATE users SET is_admin = ? WHERE id = ?', body.isAdmin ? 1 : 0, target]);
    if (body.active !== undefined) {
      statements.push(['UPDATE users SET active = ? WHERE id = ?', body.active ? 1 : 0, target]);
      if (!body.active) statements.push(await auth.destroyUserSessionsStatement(target));
    }
    if (body.password !== undefined) {
      statements.push(['UPDATE users SET password_hash = ? WHERE id = ?', await auth.hashPassword(password(body.password)), target]);
      if (!isSelf) statements.push(await auth.destroyUserSessionsStatement(target));
    }
    await db.batch(statements);
    return { body: { ok: true } };
  });

  route('DELETE', '/api/admin/users/:id', ADMIN, async ({ user, params }) => {
    const target = id(params.id);
    if (target === user.id) throw bad("You can't delete yourself.");
    const { used } = await db.get(`SELECT
      EXISTS(SELECT 1 FROM expenses WHERE paid_by = ? OR created_by = ?)
      OR EXISTS(SELECT 1 FROM expense_shares WHERE user_id = ?)
      OR EXISTS(SELECT 1 FROM payments WHERE from_user = ? OR to_user = ? OR created_by = ?) AS used`, ...Array(6).fill(target));
    if (used) throw bad('This person appears in expenses or payments, so they can only be deactivated (their history stays intact).');
    const [, , , , deleted] = await db.batch([
      ['DELETE FROM sessions WHERE user_id = ?', target],
      ['DELETE FROM group_members WHERE user_id = ?', target],
      ['DELETE FROM telegram_links WHERE user_id = ?', target],
      ['DELETE FROM telegram_codes WHERE user_id = ?', target],
      ['DELETE FROM users WHERE id = ? RETURNING id', target],
    ]);
    if (!deleted.length) throw new HttpError(404, 'User not found.');
    return { body: { ok: true } };
  });

  // Telegram notifications
  const needTelegram = () => {
    if (!telegram) throw new HttpError(503, 'Telegram notifications aren\'t set up on this server.');
    return telegram;
  };

  route('GET', '/api/me/telegram', USER, async ({ user }) => {
    if (!telegram) return { body: { available: false } };
    const link = await db.get('SELECT tg_name, linked_at FROM telegram_links WHERE user_id = ?', user.id);
    return { body: { available: true, connected: !!link, tgName: link?.tg_name || '', linkedAt: link?.linked_at || null } };
  });

  route('POST', '/api/me/telegram/link', USER, async ({ user }) => {
    const tg = needTelegram();
    const [bot, code] = await Promise.all([tg.username(), tg.createLinkCode(user.id)]);
    return { body: { url: `https://t.me/${bot}?start=${code}` } };
  });

  route('DELETE', '/api/me/telegram', USER, async ({ user }) => {
    await db.batch([
      ['DELETE FROM telegram_links WHERE user_id = ?', user.id],
      ['DELETE FROM telegram_codes WHERE user_id = ?', user.id],
    ]);
    return { body: { ok: true } };
  });

  route('POST', '/api/me/telegram/test', USER, async ({ user }) => {
    const tg = needTelegram();
    const link = await db.get('SELECT chat_id FROM telegram_links WHERE user_id = ?', user.id);
    if (!link) throw bad('Connect Telegram first.');
    const r = await tg.send(link.chat_id, `👋 Test message for <b>${escapeHtml(user.name)}</b> — notifications are working.`);
    if (!r.ok) throw bad(`Telegram couldn't deliver it (${r.description || r.status}). Try disconnecting and connecting again.`);
    return { body: { ok: true } };
  });

  // Telegram calls this for every message sent to the bot. It proves itself with the
  // secret header set up by setWebhook; we always answer 200 so Telegram doesn't retry.
  route('POST', '/api/telegram/webhook', WEBHOOK, async ({ body, request, appUrl }) => {
    const tg = needTelegram();
    if (!(await tg.verifySecret(request.headers.get('x-telegram-bot-api-secret-token')))) {
      throw new HttpError(401, 'Bad webhook secret.');
    }
    try { await tg.handleUpdate(body, appUrl); } catch (err) { console.error('telegram update failed', err); }
    return { body: { ok: true } };
  });

  // Mini App (the site opened from the bot's "Open Splitwise" button). Telegram signs who
  // opened it; a linked account is logged straight in.
  route('POST', '/api/telegram/webapp-login', PUBLIC, async ({ body }) => {
    const tg = needTelegram();
    const tgUser = await tg.verifyInitData(body.initData);
    if (!tgUser) throw new HttpError(401, 'Telegram sign-in could not be verified. Close and reopen the app.');
    const u = await db.get(`SELECT u.id FROM telegram_links l JOIN users u ON u.id = l.user_id
      WHERE l.chat_id = ? AND u.active = 1`, String(tgUser.id));
    if (!u) return { body: { linked: false } };
    const session = await auth.createSession(db, u.id);
    return { body: { linked: true, token: session.token }, cookie: session };
  });

  // Logged in with a password inside the Mini App: connect this Telegram account for
  // notifications and future automatic sign-in.
  route('POST', '/api/me/telegram/webapp-link', USER, async ({ user, body }) => {
    const tg = needTelegram();
    const tgUser = await tg.verifyInitData(body.initData);
    if (!tgUser) throw new HttpError(401, 'Telegram sign-in could not be verified.');
    const chatId = String(tgUser.id); // a private chat's id is the user's id
    await db.batch([
      ['DELETE FROM telegram_links WHERE chat_id = ? OR user_id = ?', chatId, user.id],
      ['INSERT INTO telegram_links (user_id, chat_id, tg_name) VALUES (?, ?, ?)', user.id, chatId, telegramDisplayName(tgUser)],
    ]);
    return { body: { ok: true, tgName: telegramDisplayName(tgUser) } };
  });

  // Sets the bot's profile picture to the app icon (public/telegram-bot-photo.jpg).
  route('POST', '/api/admin/telegram/photo', ADMIN, async () => {
    const tg = needTelegram();
    if (!loadAsset) throw new HttpError(503, 'This server can\'t read its own files.');
    await tg.setProfilePhoto(await loadAsset('/telegram-bot-photo.jpg'));
    return { body: { ok: true } };
  });

  route('GET', '/api/admin/telegram', ADMIN, async ({ appUrl }) => {
    if (!telegram) return { body: { configured: false } };
    const expectedUrl = `${appUrl}/api/telegram/webhook`;
    let bot = null;
    let tokenError = null;
    try { bot = await telegram.username(); } catch (err) { tokenError = err.message; }
    const [info, menu] = bot ? await Promise.all([telegram.webhookInfo(), telegram.menuButton()]) : [null, null];
    const { n } = await db.get('SELECT COUNT(*) AS n FROM telegram_links');
    return {
      body: {
        configured: true, bot, tokenError, connectedPeople: n,
        webhookOk: info?.url === expectedUrl, webhookUrl: info?.url || '', expectedUrl,
        menuButtonOk: menu?.type === 'web_app' && String(menu.web_app?.url || '').replace(/\/+$/, '') === appUrl,
        menuButton: menu?.type === 'web_app' ? menu.web_app.url : (menu?.type || ''),
        lastError: info?.last_error_message || '', pending: info?.pending_update_count || 0,
      },
    };
  });

  route('POST', '/api/admin/telegram/webhook', ADMIN, async ({ appUrl }) => {
    const tg = needTelegram();
    await tg.username(); // fails clearly if the token is wrong
    await tg.setWebhook(`${appUrl}/api/telegram/webhook`);
    await tg.setMenuButton(appUrl);
    return { body: { ok: true } };
  });

  return routes;
}

// --- app ---------------------------------------------------------------------

// Returns `handle(request, { clientIp })` → Response for /api/* paths, or null for anything else.
// `telegram` (from lib/telegram.js) is optional; without it no notifications are sent.
// `loadAsset(path)` returns the bytes of a file in public/ (used for the bot's picture).
export function createApp(db, { secureCookies = false, telegram = null, loadAsset = null } = {}) {
  const routes = buildRoutes(db, telegram, loadAsset);

  const cookieHeader = ({ token, maxAge }) =>
    `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
  const json = (status, body, headers = {}) => new Response(body === undefined ? '' : JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });

  // waitUntil keeps background work (notifications) alive after the response is sent.
  return async function handle(request, { clientIp = 'unknown', waitUntil = p => { p.catch(() => {}); } } = {}) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return null;

    try {
      const match = routes.find(r => r.method === request.method && r.re.test(url.pathname));
      if (!match) throw new HttpError(404, 'Not found.');

      // CSRF guard: browsers won't attach this header cross-site without a CORS preflight we never allow.
      if (request.method !== 'GET' && !match.noCsrf && request.headers.get('x-requested-with') !== 'fetch') {
        throw new HttpError(403, 'Missing request header.');
      }

      const bearer = /^Bearer (\S+)$/.exec(request.headers.get('authorization') || '');
      const token = bearer ? bearer[1] : parseCookies(request.headers.get('cookie'))[COOKIE];
      const user = await auth.sessionUser(db, token);
      if (!match.public && !user) throw new HttpError(401, 'Please log in.');
      if (match.admin && !user.isAdmin) throw new HttpError(403, 'Admins only.');

      const values = url.pathname.match(match.re).slice(1);
      const params = Object.fromEntries(match.keys.map((k, i) => [k, values[i]]));
      let body = {};
      if (request.method !== 'GET') {
        const text = await request.text();
        if (text.length > MAX_BODY) throw new HttpError(413, 'Request too large.');
        if (text) {
          try { body = JSON.parse(text); } catch { throw bad('Invalid JSON.'); }
        }
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) throw bad('Expected a JSON object.');

      const appUrl = url.origin;
      // Build and send messages after responding; failures are logged, never shown to the user.
      const notify = build => {
        if (!telegram) return;
        waitUntil(Promise.resolve().then(build).then(messages => telegram.sendToUsers(messages))
          .catch(err => console.error('notification failed', err)));
      };
      const result = await match.handler({ user, body, params, token, clientIp, request, appUrl, notify });
      return json(result.status || 200, result.body, result.cookie ? { 'Set-Cookie': cookieHeader(result.cookie) } : {});
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message });
      console.error(err);
      return json(500, { error: 'Something went wrong on the server.' });
    }
  };
}

// Make sure there's always an admin to log in with. Returns the credentials if one was
// created or reset, else null.
export async function ensureAdmin(db, { username = 'admin', password: pw } = {}) {
  const { n } = await db.get('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND active = 1');
  if (n > 0) return null;
  const generated = pw || btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(9)))).replace(/[+/=]/g, '');
  const hash = await auth.hashPassword(generated);
  const existing = await db.get('SELECT id FROM users WHERE username = ?', username);
  if (existing) await db.run('UPDATE users SET is_admin = 1, active = 1, password_hash = ? WHERE id = ?', hash, existing.id);
  else await db.run('INSERT INTO users (username, name, password_hash, is_admin) VALUES (?, ?, ?, 1)', username, 'Admin', hash);
  return { username, password: generated };
}
