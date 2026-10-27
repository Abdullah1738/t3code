// Display time helpers shared by the web and mobile board and iMessage screens.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How long something has waited: under an hour, under a day, or longer. */
export type AgeTier = "minutes" | "hours" | "days";

export interface AgeView {
  /** "now", "52m", "5h", "1d 14h". */
  readonly label: string;
  readonly tier: AgeTier;
}

/** The card age element: a short span since `atIso`, and how loud to show it. */
export function ageView(atIso: string, nowMs: number): AgeView | null {
  const diff = nowMs - Date.parse(atIso);
  if (!Number.isFinite(diff)) return null;
  if (diff < MINUTE_MS) return { label: "now", tier: "minutes" };
  if (diff < HOUR_MS) return { label: `${Math.floor(diff / MINUTE_MS)}m`, tier: "minutes" };
  if (diff < DAY_MS) return { label: `${Math.floor(diff / HOUR_MS)}h`, tier: "hours" };
  const days = Math.floor(diff / DAY_MS);
  const hours = Math.floor((diff % DAY_MS) / HOUR_MS);
  return { label: hours > 0 ? `${days}d ${hours}h` : `${days}d`, tier: "days" };
}

const dayLabelFormatters = new Map<string, Intl.DateTimeFormat>();

/** "Mon 19 Oct" in the reader's time zone (or `timeZone` when given). */
export function formatDayLabel(atIso: string, timeZone?: string): string {
  const key = timeZone ?? "";
  let formatter = dayLabelFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      ...(timeZone ? { timeZone } : {}),
    });
    dayLabelFormatters.set(key, formatter);
  }
  const atMs = Date.parse(atIso);
  if (!Number.isFinite(atMs)) return "";
  return formatter.format(atMs).replace(",", "");
}

const timeOfDayFormatters = new Map<string, Intl.DateTimeFormat>();

/** "15:41" in the reader's time zone (or `timeZone` when given). */
export function formatTimeOfDay(atIso: string, timeZone?: string): string {
  const key = timeZone ?? "";
  let formatter = timeOfDayFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      ...(timeZone ? { timeZone } : {}),
    });
    timeOfDayFormatters.set(key, formatter);
  }
  const atMs = Date.parse(atIso);
  if (!Number.isFinite(atMs)) return "";
  return formatter.format(atMs);
}

function calendarDay(atMs: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    ...(timeZone ? { timeZone } : {}),
  }).format(atMs);
}

/** "15:41" for today, "Wed 14 Oct" for anything earlier. */
export function clockLabel(atIso: string, nowMs: number, timeZone?: string): string {
  const atMs = Date.parse(atIso);
  if (!Number.isFinite(atMs)) return "";
  return calendarDay(atMs, timeZone) === calendarDay(nowMs, timeZone)
    ? formatTimeOfDay(atIso, timeZone)
    : formatDayLabel(atIso, timeZone);
}
