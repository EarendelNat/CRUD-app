# Step Race — a weekly step competition for ten people

Everyone logs their daily steps. The week's totals put ten little runners on a
shared athletics track that you scroll sideways to follow, with a leaderboard,
your own pace target, and one group goal that everybody's steps feed into.

The week resets every Monday, so there are fifty-two chances to win a year
rather than one.

## Running it

Needs Node 22.5 or newer (it uses the built-in `node:sqlite`, so there is
nothing to compile and no database server to install).

```bash
npm install
npm run seed     # optional: ten demo members with two weeks of steps
npm start        # http://localhost:3000
```

Demo accounts are `aisyah@example.com` … `jonas@example.com`, all with the
password `password123`. `npm run reset` wipes and re-seeds.

For your real group: skip the seed, start the server, and have everyone visit
the URL and pick **Join the group**. They'll need the invite code — printed in
the console at startup, `STEP2026` unless you change it.

## Configuration

Copy `.env.example` to `.env`. Everything has a working default.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `INVITE_CODE` | `STEP2026` | Code required to join the group |
| `MAX_MEMBERS` | `10` | Hard cap on group size |
| `APP_TZ` | `Asia/Singapore` | Decides "what day is it" and when the week rolls over |
| `DB_PATH` | `./data/app.db` | Where the SQLite file lives |

`APP_TZ` matters more than it looks. Without it a server in UTC would roll the
week over at 8am Monday for a group in Singapore.

## Deploying

`render.yaml` is a ready Render blueprint: **New → Blueprint** in the Render
dashboard, point it at this repo, and enter an `INVITE_CODE` when prompted.

The one thing to get right anywhere you deploy:

> **Mount a persistent volume at `/app/data`.** Without one the SQLite file sits
> in the container's own filesystem, and every restart or redeploy wipes the
> group's entire step history.

On Render that means a **paid instance type** — persistent disks aren't available
on the free tier, whose filesystem is ephemeral. Roughly $7/month at the time of
writing. If you'd rather stay free, the alternative is to move storage to a
hosted Postgres free tier (Neon, Supabase) and port `server/db.js` off SQLite;
the queries are plain SQL, so it is a contained change, but it is a change.

The `Dockerfile` also works as-is on Railway, Fly.io, or any Docker host. Vercel
and other pure-serverless hosts will not work — no persistent disk.

GitHub Pages will not work either, and can't be made to: it serves static files
only, so there is no Node process to run the API and no database to log into.

### A note on the invite code

`STEP2026` is a convenience default for local development and is visible in this
public repo. Set a different `INVITE_CODE` on your deployment — it is the only
thing standing between a stranger and one of your ten places.

## How it is built

- **Backend** — Node + Express 5, no ORM
- **Database** — SQLite via built-in `node:sqlite`
- **Auth** — scrypt password hashing (`node:crypto`), opaque session tokens in an
  httpOnly cookie
- **Frontend** — plain HTML, CSS and ES modules. No build step, no framework,
  no bundler. Edit a file, reload the page.

Three runtime dependencies would be normal here. There is one: Express.

### The data model

One record type does the real work:

```
step_entries (user_id, date, steps)   UNIQUE(user_id, date)
```

One row per person per day. Every number the app displays — weekly totals,
ranks, positions on the track, pace, group progress — is derived by summing that
table over a date range. Nothing is stored pre-summed, so nothing can go stale.
Ten people over seven days is at most seventy rows to add up.

The `UNIQUE(user_id, date)` constraint is what makes logging idempotent: entering
Tuesday twice edits Tuesday rather than adding a second Tuesday.

