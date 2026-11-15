import type { NotificationEvent } from "./notification-events.ts";
import { toolError } from "./toollog.ts";
import {
  BOARD_EVENT_KEY_LIMIT, boardEventKey, IMESSAGE_ORIGIN, type AlertBackend, type BoardEntry, type BoardSnapshot, type BoardTelemetry, type PermissionRequest,
  type QuestionRequest, type RequestReader, type SessionRecord,
} from "./openchamber.ts";
import {
  ControlClient, ControlError, epoch, permissionFrom, questionFrom, ThreadDirectories,
  type ControlConfigOptions, type PendingRequest, type ThreadState, type ThreadSummary,
} from "./control.ts";

/** States that mean a thread is still working. `waiting` is not: its reply is out, only background work drains. */
const BUSY = new Set<ThreadState>(["running", "needs-input", "queued"]);
/** Where attention finds busy folders: Robob's active thread list, or a stand-in in tests. */
export interface ReviewBoard {
  snapshot(): Promise<BoardSnapshot>;
  markDirty?(reason?: "hard" | "soft", eventType?: string): void;
  status?(): BoardTelemetry;
  applyStatus?(threadId: string, state: ThreadState, runId?: string): void;
  recordLocal?(eventType: string): void;
}

const BOARD_MAX_AGE = 30_000;
const BOARD_MIN_GAP = 3_000;
const BOARD_SOFT_GAP = 15_000;
const BOARD_BACKOFF_MAX = 60_000;
const BOARD_LIMIT = 500;
const BOARD_LIMIT_WARNING_GAP = 10 * 60_000;
type BoardOptions = { now?: () => number; log?: (event: string) => void };
const HARD_BOARD_CHANGES = new Set([
  "thread.archived", "thread.unarchived", "thread.deleted", "thread.settled", "thread.unsettled",
  "thread.runtime-mode-updated", "run.created", "run.updated", "runtime-request.updated",
]);
const BOARD_STATES = new Set<unknown>(["idle", "running", "waiting", "needs-input", "queued"]);

/** The turn counter attention.ts uses as `workRevision`: the ordinal of the thread's newest run. */
export function runOrdinal(runId: string | null | undefined): number {
  const match = /:ordinal:(\d+)$/.exec(runId ?? "");
  return match ? Number(match[1]) : 0;
}

/**
 * Maps one control thread onto attention.ts's board vocabulary. A working
 * thread is `running`; a thread whose reply is out is `waiting` and idle, so
 * attention stops polling its folder.
 */
export function boardEntry(thread: ThreadSummary, directory: string): BoardEntry {
  const busy = BUSY.has(thread.state);
  return {
    sessionId: thread.threadId,
    directory,
    title: thread.title,
    ...(thread.projectId ? { projectId: thread.projectId } : {}),
    state: busy ? "running" : "waiting",
    status: busy ? "busy" : "idle",
    workRevision: runOrdinal(thread.latestRunId),
    updatedAt: epoch(thread.updatedAt),
    ...(thread.pendingRequest ? { attention: { kind: thread.pendingRequest.kind, count: 1 } } : {}),
  };
}

/**
 * The board attention reads each tick, built from `GET /threads?active=true`:
 * non-idle conversations, including forks. iMessage chats are left out because
 * that bridge asks in-chat. Subagents are not listed; their requests are found
 * through the shared `/requests` read.
 */
