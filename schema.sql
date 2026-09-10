-- D1 schema. Apply with:
--   npx wrangler d1 execute step-race --file=./schema.sql --local    (dev)
--   npx wrangler d1 execute step-race --file=./schema.sql --remote   (production)
--
-- D1 *is* SQLite, so this is the same schema the Node version used, minus the
-- PRAGMAs (D1 manages journalling itself and enforces foreign keys already).
--
-- The data model is deliberately tiny. There is ONE main record type:
--
--   step_entries -- one row per person per day: who, which date, how many steps
--
-- Everything the UI shows (weekly totals, the leaderboard, positions on the
-- race track, group goal progress) is derived from that table by summing over a
-- date range. A stored "weekly total" would just be a cache that can go stale.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  avatar        TEXT NOT NULL DEFAULT '🙂',
  password_hash TEXT NOT NULL,
  weekly_goal   INTEGER NOT NULL DEFAULT 70000,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- THE main record. One row per person per day.
CREATE TABLE IF NOT EXISTS step_entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  steps      INTEGER NOT NULL CHECK (steps >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_entries_date ON step_entries(date);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- Lets every session belonging to one person be revoked in a single statement,
-- which is what you want the moment an account is suspected compromised.
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Failed login and signup attempts, counted per source IP and per target email.
-- This is what stops someone grinding passwords or guessing the invite code;
-- see worker/throttle.js. Rows are transient and purged after a day.
CREATE TABLE IF NOT EXISTS auth_throttle (
  key          TEXT PRIMARY KEY,   -- 'ip:1.2.3.4' or 'subject:someone@example.com'
  fails        INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL DEFAULT (datetime('now')),
  locked_until TEXT
);

CREATE INDEX IF NOT EXISTS idx_throttle_window ON auth_throttle(window_start);

-- The one social action: a clap for someone, at most one per person per week.
CREATE TABLE IF NOT EXISTS cheers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (from_user, to_user, week_start),
  CHECK (from_user <> to_user)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Group config. INSERT OR IGNORE so re-running this file is harmless.
INSERT OR IGNORE INTO meta (key, value) VALUES
  ('group_name',         'The Ten'),
  ('journey_name',       'Kuala Lumpur'),
  ('journey_goal_steps', '750000');
