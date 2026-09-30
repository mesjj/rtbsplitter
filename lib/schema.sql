-- Full schema. Used as-is for Cloudflare D1, and by lib/db.js for local SQLite files.
-- Every statement is idempotent so it can be re-applied safely.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'USD',
  description TEXT NOT NULL DEFAULT '',
  archived    INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id  INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  left_at   TEXT,                         -- set = past member (kept because they have history)
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS expenses (
  id          INTEGER PRIMARY KEY,
  group_id    INTEGER REFERENCES groups(id),
  description TEXT NOT NULL,
  amount      INTEGER NOT NULL,           -- cents
  paid_by     INTEGER NOT NULL REFERENCES users(id),
  split_type  TEXT NOT NULL,              -- equal | exact | percent | shares
  date        TEXT NOT NULL,              -- YYYY-MM-DD
  notes       TEXT NOT NULL DEFAULT '',
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS expense_shares (
  expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  cents      INTEGER NOT NULL,
  value      REAL,                        -- what was typed: amount / % / shares
  PRIMARY KEY (expense_id, user_id)
);

CREATE TABLE IF NOT EXISTS payments (
  id         INTEGER PRIMARY KEY,
  group_id   INTEGER REFERENCES groups(id),
  from_user  INTEGER NOT NULL REFERENCES users(id),
  to_user    INTEGER NOT NULL REFERENCES users(id),
  amount     INTEGER NOT NULL,            -- cents
  date       TEXT NOT NULL,
  notes      TEXT NOT NULL DEFAULT '',
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Failed logins per client+username, for brute-force limiting. Stored in the database
-- (not memory) because Workers don't keep memory between requests.
CREATE TABLE IF NOT EXISTS login_failures (
  key      TEXT PRIMARY KEY,
  first_at INTEGER NOT NULL,              -- ms
  count    INTEGER NOT NULL
);

-- Telegram notifications: which chat each person gets messages in.
CREATE TABLE IF NOT EXISTS telegram_links (
  user_id   INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  chat_id   TEXT NOT NULL UNIQUE,
  tg_name   TEXT NOT NULL DEFAULT '',     -- their Telegram @username or first name, for display
  linked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One-time codes behind the "Connect Telegram" link (t.me/<bot>?start=<code>).
CREATE TABLE IF NOT EXISTS telegram_codes (
  code       TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,            -- ms
  kind       TEXT NOT NULL DEFAULT 'connect' -- 'connect' (Connect button) or 'invite' (sent by an admin)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS expenses_group ON expenses(group_id);
CREATE INDEX IF NOT EXISTS payments_group ON payments(group_id);
CREATE INDEX IF NOT EXISTS shares_user ON expense_shares(user_id);
CREATE INDEX IF NOT EXISTS members_user ON group_members(user_id);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