export class ActiveThreadsBoard implements ReviewBoard {
  private cache?: BoardSnapshot;
  private readonly states = new Map<string, ThreadState>();
  private readonly runIds = new Map<string, string | null | undefined>();
  private readonly reconciling = new Map<string, { version: number; promise: Promise<void> }>();
  private readonly threadReadAt = new Map<string, number>();
  private readonly deferredReads = new Set<string>();
  private readonly offboard = new Set<string>();
  private readonly pendingStatuses = new Map<string, { state: ThreadState; thread?: ThreadSummary }>();
  private fetchedAt = 0;
  private dirty: "hard" | "soft" | undefined = "hard";
  private fetching?: Promise<BoardSnapshot>;
  private retryAt = 0;
  private failure?: unknown;
  private warnedAt = -Infinity;
  private readonly now: () => number;
  private readonly telemetry: BoardTelemetry = {
    boardFetches: 0, boardCacheHits: 0, boardFetchErrors: 0, boardBackoffMs: 0, lastFetchDurationMs: null, lastFetchReason: null,
    fetchesByReason: { cold: 0, age: 0, hard: 0, soft: 0 }, dirtyEventsByType: {}, windowStartedAt: "",
    threadReads: 0, threadReadErrors: 0, threadReadsByReason: { run: 0, state: 0, followup: 0 },
  };

  constructor(
    private readonly client: Pick<ControlClient, "listThreads"> & { thread?(id: string): Promise<{ thread: ThreadSummary }> },
    private readonly directories: Pick<ThreadDirectories, "of">,
    private readonly options: BoardOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.telemetry.windowStartedAt = new Date(this.now()).toISOString();
  }

  markDirty(reason: "hard" | "soft" = "hard", eventType?: string): void {
    if (eventType !== undefined) this.countEvent(reason, eventType);
    if (this.dirty !== "hard") this.dirty = reason;
  }

  recordLocal(eventType: string): void { this.countEvent("local", eventType); }

  private countEvent(reason: "hard" | "soft" | "local", eventType: string): void {
    const events = this.telemetry.dirtyEventsByType;
    const key = Object.hasOwn(events, eventType) || (eventType !== "other" && Object.keys(events).filter(key => key !== "other").length < BOARD_EVENT_KEY_LIMIT)
      ? eventType : "other";
    if (!Object.hasOwn(events, key)) events[key] = { hard: 0, soft: 0 };
    events[key]![reason] = (events[key]![reason] ?? 0) + 1;
  }

  applyStatus(threadId: string, state: ThreadState, runId?: string): void {
    const entry = this.cache?.entries.find(entry => entry.sessionId === threadId);
    const kind = entry ? (state === "idle" ? "leave" : this.states.get(threadId) === state ? "same" : "move")
      : state === "idle" || this.offboard.has(threadId) ? "offboard" : "join";
    const key = `thread.status:${kind}`;
    // Alerts bypass the board. Known rows can be patched locally; the 30 s
    // age refresh backs up missed roster changes. Run events need extra care:
    // their state describes one run, which may not be the thread's active run.
    const ambiguous = this.reconciling.has(threadId) || (runId !== undefined && (entry || this.fetching || !this.cache)
      && (runId !== this.runIds.get(threadId) || state !== this.states.get(threadId)));
    if (ambiguous && this.client.thread) this.reconcileStatus(threadId, runId !== this.runIds.get(threadId) ? "run" : "state");
    else if (ambiguous) this.markDirty("soft");
    else this.applyCachedStatus(threadId, state);
    if (!this.cache || this.fetching) this.markDirty("hard", key);
    else if (kind === "join") this.markDirty("soft", key);
    else this.countEvent("local", key);
  }

  private applyCachedStatus(threadId: string, state: ThreadState, thread?: ThreadSummary): void {
    if (this.cache) {
      this.patchStatus(this.cache, threadId, state);
      if (thread) this.patchThread(this.cache, thread);
    }
    if (this.fetching) {
      const canonical = thread ?? this.pendingStatuses.get(threadId)?.thread;
      this.pendingStatuses.set(threadId, { state, thread: canonical ? { ...canonical, state } : undefined });
    }
  }

  private patchThread(snapshot: BoardSnapshot, thread: ThreadSummary): void {
    const entry = snapshot.entries.find(entry => entry.sessionId === thread.threadId);
    if (entry || this.states.has(thread.threadId)) this.runIds.set(thread.threadId, thread.activeRunId ?? thread.latestRunId);
    if (thread.origin === IMESSAGE_ORIGIN || thread.relationshipToParent === "subagent") {
      this.offboard.add(thread.threadId);
      this.patchStatus(snapshot, thread.threadId, "idle");
    } else {
      this.offboard.delete(thread.threadId);
      if (entry) snapshot.entries[snapshot.entries.indexOf(entry)] = boardEntry(thread, entry.directory);
    }
  }

