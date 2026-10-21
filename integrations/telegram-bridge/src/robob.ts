import type { NotificationEvent } from "./notification-events.ts";
import {
  type AlertBackend, type BoardEntry, type BoardSnapshot, type PermissionRequest,
  type QuestionRequest, type SessionRecord, type SessionStatus,
} from "./openchamber.ts";
import {
  ControlClient, ControlError, epoch, permissionFrom, questionFrom, ThreadDirectories,
  type ControlConfigOptions, type MissionThreads, type PendingRequest, type ThreadState, type ThreadSummary,
} from "./control.ts";

/** How long one missions status read answers `leadAnswers`: about one attention tick. */
const MISSIONS_FRESH_MS = 5_000;

/** States that mean a thread is still working. `waiting` is not: its reply is out, only background work drains. */
const BUSY = new Set<ThreadState>(["running", "needs-input", "queued"]);
/** Where review notices come from: Robob's session board, or a stand-in in tests. */
export interface ReviewBoard {
  snapshot(): Promise<BoardSnapshot>;
}

/** The turn counter attention.ts uses as `workRevision`: the ordinal of the thread's newest run. */
export function runOrdinal(runId: string | null | undefined): number {
  const match = /:ordinal:(\d+)$/.exec(runId ?? "");
  return match ? Number(match[1]) : 0;
}

/** One card of Robob's session board (/api/ardud/board), as the server sends it. */
export interface RobobBoardEntry {
  threadId: string;
  projectId: string | null;
  title: string;
  state: BoardEntry["state"];
  /** `working`, `queued`, `background`, `needs-input`, `idle`, `deleted` or `unknown`. */
  status: string;
  workRevision: number;
  updatedAt: number;
  attention?: { kind: "question" | "approval"; count: number };
  worktreePath?: string | null;
}

export interface RobobBoardSnapshot {
  version: 1;
  revision: number;
  activatedAt: number;
  entries: RobobBoardEntry[];
  syncError: string | null;
}

/**
 * Maps a server card onto attention.ts's board vocabulary. The server already
 * leaves iMessage threads off the board, files automated origins under
 * scheduled and rolls subagents up into their parent, so only the live status
 * needs translating: a card is idle only when nothing under it still works.
 */
export function boardEntry(entry: RobobBoardEntry, directory: string): BoardEntry {
  return {
    sessionId: entry.threadId,
    directory,
    title: entry.title,
    ...(entry.projectId ? { projectId: entry.projectId } : {}),
    state: entry.state,
    status: entry.status === "idle" ? "idle" : entry.status === "deleted" || entry.status === "unknown" ? entry.status : "busy",
    workRevision: entry.workRevision,
    updatedAt: entry.updatedAt,
    ...(entry.attention ? { attention: entry.attention } : {}),
  };
}

export class ServerReviewBoard implements ReviewBoard {
  constructor(private readonly client: Pick<ControlClient, "board">, private readonly directories: ThreadDirectories) {}

  async snapshot(): Promise<BoardSnapshot> {
    const board = await this.client.board<RobobBoardSnapshot>();
    const entries: BoardEntry[] = [];
    for (const entry of board.entries) {
      const directory = entry.worktreePath ?? (entry.projectId ? await this.directories.rootOf(entry.projectId) : undefined) ?? "/";
      entries.push(boardEntry(entry, directory));
    }
    return { version: 1, revision: board.revision, activatedAt: board.activatedAt, migrationComplete: true, entries, syncError: board.syncError };
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
  private missionsRead?: { at: number; read: Promise<{ missions: MissionThreads[] }> };

  constructor(options: RobobAlertOptions = {}) {
    this.client = options.client ?? new ControlClient(options);
    this.directories = new ThreadDirectories(this.client);
    this.board = options.board ?? new ServerReviewBoard(this.client, this.directories);
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
   * Mission threads other than the master take their questions and permission
   * requests to their lead (Robob's router tells it). One status read serves a
   * whole attention tick.
   */
  async leadAnswers(sessionId: string): Promise<boolean> {
    try {
      const threadId = await this.resolve(sessionId);
      const { missions } = await this.missionThreads();
      return missions.some(mission => mission.masterThreadIds !== undefined
        && mission.threadIds?.includes(threadId) === true
        && !mission.masterThreadIds.includes(threadId));
    } catch { return false; }
  }

  private missionThreads(): Promise<{ missions: MissionThreads[] }> {
    const now = Date.now();
    if (!this.missionsRead || now - this.missionsRead.at > MISSIONS_FRESH_MS) {
      const read = this.client.missions();
      this.missionsRead = { at: now, read };
      // A failed read is not kept: the next check asks again.
      read.catch(() => { if (this.missionsRead?.read === read) this.missionsRead = undefined; });
    }
    return this.missionsRead.read;
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
