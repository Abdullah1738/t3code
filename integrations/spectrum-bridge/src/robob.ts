import { IMESSAGE_ORIGIN, type ChatBackend, type FilePart, type MessageRecord, type PermissionRequest, type QuestionRequest, type SessionRecord, type SessionStatus } from "./openchamber.ts";
import {
  ControlClient, ControlError, epoch, permissionFrom, questionFrom, ThreadDirectories,
  type ControlConfigOptions, type ControlMessage, type RunSummary, type ThreadDetail, type ThreadSummary,
} from "./control.ts";
import { imessagePreferences, type PreferredModel } from "./preferred-model.ts";
import type { Store } from "./store.ts";

/**
 * The control API has no system or synthetic record, so the per-turn channel
 * guidance is prepended to the prompt between these markers. messages() strips
 * it again, so recaps and turn reads only see what the owner wrote.
 */
export const GUIDANCE_START = "[Channel guidance from the iMessage bridge, not typed by the owner]";
export const GUIDANCE_END = "[End of channel guidance. The owner's message follows.]";

export function withGuidance(system: string, text: string): string {
  return system.trim() ? `${GUIDANCE_START}\n${system.trim()}\n${GUIDANCE_END}\n\n${text}` : text;
}

export function withoutGuidance(text: string): string {
  if (!text.startsWith(GUIDANCE_START)) return text;
  const end = text.indexOf(GUIDANCE_END);
  return end < 0 ? text : text.slice(end + GUIDANCE_END.length).replace(/^\n+/, "");
}

const TERMINAL = new Set(["completed", "waiting", "failed", "cancelled", "interrupted", "rolled_back"]);
const outcome = (status: string): "succeeded" | "failed" | "interrupted" =>
  status === "completed" || status === "waiting" ? "succeeded" : status === "failed" ? "failed" : "interrupted";
/** States that mean the conversation is still busy. `waiting` is not: the reply is out, only background work drains. */
const BUSY = new Set(["running", "needs-input", "queued"]);

/** The send route derives the message id from `clientRequestId`; this maps it back to the bridge's prompt id. */
export const sentMessagePrefix = (threadId: string) => `ardud-control:send:${threadId}:`;

function promptId(threadId: string, message: ControlMessage): string {
  const prefix = sentMessagePrefix(threadId);
  if (!message.messageId.startsWith(prefix)) return message.messageId;
  try { return decodeURIComponent(message.messageId.slice(prefix.length)); } catch { return message.messageId; }
}

/**
 * Rebuilds OpenCode-2-style session records from Robob runs and messages, the
 * shape the router reads turns from: each run's user prompt, its assistant
 * steps, then an `idle` marker once the run has settled. User messages the
 * agent or server sent to itself (background completion wakes) are left out:
 * to the router a user record means the owner wrote something.
 */
export function recordsFromThread(thread: Pick<ThreadDetail, "threadId" | "recentRuns" | "run" | "lastError">, messages: ControlMessage[]): MessageRecord[] {
  const runs = new Map<string, RunSummary>();
  for (const run of [...thread.recentRuns ?? [], ...(thread.run ? [thread.run] : [])]) runs.set(run.runId, run);
  const ordinal = (runId: string) => runs.get(runId)?.ordinal ?? Number(/:ordinal:(\d+)$/.exec(runId)?.[1] ?? 0);
  const byRun = new Map<string, ControlMessage[]>();
  for (const message of messages) {
    if (message.runId === null || message.role === "system") continue;
    byRun.set(message.runId, [...byRun.get(message.runId) ?? [], message]);
  }
  const latest = [...runs.values()].sort((a, b) => b.ordinal - a.ordinal)[0]?.runId;
  const records: MessageRecord[] = [];
  for (const [runId, group] of [...byRun].sort((a, b) => ordinal(a[0]) - ordinal(b[0]))) {
    group.sort((a, b) => epoch(a.createdAt) - epoch(b.createdAt) || a.messageId.localeCompare(b.messageId));
    // Runs older than the detail's recent window settled long ago.
    const status = runs.get(runId)?.status ?? "completed";
    const settled = TERMINAL.has(status);
    let last: Extract<MessageRecord, { type: "assistant" }> | undefined;
    for (const message of group) {
      const created = epoch(message.createdAt);
      if (message.role === "user") {
        if (message.createdBy !== undefined && message.createdBy !== "user") continue;
        records.push({ id: promptId(thread.threadId, message), type: "user", text: withoutGuidance(message.text), time: { created } });
        continue;
      }
      const done = settled || !message.streaming;
      last = {
        id: message.messageId, type: "assistant", content: [{ type: "text", text: message.text }],
        ...(done ? { finish: "stop" } : {}),
        time: { created, ...(done ? { completed: epoch(message.updatedAt, created) } : {}) },
      };
      records.push(last);
    }
    if (!settled) continue;
    const result = outcome(status);
    if (result === "failed" && runId === latest && thread.lastError) {
      // Carries the provider's error text, which is how a refusal is recognised.
      const error = { type: "provider", message: thread.lastError };
      if (last) last.error = error;
      else records.push({ id: `${runId}:error`, type: "assistant", content: [], finish: "error", error, time: { created: epoch(group.at(-1)?.updatedAt ?? null), completed: epoch(group.at(-1)?.updatedAt ?? null) } });
    }
    records.push({ id: `idle:${runId}`, type: "idle", outcome: result, time: { created: epoch(group.at(-1)?.updatedAt ?? null) } });
  }
  return records;
}