  private reconcileStatus(threadId: string, reason: keyof BoardTelemetry["threadReadsByReason"]): void {
    const pending = this.reconciling.get(threadId);
    if (pending) { pending.version++; return; }
    const lastRead = this.threadReadAt.get(threadId);
    if (lastRead !== undefined && this.now() - lastRead < BOARD_MIN_GAP) {
      this.deferredReads.add(threadId);
      return;
    }
    this.deferredReads.delete(threadId);
    this.threadReadAt.set(threadId, this.now());
    if (this.threadReadAt.size > 2_000) {
      // The size threshold only triggers expiry; live cooldowns and queued
      // followups must survive even when the active set exceeds it.
      for (const [id, at] of this.threadReadAt) {
        if (this.now() - at >= BOARD_MIN_GAP && !this.reconciling.has(id) && !this.deferredReads.has(id)) this.threadReadAt.delete(id);
      }
    }
    const task = { version: 0, promise: Promise.resolve() };
    this.reconciling.set(threadId, task);
    this.telemetry.threadReads++;
    this.telemetry.threadReadsByReason[reason]++;
    task.promise = (async () => {
      const { thread } = await this.client.thread!(threadId);
      if (task.version !== 0) { this.deferredReads.add(threadId); return; }
      this.applyCachedStatus(threadId, thread.state, thread);
      if (!this.cache?.entries.some(entry => entry.sessionId === threadId) && thread.state !== "idle"
        && thread.origin !== IMESSAGE_ORIGIN && thread.relationshipToParent !== "subagent") this.markDirty("soft");
    })().catch(error => {
      this.telemetry.threadReadErrors++;
      this.markDirty("soft");
      toolError("telegram", "tg.robob.statusRead", undefined, error);
    }).finally(() => { this.reconciling.delete(threadId); });
  }

  private async reconciled(): Promise<void> {
    while (this.reconciling.size) await Promise.all([...this.reconciling.values()].map(task => task.promise));
  }

  private patchStatus(snapshot: BoardSnapshot, threadId: string, state: ThreadState): void {
    const index = snapshot.entries.findIndex(entry => entry.sessionId === threadId);
    if (index < 0) return;
    this.states.set(threadId, state);
    if (state === "idle") snapshot.entries.splice(index, 1);
    else {
      const entry = snapshot.entries[index]!;
      entry.state = BUSY.has(state) ? "running" : "waiting";
      entry.status = BUSY.has(state) ? "busy" : "idle";
    }
  }

  status(): BoardTelemetry {
    return { ...this.telemetry, fetchesByReason: { ...this.telemetry.fetchesByReason },
      threadReadsByReason: { ...this.telemetry.threadReadsByReason },
      dirtyEventsByType: Object.fromEntries(Object.entries(this.telemetry.dirtyEventsByType).map(([key, counts]) => [key, { ...counts }])) };
  }

  snapshot(): Promise<BoardSnapshot> {
    for (const threadId of this.deferredReads) {
      if (this.now() - this.threadReadAt.get(threadId)! >= BOARD_MIN_GAP) this.reconcileStatus(threadId, "followup");
    }
    if (this.fetching) {
      this.telemetry.boardCacheHits++;
      return this.fetching;
    }
    if (this.reconciling.size) return this.reconciled().then(() => this.snapshot());
    const now = this.now();
    if (now < this.retryAt) {
      if (!this.cache) return Promise.reject(this.failure);
      this.telemetry.boardCacheHits++;
      return Promise.resolve(this.cache);
    }
    const age = now - this.fetchedAt;
    const gap = this.dirty === "soft" ? BOARD_SOFT_GAP : BOARD_MIN_GAP;
    if (this.cache && (age < gap || (!this.dirty && age < BOARD_MAX_AGE))) {
      this.telemetry.boardCacheHits++;
      return Promise.resolve(this.cache);
    }
    const reason = !this.cache ? "cold" : this.dirty ?? "age";
    this.fetching = this.fetch(reason).then(async snapshot => {
      await this.reconciled();
      return this.cache ?? snapshot;
    }).finally(() => { this.fetching = undefined; this.pendingStatuses.clear(); });
    return this.fetching;
  }