Supporting tables are plumbing, not features: `users`, `sessions`, `cheers`
(the 👏 button), and `meta` (the group's name and goal).

### The permission rule

> Any member can read everyone's steps. You can only write your own.

The read half is one middleware (`requireAuth`) on every `/api` route. The write
half isn't a check at all — `PUT /api/entries` takes the user id from the session
and ignores any id in the request body, so "write to someone else's day" is not
expressible, crafted request or not.

Everything else is deliberately equal: any member can change the group's shared
goal, because a group of ten does not need an admin.

## The features, and why they exist

The leaderboard is the fun part, but it isn't where an app like this succeeds or
fails. Two things kill it: people forget to log, and whoever is losing by
Wednesday stops opening it. Most of these features target one of those.

**Against forgetting to log**

- **Backfill grid** — the whole week as seven boxes. Forgot Tuesday? Type it in.
  Past weeks stay editable, because people genuinely don't catch up until Monday.
- **Ghost runners** — someone who hasn't logged today is greyed and dashed, but
  still standing at their real total, never dropped to zero. The board never
  looks emptier than the group actually is, and a row of ghosts is a gentle nudge.
- **"8/10 logged today"** — one number, visible, mildly shaming.

**Against losing being boring**

- **Personal pace line** — an orange dashed line on the track at where *you*
  should be by today to hit *your* goal. Tenth place still has a race to run.
- **Everyone sets their own weekly goal** — 50k and 90k are both real targets.
- **Head-to-head chips** — "1,482 behind Hakim", "10,842 ahead of Grace". The
  person one place above you is a better motivator than the leader.
- **Group goal** — "walking to Kuala Lumpur, 46%". Everyone's steps count towards
  it wherever they are on the leaderboard.
- **Weekly reset** — Monday is a clean slate; finished weeks stay in the archive.

**Making the race legible**

- **Absolute scale** — a fixed number of pixels per thousand steps, so the gaps
  you see are the real gaps. The leader really is off-screen. A compressed scale
  would keep everyone visible but would quietly lie about the distances.
- **Fixed name gutter** — a runner scrolled out of view still has a visible lane.
- **Minimap** — the whole track as one strip; click or drag it to jump. Plus a
  **Jump to me** button and arrow-key scrolling.
- **Milestone flags** every 10k, and a checkered flag at your weekly goal, so
  scrolling has landmarks instead of blank road.
- **Avatars** — 22 to pick from. Being a specific character is what makes the
  track worth scrolling.

**The one social action**

- **👏 Cheer** — one per person per week, undoable. Not a comment thread: you
  already have a group chat, and comments would mean moderation.

## Deliberately left out

- **Health app / Google Fit import** — the real answer to logging friction, and
  an OAuth rabbit hole that would eat the whole project. Manual entry plus
  backfill is the right trade for ten people who know each other.
- **Anti-cheat validation** — social trust beats a step cap in a group of ten.
  The server only rejects a day over 200,000 steps, which is a typo, not a lie.
- **Comments, photos, public profiles** — each one adds a record type, and two of
  them add moderation.

## API

Everything except `/api/config`, signup and login requires a session.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/config` | Group name, size, avatar list (public; never the invite code) |
| `POST` | `/api/auth/signup` | Join, with invite code |
| `POST` | `/api/auth/login` / `logout` | Session in, session out |
| `GET` / `PATCH` | `/api/me` | Your profile, avatar and weekly goal |
| `GET` | `/api/week?week=YYYY-MM-DD` | **The one read.** Everything the UI renders, for that week |
| `PUT` | `/api/entries` | Log or correct one of *your* days |
| `DELETE` | `/api/entries/:date` | Clear one of your days |
| `POST` / `DELETE` | `/api/cheers` | Cheer, un-cheer |
| `PATCH` | `/api/group` | Change the shared goal |

`GET /api/week` accepts any date inside a week and resolves it to that Monday.

## Layout

```
server/
  index.js     Express app, routes, validation
  db.js        Schema and every query
  auth.js      scrypt hashing, sessions, route guards
  week.js      Timezone-aware week maths
  weekview.js  Builds the payload GET /api/week returns
public/
  login.html   Sign in / join
  index.html   The app
  js/          api.js, track.js, app.js
  css/
scripts/
  seed.js      Ten demo members, two weeks of steps
```
