// HTTP server and API routes.

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  addCheer,
  countUsers,
  createUser,
  deleteEntry,
  findUserByEmail,
  getMeta,
  purgeExpiredSessions,
  removeCheer,
  setMeta,
  updateUserProfile,
  upsertEntry,
} from './db.js';
import {
  attachUser,
  endSession,
  hashPassword,
  requireAuth,
  startSession,
  verifyPassword,
} from './auth.js';
import { buildWeekView } from './weekview.js';
import {
  APP_TZ,
  currentWeekStart,
  isValidISODate,
  todayISO,
  weekStartOf,
} from './week.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const PORT = Number(process.env.PORT) || 3000;
const INVITE_CODE = process.env.INVITE_CODE || 'STEP2026';
const MAX_MEMBERS = Number(process.env.MAX_MEMBERS) || 10;

// A day's steps above this is almost certainly a typo (a very long day is
// ~50k). We reject rather than silently clamp, so the person can fix it.
const MAX_STEPS_PER_DAY = 200000;

// The avatars people may pick. Kept server-side too, so a crafted request
// can't set an arbitrary string as an avatar.
const AVATARS = [
  '🦊', '🐢', '🐇', '🐕', '🐈', '🐼', '🐨', '🦁',
  '🐯', '🦄', '🐝', '🦖', '🐙', '🦩', '🐧', '🦉',
  '🏃', '🚶', '🧗', '🤸', '💃', '🕺',
];

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

// Minimal cookie parsing -- one cookie, no signing, so a dependency would be
// more code to audit than the four lines it replaces.
app.use((req, _res, next) => {
  req.cookies = Object.create(null);
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key) req.cookies[key] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  next();
});

app.use(attachUser);

// ------------------------------------------------------------------- helpers

/** Wrap an async route so a thrown error reaches the error handler. */
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

/**
 * Resolve a ?week= query into a Monday. Any date inside the week works, so
 * '2026-09-10' and '2026-09-07' both mean the same week.
 */
function resolveWeek(query) {
  const raw = query.week;
  if (!raw) return currentWeekStart();
  if (!isValidISODate(raw)) return null;
  return weekStartOf(raw);
}

// ---------------------------------------------------------------------- auth

app.get('/api/config', (_req, res) => {
  // Told to the login page so it can explain itself. Never includes the invite
  // code -- only whether the group still has room.
  res.json({
    groupName: getMeta().group_name,
    memberCount: countUsers(),
    maxMembers: MAX_MEMBERS,
    full: countUsers() >= MAX_MEMBERS,
    avatars: AVATARS,
    timezone: APP_TZ,
  });
});

app.post(
  '/api/auth/signup',
  wrap(async (req, res) => {
    const { email, name, password, avatar, inviteCode } = req.body ?? {};

    if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      return fail(res, 400, 'Please enter a valid email address.');
    }
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 30) {
      return fail(res, 400, 'Your name needs to be between 2 and 30 characters.');
    }
    if (typeof password !== 'string' || password.length < 8) {
      return fail(res, 400, 'Your password needs to be at least 8 characters.');
    }
    if (inviteCode !== INVITE_CODE) {
      return fail(res, 403, 'That invite code is not right.');
    }
    if (avatar !== undefined && !AVATARS.includes(avatar)) {
      return fail(res, 400, 'Please pick one of the offered avatars.');
    }
    // The group has a fixed size; this is what makes it a group of ten.
    if (countUsers() >= MAX_MEMBERS) {
      return fail(res, 403, `This group is full (${MAX_MEMBERS} members).`);
    }
    if (findUserByEmail(email)) {
      return fail(res, 409, 'Someone has already signed up with that email.');
    }

    const user = createUser({
      email,
      name,
      avatar: avatar || AVATARS[countUsers() % AVATARS.length],
      passwordHash: await hashPassword(password),
    });

    startSession(res, user.id);
    res.status(201).json({ user });
  })
);

app.post(
  '/api/auth/login',
  wrap(async (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string') {
      return fail(res, 400, 'Please enter your email and password.');
    }

    const record = findUserByEmail(email);
    // Same message either way, so this can't be used to discover who is a
    // member. We still hash on a miss to keep the timing similar.
    const ok = record
      ? await verifyPassword(password, record.password_hash)
      : await verifyPassword(password, 'x:00');

    if (!record || !ok) {
      return fail(res, 401, 'That email and password do not match.');
    }

    startSession(res, record.id);
    res.json({ user: { id: record.id, email: record.email, name: record.name, avatar: record.avatar, weekly_goal: record.weekly_goal } });
  })
);

app.post('/api/auth/logout', (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.patch('/api/me', requireAuth, (req, res) => {
  const { name, avatar, weeklyGoal } = req.body ?? {};
  const patch = {};

  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 30) {
      return fail(res, 400, 'Your name needs to be between 2 and 30 characters.');
    }
    patch.name = name.trim();
  }
  if (avatar !== undefined) {
    if (!AVATARS.includes(avatar)) return fail(res, 400, 'Please pick one of the offered avatars.');
    patch.avatar = avatar;
  }
  if (weeklyGoal !== undefined) {
    const goal = Number(weeklyGoal);
    if (!Number.isInteger(goal) || goal < 7000 || goal > 700000) {
      return fail(res, 400, 'Pick a weekly goal between 7,000 and 700,000 steps.');
    }
    patch.weeklyGoal = goal;
  }

  // req.user.id, never a body field: you can only ever edit yourself.
  res.json({ user: updateUserProfile(req.user.id, patch) });
});

