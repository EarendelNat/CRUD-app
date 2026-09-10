// Database: schema, and every query the app makes.
//
// Uses node:sqlite, built into Node 22.5+, so there is nothing to compile and
// no database server to run. The whole app is one file on disk.
//
// The data model is deliberately tiny. There is ONE main record type:
//
//   step_entries -- one row per person per day: who, which date, how many steps
//
// Everything the UI shows (weekly totals, the leaderboard, positions on the
// race track, the group goal progress) is derived from that table by summing
// over a date range. Adding a "weekly total" column would just be a cache that
// can go stale, so we don't.
//
// The supporting tables are plumbing, not features: users and sessions exist
// for login, cheers exists for the one social action, meta holds group config.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DB_PATH = resolve(process.env.DB_PATH || './data/app.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

// WAL lets the app keep reading while a write is in flight. Barely matters at
// ten users, but it is the right default and costs nothing.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
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
`);

// ---------------------------------------------------------------- group config

const DEFAULT_META = {
  group_name: 'The Ten',
  journey_name: 'Kuala Lumpur',
  // Steps for the whole group to "walk" the journey together in one week.
  // Ten people at 70k each is 700k, so this is a stretch but reachable.
  journey_goal_steps: '750000',
};

for (const [key, value] of Object.entries(DEFAULT_META)) {
  db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run(key, value);
}

export function getMeta() {
  const rows = db.prepare('SELECT key, value FROM meta').all();
  const out = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

export function setMeta(key, value) {
  db.prepare(
    'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

// ---------------------------------------------------------------------- users

const PUBLIC_USER_COLS = 'id, email, name, avatar, weekly_goal, created_at';

export function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

export function findUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
}

export function findUserById(id) {
  return db.prepare(`SELECT ${PUBLIC_USER_COLS} FROM users WHERE id = ?`).get(id);
}

export function listUsers() {
  return db.prepare(`SELECT ${PUBLIC_USER_COLS} FROM users ORDER BY id`).all();
}

export function createUser({ email, name, avatar, passwordHash, weeklyGoal = 70000 }) {
  const info = db
    .prepare(
      'INSERT INTO users(email, name, avatar, password_hash, weekly_goal) VALUES (?, ?, ?, ?, ?)'
    )
    .run(email.toLowerCase().trim(), name.trim(), avatar, passwordHash, weeklyGoal);
  return findUserById(Number(info.lastInsertRowid));
}

export function updateUserProfile(id, { name, avatar, weeklyGoal }) {
  // Only overwrite the fields actually supplied; COALESCE leaves the rest alone.
  db.prepare(
    `UPDATE users
        SET name        = COALESCE(?, name),
            avatar      = COALESCE(?, avatar),
            weekly_goal = COALESCE(?, weekly_goal)
      WHERE id = ?`
  ).run(name ?? null, avatar ?? null, weeklyGoal ?? null, id);
  return findUserById(id);
}

// -------------------------------------------------------------------- sessions

export function createSession(token, userId, expiresAt) {
  db.prepare('INSERT INTO sessions(token, user_id, expires_at) VALUES (?, ?, ?)').run(
    token,
    userId,
    expiresAt
  );
}

export function findValidSession(token) {
  return db
    .prepare("SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')")
    .get(token);
}

export function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function purgeExpiredSessions() {
  return db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run().changes;
}

// ---------------------------------------------------------------- step entries

/** Every entry in a date range, for all members. Drives the whole week view. */
export function entriesInRange(startISO, endISO) {
  return db
    .prepare(
      'SELECT user_id, date, steps FROM step_entries WHERE date BETWEEN ? AND ? ORDER BY date'
    )
    .all(startISO, endISO);
}

/**
 * Record one person's steps for one day.
 * The caller always passes the *session* user id, never a client-supplied one --
 * that is what enforces "you may only edit your own steps".
 */
export function upsertEntry(userId, dateISO, steps) {
  db.prepare(
    `INSERT INTO step_entries(user_id, date, steps) VALUES (?, ?, ?)
       ON CONFLICT(user_id, date)
       DO UPDATE SET steps = excluded.steps, updated_at = datetime('now')`
  ).run(userId, dateISO, steps);
  return db
    .prepare('SELECT user_id, date, steps FROM step_entries WHERE user_id = ? AND date = ?')
    .get(userId, dateISO);
}

export function deleteEntry(userId, dateISO) {
  return db
    .prepare('DELETE FROM step_entries WHERE user_id = ? AND date = ?')
    .run(userId, dateISO).changes;
}

/** Week starts that have at least one entry -- the archive list. */
export function weeksWithData() {
  // date(d, 'weekday 0', '-6 days') is SQLite's way of saying "the Monday of
  // that week": jump forward to Sunday, then back six days.
  return db
    .prepare(
      `SELECT DISTINCT date(date, 'weekday 0', '-6 days') AS week_start
         FROM step_entries
        ORDER BY week_start DESC`
    )
    .all()
    .map((row) => row.week_start);
}

// ---------------------------------------------------------------------- cheers

export function cheersForWeek(weekStartISO) {
  return db
    .prepare('SELECT from_user, to_user FROM cheers WHERE week_start = ?')
    .all(weekStartISO);
}

/** Returns false if this person already cheered that person this week. */
export function addCheer(fromUserId, toUserId, weekStartISO) {
  const info = db
    .prepare('INSERT OR IGNORE INTO cheers(from_user, to_user, week_start) VALUES (?, ?, ?)')
    .run(fromUserId, toUserId, weekStartISO);
  return info.changes > 0;
}

export function removeCheer(fromUserId, toUserId, weekStartISO) {
  return db
    .prepare('DELETE FROM cheers WHERE from_user = ? AND to_user = ? AND week_start = ?')
    .run(fromUserId, toUserId, weekStartISO).changes;
}
