// Wall-clock helpers for report windows in a mission's zone (Intl only).

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = { Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };

const formatters = new Map();
const formatter = (zone) => {
  if (!formatters.has(zone)) {
    formatters.set(
      zone,
      new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        weekday: 'short',
      }),
    );
  }
  return formatters.get(zone);
};

/** Throws on a zone name Intl doesn't know. */
export function assertZone(zone) {
  try {
    formatter(zone);
  } catch {
    throw new Error(`unknown time zone ${JSON.stringify(zone)}`);
  }
  return zone;
}

/** Wall-clock parts of an instant in `zone`. */
export function parts(iso, zone) {
  const out = {};
  for (const { type, value } of formatter(zone).formatToParts(new Date(iso))) out[type] = value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: out.weekday,
  };
}

// Zone offset in ms at an instant (wall time minus UTC).
const offsetAt = (ms, zone) => {
  const p = parts(new Date(ms).toISOString(), zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
};

/**
 * The instant a calendar day starts in `zone`: local midnight, or the first
 * wall time after it when a DST change skips midnight.
 */
export function dayStart(day, zone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) throw new Error(`bad day ${JSON.stringify(day)} (want YYYY-MM-DD)`);
  const wall = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  let guess = wall - offsetAt(wall, zone);
  guess = wall - offsetAt(guess, zone);
  // A skipped midnight lands the guess on the previous day: step forward to the day.
  const p = parts(new Date(guess).toISOString(), zone);
  if (p.day !== Number(match[3])) guess += (24 - p.hour) * 3_600_000 - p.minute * 60_000;
  return new Date(guess).toISOString();
}

/** Calendar day (YYYY-MM-DD) of an instant in `zone`. */
export function dayOf(iso, zone) {
  const p = parts(iso, zone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

const shiftDay = (day, days) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

/** The whole day `day` in `zone`: its start to the next day's start. */
export function dayWindow(day, zone) {
  return { day, from: dayStart(day, zone), to: dayStart(shiftDay(day, 1), zone) };
}

/** The last whole day in `zone` that ended at or before `nowIso`. */
export function lastWholeDay(nowIso, zone) {
  return dayWindow(shiftDay(dayOf(nowIso, zone), -1), zone);
}

/** "14:05" in `zone`. */
export function clock(iso, zone) {
  const p = parts(iso, zone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** "22 Oct 14:05" in `zone`. */
export function stamp(iso, zone) {
  const p = parts(iso, zone);
  return `${p.day} ${MONTHS[p.month - 1]} ${clock(iso, zone)}`;
}

/** "Thursday 22 Oct 2026" in `zone`. */
export function longDay(iso, zone) {
  const p = parts(iso, zone);
  return `${WEEKDAYS[p.weekday] ?? p.weekday} ${p.day} ${MONTHS[p.month - 1]} ${p.year}`;
}

/** "Asia/Dubai" -> "Dubai". */
export const zoneLabel = (zone) => (zone.split('/').at(-1) ?? zone).replaceAll('_', ' ');
