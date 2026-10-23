import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/**
 * Report windows, periods and titles. Windows and periods follow the
 * mission's day boundary zone; a mission without one keeps UTC: rolling
 * windows and "UTC" labels.
 */

/** The report's first markdown heading, else a name for its kind. */
export const reportTitle = (report: { readonly kind: string; readonly head: string }): string => {
  for (const line of report.head.split("\n")) {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line.trim());
    if (heading?.[1]) return heading[1].slice(0, 120);
  }
  return report.kind === "daily" ? "Daily report" : "Update";
};

/** The named zone from `reports.dayBoundary`, or null when unset or unknown. */
export const reportZone = (
  mission: { readonly reports?: { readonly dayBoundary?: string | undefined } | undefined } | null,
): DateTime.TimeZone | null => {
  const boundary = mission?.reports?.dayBoundary;
  return boundary === undefined ? null : Option.getOrNull(DateTime.zoneMakeNamed(boundary));
};

const zoned = (zone: DateTime.TimeZone, iso: string) =>
  DateTime.makeZonedUnsafe(iso, { timeZone: zone });

/** Where a day starts in its zone: midnight, or the first hour after a skipped one. */
const dayStart = (date: DateTime.Zoned) => DateTime.startOf(date, "day");

const isDayStart = (date: DateTime.Zoned) =>
  DateTime.toEpochMillis(dayStart(date)) === DateTime.toEpochMillis(date);

/**
 * The day ending at `toIso` (or, with no end, the last whole day before
 * `nowIso`), day start to day start in `zone`, so a day across a DST change is
 * 23 or 25 hours. An end that isn't a day start keeps a rolling day back.
 */
export const dayWindow = (
  zone: DateTime.TimeZone,
  input: { readonly toIso?: string | undefined; readonly nowIso: string },
): { readonly from: string; readonly to: string } => {
  const end =
    input.toIso === undefined ? dayStart(zoned(zone, input.nowIso)) : zoned(zone, input.toIso);
  // Each bound is its own day's start: a day back from a skipped midnight
  // lands an hour late.
  const back = DateTime.subtract(end, { days: 1 });
  return {
    from: DateTime.formatIso(isDayStart(end) ? dayStart(back) : back),
    to: DateTime.formatIso(end),
  };
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Asia/Dubai" -> "Dubai", "America/New_York" -> "New York". */
export const zoneLabel = (zone: DateTime.TimeZone): string => {
  const name = DateTime.zoneToString(zone);
  return (name.split("/").at(-1) ?? name).replaceAll("_", " ");
};

const pad = (value: number) => String(value).padStart(2, "0");

const wallParts = (iso: string, zone: DateTime.TimeZone | null) => {
  const date = DateTime.make(iso);
  if (Option.isNone(date)) return null;
  const parts =
    zone === null
      ? DateTime.toPartsUtc(date.value)
      : DateTime.toParts(DateTime.setZone(date.value, zone));
  return {
    day: `${parts.day} ${MONTHS[parts.month - 1]}`,
    weekday: WEEKDAYS[parts.weekDay] ?? "",
    time: `${pad(parts.hour)}:${pad(parts.minute)}`,
  };
};

/**
 * "21 Oct 00:00–04:00 UTC", or both days when the window crosses midnight.
 * With a zone the times are wall times there ("21 Oct 00:00–04:00 Dubai"),
 * and a window that is exactly one day there reads "Wed 21 Oct (Dubai day)".
 */
export const reportPeriod = (
  fromIso: string,
  toIso: string,
  zone: DateTime.TimeZone | null = null,
): string => {
  const from = wallParts(fromIso, zone);
  const to = wallParts(toIso, zone);
  if (from === null || to === null) return "";
  const label = zone === null ? "UTC" : zoneLabel(zone);
  if (zone !== null && isDayStart(zoned(zone, toIso))) {
    const window = dayWindow(zone, { toIso, nowIso: toIso });
    if (Date.parse(window.from) === Date.parse(fromIso)) {
      return `${from.weekday} ${from.day} (${label} day)`;
    }
  }
  return from.day === to.day
    ? `${from.day} ${from.time}–${to.time} ${label}`
    : `${from.day} ${from.time} – ${to.day} ${to.time} ${label}`;
};
