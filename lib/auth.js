// Password hashing, sessions and login rate limiting. Uses Web Crypto so it runs on
// both Node and Cloudflare Workers.

import { scryptSync, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100_000; // the maximum Cloudflare Workers allows
const subtle = globalThis.crypto.subtle;

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const unhex = s => Uint8Array.from(s.match(/../g) || [], b => parseInt(b, 16));
const randomBytes = n => globalThis.crypto.getRandomValues(new Uint8Array(n));

async function pbkdf2(password, salt, iterations) {
  const key = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

function equal(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${hex(salt)}$${hex(await pbkdf2(password, salt, PBKDF2_ITERATIONS))}`;
}

// → { ok, rehash }. `rehash` means the stored hash uses an older scheme and should be replaced.
export async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts[0] === 'pbkdf2' && parts.length === 4) {
    const iterations = Number(parts[1]);
    const ok = equal(await pbkdf2(password, unhex(parts[2]), iterations), unhex(parts[3]));
    return { ok, rehash: ok && iterations < PBKDF2_ITERATIONS };
  }
  if (parts[0] === 'scrypt' && parts.length === 3) {
    // Hashes from the first version of the app.
    const expected = Buffer.from(parts[2], 'hex');
    const actual = scryptSync(password, Buffer.from(parts[1], 'hex'), expected.length);
    const ok = timingSafeEqual(actual, expected);
    return { ok, rehash: ok };
  }
  return { ok: false, rehash: false };
}

const sha256 = async s => hex(await subtle.digest('SHA-256', new TextEncoder().encode(s)));

export async function createSession(db, userId) {
  const token = btoa(String.fromCharCode(...randomBytes(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
    await sha256(token), userId, Date.now() + SESSION_DAYS * 86400_000);
  // Opportunistic cleanup keeps the table small without a scheduled job.
  await db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
  return { token, maxAge: SESSION_DAYS * 86400 };
}

export async function sessionUser(db, token) {
  if (!token) return null;
  const row = await db.get(`
    SELECT u.id, u.username, u.name, u.is_admin, u.active, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`, await sha256(token));
  if (!row) return null;
  if (row.expires_at < Date.now() || !row.active) {
    await destroySession(db, token);
    return null;
  }
  return { id: row.id, username: row.username, name: row.name, isAdmin: !!row.is_admin };
}

export async function destroySession(db, token) {
  if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', await sha256(token));
}

// Statement (for db.batch) that logs a user out everywhere, optionally keeping one session.
export async function destroyUserSessionsStatement(userId, exceptToken) {
  return ['DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', userId, exceptToken ? await sha256(exceptToken) : ''];
}

// Brute-force guard: 10 failed logins per key per 15 minutes, kept in the database.
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 10;

export async function loginBlocked(db, key) {
  const f = await db.get('SELECT first_at, count FROM login_failures WHERE key = ?', key);
  return !!f && Date.now() - f.first_at < WINDOW_MS && f.count >= MAX_FAILURES;
}
export async function recordLoginFailure(db, key) {
  const now = Date.now();
  await db.run(`INSERT INTO login_failures (key, first_at, count) VALUES (?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN ? - first_at > ? THEN 1 ELSE count + 1 END,
      first_at = CASE WHEN ? - first_at > ? THEN ? ELSE first_at END`,
  key, now, now, WINDOW_MS, now, WINDOW_MS, now);
  await db.run('DELETE FROM login_failures WHERE first_at < ?', now - WINDOW_MS);
}
export async function clearLoginFailures(db, key) {
  await db.run('DELETE FROM login_failures WHERE key = ?', key);
}
