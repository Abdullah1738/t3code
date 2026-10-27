import type { NotificationEvent } from "./notification-events.ts";
import {
  IMESSAGE_ORIGIN, type AlertBackend, type BoardEntry, type BoardSnapshot, type PermissionRequest,
  type QuestionRequest, type RequestReader, type SessionRecord, type SessionStatus,
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
}

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
 * root threads that are not idle, iMessage chats left out (that bridge asks
 * them in-chat). Subagents are not listed; their requests are found through
 * the shared `/requests` read.
 */
export class ActiveThreadsBoard implements ReviewBoard {
  constructor(private readonly client: Pick<ControlClient, "listThreads">, private readonly directories: ThreadDirectories) {}

  async snapshot(): Promise<BoardSnapshot> {
    const { threads } = await this.client.listThreads({ active: true, limit: 500 });
    const entries: BoardEntry[] = [];
    for (const thread of threads) {
      if (thread.origin === IMESSAGE_ORIGIN) continue;
      entries.push(boardEntry(thread, await this.directories.of(thread)));
    }
    return { version: 1, revision: 0, activatedAt: 0, migrationComplete: true, entries, syncError: null };
  }
}

export interface RobobAlertOptions extends ControlConfigOptions {
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
    this.board = options.board ?? new ActiveThreadsBoard(this.client, this.directories);
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
          const directory = await this.directoryOf(request.threadId).catch(() => undefined);
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