  private async fetch(reason: keyof BoardTelemetry["fetchesByReason"]): Promise<BoardSnapshot> {
    const startedAt = this.now();
    const dirty = this.dirty;
    // Events received during this fetch remain dirty after it completes.
    this.dirty = undefined;
    this.telemetry.boardFetches++;
    this.telemetry.fetchesByReason[reason]++;
    this.telemetry.lastFetchReason = reason === "hard" || reason === "soft" ? "dirty" : reason;
    try {
      const { threads } = await this.client.listThreads({ active: true, limit: BOARD_LIMIT });
      if (threads.length === BOARD_LIMIT && this.now() - this.warnedAt >= BOARD_LIMIT_WARNING_GAP) {
        this.warnedAt = this.now();
        (this.options.log ?? console.warn)("board-roster-at-limit");
      }
      const entries: BoardEntry[] = [];
      for (const thread of threads) {
        if (thread.origin === IMESSAGE_ORIGIN) continue;
        entries.push(boardEntry(thread, await this.directories.of(thread)));
      }
      this.states.clear();
      this.runIds.clear();
      this.offboard.clear();
      for (const thread of threads) {
        this.states.set(thread.threadId, thread.state);
        this.runIds.set(thread.threadId, thread.activeRunId ?? thread.latestRunId);
        if (thread.origin === IMESSAGE_ORIGIN) this.offboard.add(thread.threadId);
      }
      this.cache = { version: 1, revision: 0, activatedAt: 0, migrationComplete: true, entries, syncError: null };
      // Statuses can arrive while either the roster or its folders are loading.
      for (const [threadId, update] of this.pendingStatuses) {
        this.patchStatus(this.cache, threadId, update.state);
        if (update.thread) this.patchThread(this.cache, update.thread);
      }
      this.fetchedAt = this.now();
      this.retryAt = 0;
      this.failure = undefined;
      this.telemetry.boardBackoffMs = 0;
      return this.cache;
    } catch (error) {
      this.telemetry.boardFetchErrors++;
      this.markDirty(dirty ?? "soft");
      this.failure = error;
      this.telemetry.boardBackoffMs = Math.min((this.telemetry.boardBackoffMs || 2_500) * 2, BOARD_BACKOFF_MAX);
      this.retryAt = this.now() + this.telemetry.boardBackoffMs;
      throw error;
    } finally {
      this.telemetry.lastFetchDurationMs = Math.max(0, this.now() - startedAt);
    }
  }
}

export interface RobobAlertOptions extends ControlConfigOptions, BoardOptions {
  client?: ControlClient;
  board?: ReviewBoard;
}

/** The Telegram alert backend on Robob's control API. Session ids are thread ids; `ses_` ids resolve through the import mapping. */
export class RobobAlertBackend implements AlertBackend {
  readonly brand = { app: "Robob", board: "the Board" };
  readonly client: ControlClient;
  readonly directories: ThreadDirectories;
  private readonly board: ReviewBoard;
  /** Thread id to directory; a thread's folder does not change. */
  private readonly threadDirectories = new Map<string, string>();
  private readonly native = new Map<string, string>();

  constructor(options: RobobAlertOptions = {}) {
    this.client = options.client ?? new ControlClient(options);
    this.directories = new ThreadDirectories(this.client);
    this.board = options.board ?? new ActiveThreadsBoard(this.client, this.directories, options);
  }

  private async resolve(id: string): Promise<string> {
    if (!id.startsWith("ses_")) return id;
    const known = this.native.get(id);
    if (known) return known;
    const { thread } = await this.client.byNative(id);
    this.native.set(id, thread.threadId);
    return thread.threadId;
  }

