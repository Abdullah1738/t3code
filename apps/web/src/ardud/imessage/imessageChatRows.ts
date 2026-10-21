import type { TimelineEntry, WorkLogEntry } from "../../session-logic";
import type { ChatMessage } from "../../types";

/**
 * One chat row. Agent work between two messages collapses into a single row, so each
 * agent turn reads as incoming message, agent activity, reply.
 */
export type IMessageChatRow =
  | { readonly kind: "divider"; readonly id: string; readonly createdAt: string }
  | { readonly kind: "incoming"; readonly id: string; readonly message: ChatMessage }
  | { readonly kind: "reply"; readonly id: string; readonly message: ChatMessage }
  | {
      readonly kind: "agent";
      readonly id: string;
      readonly work: ReadonlyArray<WorkLogEntry>;
      readonly startedAt: string;
      readonly endedAt: string;
    };

/** Local calendar day, so a divider lands on the day the owner sees on the clock. */
export function imessageDayKey(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * Turns one thread's timeline into chat rows. `previousDayKey` is the day of the thread
 * before it, so a thread that starts on a new day still gets a divider.
 */
export function buildIMessageChatRows(
  entries: ReadonlyArray<TimelineEntry>,
  previousDayKey: string | null,
): IMessageChatRow[] {
  const rows: IMessageChatRow[] = [];
  let dayKey = previousDayKey;
  let work: WorkLogEntry[] = [];

  const flushWork = () => {
    const first = work[0];
    const last = work[work.length - 1];
    if (first === undefined || last === undefined) return;
    rows.push({
      kind: "agent",
      id: `agent:${first.id}`,
      work,
      startedAt: first.createdAt,
      endedAt: last.createdAt,
    });
    work = [];
  };

  const enterDay = (createdAt: string) => {
    const key = imessageDayKey(createdAt);
    if (key === dayKey) return;
    flushWork();
    dayKey = key;
    rows.push({ kind: "divider", id: `day:${createdAt}`, createdAt });
  };

  for (const entry of entries) {
    if (entry.kind === "work") {
      enterDay(entry.createdAt);
      work.push(entry.entry);
      continue;
    }
    if (entry.kind !== "message") continue;
    const { message } = entry;
    if (message.role !== "user" && message.role !== "assistant") continue;
    enterDay(entry.createdAt);
    flushWork();
    rows.push({
      kind: message.role === "user" ? "incoming" : "reply",
      id: entry.id,
      message,
    });
  }
  flushWork();
  return rows;
}
