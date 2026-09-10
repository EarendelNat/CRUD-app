// Builds the one payload the whole UI runs on.
//
// The client asks for a week and gets back everything it needs to draw the race
// track, the leaderboard, the backfill grid and the group goal. All of it is
// computed here from raw step_entries rows -- nothing is stored pre-summed.
//
// One request, one render. At ten people and seven days that is at most 70 rows
// to add up, well inside a Worker's CPU budget.

import { cheersForWeek, entriesInRange, getMeta, listUsers, weeksWithData } from './db.js';
import {
  DAY_NAMES,
  currentWeekStart,
  daysElapsed,
  todayISO,
  weekDates,
  weekLabel,
} from './week.js';

/** Milestone flags along the track, every 10k steps. */
function milestonesUpTo(maxSteps) {
  const top = Math.max(maxSteps, 30000);
  const out = [];
  for (let m = 10000; m <= top + 20000; m += 10000) out.push(m);
  return out;
}

export async function buildWeekView(db, weekStartISO, viewerId, tz) {
  const dates = weekDates(weekStartISO);
  const weekEnd = dates[6];
  const today = todayISO(tz);
  const elapsed = daysElapsed(weekStartISO, tz);
  const isCurrentWeek = weekStartISO === currentWeekStart(tz);

  // Five independent reads -- fire them together rather than in sequence, so
  // the request costs one round of D1 latency instead of five.
  const [meta, users, entries, cheers, archiveWeeks] = await Promise.all([
    getMeta(db),
    listUsers(db),
    entriesInRange(db, weekStartISO, weekEnd),
    cheersForWeek(db, weekStartISO),
    weeksWithData(db),
  ]);

  // Group entries by user so each member can be assembled in one pass.
  const byUser = new Map(users.map((u) => [u.id, []]));
  for (const entry of entries) {
    if (byUser.has(entry.user_id)) byUser.get(entry.user_id).push(entry);
  }

  const cheerCount = new Map();
  const cheeredByViewer = new Set();
  for (const c of cheers) {
    cheerCount.set(c.to_user, (cheerCount.get(c.to_user) || 0) + 1);
    if (c.from_user === viewerId) cheeredByViewer.add(c.to_user);
  }

  const members = users.map((user) => {
    const days = {};
    let total = 0;
    let lastLoggedDate = null;

    for (const entry of byUser.get(user.id)) {
      days[entry.date] = entry.steps;
      total += entry.steps;
      if (!lastLoggedDate || entry.date > lastLoggedDate) lastLoggedDate = entry.date;
    }

    // Pace: by day N of 7 you are "on pace" once you have N/7 of your goal.
    // Past weeks are judged against the whole goal, since they are finished.
    const paceTarget = Math.round((user.weekly_goal * elapsed) / 7);

    // A ghost is someone who has not logged today yet. Their position on the
    // track is still their real total -- we grey them out rather than dropping
    // them to zero, so the board never looks emptier than the group really is.
    const hasLoggedToday = isCurrentWeek ? days[today] !== undefined : true;

    return {
      id: user.id,
      name: user.name,
      avatar: user.avatar,
      weeklyGoal: user.weekly_goal,
      isMe: user.id === viewerId,
      days,
      total,
      loggedDays: Object.keys(days).length,
      lastLoggedDate,
      lastLoggedDay: lastLoggedDate ? DAY_NAMES[dates.indexOf(lastLoggedDate)] : null,
      hasLoggedToday,
      isGhost: !hasLoggedToday,
      paceTarget,
      paceDelta: total - paceTarget,
      goalPercent: user.weekly_goal > 0 ? Math.round((total / user.weekly_goal) * 100) : 0,
      cheersReceived: cheerCount.get(user.id) || 0,
      cheeredByMe: cheeredByViewer.has(user.id),
    };
  });

  // Rank by total, most steps first. Equal totals share a rank.
  const ranked = [...members].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  ranked.forEach((member, index) => {
    member.rank =
      index > 0 && member.total === ranked[index - 1].total ? ranked[index - 1].rank : index + 1;
  });

  // Head-to-head: who is directly ahead of and behind the viewer.
  // We report the current gap rather than "you just passed X", because that
  // would need a history of past positions and we only store daily totals.
  const myIndex = ranked.findIndex((m) => m.id === viewerId);
  const rivals = { ahead: null, behind: null };
  if (myIndex !== -1) {
    const me = ranked[myIndex];
    const ahead = ranked.slice(0, myIndex).reverse().find((m) => m.total > me.total);
    const behind = ranked.slice(myIndex + 1).find((m) => m.total < me.total);
    if (ahead) {
      rivals.ahead = { name: ahead.name, avatar: ahead.avatar, gap: ahead.total - me.total };
    }
    if (behind) {
      rivals.behind = { name: behind.name, avatar: behind.avatar, gap: me.total - behind.total };
    }
  }

  const groupTotal = members.reduce((sum, m) => sum + m.total, 0);
  const journeyGoal = Number(meta.journey_goal_steps) || 750000;
  const maxSteps = members.reduce((max, m) => Math.max(max, m.total), 0);

  return {
    weekStart: weekStartISO,
    weekEnd,
    weekLabel: weekLabel(weekStartISO),
    isCurrentWeek,
    today,
    daysElapsed: elapsed,
    dates: dates.map((iso, i) => ({
      iso,
      dayName: DAY_NAMES[i],
      isToday: iso === today,
      isFuture: iso > today,
    })),
    members: ranked,
    group: {
      name: meta.group_name,
      journeyName: meta.journey_name,
      total: groupTotal,
      goal: journeyGoal,
      percent: journeyGoal > 0 ? Math.min(100, Math.round((groupTotal / journeyGoal) * 100)) : 0,
      loggedToday: members.filter((m) => m.hasLoggedToday).length,
      memberCount: members.length,
    },
    rivals,
    maxSteps,
    milestones: milestonesUpTo(maxSteps),
    archiveWeeks,
  };
}
