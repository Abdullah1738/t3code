/** Free/busy and holds for the scoped responder: start and end times only, never titles. */
import { homedir } from "node:os";
import { join } from "node:path";

export type Busy = { start: number; end: number };
export type FreeWindow = { start: number; end: number };
export type WorkingHours = { startHour: number; endHour: number; days: number[] };

const DAY = 24 * 60 * 60_000;
export const HORIZON_DAYS = 14;
export const SLOT_MAX_MS = 2 * 60 * 60_000;
const BUFFER_MS = 15 * 60_000;
export const DEFAULT_HOURS: WorkingHours = { startHour: 10, endHour: 18, days: [1, 2, 3, 4, 5] };

/** applecal rejects fractional seconds. */
export const calendarTime = (at: number) => new Date(Math.floor(at / 1000) * 1000).toISOString().replace(".000Z", "Z");

/** Local wall-clock parts in a time zone, enough to walk days and hours. */
export function localParts(at: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short", hourCycle: "h23" })
    .formatToParts(new Date(at));
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), hour: Number(get("hour")), minute: Number(get("minute")), weekday };
}

/** Epoch ms of a local wall-clock time (fixed-offset zones like Asia/Dubai are exact; DST zones are close enough for slots). */
function zonedTime(year: number, month: number, day: number, hour: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day, hour);
  const local = localParts(guess, timeZone);
  const shown = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  return guess - (shown - guess);
}

export const fmt = (at: number, timeZone: string) => new Date(at).toLocaleString("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function freeWindows(busy: Busy[], now: number, timeZone: string, hours = DEFAULT_HOURS, days = HORIZON_DAYS): FreeWindow[] {
  const windows: FreeWindow[] = [];
  const blocks = busy.map(entry => ({ start: entry.start - BUFFER_MS, end: entry.end + BUFFER_MS })).sort((a, b) => a.start - b.start);
  for (let offset = 0; offset <= days; offset++) {
    const day = localParts(now + offset * DAY, timeZone);
    if (!hours.days.includes(day.weekday)) continue;
    let start = Math.max(zonedTime(day.year, day.month, day.day, hours.startHour, timeZone), Math.ceil((now + 2 * 60 * 60_000) / 1_800_000) * 1_800_000);
    const end = zonedTime(day.year, day.month, day.day, hours.endHour, timeZone);
    for (const block of blocks) {
      if (block.end <= start || block.start >= end) continue;
      if (block.start > start) windows.push({ start, end: Math.min(block.start, end) });
      start = Math.max(start, block.end);
    }
    if (end > start) windows.push({ start, end });
  }
  return windows.filter(window => window.end - window.start >= 30 * 60_000);
}

export function slotFits(slot: { start: string; end: string }, windows: FreeWindow[]): { start: number; end: number } | undefined {
  const start = Date.parse(slot.start);
  const end = Date.parse(slot.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > SLOT_MAX_MS) return undefined;
  return windows.some(window => start >= window.start && end <= window.end) ? { start, end } : undefined;
}

/** Busy blocks from Apple Calendar via applecal: times only. All-day entries (birthdays, holidays) don't block. */
export async function applecalBusy(from: number, to: number): Promise<Busy[] | "unavailable"> {
  try {
    const child = Bun.spawn([join(homedir(), ".local/bin/applecal"), "list-events", "--json", "--from", calendarTime(from), "--to", calendarTime(to)],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), 20_000);
    const out = await new Response(child.stdout).text();
    clearTimeout(timer);
    if (await child.exited !== 0) return "unavailable";
    const events = JSON.parse(out) as { startDate?: string; endDate?: string; isAllDay?: boolean }[];
    if (!Array.isArray(events)) return "unavailable";
    return events.filter(event => !event.isAllDay && event.startDate && event.endDate)
      .map(event => ({ start: Date.parse(event.startDate!), end: Date.parse(event.endDate!) }))
      .filter(entry => Number.isFinite(entry.start) && Number.isFinite(entry.end));
  } catch { return "unavailable"; }
}

export async function applecalHold(input: { title: string; start: number; end: number; notes: string }): Promise<boolean> {
  try {
    const child = Bun.spawn([join(homedir(), ".local/bin/applecal"), "create-event", "--title", input.title,
      "--start", calendarTime(input.start), "--end", calendarTime(input.end), "--notes", input.notes],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), 20_000);
    const code = await child.exited;
    clearTimeout(timer);
    return code === 0;
  } catch { return false; }
}