// ------------------------------------------------------------------ the week

app.get('/api/week', requireAuth, (req, res) => {
  const weekStart = resolveWeek(req.query);
  if (!weekStart) return fail(res, 400, 'That is not a valid date.');
  res.json(buildWeekView(weekStart, req.user.id));
});

// ----------------------------------------------------------------- my steps

/**
 * Log or correct one day of MY steps.
 *
 * This is the app's one shared action, and the write half of the permission
 * rule lives here: the row is keyed on req.user.id, so there is no way to
 * express "write to someone else's day" even with a crafted request body.
 */
app.put('/api/entries', requireAuth, (req, res) => {
  const { date, steps } = req.body ?? {};

  if (!isValidISODate(date)) {
    return fail(res, 400, 'Please give a date as YYYY-MM-DD.');
  }
  // No logging the future -- it would sit on the leaderboard unearned.
  if (date > todayISO()) {
    return fail(res, 400, 'You cannot log steps for a day that has not happened yet.');
  }

  const count = Number(steps);
  if (!Number.isInteger(count) || count < 0) {
    return fail(res, 400, 'Steps must be a whole number, zero or more.');
  }
  if (count > MAX_STEPS_PER_DAY) {
    return fail(res, 400, `${count.toLocaleString()} steps in a day looks like a typo.`);
  }

  const entry = upsertEntry(req.user.id, date, count);
  res.json({ entry });
});

app.delete('/api/entries/:date', requireAuth, (req, res) => {
  const { date } = req.params;
  if (!isValidISODate(date)) return fail(res, 400, 'Please give a date as YYYY-MM-DD.');
  const removed = deleteEntry(req.user.id, date);
  res.json({ removed });
});

// -------------------------------------------------------------------- cheers

app.post('/api/cheers', requireAuth, (req, res) => {
  const toUser = Number(req.body?.toUserId);
  const weekStart = resolveWeek(req.body ?? {});

  if (!Number.isInteger(toUser)) return fail(res, 400, 'Which member do you want to cheer?');
  if (!weekStart) return fail(res, 400, 'That is not a valid date.');
  // Checked here rather than relying on the CHECK constraint, because
  // INSERT OR IGNORE would swallow the violation and report a silent no-op.
  if (toUser === req.user.id) return fail(res, 400, 'Cheer someone else, not yourself.');

  const added = addCheer(req.user.id, toUser, weekStart);
  res.json({ added, alreadyCheered: !added });
});

app.delete('/api/cheers/:toUserId', requireAuth, (req, res) => {
  const toUser = Number(req.params.toUserId);
  const weekStart = resolveWeek(req.query);
  if (!Number.isInteger(toUser)) return fail(res, 400, 'Which member do you want to un-cheer?');
  if (!weekStart) return fail(res, 400, 'That is not a valid date.');
  res.json({ removed: removeCheer(req.user.id, toUser, weekStart) });
});

// --------------------------------------------------------------- group goal

app.patch('/api/group', requireAuth, (req, res) => {
  // Ten people who know each other don't need an admin role -- any member can
  // set the group's shared goal, the same way anyone can move a whiteboard.
  const { journeyName, journeyGoalSteps, groupName } = req.body ?? {};

  if (journeyName !== undefined) {
    if (typeof journeyName !== 'string' || !journeyName.trim() || journeyName.length > 40) {
      return fail(res, 400, 'Give the destination a name of up to 40 characters.');
    }
    setMeta('journey_name', journeyName.trim());
  }
  if (groupName !== undefined) {
    if (typeof groupName !== 'string' || !groupName.trim() || groupName.length > 40) {
      return fail(res, 400, 'Give the group a name of up to 40 characters.');
    }
    setMeta('group_name', groupName.trim());
  }
  if (journeyGoalSteps !== undefined) {
    const goal = Number(journeyGoalSteps);
    if (!Number.isInteger(goal) || goal < 10000 || goal > 20000000) {
      return fail(res, 400, 'Pick a group goal between 10,000 and 20,000,000 steps.');
    }
    setMeta('journey_goal_steps', goal);
  }

  res.json({ meta: getMeta() });
});

// ------------------------------------------------------------- static + pages

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

// Send signed-out visitors to the login page, and signed-in ones to the app.
app.get('/', (req, res) => {
  res.sendFile(join(PUBLIC_DIR, req.user ? 'index.html' : 'login.html'));
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return fail(res, 404, 'No such endpoint.');
  res.status(404).sendFile(join(PUBLIC_DIR, 'login.html'));
});

app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  if (res.headersSent) return;
  fail(res, 500, 'Something went wrong on our end.');
});

// Tidy up expired sessions on boot and daily thereafter.
purgeExpiredSessions();
setInterval(purgeExpiredSessions, 86400000).unref();

app.listen(PORT, () => {
  const members = countUsers();
  console.log(`\n  ${getMeta().group_name} step race`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  timezone ${APP_TZ}  |  week of ${currentWeekStart()}`);
  console.log(`  ${members}/${MAX_MEMBERS} members  |  invite code: ${INVITE_CODE}\n`);
});
