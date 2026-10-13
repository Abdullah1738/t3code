import type {
  ArdudBoardAttention,
  ArdudBoardEntry,
  ArdudBoardLane,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

/**
 * The session board's rules, ported from OpenChamber's session-board runtime.
 * Pure: the service feeds it thread observations and persists the rows it
 * returns. Root threads and forks get cards; subagent threads never do, they
 * only keep their parent running and roll their requests up to it. A user
 * settle in t3 completes a card; there are no card actions any more.
 */

export type CompletedFrom = "waiting" | "backlog" | "scheduled";

/** One durable ledger row, keyed by t3 thread id. */
export interface BoardRow {
  readonly threadId: string;
  readonly projectId: string | null;
  readonly title: string;
  /** Epoch ms of the latest user message already accounted for. */
  readonly promptAt: number | null;
  readonly pending: boolean;
  readonly reviewed: boolean;
  readonly backlog: boolean;
  readonly scheduled: boolean;
  readonly completedFrom: CompletedFrom | null;
  readonly deleted: boolean;
  readonly workRevision: number;
  readonly updatedAt: number;
}

/**
 * Live run state of a thread:
 * - `working`: a run is preparing, starting or running
 * - `queued`: a run is queued behind another
 * - `background`: the turn ended but its background work (subagents, commands) still runs
 * - `idle`: nothing is running
 */
export type LiveStatus = "working" | "queued" | "background" | "idle";

const isActive = (status: LiveStatus | undefined): boolean =>
  status !== undefined && status !== "idle";

/** What one read of a thread shell says about it. */
export interface ThreadObservation {
  readonly threadId: string;
  readonly deleted?: false;
  readonly projectId: string | null;
  readonly title: string;
  readonly parentId: string | null;
  readonly rootId: string;
  readonly relationship: "fork" | "subagent" | null;
  readonly promptAt: number | null;
  readonly live: LiveStatus;
  readonly attention: ArdudBoardAttention | null;
  readonly model: string | null;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly archived: boolean;
  /**
   * The user just settled the thread in t3 (from the event stream, never the
   * automatic sweep); the board treats that as Done.
   */
  readonly settledByUser?: boolean;
  /** Whether t3 currently shows the thread as settled. */
  readonly settled?: boolean;
  /**
   * Whether the thread's latest prompt came from a scheduled task, when known.
   * False corrects a card persisted as scheduled; undefined leaves it alone.
   */
  readonly scheduledHint?: boolean;
}

export interface DeletedObservation {
  readonly threadId: string;
  readonly deleted: true;
}

export type Observation = ThreadObservation | DeletedObservation;

/** Live projection of a thread. Never persisted. */
export interface LiveInfo {
  readonly live: LiveStatus;
  readonly parentId: string | null;
  readonly rootId: string;
  readonly relationship: "fork" | "subagent" | null;
  readonly attention: ArdudBoardAttention | null;
  readonly model: string | null;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly archived: boolean;
  readonly settled: boolean;
  readonly title: string;
  readonly projectId: string | null;
}

/** Origins whose threads never reach the board (they talk to the owner elsewhere). */
const QUIET_ORIGINS: ReadonlySet<string> = new Set(["imessage"]);
/** Origins whose threads land in the Scheduled lane instead of Waiting for review. */
const AUTOMATED_ORIGINS: ReadonlySet<string> = new Set(["automation", "crw", "watcher"]);

export const blankRow = (threadId: string, title = threadId): BoardRow => ({
  threadId,
  projectId: null,
  title,
  promptAt: null,
  pending: false,
  reviewed: false,
  backlog: false,
  scheduled: false,
  completedFrom: null,
  deleted: false,
  workRevision: 0,
  updatedAt: 0,
});

export interface ObservePatch {
  /** Rows to write. Empty when nothing durable changed. */
  readonly rows: ReadonlyArray<BoardRow>;
  readonly live: ReadonlyArray<readonly [string, LiveInfo | null]>;
  /** The observation would create a new card; the caller may add a scheduled hint and retry. */
  readonly creates: boolean;
}

const sameRow = (left: BoardRow, right: BoardRow) =>
  left.projectId === right.projectId &&
  left.title === right.title &&
  left.promptAt === right.promptAt &&
  left.pending === right.pending &&
  left.reviewed === right.reviewed &&
  left.backlog === right.backlog &&
  left.scheduled === right.scheduled &&
  left.completedFrom === right.completedFrom &&
  left.deleted === right.deleted &&
  left.workRevision === right.workRevision &&
  left.updatedAt === right.updatedAt;

export class BoardModel {
  readonly rows = new Map<string, BoardRow>();
  readonly live = new Map<string, LiveInfo>();
  readonly origins = new Map<string, string>();
  /**
   * The scheduled task behind each card's latest prompt, or null when it was
   * checked and is not a scheduled run.
   */
  readonly schedules = new Map<string, string | null>();
  activatedAt: number;
  private readonly now: () => number;

  constructor(options: { readonly activatedAt: number; readonly now: () => number }) {
    this.activatedAt = options.activatedAt;
    this.now = options.now;
  }

  /** The thread's own origin, else the nearest one up its parent chain, else its root's. */
  originOf(threadId: string): string | null {
    const visited = new Set<string>();
    let id: string | null = threadId;
    while (id !== null && !visited.has(id)) {
      visited.add(id);
      const origin = this.origins.get(id);
      if (origin !== undefined) return origin;
      id = this.live.get(id)?.parentId ?? null;
    }
    const rootId = this.live.get(threadId)?.rootId;
    return rootId === undefined ? null : (this.origins.get(rootId) ?? null);
  }

  /** iMessage threads and everything below or forked from them stay off the board. */
  isQuiet(threadId: string): boolean {
    const origin = this.originOf(threadId);
    return origin !== null && QUIET_ORIGINS.has(origin);
  }

  isAutomated(threadId: string): boolean {
    const origin = this.originOf(threadId);
    return origin !== null && AUTOMATED_ORIGINS.has(origin);
  }

  /** The subagent chain above a thread. A fork is its own work, so it stops the walk. */
  private *subagentAncestors(threadId: string): Generator<string> {
    const visited = new Set([threadId]);
    let info = this.live.get(threadId);
    while (info !== undefined && info.relationship === "subagent" && info.parentId !== null) {
      const parentId = info.parentId;
      if (visited.has(parentId)) return;
      visited.add(parentId);
      yield parentId;
      info = this.live.get(parentId);
    }
  }

  /** Threads with a running subagent below them: their turn has not really ended. */
  workingAncestors(): Set<string> {
    const working = new Set<string>();
    for (const [threadId, info] of this.live) {
      if (!isActive(info.live)) continue;
      for (const ancestor of this.subagentAncestors(threadId)) working.add(ancestor);
    }
    return working;
  }

  /** Whether a card's work is still going on, on the thread itself or in its subagents. */
  isRunning(threadId: string, working: ReadonlySet<string> = this.workingAncestors()): boolean {
    return isActive(this.live.get(threadId)?.live) || working.has(threadId);
  }

  /**
   * Applies one observation without committing it. The caller persists the
   * returned rows, then calls `commit`.
   */
  observe(observation: Observation): ObservePatch {
    const threadId = observation.threadId;
    const current = this.rows.get(threadId);
    if (observation.deleted === true) {
      const rows = current === undefined || current.deleted ? [] : [{ ...current, deleted: true }];
      return { rows, live: [[threadId, null]], creates: false };
    }

    const previousLive = this.live.get(threadId);
    const info: LiveInfo = {
      live: observation.live,
      parentId: observation.parentId,
      rootId: observation.rootId,
      relationship: observation.relationship,
      attention: observation.attention,
      model: observation.model,
      branch: observation.branch,
      worktreePath: observation.worktreePath,
      archived: observation.archived,
      settled: observation.settled === true,
      title: observation.title,
      projectId: observation.projectId,
    };
    const live: ObservePatch["live"] = [[threadId, info]];
    if (observation.relationship === "subagent") return { rows: [], live, creates: false };

    // Origin checks walk the live chain, so they see the observed lineage.
    this.live.set(threadId, info);
    const quiet = this.isQuiet(threadId);
    const automated = this.isAutomated(threadId);
    if (previousLive === undefined) this.live.delete(threadId);
    else this.live.set(threadId, previousLive);

    const base = current ?? blankRow(threadId, observation.title);
    let row: BoardRow = {
      ...base,
      title: observation.title || base.title,
      projectId: observation.projectId ?? base.projectId,
    };
    const now = this.now();
    const active = isActive(observation.live);
    const prompt = observation.promptAt;
    if (prompt !== null && (row.promptAt === null || prompt > row.promptAt)) {
      row = { ...row, promptAt: prompt, deleted: false };
      if (prompt >= this.activatedAt && !quiet) {
        // Lane provenance follows the latest prompt: a user follow-up to a
        // thread a schedule once woke is review work again. The caller re-adds
        // the scheduled hint when this prompt came from a scheduled task.
        row = {
          ...row,
          pending: true,
          reviewed: false,
          backlog: false,
          scheduled: false,
          completedFrom: null,
          workRevision: row.workRevision + 1,
          updatedAt: Math.max(row.updatedAt, prompt),
        };
      }
    }
    if (active && !quiet && !row.pending && !row.reviewed) {
      row = {
        ...row,
        pending: true,
        workRevision: row.workRevision + 1,
        updatedAt: Math.max(row.updatedAt, now),
      };
    }
    // Genuine activity after a review shows at once, even before the matching
    // user message is observed.
    if (active && !quiet && row.reviewed && !isActive(previousLive?.live)) {
      row = {
        ...row,
        pending: true,
        reviewed: false,
        backlog: false,
        completedFrom: null,
        workRevision: row.workRevision + 1,
        updatedAt: Math.max(row.updatedAt, now),
      };
    }
    if (active && row.deleted) row = { ...row, deleted: false };
    if ((observation.scheduledHint === true || automated) && !row.scheduled) {
      // Baselined automated threads have no prompt-driven stamp; date the card.
      row = { ...row, scheduled: true, updatedAt: row.updatedAt || (row.promptAt ?? now) };
    } else if (observation.scheduledHint === false && !automated && row.scheduled) {
      // A card persisted as scheduled whose latest prompt is not a scheduled run.
      row = { ...row, scheduled: false };
    }
    // The user settled the thread in t3: mark its card Done. t3 only lets a
    // thread settle once its turn ended, so background work draining under it
    // doesn't block this. Un-settling in t3 does not restore the card; any new
    // message to the thread brings it back anyway.
    if (
      observation.settledByUser === true &&
      observation.live !== "working" &&
      observation.live !== "queued" &&
      (row.pending || row.backlog || (row.scheduled && !row.reviewed))
    ) {
      row = {
        ...row,
        pending: false,
        reviewed: true,
        backlog: false,
        completedFrom: row.backlog ? "backlog" : row.scheduled ? "scheduled" : "waiting",
        workRevision: row.workRevision + 1,
      };
    }

    // The activation cutoff baselines old history: an untouched thread is never written.
    if (current === undefined && !row.pending && !row.backlog && !row.scheduled) {
      return { rows: [], live, creates: false };
    }
    if (current !== undefined && sameRow(current, row)) return { rows: [], live, creates: false };
    return { rows: [row], live, creates: current === undefined };
  }

  commit(patch: Pick<ObservePatch, "rows" | "live">): void {
    for (const row of patch.rows) this.rows.set(row.threadId, row);
    for (const [threadId, info] of patch.live) {
      if (info === null) this.live.delete(threadId);
      else this.live.set(threadId, info);
    }
  }

  /**
   * A schedule shows as one card: its latest run. Older runs resting in the
   * Scheduled lane are completed the way a review completes them. Runs still
   * running or waiting on a request stay until they settle, and a card the
   * user restored stays until the schedule runs again. Returns the rows to
   * write; the caller commits them.
   */
  supersededRuns(): BoardRow[] {
    const order = (row: BoardRow) => row.promptAt ?? row.updatedAt;
    const runs: Array<{ readonly row: BoardRow; readonly scheduleId: string }> = [];
    const latest = new Map<string, BoardRow>();
    for (const [threadId, scheduleId] of this.schedules) {
      if (scheduleId === null) continue;
      const row = this.rows.get(threadId);
      if (row === undefined) continue;
      runs.push({ row, scheduleId });
      const current = latest.get(scheduleId);
      if (
        current === undefined ||
        order(row) > order(current) ||
        (order(row) === order(current) && row.threadId > current.threadId)
      ) {
        latest.set(scheduleId, row);
      }
    }
    let working: ReadonlySet<string> | undefined;
    let totals: ReadonlyMap<string, ArdudBoardAttention> | undefined;
    const superseded: BoardRow[] = [];
    for (const { row, scheduleId } of runs) {
      const newest = latest.get(scheduleId)!;
      if (newest.threadId === row.threadId || row.reviewed || !row.scheduled || row.backlog) {
        continue;
      }
      if (!row.pending && row.updatedAt >= order(newest)) continue;
      working ??= this.workingAncestors();
      totals ??= this.attentionTotals();
      if (totals.has(row.threadId) || this.laneOf(row, working, totals) !== "scheduled") continue;
      superseded.push({ ...row, pending: false, reviewed: true, completedFrom: "scheduled" });
    }
    return superseded;
  }

  /** Requests on each thread plus every subagent below it. */
  attentionTotals(): Map<string, ArdudBoardAttention> {
    const totals = new Map<string, { kind: "question" | "approval"; count: number }>();
    for (const [threadId, info] of this.live) {
      const attention = info.attention;
      if (attention === null || attention.count === 0) continue;
      for (const id of [threadId, ...this.subagentAncestors(threadId)]) {
        const total = totals.get(id) ?? { kind: "approval" as const, count: 0 };
        total.count += attention.count;
        if (attention.kind === "question") total.kind = "question";
        totals.set(id, total);
      }
    }
    return totals;
  }

  /** The lane a row shows in, or null when it is not on the board. */
  laneOf(
    row: BoardRow,
    working: ReadonlySet<string> = this.workingAncestors(),
    totals: ReadonlyMap<string, ArdudBoardAttention> = this.attentionTotals(),
  ): ArdudBoardLane | null {
    if (this.isQuiet(row.threadId)) return null;
    const live = this.live.get(row.threadId)?.live;
    const visible =
      isActive(live) ||
      totals.has(row.threadId) ||
      row.pending ||
      row.backlog ||
      (row.scheduled && !row.reviewed);
    if (!visible) return null;
    // Only unreviewed work counts as still running through its subagents.
    const stillWorking = row.pending && !row.backlog && working.has(row.threadId);
    // After a restart a pending scheduled run shows as running until it is
    // confirmed settled.
    if (
      isActive(live) ||
      stillWorking ||
      (row.scheduled && live === undefined && row.pending && !row.deleted)
    ) {
      return "running";
    }
    if (row.scheduled) return "scheduled";
    if (row.backlog) return "backlog";
    return "waiting";
  }

  entry(
    row: BoardRow,
    working: ReadonlySet<string> = this.workingAncestors(),
    totals: ReadonlyMap<string, ArdudBoardAttention> = this.attentionTotals(),
  ): ArdudBoardEntry | null {
    const lane = this.laneOf(row, working, totals);
    if (lane === null) return null;
    const info = this.live.get(row.threadId);
    const attention = totals.get(row.threadId);
    const status = row.deleted
      ? "deleted"
      : info === undefined
        ? "unknown"
        : attention !== undefined && this.isRunning(row.threadId, working)
          ? "needs-input"
          : info.live === "idle" && working.has(row.threadId)
            ? "background"
            : info.live;
    return {
      threadId: row.threadId as ThreadId,
      projectId: (info?.projectId ?? row.projectId) as ProjectId | null,
      title: info?.title || row.title,
      state: lane,
      status,
      workRevision: row.workRevision,
      updatedAt: row.updatedAt,
      ...(attention === undefined ? {} : { attention }),
      model: info?.model ?? null,
      branch: info?.branch ?? null,
      worktreePath: info?.worktreePath ?? null,
      ...(info?.archived ? { archived: true } : {}),
    };
  }

  entries(): ArdudBoardEntry[] {
    const working = this.workingAncestors();
    const totals = this.attentionTotals();
    const entries: ArdudBoardEntry[] = [];
    for (const row of this.rows.values()) {
      const entry = this.entry(row, working, totals);
      if (entry !== null) entries.push(entry);
    }
    return entries.sort(
      (left, right) =>
        right.updatedAt - left.updatedAt || left.threadId.localeCompare(right.threadId),
    );
  }
}
