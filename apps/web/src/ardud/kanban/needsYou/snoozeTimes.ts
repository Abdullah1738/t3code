/** A time an ask is put away until, and how the page names it: "tomorrow 09:00". */
export interface SnoozeUntil {
  readonly iso: string;
  readonly label: string;
}

/** Where Snooze puts an ask: the next morning at nine, his time. */
export function tomorrowMorning(): SnoozeUntil {
  const at = new Date();
  at.setDate(at.getDate() + 1);
  at.setHours(9, 0, 0, 0);
  return { iso: at.toISOString(), label: "tomorrow 09:00" };
}

export interface SnoozeChoice extends SnoozeUntil {
  readonly id: "later" | "tomorrow" | "week";
  readonly name: string;
  /** The time alone, shown beside the name: "17:00", "Mon 09:00". */
  readonly when: string;
}

/**
 * The times the Snooze menu offers. "Later today" is three hours on, at the
 * full hour, and is left out once that would be tomorrow.
 */
export function snoozeChoices(nowMs: number): ReadonlyArray<SnoozeChoice> {
  const choices: Array<SnoozeChoice> = [];
  const later = new Date(nowMs + 3 * 3_600_000);
  if (later.getMinutes() > 0 || later.getSeconds() > 0) later.setHours(later.getHours() + 1);
  later.setMinutes(0, 0, 0);
  if (sameDay(later.toISOString(), nowMs)) {
    const time = TIME.format(later);
    choices.push({
      id: "later",
      name: "Later today",
      when: time,
      iso: later.toISOString(),
      label: `today ${time}`,
    });
  }
  const tomorrow = new Date(nowMs);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  choices.push({
    id: "tomorrow",
    name: "Tomorrow",
    when: "09:00",
    iso: tomorrow.toISOString(),
    label: "tomorrow 09:00",
  });
  const week = new Date(nowMs);
  // The coming Monday; a full week on when today is one.
  week.setDate(week.getDate() + ((8 - week.getDay()) % 7 || 7));
  week.setHours(9, 0, 0, 0);
  const monday = `${DAY.format(week)} 09:00`;
  choices.push({
    id: "week",
    name: "Next week",
    when: monday,
    iso: week.toISOString(),
    label: monday,
  });
  return choices;
}

/** A value for a `datetime-local` input: the time in his own zone, to the minute. */
export function localInputValue(at: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}`;
}

const DAY = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const DATE = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const TIME = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** A time as the queue names it: "09:00" today, "Wed 09:00" this week, "14 Nov 09:00" later. */
export function shortWhen(iso: string, nowMs: number): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const now = new Date(nowMs);
  const days = Math.round(
    (new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime() -
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) /
      86_400_000,
  );
  const time = TIME.format(at);
  if (days === 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  if (days === -1) return `yesterday ${time}`;
  return Math.abs(days) < 7 ? `${DAY.format(at)} ${time}` : `${DATE.format(at)} ${time}`;
}

/** True when the two times fall on the same day here. */
export function sameDay(iso: string, nowMs: number): boolean {
  const at = new Date(iso);
  const now = new Date(nowMs);
  return (
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate()
  );
}
