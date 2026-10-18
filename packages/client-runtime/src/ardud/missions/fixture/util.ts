import { MissionError, type MissionErrorCode } from "@t3tools/contracts";

export function fail(code: MissionErrorCode, detail: string): Promise<never> {
  return Promise.reject(new MissionError({ code, detail }));
}

/** Fits text into a message summary (400 characters, trimmed). */
export function clampSummary(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= 400 ? trimmed : `${trimmed.slice(0, 399).trimEnd()}…`;
}

export function newestFirst<T extends { readonly createdAt: string }>(
  items: ReadonlyArray<T>,
): T[] {
  return [...items].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/** Swaps the record with the same id in place (records themselves never mutate). */
export function replace<T extends { readonly id: string }>(list: T[], next: T): void {
  const index = list.findIndex((entry) => entry.id === next.id);
  if (index >= 0) list[index] = next;
}