function dataUrl(url: string): { mimeType: string; bytes: Uint8Array } {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s.exec(url);
  if (!match) throw new Error("Unsupported attachment URL");
  return { mimeType: match[1]!, bytes: new Uint8Array(Buffer.from(match[2]!, "base64")) };
}

export interface RobobBackendOptions extends ControlConfigOptions {
  /** Root for per-chat folders. It must be a registered Robob project root (see README). */
  chatRoot: string;
  /**
   * Model for a new chat thread. Defaults to the bridge's `imessage` preference;
   * without one Robob's own default model applies. Every prompt also carries the
   * preference, so a later config change applies from the next turn.
   */
  model?: () => Promise<PreferredModel | undefined>;
  client?: ControlClient;
}

/** The iMessage router's backend on Robob's control API. Accepts thread ids and OpenCode `ses_` ids alike. */
export class RobobBackend implements ChatBackend {
  readonly brand = { app: "Robob" };
  readonly client: ControlClient;
  private readonly chatRoot: string;
  private readonly directories: ThreadDirectories;
  private readonly native = new Map<string, string>();

  constructor(private readonly options: RobobBackendOptions) {
    if (!options.chatRoot.startsWith("/") || options.chatRoot.includes("\0")) throw new Error("Invalid iMessage chat root");
    this.chatRoot = options.chatRoot.replace(/\/+$/, "");
    this.client = options.client ?? new ControlClient(options);
    this.directories = new ThreadDirectories(this.client);
  }

  /** Thread id for a stored route id. `ses_` ids resolve through the OpenCode import mapping. */
  async resolve(id: string): Promise<string> {
    if (!id.startsWith("ses_")) return id;
    const known = this.native.get(id);
    if (known) return known;
    const { thread } = await this.client.byNative(id);
    this.native.set(id, thread.threadId);
    return thread.threadId;
  }

  /** Robob threads can reset their agent's context in place (t3_context_reset). Imported `ses_` routes move to a new chat instead. */
  resetsContext(id: string): boolean {
    return !id.startsWith("ses_");
  }

  private async detail(id: string): Promise<ThreadDetail> {
    return (await this.client.thread(await this.resolve(id))).thread;
  }

  async health() {
    const result = await this.client.request<{ status?: string; time?: string }>("GET", "/health");
    return { status: result.status === "healthy" ? "ok" : String(result.status), timestamp: String(result.time ?? ""), openchamberVersion: "robob", backend: "robob" };
  }

  /** True when the chat root is a registered project, so chat folders join it instead of becoming projects. */
  async chatRootRegistered(): Promise<boolean> {
    return (await this.directories.refresh()).some(project => project.workspaceRoot.replace(/\/+$/, "") === this.chatRoot);
  }

