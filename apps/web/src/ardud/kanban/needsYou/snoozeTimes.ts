/** Where Snooze puts an ask: the next morning at nine, his time. */
export function tomorrowMorning(): { readonly iso: string; readonly label: string } {
  const at = new Date();
  at.setDate(at.getDate() + 1);
  at.setHours(9, 0, 0, 0);
  return { iso: at.toISOString(), label: "tomorrow 09:00" };
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
