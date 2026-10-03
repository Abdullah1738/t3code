import type {
  ArdudBoardDelta,
  ArdudBoardEntry,
  ArdudBoardLane,
  ArdudBoardSnapshot,
} from "@t3tools/contracts";

/**
 * Pure client logic for the fork's session board (/api/ardud/board), shared
 * by web and mobile. Transport and state containers stay with each client.
 */

export interface BoardData {
  readonly entries: ReadonlyMap<string, ArdudBoardEntry>;
  readonly revision: number;
  readonly syncError: string | null;
}

export function applyBoardSnapshot<S extends BoardData>(state: S, snapshot: ArdudBoardSnapshot): S {
  return {
    ...state,
    entries: new Map(snapshot.entries.map((entry) => [entry.threadId, entry])),
    revision: snapshot.revision,
    syncError: snapshot.syncError,
  };
}

export function applyBoardDelta<S extends BoardData>(state: S, delta: ArdudBoardDelta): S {
  const entries = new Map(state.entries);
  for (const id of delta.removed) entries.delete(id);
  for (const entry of delta.upserts) entries.set(entry.threadId, entry);
  return {
    ...state,
    entries,
    revision: Math.max(state.revision, delta.revision),
    syncError: delta.syncError,
  };
}

/** Action responses can race the stream; only a snapshot at least as new replaces state. */
export function acceptBoardSnapshot<S extends BoardData>(
  state: S,
  snapshot: ArdudBoardSnapshot,
): S {
  return snapshot.revision >= state.revision ? applyBoardSnapshot(state, snapshot) : state;
}

/** Parses a text/event-stream body into (event, data) pairs. Comment-only blocks are skipped. */
export function createSseParser(onEvent: (event: string, data: string) => void) {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length > 0) onEvent(event, data.join("\n"));
      boundary = buffer.indexOf("\n\n");
    }
  };
}

/** Reconnect delay after `attempt` consecutive failures: 2s doubling to a 30s cap. */
export function boardReconnectDelay(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
}

export type BoardLanes = Record<ArdudBoardLane, ArdudBoardEntry[]>;

/** Splits entries into lanes, newest work first, ties broken by thread id. */
export function groupBoardLanes(entries: Iterable<ArdudBoardEntry>): BoardLanes {
  const lanes: BoardLanes = { running: [], waiting: [], backlog: [], scheduled: [] };
  for (const entry of entries) lanes[entry.state].push(entry);
  for (const lane of Object.values(lanes)) {
    lane.sort((a, b) => b.updatedAt - a.updatedAt || a.threadId.localeCompare(b.threadId));
  }
  return lanes;
}

/** Runs `task` over `items` with bounded concurrency; resolves false if any task failed. */
export async function settleBoardTasks<T>(
  items: ReadonlyArray<T>,
  task: (item: T) => Promise<unknown>,
  concurrency = 4,
): Promise<boolean> {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      try {
        await task(item);
      } catch {
        failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return !failed;
}

/** The card's status line, matching OpenChamber's wording. */
export function statusLabel(entry: Pick<ArdudBoardEntry, "state" | "status">): string {
  if (entry.status === "deleted") return "Deleted";
  if (entry.state === "backlog") return "Saved for later";
  if (entry.state === "scheduled") return "Scheduled task";
  if (entry.state === "waiting")
    return entry.status === "unknown" ? "Checking status…" : "Ready for review";
  switch (entry.status) {
    case "working":
      return "Working…";
    case "queued":
      return "Queued…";
    case "background":
      return "Waiting on background work…";
    case "needs-input":
      return "Needs your input";
    default:
      return "Checking status…";
  }
}

// @effect-diagnostics-next-line globalDate:off - display helper for React views, outside an Effect runtime.
export function formatBoardAge(updatedAt: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - updatedAt) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
