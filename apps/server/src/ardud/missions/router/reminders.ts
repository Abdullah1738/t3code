import type { MissionMessage } from "@t3tools/contracts";

/**
 * Reminder rules. A thread that leaves deliveries unread for over 30 minutes
 * while idle gets one reminder, at most one per 30 minutes per thread. Each
 * delivery is reminded once; after that it only shows in the master's
 * attention view.
 */
export const REMIND_AFTER_MS = 30 * 60 * 1000;
export const REMIND_GAP_MS = 30 * 60 * 1000;
/** How often the router looks for stale deliveries. */
export const REMIND_SWEEP = "5 minutes";

export const reminderRequestId = (missionId: string, threadId: string, upToSeq: number) =>
  `mission-remind:${missionId}:${threadId}:${upToSeq}`;

/** True when the thread's last reminder is older than the gap (or it never had one). */
export const reminderDue = (lastReminderAt: string | null, gapCutoffIso: string) =>
  lastReminderAt === null || lastReminderAt <= gapCutoffIso;

export const reminderLine = (input: {
  readonly unread: number;
  readonly rooms: ReadonlyArray<string>;
  readonly oldest: MissionMessage | null;
}) => {
  const where = input.rooms.length === 1 ? input.rooms[0] : `${input.rooms.length} rooms`;
  const oldest =
    input.oldest === null
      ? ""
      : ` (oldest: #${input.oldest.seq} ${input.oldest.kind}: ${input.oldest.summary.slice(0, 120)})`;
  return `[mission] Reminder: ${input.unread} message${input.unread === 1 ? "" : "s"} unread for over 30 minutes in ${where}${oldest}. Read them with mission_inbox, handle, then mission_mark_read. This is the only reminder; after it they go to the master.`;
};
