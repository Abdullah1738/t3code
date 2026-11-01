/** What a typed slot count commits: a whole number clamped to min..max, or null to keep the current count. */
export function committedSlots(
  text: string,
  current: number,
  min: number,
  max?: number | undefined,
): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const typed = Number(trimmed);
  if (!Number.isSafeInteger(typed)) return null;
  const next = Math.max(min, max === undefined ? typed : Math.min(max, typed));
  return next === current ? null : next;
}
