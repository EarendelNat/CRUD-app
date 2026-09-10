// Fills the database with ten members and two weeks of plausible steps, so you
// can see the race track working before your real group has signed up.
//
//   npm run seed     add demo data (skips if members already exist)
//   npm run reset    wipe everything first, then seed
//
// Every demo account uses the password: password123

import { db, createUser, countUsers, upsertEntry, setMeta } from '../server/db.js';
import { hashPassword } from '../server/auth.js';
import { addWeeks, currentWeekStart, daysElapsed, weekDates } from '../server/week.js';

const RESET = process.argv.includes('--reset');

const PEOPLE = [
  // A spread of characters so the track has a real shape: a runaway leader,
  // a tight midfield scrap, someone who has barely logged, someone who
  // started slow and is climbing.
  { name: 'Aisyah',  avatar: '🦊', pattern: 'leader',     goal: 90000 },
  { name: 'Ben',     avatar: '🐢', pattern: 'steady',     goal: 70000 },
  { name: 'Chloe',   avatar: '🐇', pattern: 'climber',    goal: 70000 },
  { name: 'Darren',  avatar: '🦁', pattern: 'steady',     goal: 70000 },
  { name: 'Elena',   avatar: '🦄', pattern: 'weekender',  goal: 60000 },
  { name: 'Faiz',    avatar: '🐯', pattern: 'steady',     goal: 70000 },
  { name: 'Grace',   avatar: '🐼', pattern: 'sporadic',   goal: 50000 },
  { name: 'Hakim',   avatar: '🦖', pattern: 'climber',    goal: 80000 },
  { name: 'Iris',    avatar: '🐧', pattern: 'behind',     goal: 70000 },
  { name: 'Jonas',   avatar: '🦉', pattern: 'steady',     goal: 70000 },
];

// Deterministic pseudo-random, so re-seeding gives the same demo week and
// screenshots stay comparable.
let seedState = 12345;
function rand() {
  seedState = (seedState * 1103515245 + 12345) % 2147483648;
  return seedState / 2147483648;
}
const jitter = (base, spread) => Math.max(0, Math.round(base + (rand() - 0.5) * spread));

/** Steps for one person on one day, dayIndex 0 = Monday. */
function stepsFor(pattern, dayIndex) {
  const isWeekend = dayIndex >= 5;
  switch (pattern) {
    case 'leader':
      return jitter(15500, 4000);
    case 'steady':
      return jitter(isWeekend ? 11000 : 9800, 3500);
    case 'climber':
      // Starts slow, builds through the week.
      return jitter(6000 + dayIndex * 1600, 2500);
    case 'weekender':
      // Barely moves on workdays, big weekend walks.
      return isWeekend ? jitter(18000, 5000) : jitter(4200, 2000);
    case 'sporadic':
      // Logs some days and not others -- this is what makes ghosts appear.
      return rand() < 0.45 ? 0 : jitter(9000, 6000);
    case 'behind':
      return jitter(4800, 2500);
    default:
      return jitter(9000, 3000);
  }
}

if (RESET) {
  // Order matters: children before parents, because foreign keys are on.
  db.exec('DELETE FROM cheers; DELETE FROM sessions; DELETE FROM step_entries; DELETE FROM users;');
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('users','step_entries','cheers')");
  console.log('Wiped existing data.');
}

if (countUsers() > 0) {
  console.log(
    `Database already has ${countUsers()} member(s); leaving it alone.\n` +
      'Run "npm run reset" if you want to wipe and re-seed.'
  );
  process.exit(0);
}

const passwordHash = await hashPassword('password123');
const thisWeek = currentWeekStart();
const lastWeek = addWeeks(thisWeek, -1);
const elapsed = daysElapsed(thisWeek);

setMeta('group_name', 'The Ten');
setMeta('journey_name', 'Kuala Lumpur');
setMeta('journey_goal_steps', '750000');

for (const person of PEOPLE) {
  const user = createUser({
    email: `${person.name.toLowerCase()}@example.com`,
    name: person.name,
    avatar: person.avatar,
    passwordHash,
    weeklyGoal: person.goal,
  });

  // Last week: a complete week, so the archive view has something in it.
  weekDates(lastWeek).forEach((date, dayIndex) => {
    const steps = stepsFor(person.pattern, dayIndex);
    if (steps > 0) upsertEntry(user.id, date, steps);
  });

  // This week: only up to today, and Grace/Iris skip today so the UI has
  // ghosts to grey out.
  const skipsToday = person.pattern === 'sporadic' || person.pattern === 'behind';
  weekDates(thisWeek).forEach((date, dayIndex) => {
    if (dayIndex >= elapsed) return;                     // don't log the future
    if (skipsToday && dayIndex === elapsed - 1) return;  // leave today un-logged
    const steps = stepsFor(person.pattern, dayIndex);
    if (steps > 0) upsertEntry(user.id, date, steps);
  });

  console.log(`  ${person.avatar}  ${person.name.padEnd(8)} ${person.pattern}`);
}

console.log(`\nSeeded ${PEOPLE.length} members.`);
console.log(`  this week: ${thisWeek} (day ${elapsed} of 7)`);
console.log(`  last week: ${lastWeek} (complete, for the archive)`);
console.log('\nSign in with any of:');
console.log('  aisyah@example.com / password123   (the leader)');
console.log('  iris@example.com   / password123   (last place, has not logged today)');
console.log('  chloe@example.com  / password123   (mid-pack climber)');
