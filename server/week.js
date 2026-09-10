// Week + date helpers.
//
// Everything in this app is keyed on a plain 'YYYY-MM-DD' date string, never a
// timestamp. That keeps "Tuesday's steps" unambiguous. The only tricky part is
// deciding which day "now" falls on, and when the week rolls over -- both of
// which must happen in the group's own timezone, not the server's. A server in
// UTC would otherwise roll the week over at 8am Monday for a group in Singapore.

export const APP_TZ = process.env.APP_TZ || 'Asia/Singapore';

const DAY_MS = 86400000;

export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** 'YYYY-MM-DD' for the given instant, as seen in the group's timezone. */
export function todayISO(now = new Date()) {
  // en-CA formats as YYYY-MM-DD, which is exactly the shape we store.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Day of week for a 'YYYY-MM-DD' string. 0 = Monday ... 6 = Sunday. */
export function weekdayIndex(iso) {
  // Parsing as UTC midnight is safe: the string already encodes the local date,
  // so we only need its calendar position, not a real instant.
  const utc = new Date(`${iso}T00:00:00Z`);
  return (utc.getUTCDay() + 6) % 7; // shift Sunday-first to Monday-first
}

/** The Monday of the week containing the given 'YYYY-MM-DD'. */
export function weekStartOf(iso) {
  const utc = new Date(`${iso}T00:00:00Z`);
  utc.setUTCDate(utc.getUTCDate() - weekdayIndex(iso));
  return utc.toISOString().slice(0, 10);
}

/** The Monday of the current week, in the group's timezone. */
export function currentWeekStart(now = new Date()) {
  return weekStartOf(todayISO(now));
}

/** Shift a week start by n weeks (negative = earlier). */
export function addWeeks(weekStartISO, n) {
  const utc = new Date(`${weekStartISO}T00:00:00Z`);
  utc.setUTCDate(utc.getUTCDate() + n * 7);
  return utc.toISOString().slice(0, 10);
}

/** The seven 'YYYY-MM-DD' dates of a week, Monday first. */
export function weekDates(weekStartISO) {
  const base = new Date(`${weekStartISO}T00:00:00Z`).getTime();
  return Array.from({ length: 7 }, (_, i) =>
    new Date(base + i * DAY_MS).toISOString().slice(0, 10)
  );
}

/** True if the string is a well-formed, real calendar date. */
export function isValidISODate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const utc = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(utc.getTime()) && utc.toISOString().slice(0, 10) === value;
}

/**
 * How far through the week we are, for pace calculations.
 * Returns days 1..7 -- on Monday you are expected to have 1/7 of your goal,
 * by Sunday the full thing. Past weeks always count as complete.
 */
export function daysElapsed(weekStartISO, now = new Date()) {
  const today = todayISO(now);
  if (today < weekStartISO) return 0;                      // week hasn't started
  if (today > weekDates(weekStartISO)[6]) return 7;        // week is over
  return weekdayIndex(today) + 1;
}

/** Nicely formatted week label, e.g. "6 - 12 Oct 2026". */
export function weekLabel(weekStartISO) {
  const dates = weekDates(weekStartISO);
  const fmt = (iso, opts) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts }).format(
      new Date(`${iso}T00:00:00Z`)
    );
  const startDay = fmt(dates[0], { day: 'numeric' });
  const endFull = fmt(dates[6], { day: 'numeric', month: 'short', year: 'numeric' });
  const startMonth = fmt(dates[0], { month: 'short' });
  const endMonth = fmt(dates[6], { month: 'short' });
  // Only repeat the month on the left side when the week straddles two months.
  return startMonth === endMonth
    ? `${startDay} - ${endFull}`
    : `${startDay} ${startMonth} - ${endFull}`;
}