  async createChat(title?: string): Promise<{ id: string; directory: string }> {
    if (!await this.chatRootRegistered()) throw new Error("iMessage chat root is not a Robob project");
    const now = new Date();
    const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
    const directory = `${this.chatRoot}/${date}/session-${crypto.randomUUID()}`;
    const model = await (this.options.model ?? (async () => (await imessagePreferences()).model))().catch(() => undefined);
    const created = await this.client.request<{ threadId: string; directory: string | null }>("POST", "/threads", {
      directory, origin: IMESSAGE_ORIGIN, runtimeMode: "full-access",
      title: title ?? `iMessage ${date} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
      ...(model ? { model: `${model.providerID}/${model.modelID}`, ...(model.variant ? { variant: model.variant } : {}) } : {}),
    });
    if (typeof created.threadId !== "string" || !created.threadId) throw new Error("Invalid Robob thread response");
    return { id: created.threadId, directory: created.directory ?? directory };
  }

  async markImessageOrigin(id: string): Promise<"marked" | "already" | "missing"> {
    let thread: ThreadDetail;
    try {
      thread = await this.detail(id);
    } catch (error) {
      // An unimported `ses_` id is not missing yet; only a known thread id can be.
      if (error instanceof ControlError && error.status === 404 && !id.startsWith("ses_")) return "missing";
      throw error;
    }
    if (thread.origin === IMESSAGE_ORIGIN) return "already";
    await this.client.request("PUT", `/threads/${encodeURIComponent(thread.threadId)}/origin`, { origin: IMESSAGE_ORIGIN });
    return "marked";
  }

  async retireOthers(keepId: string): Promise<number> {
    const keep = await this.resolve(keepId);
    const { threads } = await this.client.listThreads({ origin: IMESSAGE_ORIGIN, limit: 500 });
    let settled = 0;
    for (const thread of threads) {
      if (thread.threadId === keep || thread.parentThreadId || thread.settled || thread.archived || BUSY.has(thread.state) || thread.pendingRequest) continue;
      try {
        const result = await this.client.request<{ thread?: { settled?: boolean } } | undefined>("PATCH", `/threads/${encodeURIComponent(thread.threadId)}`, { settled: true });
        // An older server ignores the field and answers 200, so only count what it reports as settled.
        if (result?.thread?.settled === true) settled += 1;
      } catch {
        // A thread that started a run in the meantime refuses to settle; leave it.
      }
    }
    return settled;
  }

  private async record(id: string, thread: ThreadSummary, parentID?: string): Promise<SessionRecord> {
    return {
      id, directory: await this.directories.of(thread), title: thread.title,
      ...(parentID ?? thread.parentThreadId ? { parentID: parentID ?? thread.parentThreadId! } : {}),
      time: { created: epoch(thread.createdAt), updated: epoch(thread.updatedAt) },
      metadata: { openchamber: { ...(thread.origin ? { origin: thread.origin } : {}) } },
    };
  }

  async getSession(id: string, _directory?: string): Promise<SessionRecord | undefined> {
    return this.record(id, await this.detail(id));
  }

  async children(id: string, _directory?: string): Promise<SessionRecord[]> {
    const threadId = await this.resolve(id);
    const { threads } = await this.client.listThreads({ parentThreadId: threadId, includeSubagents: true, limit: 500 });
    return Promise.all(threads.filter(thread => thread.parentThreadId === threadId).map(thread => this.record(thread.threadId, thread, id)));
  }

  async messages(id: string, _directory?: string, { until, limit = 100 }: { until?: string; since?: number; limit?: number } = {}): Promise<MessageRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid message limit");
    const threadId = await this.resolve(id);
    const [{ thread }, { messages }] = await Promise.all([this.client.thread(threadId), this.client.messages(threadId)]);
    const records = recordsFromThread(thread, messages);
    const found = until === undefined ? -1 : records.findIndex(record => record.id === until);
    // Like the OpenChamber pager: the newest page, extended back to `until` when it is present.
    const start = found >= 0 ? Math.min(found, Math.max(0, records.length - limit)) : Math.max(0, records.length - limit);
    return records.slice(start);
  }

  async promptAccepted(id: string, _directory: string, messageId: string): Promise<boolean> {
    const threadId = await this.resolve(id);
    const { messages } = await this.client.messages(threadId);
    return messages.some(message => message.role === "user" && promptId(threadId, message) === messageId);
  }

  /**
   * One send per prompt. `clientRequestId` is the router's prompt id, so a
   * retried POST replays instead of sending twice, and the message reads back
   * under that id. The send returns once Robob durably accepted it.
   */
  async prompt(id: string, _directory: string, messageId: string, text: string, system = "", files: readonly FilePart[] = [],
    model?: { providerID: string; modelID: string; variant?: string }): Promise<void> {
    const threadId = await this.resolve(id);
    const attachments = [];
    for (const [index, file] of files.entries()) {
      const { mimeType, bytes } = dataUrl(file.url);
      attachments.push(await this.client.upload({ name: file.filename ?? `attachment-${index + 1}`, mimeType: file.mime || mimeType, bytes }));
    }
    await this.client.request("POST", `/threads/${encodeURIComponent(threadId)}/send`, {
      text: withGuidance(system, text), mode: "auto", clientRequestId: messageId,
      ...(model ? { model: `${model.providerID}/${model.modelID}`, ...(model.variant ? { variant: model.variant } : {}) } : {}),
      ...(attachments.length ? { attachments } : {}),
    }, { timeoutMs: 60_000 });
  }

  async abort(id: string, _directory?: string): Promise<boolean> {
    const threadId = await this.resolve(id);
    const result = await this.client.request<{ interrupted?: unknown }>("POST", `/threads/${encodeURIComponent(threadId)}/interrupt`, {});
    return result.interrupted === true;
  }

  /** Busy threads, keyed by thread id and, for imported threads, by their `ses_` id too. */
  async statuses(): Promise<Record<string, SessionStatus>> {
    const { threads } = await this.client.listThreads({ active: true, includeSubagents: true, limit: 500 });
    const statuses: Record<string, SessionStatus> = {};
    for (const thread of threads) {
      if (!BUSY.has(thread.state)) continue;
      statuses[thread.threadId] = { type: "busy" };
      if (thread.nativeSessionId) statuses[thread.nativeSessionId] = { type: "busy" };
    }
    for (const [session, threadId] of this.native) if (statuses[threadId]) statuses[session] = { type: "busy" };
    return statuses;
  }

  async permissions(sessionId: string, _directory?: string): Promise<PermissionRequest[]> {
    const thread = await this.detail(sessionId);
    return thread.pendingRequests.filter(request => request.kind === "approval").map(request => permissionFrom(request, sessionId));
  }

  async questions(sessionId: string, _directory?: string): Promise<QuestionRequest[]> {
    const thread = await this.detail(sessionId);
    return thread.pendingRequests.filter(request => request.kind === "question").map(request => questionFrom(request, sessionId));
  }

  async permissionReply(sessionId: string, requestId: string, _directory: string, reply: "once" | "reject"): Promise<boolean> {
    if (reply !== "once" && reply !== "reject") throw new Error("Invalid permission reply");
    await this.client.respond(await this.resolve(sessionId), requestId, { decision: reply === "once" ? "approve" : "deny" });
    return true;
  }

  /** Answers keyed by question id; values are the option labels (or free text where allowed). */
  async questionReply(request: QuestionRequest, _directory: string, answers: string[][]): Promise<boolean> {
    if (request.unsupported || answers.length !== request.questions.length) throw new Error("Invalid form answer");
    const body = Object.fromEntries(request.questions.map((question, index) =>
      [question.key, question.multiple === true ? answers[index]! : answers[index]![0]!]));
    await this.client.respond(await this.resolve(request.sessionID), request.id, { answers: body });
    return true;
  }

  async cancelQuestion(sessionId: string, requestId: string): Promise<boolean> {
    await this.client.respond(await this.resolve(sessionId), requestId, { dismiss: true });
    return true;
  }

  /** Robob threads in full-access mode never ask; subagents inherit the mode. Undefined when unknown. */
  async isSessionAutoAccepting(sessionId: string, _directory?: string): Promise<boolean | undefined> {
    try { return (await this.detail(sessionId)).runtimeMode === "full-access"; } catch { return undefined; }
  }
}

/**
 * A stored `ses_` route that Robob cannot map (the OpenCode importer has not
 * covered it) would stall every turn. Drop it so the next text starts a fresh
 * chat; any other failure leaves the route alone.
 */
export async function retireUnresolvedRoute(store: Store, backend: Pick<RobobBackend, "resolve">): Promise<boolean> {
  const route = store.get<{ id?: unknown } | null>("route");
  if (typeof route?.id !== "string" || !route.id.startsWith("ses_")) return false;
  try {
    await backend.resolve(route.id);
    return false;
  } catch (error) {
    if (!(error instanceof ControlError) || error.status !== 404) return false;
  }
  store.db.transaction(() => {
    if ((store.get<{ id?: unknown } | null>("route"))?.id !== route.id) return;
    store.set("route", null);
    store.set("activeTurn", null);
    store.set("pendingApprovals", null);
    store.set("watermark", null);
  }).immediate();
  return true;
}
