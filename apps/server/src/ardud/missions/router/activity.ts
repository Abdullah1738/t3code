import type {
  MissionActor,
  MissionRoomActivity,
  RoleId,
  RoomActivityBin,
  RoomActivityRow,
  RoomId,
  ThreadId,
} from "@t3tools/contracts";

import { actorKey } from "./model.ts";
import type { ActivityMessage, ActivityTally } from "./RouterStore.ts";

/** Minutes per bin of the board's day line. */
export const ACTIVITY_BIN_MINUTES = 5;

export interface MasterIdentity {
  readonly roleId: RoleId | null;
  readonly threadIds: ReadonlyArray<ThreadId>;
}

const isMasterActor = (actor: MissionActor, master: MasterIdentity): boolean =>
  (actor._tag === "role" && actor.roleId === master.roleId) ||
  (actor._tag === "thread" && master.threadIds.includes(actor.threadId));

/**
 * The board's day line and "since" tally from router messages: rows per room,
 * busiest first, with 5-minute bins from `dayStart`.
 */
export const roomActivity = (input: {
  readonly dayStart: string;
  readonly day: ReadonlyArray<ActivityMessage>;
  readonly tally: ReadonlyArray<ActivityTally>;
  readonly master: MasterIdentity;
}): MissionRoomActivity => {
  const start = Date.parse(input.dayStart);
  const binMs = ACTIVITY_BIN_MINUTES * 60_000;
  const rooms = new Map<RoomId, { total: number; bins: Map<number, RoomActivityBin> }>();
  for (const message of input.day) {
    const at = Date.parse(message.createdAt);
    if (!Number.isFinite(at) || at < start) continue;
    const index = Math.floor((at - start) / binMs);
    const room = rooms.get(message.roomId) ?? { total: 0, bins: new Map() };
    rooms.set(message.roomId, room);
    room.total += 1;
    const bin = room.bins.get(index) ?? { index, blockers: 0, master: 0, other: 0 };
    room.bins.set(index, {
      ...bin,
      ...(message.kind === "blocker"
        ? { blockers: bin.blockers + 1 }
        : message.kind === "decision" && isMasterActor(message.author, input.master)
          ? { master: bin.master + 1 }
          : { other: bin.other + 1 }),
    });
  }
  const rows: Array<RoomActivityRow> = [...rooms.entries()]
    .map(([roomId, room]) => ({
      roomId,
      total: room.total,
      bins: [...room.bins.values()].toSorted((a, b) => a.index - b.index),
    }))
    .toSorted((a, b) => b.total - a.total || a.roomId.localeCompare(b.roomId));

  let messages = 0;
  let masterDecisions = 0;
  const blockerAuthors = new Set<string>();
  for (const entry of input.tally) {
    messages += entry.count;
    if (entry.kind === "decision" && isMasterActor(entry.author, input.master)) {
      masterDecisions += entry.count;
    }
    if (entry.kind === "blocker") blockerAuthors.add(actorKey(entry.author));
  }
  return { rows, since: { messages, masterDecisions, blockerAuthors: blockerAuthors.size } };
};
