// Authentication: password hashing, session cookies, route guards.
//
// Deliberately dependency-free -- scrypt and randomBytes come from node:crypto,
// so there is no bcrypt to compile and no auth service to sign up for.
//
// Sessions are opaque random tokens stored in the sessions table and handed to
// the browser in an httpOnly cookie. The cookie holds no user data, so nothing
// is forgeable: a token either exists in the table and is unexpired, or it is
// worthless. Signing it as well would add nothing.

import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import {
  createSession,
  deleteSession,
  findUserById,
  findValidSession,
} from './db.js';

const scrypt = promisify(scryptCallback);

const KEY_LENGTH = 64;
const SESSION_DAYS = 30;
export const SESSION_COOKIE = 'sid';

// ------------------------------------------------------------------ passwords

/** Hash a password as 'salt:derivedKey', both hex. */
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return `${salt}:${derived.toString('hex')}`;
}

/** Constant-time check of a password against a stored 'salt:key' hash. */
export async function verifyPassword(password, stored) {
  const [salt, keyHex] = String(stored).split(':');
  if (!salt || !keyHex) return false;

  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, salt, expected.length);

  // timingSafeEqual throws on length mismatch, so check that first.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ------------------------------------------------------------------- sessions

/** Create a session for a user and set the cookie on the response. */
export function startSession(res, userId) {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);

  // SQLite compares datetimes as strings, so store the same shape it produces.
  createSession(token, userId, expires.toISOString().replace('T', ' ').slice(0, 19));

  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    expires,
    path: '/',
  });
  return token;
}

export function endSession(req, res) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) deleteSession(token);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

// --------------------------------------------------------------- route guards

/**
 * Attaches req.user when a valid session cookie is present, and never fails.
 * Use this where a page or endpoint behaves differently for members and
 * strangers but is not restricted outright.
 */
export function attachUser(req, _res, next) {
  req.user = null;
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    const session = findValidSession(token);
    if (session) req.user = findUserById(session.user_id);
  }
  next();
}

/**
 * THE PERMISSION RULE, half one: you must be a member of the group to read any
 * of its data. Every /api route except signup and login sits behind this.
 */
export function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Please sign in.' });
  }
  next();
}

// The other half of the rule -- "you may only write your own steps" -- is not a
// middleware, because there is nothing to check: the write routes take the user
// id from req.user and ignore any id in the request body, so writing to someone
// else's row is not expressible. See PUT /api/entries in index.js.