  async directoryOf(threadId: string): Promise<string> {
    const known = this.threadDirectories.get(threadId);
    if (known) return known;
    const { thread } = await this.client.thread(threadId);
    return this.remember(thread);
  }

  private async remember(thread: ThreadSummary): Promise<string> {
    const directory = await this.directories.of(thread);
    this.threadDirectories.set(thread.threadId, directory);
    if (this.threadDirectories.size > 2_000) this.threadDirectories.delete(this.threadDirectories.keys().next().value!);
    return directory;
  }

  async health() {
    const result = await this.client.request<{ status?: string; time?: string }>("GET", "/health");
    return { status: result.status === "healthy" ? "ok" : String(result.status), timestamp: String(result.time ?? ""), openchamberVersion: "robob", backend: "robob" };
  }

  sessionBoard(): Promise<BoardSnapshot> {
    return this.board.snapshot();
  }

  markDirty(reason: "hard" | "soft" = "hard", eventType?: string): void { this.board.markDirty?.(reason, eventType); }

  boardStatus(): BoardTelemetry | undefined { return this.board.status?.(); }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const { thread } = await this.client.thread(await this.resolve(id));
    return {
      id, directory: await this.remember(thread), title: thread.title,
      ...(thread.parentThreadId ? { parentID: thread.parentThreadId } : {}),
      time: { created: epoch(thread.createdAt), updated: epoch(thread.updatedAt) },
      // Children carry their root's origin, so the iMessage family check sees it directly.
      metadata: { openchamber: { ...(thread.origin ? { origin: thread.origin } : {}) } },
    };
  }

  /**
   * One `GET /requests`, scoped to a folder by each thread's directory, the way
   * OpenChamber scoped requests by location. The route lists every thread's
   * requests and is expensive on the server, so attention reads it once a tick.
   */
  async pendingRequests(): Promise<RequestReader> {
    const { requests } = await this.client.request<{ requests: Array<PendingRequest & { threadId: string }> }>("GET", "/requests");
    const inFolder = async (directory: string, kind: PendingRequest["kind"]) => {
      const found = [];
      for (const request of requests) {
        if (request.kind === kind && await this.directoryOf(request.threadId) === directory) found.push(request);
      }
      return found;
    };
    return {
      permissions: async directory => (await inFolder(directory, "approval")).map(request => permissionFrom(request, request.threadId)),
      questions: async directory => (await inFolder(directory, "question")).map(request => questionFrom(request, request.threadId)),
      directories: async () => {
        const found = new Set<string>();
        for (const request of requests) {
          const directory = await this.directoryOf(request.threadId).catch(error => {
            toolError("telegram", "tg.robob.requestDirectory", { thread: request.threadId }, error); return undefined;
          });
          if (directory !== undefined) found.add(directory);
        }
        return [...found];
      },
    };
  }

  async permissions(directory: string): Promise<PermissionRequest[]> {
    return (await this.pendingRequests()).permissions(directory);
  }

  async questions(directory: string): Promise<QuestionRequest[]> {
    return (await this.pendingRequests()).questions(directory);
  }

  async permissionReply(sessionId: string, requestId: string, _directory: string, reply: "once" | "reject"): Promise<boolean> {
    if (reply !== "once" && reply !== "reject") throw new Error("Invalid permission reply");
    await this.client.respond(await this.resolve(sessionId), requestId, { decision: reply === "once" ? "approve" : "deny" });
    return true;
  }

  async questionReply(request: QuestionRequest, _directory: string, answers: string[][]): Promise<boolean> {
    if (request.unsupported || answers.length !== request.questions.length) throw new Error("Invalid form answer");
    const body = Object.fromEntries(request.questions.map((question, index) =>
      [question.key, question.multiple === true ? answers[index]! : answers[index]![0]!]));
    await this.client.respond(await this.resolve(request.sessionID), request.id, { answers: body });
    return true;
  }

  /** Full-access threads never ask; subagents inherit their parent's mode. Undefined when unknown. */
  async isSessionAutoAccepting(sessionId: string): Promise<boolean | undefined> {
    try { return (await this.client.thread(await this.resolve(sessionId))).thread.runtimeMode === "full-access"; }
    catch (error) { toolError("telegram", "tg.robob.runtimeMode", { thread: sessionId }, error); return undefined; }
  }

  /**
   * Decodes one control event into attention.ts's vocabulary. A thread whose
   * folder cannot be read only wakes a recheck, like an unlocated OpenCode event.
   */
  async notification(data: Record<string, unknown>): Promise<NotificationEvent | undefined> {
    const type = data.type;
    const threadId = typeof data.threadId === "string" && /^[^\p{Cc}]{1,4096}$/u.test(data.threadId) ? data.threadId : undefined;
    const hard = type === "ready" || type === "thread.created" || type === "request.opened" || type === "request.resolved"
      || (type === "thread.status" && BOARD_STATES.has(data.state))
      || (type === "thread.updated" && typeof data.change === "string" && HARD_BOARD_CHANGES.has(data.change));
    // Alerts bypass the board; unknown and non-roster events can wait for the soft gap.
    if (type === "message.completed" && data.role === "assistant") {
      // Completion changes no board fields; run events refresh workRevision.
      this.board.recordLocal?.("message.completed:assistant");
    } else if (type === "thread.status" && threadId && BOARD_STATES.has(data.state) && this.board.applyStatus) {
      this.board.applyStatus(threadId, data.state as ThreadState, typeof data.runId === "string" ? data.runId : undefined);
    } else this.markDirty(hard ? "hard" : "soft", boardEventKey(type, data.change));
    if (type === "ready") return { type: "invalidate" };
    if (!threadId) return { type: "wake" };
    if (type === "thread.updated") {
      return data.change === "thread.runtime-mode-updated" ? { type: "invalidate" } : { type: "wake" };
    }
    if (type === "thread.created") return { type: "wake" };
    if (type !== "request.opened" && type !== "request.resolved" && type !== "thread.status" && type !== "message.completed") return;
    if (type === "message.completed" && data.role !== "user") return;
    const directory = await this.directoryOf(threadId).catch(error => {
      toolError("telegram", "tg.robob.eventDirectory", { thread: threadId }, error); return undefined;
    });
    if (!directory) return { type: "wake" };
    if (type === "request.opened" || type === "request.resolved") {
      const requestId = typeof data.requestId === "string" && data.requestId ? data.requestId : undefined;
      if (!requestId || (data.kind !== "approval" && data.kind !== "question")) return { type: "wake" };
      return { type: type === "request.opened" ? "asked" : "resolved", sessionId: threadId, directory, requestId, kind: data.kind };
    }
    if (type === "thread.status") {
      if (data.state === "queued") return { type: "wake" };
      return { type: "status", sessionId: threadId, directory, status: BUSY.has(data.state as ThreadState) ? "busy" : "idle" };
    }
    return { type: "changed", sessionId: threadId, directory };
  }

  /**
   * Control events as notification events. Resumes with Last-Event-ID across
   * reconnects within this process; after a restart the stream starts at the
   * live head and the opening `invalidate` makes attention reread everything.
   */
  async *notifications(signal: AbortSignal, onConnected?: () => void): AsyncGenerator<NotificationEvent, void, unknown> {
    let after: number | undefined;
    let backoff = 1_000;
    while (!signal.aborted) {
      try {
        for await (const frame of this.client.events({ signal, ...(after === undefined ? {} : { after }) })) {
          backoff = 1_000;
          onConnected?.();
          if (frame.id !== undefined && /^\d+$/.test(frame.id)) after = Number(frame.id);
          const event = await this.notification(frame.data);
          if (event) yield event;
        }
      } catch (error) {
        toolError("telegram", "tg.robob.notifications", undefined, error);
        if (signal.aborted) return;
        if (error instanceof ControlError && (error.status === 401 || error.status === 403)) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}
