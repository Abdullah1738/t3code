import type { NotificationEvent } from "./notification-events.ts";
import {
  IMESSAGE_ORIGIN, type AlertBackend, type BoardEntry, type BoardSnapshot, type PermissionRequest,
  type QuestionRequest, type SessionRecord, type SessionStatus,
} from "./openchamber.ts";
import {
  ControlClient, ControlError, epoch, permissionFrom, questionFrom, ThreadDirectories,
  type ControlConfigOptions, type PendingRequest, type ThreadState, type ThreadSummary,
} from "./control.ts";

/** States that mean a thread is still working. `waiting` is not: its reply is out, only background work drains. */
const BUSY = new Set<ThreadState>(["running", "needs-input", "queued"]);
/** Fixed activation stamp of the derived board, so its review baseline never mixes with OpenChamber's. */
export const ROBOB_BOARD_ACTIVATED = 1_000;

/**
 * Where review notices come from. Until Robob's session board
 * (/api/ardud/board/*) is ready, ThreadReviewBoard derives one from the
 * control API's thread list; the real board plugs in here later.
 */
export interface ReviewBoard {
  snapshot(): Promise<BoardSnapshot>;
}

/** The turn counter attention.ts uses as `workRevision`: the ordinal of the thread's newest run. */
export function runOrdinal(runId: string | null | undefined): number {
  const match = /:ordinal:(\d+)$/.exec(runId ?? "");
  return match ? Number(match[1]) : 0;
}

/**
 * Board state for one root thread, or undefined when it never belongs on the
 * board. iMessage threads are quiet. Other origins (automation, crw, watcher)
 * are someone else's to review, so they count as scheduled, which attention.ts
 * never announces. A thread the owner marked settled counts as backlog.
 */
export function boardEntry(thread: ThreadSummary, directory: string): BoardEntry | undefined {
  if (thread.origin === IMESSAGE_ORIGIN || thread.archived) return;
  const busy = BUSY.has(thread.state);
  const state: BoardEntry["state"] = thread.origin !== null ? "scheduled" : thread.settled ? "backlog" : busy ? "running" : "waiting";
  return {
    sessionId: thread.threadId,
    directory,
    title: thread.title,
    ...(thread.parentThreadId ? { parentId: thread.parentThreadId } : {}),
    projectId: thread.projectId,
    state,
    status: busy ? "busy" : "idle",
    workRevision: runOrdinal(thread.latestRunId),
    updatedAt: epoch(thread.updatedAt),
    ...(thread.pendingRequest ? { attention: { kind: thread.pendingRequest.kind, count: 1 } } : {}),
  };
}

export class ThreadReviewBoard implements ReviewBoard {
  constructor(private readonly client: Pick<ControlClient, "listThreads">, private readonly directories: ThreadDirectories, private readonly limit = 200) {}

  async snapshot(): Promise<BoardSnapshot> {
    const { threads } = await this.client.listThreads({ limit: this.limit });
    const entries: BoardEntry[] = [];
    for (const thread of threads) {
      const entry = boardEntry(thread, await this.directories.of(thread));
      if (entry) entries.push(entry);
    }
    return { version: 1, revision: 0, activatedAt: ROBOB_BOARD_ACTIVATED, migrationComplete: true, entries };
  }
}

export interface RobobAlertOptions extends ControlConfigOptions {
  client?: ControlClient;
  board?: ReviewBoard;
}

/** The Telegram alert backend on Robob's control API. Session ids are thread ids; `ses_` ids resolve through the import mapping. */
export class RobobAlertBackend implements AlertBackend {
  readonly client: ControlClient;
  readonly directories: ThreadDirectories;
  private readonly board: ReviewBoard;
  /** Thread id to directory; a thread's folder does not change. */
  private readonly threadDirectories = new Map<string, string>();
  private readonly native = new Map<string, string>();

  constructor(options: RobobAlertOptions = {}) {
    this.client = options.client ?? new ControlClient(options);
    this.directories = new ThreadDirectories(this.client);
    this.board = options.board ?? new ThreadReviewBoard(this.client, this.directories);
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

  async statuses(): Promise<Record<string, SessionStatus>> {
    const { threads } = await this.client.listThreads({ active: true, includeSubagents: true, limit: 500 });
    const statuses: Record<string, SessionStatus> = {};
    for (const thread of threads) if (BUSY.has(thread.state)) statuses[thread.threadId] = { type: "busy" };
    return statuses;
  }

  /** Pending requests whose thread runs in `directory`, the way OpenChamber scoped them by location. */
  private async pending(directory: string, kind: PendingRequest["kind"]): Promise<Array<PendingRequest & { threadId: string }>> {
    const { requests } = await this.client.request<{ requests: Array<PendingRequest & { threadId: string }> }>("GET", "/requests");
    const found = [];
    for (const request of requests) {
      if (request.kind === kind && await this.directoryOf(request.threadId) === directory) found.push(request);
    }
    return found;
  }

  async permissions(directory: string): Promise<PermissionRequest[]> {
    return (await this.pending(directory, "approval")).map(request => permissionFrom(request, request.threadId));
  }

  async questions(directory: string): Promise<QuestionRequest[]> {
    return (await this.pending(directory, "question")).map(request => questionFrom(request, request.threadId));
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
    try { return (await this.client.thread(await this.resolve(sessionId))).thread.runtimeMode === "full-access"; } catch { return undefined; }
  }

  /**
   * Decodes one control event into attention.ts's vocabulary. A thread whose
   * folder cannot be read only wakes a recheck, like an unlocated OpenCode event.
   */
  async notification(data: Record<string, unknown>): Promise<NotificationEvent | undefined> {
    const type = data.type;
    if (type === "ready") return { type: "invalidate" };
    const threadId = typeof data.threadId === "string" && /^[^\p{Cc}]{1,4096}$/u.test(data.threadId) ? data.threadId : undefined;
    if (!threadId) return { type: "wake" };
    if (type === "thread.updated") return data.change === "thread.runtime-mode-updated" ? { type: "invalidate" } : { type: "wake" };
    if (type === "thread.created") return { type: "wake" };
    if (type !== "request.opened" && type !== "request.resolved" && type !== "thread.status" && type !== "message.completed") return;
    if (type === "message.completed" && data.role !== "user") return;
    const directory = await this.directoryOf(threadId).catch(() => undefined);
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
        if (signal.aborted) return;
        if (error instanceof ControlError && (error.status === 401 || error.status === 403)) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}
