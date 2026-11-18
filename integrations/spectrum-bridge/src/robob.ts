import { MessageCache } from "./message-cache.ts";
import { toolError } from "./toollog.ts";
import { IMESSAGE_ORIGIN, isCompletionNoticeText, subagentNoticeState, type ChatBackend, type FilePart, type MessageRecord, type OwnerWords, type PermissionRequest, type QuestionRequest, type SessionRecord, type SessionStatus, type SteerDelivery, type SteerGuard } from "./openchamber.ts";
import {
  ControlClient, ControlError, epoch, permissionFrom, questionFrom, ThreadDirectories,
  type ControlConfigOptions, type ControlMessage, type RunSummary, type ThreadDetail, type ThreadSummary,
} from "./control.ts";
import { nativeMessageId, opencodeCompletedSteps, opencodeFinishes, opencodeRunEvidence, type CompletedSteps, type RunEvidence, type StepFinishes } from "./opencode-steps.ts";
import { controlModelFields, imessagePreferences, type PreferredModel } from "./preferred-model.ts";
import type { Store } from "./store.ts";
import { controlDisposition } from "./control-errors.ts";
import { createHash } from "node:crypto";

/**
 * Per-turn channel guidance goes to Robob beside the message (`guidance`), and
 * Robob frames it between these markers for the agent. Older messages carry it
 * inline; messages() strips it, so recaps and turn reads only see his words.
 */
export const GUIDANCE_START = "[Channel guidance from the iMessage bridge, not typed by the owner]";
export const GUIDANCE_END = "[End of channel guidance. The owner's message follows.]";

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

/** Some providers return the selected-model complaint as a completed assistant message. */
export const SELECTED_MODEL_ISSUE = /^\s*(?:there['’]s|there is) an issue with the selected model\s*\([^\r\n)]+\)(?:[.!:]|$)/i;

function runFailure(thread: Pick<ThreadDetail, "lastError">, run: RunSummary, messages: ControlMessage[], latest: boolean): string | undefined {
  if (!TERMINAL.has(run.status)) return;
  const complaint = messages.find(message => message.runId === run.runId && message.role === "assistant" && SELECTED_MODEL_ISSUE.test(message.text))?.text;
  return (latest && (run.status === "failed" || run.ordinal === 1 || complaint) && thread.lastError) || complaint || (run.status === "failed" ? "Run failed without error details" : undefined);
}

/** The send route derives the message id from `clientRequestId`; this maps it back to the bridge's prompt id. */
export const sentMessagePrefix = (threadId: string) => `ardud-control:send:${threadId}:`;

function promptId(threadId: string, message: ControlMessage): string {
  const prefix = sentMessagePrefix(threadId);
  if (!message.messageId.startsWith(prefix)) return message.messageId;
  try { return decodeURIComponent(message.messageId.slice(prefix.length)); } catch (caughtError) { toolError("robob", "robob.catch1", caughtError); return message.messageId; }
}

/** The router's prompt ids (`msg_` plus a sha256), which it sends as `clientRequestId`. */
const BRIDGE_PROMPT = /^msg_[0-9a-f]{64}$/;
const runOrdinal = (runId: string) => Number(/:ordinal:(\d+)$/.exec(runId)?.[1] ?? 0);

/**
 * Rebuilds OpenCode-2-style session records from Robob runs and messages, the
 * shape the router reads turns from: each run's user prompt, its assistant
 * steps, then an `idle` marker once the run has settled. User messages the
 * agent or server sent to itself are left out, except completion and native progress notices:
 * the router needs their boundaries when a completion races a sealed wake. The bridge's
 * own prompts stay in even when Robob did not record them as the owner's (a
 * relay it could not verify is attributed to the bridge, not to him).
 */
export function recordsFromThread(thread: Pick<ThreadDetail, "threadId" | "recentRuns" | "run" | "lastError">, messages: ControlMessage[]): MessageRecord[] {
  const runs = new Map<string, RunSummary>();
  for (const run of [...thread.recentRuns ?? [], ...(thread.run ? [thread.run] : [])]) runs.set(run.runId, run);
  const ordinal = (runId: string) => runs.get(runId)?.ordinal ?? runOrdinal(runId);
  const byRun = new Map<string, ControlMessage[]>();
  for (const message of messages) {
    if (message.runId === null || message.role === "system") continue;
    byRun.set(message.runId, [...byRun.get(message.runId) ?? [], message]);
  }
  const latest = [...runs.values()].sort((a, b) => b.ordinal - a.ordinal)[0]?.runId;
  const records: MessageRecord[] = [];
  for (const [runId, group] of [...byRun].sort((a, b) => ordinal(a[0]) - ordinal(b[0]))) {
    group.sort((a, b) => epoch(a.createdAt) - epoch(b.createdAt) || a.messageId.localeCompare(b.messageId, undefined, { numeric: true }));
    const run = runs.get(runId);
    const settled = run !== undefined && TERMINAL.has(run.status);
    let last: Extract<MessageRecord, { type: "assistant" }> | undefined;
    for (const message of group) {
      const created = epoch(message.createdAt);
      if (message.role === "user") {
        const id = promptId(thread.threadId, message);
        const bridgeSent = id !== message.messageId && BRIDGE_PROMPT.test(id);
        const notice = isCompletionNoticeText(message.text) || subagentNoticeState(message.text) !== undefined;
        if (message.createdBy !== undefined && message.createdBy !== "user" && !bridgeSent && !notice) continue;
        records.push({ id, type: "user", text: withoutGuidance(message.text), time: { created },
          ...(notice && message.createdBy !== undefined ? { createdBy: message.createdBy } : {}) });
        continue;
      }
      const done = settled || !message.streaming;
      // Robob's own phase says whether this text was the reply. It is never a made-up OpenCode finish:
      // `unknown` stays unmarked, so the router treats it as neither an answer nor proof of a tool.
      last = {
        id: message.messageId, type: "assistant", content: [{ type: "text", text: message.text }], runId,
        ...(message.phase === "answer" ? { answer: true } : message.phase === "narration" ? { answer: false } : {}),
        time: { created, ...(done ? { completed: epoch(message.updatedAt, created) } : {}) },
      };
      records.push(last);
    }
    if (!settled || !run) continue;
    const failure = runFailure(thread, run, group, runId === latest);
    const result = failure ? "failed" : outcome(run.status);
    if (failure) {
      // Carries the provider's error text, which is how a refusal is recognised.
      const error = { type: "provider", message: failure };
      if (last) last.error = error;
      else records.push({ id: `${runId}:error`, type: "assistant", content: [], runId, finish: "error", error, time: { created: epoch(group.at(-1)?.updatedAt ?? null), completed: epoch(group.at(-1)?.updatedAt ?? null) } });
    }
    records.push({ id: `idle:${runId}`, type: "idle", outcome: result,
      ...(run.completedAt ? { completedAt: epoch(run.completedAt) } : {}),
      ...(failure && run.ordinal === 1 ? { firstTurnFailure: true } : {}),
      ...(group.some(message => message.role === "assistant" && SELECTED_MODEL_ISSUE.test(message.text)) ? { modelError: true } : {}),
      time: { created: epoch(group.at(-1)?.updatedAt ?? null) } });
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
  /**
   * Folder under `chatRoot` for this chat's threads (Sendblue non-owner chats use `chats/<slug>`).
   * The project-root check stays on `chatRoot` so every chat joins the one iMessage project.
   */
  subdir?: string;
  /** Title for new threads, e.g. the person's or group's name. */
  title?: string;
  /** How each assistant step ended, read from OpenCode (see opencode-steps.ts). */
  finishes?: StepFinishes;
  /** Completed native blocks for interrupted OpenCode replies. */
  completedSteps?: CompletedSteps;
  /** Whether a native run called tools (see opencode-steps.ts opencodeRunEvidence). */
  runEvidence?: RunEvidence;
  /**
   * Raises one alert when a thread this backend created fails its first turn (see `checkFirstTurn`).
   * Unset means no alerts; only the running bridge wires it to Telegram.
   */
  alert?: (threadId: string, text: string) => Promise<boolean>;
}

const CHATS_DIR = "chats";

/** The iMessage router's backend on Robob's control API. Accepts thread ids and OpenCode `ses_` ids alike. */
export class RobobBackend implements ChatBackend {
  readonly brand = { app: "Robob" };
  readonly client: ControlClient;
  private readonly chatRoot: string;
  private readonly directories: ThreadDirectories;
  private readonly native = new Map<string, string>();
  private readonly finishes: StepFinishes;
  private readonly completedSteps: CompletedSteps;
  private readonly runEvidence: RunEvidence;
  /** A step's finish never changes once written, so each is looked up once. */
  private readonly finished = new Map<string, string>();
  /**
   * Proven evidence for runs that have settled, keyed by thread and run. Only `ran` or `none` is kept:
   * an `unknown` can still resolve, so it is always asked again. A settled run's proof never changes.
   */
  private readonly settledEvidence = new Map<string, "ran" | "none">();
  private readonly sendRuns = new Map<string, { at: number; runId?: string }>();
  private readonly sendFiles = new Map<string, { fingerprint: string; attachments: Awaited<ReturnType<ControlClient["upload"]>>[] }>();
  private readonly sendBodies = new Map<string, Record<string, unknown>>();
  private readonly messageCache: MessageCache;

  messageReadScope<T>(body: () => Promise<T>): Promise<T> {
    return this.messageCache.withinTick(body);
  }

  private readMessages(threadId: string, thread: ThreadDetail, until?: string): Promise<ControlMessage[]> {
    return this.messageCache.read(threadId, JSON.stringify([thread.run, thread.recentRuns, thread.lastError]), until === undefined ? undefined : messages =>
      recordsFromThread(thread, messages).some(record => record.id === until)
      || messages.some(message => until === `idle:${message.runId}` || until === `${message.runId}:error`));
  }

  private readonly historicalRuns = new Map<string, RunSummary>();
  /** Threads createChat made whose first turn has not been judged yet. */
  private readonly firstTurns = new Map<string, string | null>();
  private readonly checkingFirstTurns = new Set<string>();
  private firstTurnStore?: Pick<Store, "get" | "set">;

  /** Each chat's store keeps pending first-turn checks across a bridge restart. */
  trackFirstTurns(store: Pick<Store, "get" | "set">): void {
    this.firstTurnStore = store;
    const pending = store.get<unknown>("firstTurns");
    if (Array.isArray(pending)) for (const entry of pending as unknown[]) {
      if (!entry || typeof entry !== "object" || !("id" in entry) || !("alert" in entry)) continue;
      if (typeof entry.id === "string" && (entry.alert === null || typeof entry.alert === "string")) this.firstTurns.set(entry.id, entry.alert);
    }
  }

  private saveFirstTurns(): void {
    this.firstTurnStore?.set("firstTurns", [...this.firstTurns].map(([id, alert]) => ({ id, alert })));
  }

  constructor(private readonly options: RobobBackendOptions) {
    if (!options.chatRoot.startsWith("/") || options.chatRoot.includes("\0")) throw new Error("Invalid iMessage chat root");
    this.chatRoot = options.chatRoot.replace(/\/+$/, "");
    if (options.subdir !== undefined && !/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/.test(options.subdir)) throw new Error("Invalid iMessage chat folder");
    this.client = options.client ?? new ControlClient(options);
    this.directories = new ThreadDirectories(this.client);
    this.messageCache = new MessageCache(this.client);
    this.finishes = options.finishes ?? opencodeFinishes();
    this.completedSteps = options.completedSteps ?? opencodeCompletedSteps();
    this.runEvidence = options.runEvidence ?? opencodeRunEvidence();
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

  /**
   * Whether the run that started at `sinceMs` called tools. Robob's run-evidence route answers; only an
   * OpenCode thread the route can't prove falls back to OpenCode's step rows. Unproven is `unknown`.
   */
  async runToolEvidence(id: string, _directory: string, sinceMs: number): Promise<"ran" | "none" | "unknown"> {
    if (!Number.isFinite(sinceMs)) return "unknown";
    try {
      const threadId = await this.resolve(id);
      const { thread } = await this.client.thread(threadId);
      const started = (run: RunSummary) => Date.parse(run.requestedAt ?? run.startedAt ?? "");
      const runs = [...thread.recentRuns ?? [], ...(thread.run ? [thread.run] : [])];
      const run = runs.filter(candidate => started(candidate) >= sinceMs).sort((a, b) => started(a) - started(b))[0];
      if (!run) return "unknown";
      const fromRobob = (await this.client.runEvidence(threadId, run.runId)).toolEvidence;
      if (fromRobob !== "unknown" || !this.isOpenCodeThread(thread) || !thread.nativeSessionId) return fromRobob;
      return this.runEvidence(thread.nativeSessionId, sinceMs);
    } catch (caughtError) { toolError("robob", "robob.catch2", caughtError);
      return "unknown";
    }
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
    const directory = `${this.chatFolder()}/${date}/session-${crypto.randomUUID()}`;
    const model = await (this.options.model ?? (async () => (await imessagePreferences()).model))().catch((caughtError) => { toolError("robob", "robob.catch3", caughtError); return undefined; });
    const created = await this.client.request<{ threadId: string; directory: string | null }>("POST", "/threads", {
      directory, origin: IMESSAGE_ORIGIN, runtimeMode: "full-access",
      title: title ?? this.options.title ?? `iMessage ${date} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
      ...(model ? controlModelFields(model) : {}),
    });
    if (typeof created.threadId !== "string" || !created.threadId) throw new Error("Invalid Robob thread response");
    if (this.options.alert) {
      this.firstTurns.set(created.threadId, null);
      this.saveFirstTurns();
    }
    return { id: created.threadId, directory: created.directory ?? directory };
  }

  /**
   * A new chat whose first turn fails usually fails every turn after it (a model its provider
   * instance can't run), and the owner only sees "something went wrong". So once the first run
   * settles, a failure, a lastError or the selected-model complaint raises one alert. Each
   * thread is judged once: a good first turn, or any later turn, never alerts.
   */
  private async checkFirstTurn(thread: ThreadDetail, messages: ControlMessage[]): Promise<void> {
    if (!this.firstTurns.has(thread.threadId) || !this.options.alert || this.checkingFirstTurns.has(thread.threadId)) return;
    let alert = this.firstTurns.get(thread.threadId);
    if (!alert) {
      const runs = [...thread.recentRuns, ...(thread.run ? [thread.run] : [])];
      const first = runs.find(run => run.ordinal === 1);
      if (!first || !TERMINAL.has(first.status)) return;
      const error = runFailure(thread, first, messages, !runs.some(run => run.ordinal > first.ordinal));
      if (!error) {
        this.firstTurns.delete(thread.threadId);
        this.saveFirstTurns();
        return;
      }
      const selection = first.model ?? thread.model;
      const model = selection ? `model=${selection.model}, instanceId=${selection.instanceId}` : "model and instanceId unknown";
      const detail = error.replace(/\s+/g, " ").trim().slice(0, 500);
      alert = `New iMessage thread "${thread.title}" (${thread.threadId}) failed its first turn: ${model}. Error: ${detail}`;
      // Keep the verdict before sending: a later run may clear lastError while Telegram is down.
      this.firstTurns.set(thread.threadId, alert);
      this.saveFirstTurns();
    }
  }

  /** A route can rotate while Telegram is down; already-recorded alerts belong to the chat, not its current route. */
  private async flushFirstTurnAlert(): Promise<void> {
    if (!this.options.alert) return;
    const pending = [...this.firstTurns].find(([id, text]) => text !== null && !this.checkingFirstTurns.has(id));
    if (!pending || pending[1] === null) return;
    const [id, text] = pending;
    this.checkingFirstTurns.add(id);
    try {
      if (await this.options.alert(id, text)) {
        this.firstTurns.delete(id);
        this.saveFirstTurns();
      }
    } catch (caughtError) { toolError("robob", "robob.catch4", caughtError); /* The durable payload is attempted on the next read. */ }
    finally { this.checkingFirstTurns.delete(id); }
  }

  /** Backend for one non-owner Sendblue chat: same server and client, its own folder and thread title. */
  forChat(subdir: string, title: string): RobobBackend {
    return new RobobBackend({ ...this.options, client: this.client, finishes: this.finishes, completedSteps: this.completedSteps, subdir, title });
  }

  chatFolder(): string {
    return this.options.subdir ? `${this.chatRoot}/${this.options.subdir}` : this.chatRoot;
  }

  private ownsFolder(path: string | null): boolean {
    const chats = `${this.chatRoot}/${CHATS_DIR}/`;
    if (!this.options.subdir) return !path?.startsWith(chats);
    return path?.startsWith(`${this.chatFolder()}/`) === true;
  }

  async markImessageOrigin(id: string): Promise<"marked" | "already" | "missing"> {
    let thread: ThreadDetail;
    try {
      thread = await this.detail(id);
    } catch (error) { toolError("robob", "robob.catch5", error);
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
    this.messageCache.routeChange();
    const { threads } = await this.client.listThreads({ origin: IMESSAGE_ORIGIN, limit: 500 });
    let settled = 0;
    for (const thread of threads) {
      if (thread.threadId === keep || thread.parentThreadId || thread.settled || thread.archived || BUSY.has(thread.state) || thread.pendingRequest) continue;
      // Each Sendblue chat retires only its own threads; another person's live chat is not stale.
      if (!this.ownsFolder(thread.worktreePath)) continue;
      try {
        const result = await this.client.request<{ thread?: { settled?: boolean } } | undefined>("PATCH", `/threads/${encodeURIComponent(thread.threadId)}`, { settled: true });
        // An older server ignores the field and answers 200, so only count what it reports as settled.
        if (result?.thread?.settled === true) settled += 1;
      } catch (caughtError) { toolError("robob", "robob.catch6", caughtError);
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

  async children(id: string, _directory?: string, complete = false): Promise<SessionRecord[]> {
    const threadId = await this.resolve(id);
    const { total, threads } = await this.client.listThreads({ parentThreadId: threadId, includeSubagents: true, limit: 500 });
    if (complete && total > threads.length) throw new Error("Incomplete child discovery");
    return Promise.all(threads.filter(thread => thread.parentThreadId === threadId).map(thread => this.record(thread.threadId, thread, id)));
  }

  async messages(id: string, _directory?: string, { until, since, limit = 100 }: { until?: string; since?: number; limit?: number } = {}): Promise<MessageRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid message limit");
    const threadId = await this.resolve(id);
    // Read messages after the run state: an earlier page must not make a just-completed
    // first turn look successful before its selected-model error text has arrived.
    let { thread } = await this.client.thread(threadId);
    let messages = await this.readMessages(threadId, thread, until);
    try {
      thread = await this.restoreRunStatuses(thread, messages, until, limit);
    } catch (error) {
      if (!(error instanceof ControlError) || error.status !== 404) throw error;
      messages = await this.messageCache.resync(threadId, JSON.stringify([thread.run, thread.recentRuns, thread.lastError]));
      thread = await this.restoreRunStatuses(thread, messages, until, limit);
    }
    await this.checkFirstTurn(thread, messages);
    await this.flushFirstTurnAlert();
    // The send receipt identifies the run even if an older failure is still in the page.
    // Persist the send time before POST too: lost responses and bridge restarts keep the boundary.
    const receiptKey = until === undefined ? undefined : `send-run:${threadId}:${until}`;
    const receipt = receiptKey ? this.firstTurnStore?.get<{ at: number; runId?: string }>(receiptKey) ?? this.sendRuns.get(receiptKey) : undefined;
    const sinceAt = since === undefined ? undefined : receipt?.at ?? since;
    const runs = [...thread.recentRuns, ...(thread.run ? [thread.run] : [])];
    const boundRun = receipt?.runId ?? messages.find(message => message.role === "user" && promptId(threadId, message) === until)?.runId;
    const receiptOrdinal = boundRun ? runs.find(run => run.runId === boundRun)?.ordinal ?? runOrdinal(boundRun) : 0;
    const stale = new Set(sinceAt === undefined ? [] : runs.filter(run => {
      if (boundRun === run.runId) return false;
      if (receiptOrdinal && run.ordinal) return run.ordinal < receiptOrdinal;
      const times = messages.filter(message => message.runId === run.runId).map(message => epoch(message.createdAt));
      const at = Date.parse(run.requestedAt ?? run.startedAt ?? "") || (times.length ? Math.min(...times) : NaN);
      return Number.isFinite(at) && at < sinceAt;
    }).map(run => run.runId));
    let records = recordsFromThread(thread, messages);
    let found = until === undefined ? -1 : records.findIndex(record => record.id === until);
    // Once the prompt is visible, the router scopes its outcome after that prompt and
    // still needs preceding completions. Before then, only this send's run can settle it.
    if (until !== undefined && found < 0 && sinceAt !== undefined) {
      records = recordsFromThread(thread, messages.filter(message => !message.runId || !stale.has(message.runId)));
      found = records.findIndex(record => record.id === until);
    }
    // Like the OpenChamber pager: the newest page, extended back to `until` when it is present.
    const start = found >= 0 ? Math.min(found, Math.max(0, records.length - limit)) : Math.max(0, records.length - limit);
    const page = records.slice(start);
    // Evidence is fetched for the runs on this page only, never the whole history.
    await this.markRunEvidence(thread, page);
    // OpenCode's own step rows are a fallback for OpenCode threads only; every other driver is judged by Robob.
    return this.isOpenCodeThread(thread) ? this.markInterrupted(this.markAnswers(page)) : page;
  }

  /** The detail keeps five runs, not five outcomes. Read missing page outcomes before forwarding any partial text. */
  private async restoreRunStatuses(thread: ThreadDetail, messages: ControlMessage[], until: string | undefined, limit: number): Promise<ThreadDetail> {
    const records = recordsFromThread(thread, messages);
    const found = until === undefined ? -1 : records.findIndex(record => record.id === until);
    const start = found >= 0 ? Math.min(found, Math.max(0, records.length - limit)) : Math.max(0, records.length - limit);
    const messageRuns = new Map(messages.filter(message => message.runId !== null).map(message => [
      message.role === "user" ? promptId(thread.threadId, message) : message.messageId, message.runId!,
    ]));
    // A historical idle marker is absent until its status is restored; still honour an idle watermark.
    const watermarkRun = until?.startsWith("idle:") ? until.slice("idle:".length) : undefined;
    const watermarkOrdinal = watermarkRun === undefined ? 0 : runOrdinal(watermarkRun);
    const needed = new Set(records.slice(start).flatMap(record => {
      const runId = record.type === "assistant" ? record.runId : messageRuns.get(record.id);
      return runId ? [runId] : [];
    }));
    if (watermarkRun) for (const message of messages) {
      if (message.runId !== null && runOrdinal(message.runId) >= watermarkOrdinal) needed.add(message.runId);
    }
    if (this.firstTurns.get(thread.threadId) === null) {
      const firstId = messages.find(message => message.runId !== null && runOrdinal(message.runId) === 1)?.runId;
      if (firstId) needed.add(firstId);
    }
    const known = new Set([...thread.recentRuns, ...(thread.run ? [thread.run] : [])].map(run => run.runId));
    const restored: RunSummary[] = [];
    for (const runId of needed) {
      if (known.has(runId)) continue;
      const key = `${thread.threadId}\u0000${runId}`;
      let run = this.historicalRuns.get(key);
      if (!run) {
        const evidence = await this.client.runEvidence(thread.threadId, runId);
        if (evidence.runId !== runId || !TERMINAL.has(evidence.status)) throw new Error("Robob run outcome is not yet known");
        run = { runId, ordinal: runOrdinal(runId), status: evidence.status };
        // Waiting means a reply is available, not that recovery can no longer change the outcome.
        if (evidence.status !== "waiting") {
          if (this.historicalRuns.size > 5_000) this.historicalRuns.clear();
          this.historicalRuns.set(key, run);
          if (evidence.toolEvidence !== "unknown") {
            if (this.settledEvidence.size > 5_000) this.settledEvidence.clear();
            this.settledEvidence.set(key, evidence.toolEvidence);
          }
        }
      }
      restored.push(run);
    }
    return restored.length ? { ...thread, recentRuns: [...thread.recentRuns, ...restored] } : thread;
  }

  /**
   * Whether the thread's driver is OpenCode, the only driver whose step rows the bridge can read as a
   * fallback. Keyed on the driver alone: a `ses_` id can survive a migration from OpenCode (ControlStore
   * keeps historical bindings), so an id is not proof of the driver the thread runs on now.
   */
  private isOpenCodeThread(thread: ThreadDetail): boolean {
    return thread.model?.instanceId === "opencode";
  }

  /**
   * Robob's messages carry no tool activity, so whether the latest run called tools comes from
   * OpenCode's own step rows for the thread's native session. The run's last record carries the
   * answer, since a tool-only run has no text record at all. Only that run is looked up.
   */
  private async markRunEvidence(thread: ThreadDetail, records: MessageRecord[]): Promise<void> {
    // One route read per run on this page, so each run's steps get only that run's evidence.
    const runIds = [...new Set(records.flatMap(record => record.type === "assistant" && record.runId ? [record.runId] : []))];
    const byRun = new Map<string, "ran" | "none" | "unknown">();
    const completed = new Set<string>();
    for (const runId of runIds) {
      const key = `${thread.threadId}\u0000${runId}`;
      const proven = this.settledEvidence.get(key);
      const interrupted = (thread.recentRuns.find(run => run.runId === runId) ?? (thread.run?.runId === runId ? thread.run : undefined))?.status === "interrupted";
      if (proven !== undefined && !interrupted) {
        byRun.set(runId, proven);
        continue;
      }
      try {
        const proof = await this.client.runEvidence(thread.threadId, runId);
        const evidence = proof.toolEvidence;
        if (proof.complete && proof.status === "interrupted") completed.add(runId);
        byRun.set(runId, evidence);
        const run = thread.recentRuns.find(candidate => candidate.runId === runId) ?? (thread.run?.runId === runId ? thread.run : undefined);
        // Only a settled run's proof is final. A running run may still call tools, so it is never cached.
        if (evidence !== "unknown" && run !== undefined && TERMINAL.has(run.status)) {
          // Clearing is safe: an entry dropped here is only fetched again.
          if (this.settledEvidence.size > 5_000) this.settledEvidence.clear();
          this.settledEvidence.set(key, evidence);
        }
      } catch (caughtError) { toolError("robob", "robob.catch7", caughtError);
        byRun.set(runId, "unknown");
      }
    }
    // An OpenCode run the route can't prove is read from OpenCode's own step rows (the fallback).
    const openCode = this.isOpenCodeThread(thread) && thread.nativeSessionId ? thread.nativeSessionId : undefined;
    for (const [runId, evidence] of byRun) {
      if (evidence !== "unknown" || openCode === undefined) continue;
      const run = thread.recentRuns.find(candidate => candidate.runId === runId) ?? (thread.run?.runId === runId ? thread.run : undefined);
      const sinceMs = Date.parse(run?.requestedAt ?? run?.startedAt ?? "");
      if (Number.isFinite(sinceMs)) byRun.set(runId, this.runEvidence(openCode, sinceMs));
    }
    for (const record of records) {
      if (record.type !== "assistant") continue;
      const evidence = record.runId ? byRun.get(record.runId) : undefined;
      if (evidence !== undefined) record.toolEvidence = evidence;
      // Only completed provider streams prove an interrupted answer finished; restart recovery also closes partial messages.
      if (record.runId && completed.has(record.runId) && record.answer === true && !record.error) {
        record.finish = "stop";
        record.interruptReplyComplete = true;
      }
    }
  }

  private markInterrupted(page: MessageRecord[]): MessageRecord[] {
    // Robob also marks interrupted streams completed. Match every native text
    // block against a finished step before treating that projection as a reply.
    const interrupted: Extract<MessageRecord, { type: "assistant" }>[] = [];
    let run: Extract<MessageRecord, { type: "assistant" }>[] = [];
    for (const record of page) {
      if (record.type === "user") run = [];
      else if (record.type === "assistant") run.push(record);
      else if (record.type === "idle") {
        if (record.outcome === "interrupted") interrupted.push(...run.filter(step => step.interruptReplyComplete !== true));
        run = [];
      }
    }
    const completed = this.completedSteps(interrupted.map(step => step.id));
    const groups = new Map<string, Extract<MessageRecord, { type: "assistant" }>[]>();
    for (const step of interrupted) {
      const native = nativeMessageId(step.id);
      if (native) groups.set(native, [...groups.get(native) ?? [], step]);
      else step.interruptReplyComplete = false;
    }
    for (const [native, group] of groups) {
      const expected = completed.get(native);
      const actual = new Map<number, string>();
      let valid = expected !== undefined;
      for (const step of group) {
        let suffix = "";
        try { suffix = decodeURIComponent(step.id.slice("message:provider:opencode:native-item:".length)); } catch { valid = false; }
        const match = /^msg_[A-Za-z0-9]+:text:(\d+)$/.exec(suffix);
        const part = match ? Number(match[1]) : -1;
        if (!Number.isSafeInteger(part) || part < 0 || actual.has(part)) valid = false;
        else actual.set(part, step.content.map(p => p.type === "text" ? p.text : "").join(""));
      }
      // Empty native blocks do not produce a Robob projection.
      if (expected && (actual.size !== expected.filter(Boolean).length
        || expected.some((text, i) => text ? actual.get(i) !== text : actual.has(i)))) valid = false;
      for (const step of group) {
        step.interruptReplyComplete = valid;
        if (valid) step.finish = "stop";
      }
    }
    return page;
  }

  /**
   * Marks finished assistant steps with `answer`: true when the model stopped
   * there (it said something to the chat), false when it went on to call tools
   * (narration). Steps OpenCode can't tell us about stay unmarked. Each step
   * also carries its OpenCode message id (`nativeMessage`), so the router can
   * judge a message written as several text blocks as a whole.
   */
  private markAnswers(records: MessageRecord[]): MessageRecord[] {
    for (const record of records) {
      const native = record.type === "assistant" ? nativeMessageId(record.id) : undefined;
      if (native) record.nativeMessage = native;
    }
    // Every assistant step is looked up, not only the ones that look like answers: a
    // step's finish is the only way to tell that it called tools (`tool-calls`).
    const steps = records.filter((record): record is Extract<MessageRecord, { type: "assistant" }> => record.type === "assistant");
    // Clear before working out what's missing, so this page's steps are looked up again rather than lost.
    if (this.finished.size > 5_000) this.finished.clear();
    const missing = steps.map(step => step.id).filter(id => !this.finished.has(id));
    if (missing.length) for (const [id, finish] of this.finishes(missing)) this.finished.set(id, finish);
    for (const step of steps) {
      const finish = this.finished.get(step.id);
      if (finish === "tool-calls") step.continued = true;
      // A step's own finish can prove that tools ran (`tool-calls`), but it can't prove that none did:
      // an unresolved step (the synthetic error record) or an `error` finish says nothing. So only
      // `ran` is merged here. The run-level answer from markRunEvidence stays authoritative otherwise.
      if (finish === "tool-calls") step.toolEvidence = "ran";
      else if (step.toolEvidence === undefined) step.toolEvidence = "unknown";
      // OpenCode's own finish fills in only what Robob's phase left unknown, and only for a completed step.
      if (step.answer === undefined && step.time.completed !== undefined && finish !== undefined) step.answer = finish === "stop";
    }
    return records;
  }

  async promptAccepted(id: string, _directory: string, messageId: string): Promise<boolean> {
    const threadId = await this.resolve(id);
    const { thread } = await this.client.thread(threadId);
    const messages = await this.readMessages(threadId, thread);
    return messages.some(message => message.role === "user" && promptId(threadId, message) === messageId);
  }

  async responseResolved(id: string, _directory: string, requestId: string): Promise<boolean> {
    // /respond changes a runtime request, never a chat message. Only a successful
    // thread read can prove that the formerly pending request is now resolved.
    const thread = await this.detail(id);
    return !thread.pendingRequests.some(request => request.requestId === requestId);
  }

  private async reconcileControl(threadId: string, messageId: string, error: unknown): Promise<boolean> {
    try {
      // A reader during the POST may have repopulated the same-tick snapshot before admission.
      this.messageCache.afterWrite(threadId);
      const accepted = await this.promptAccepted(threadId, "", messageId);
      if (error instanceof ControlError) error.reconciled = true;
      return accepted;
    } catch (readError) {
      toolError("robob", "robob.control_reconcile", readError);
      throw error;
    }
  }

  private sendBody(threadId: string, messageId: string, body: Record<string, unknown>) {
    const key = `send-body:${threadId}:${messageId}`;
    const saved = this.firstTurnStore?.get<Record<string, unknown>>(key) ?? this.sendBodies.get(key) ?? body;
    if (saved.mode !== body.mode) throw new Error("Robob send retry changed mode");
    // A held router retry may add outage guidance; an idempotent POST must keep its original body.
    this.sendBodies.set(key, saved);
    this.firstTurnStore?.set(key, saved);
    return saved;
  }

  private clearSendBody(threadId: string, messageId: string) {
    const key = `send-body:${threadId}:${messageId}`;
    this.sendBodies.delete(key);
    this.firstTurnStore?.set(key, null);
  }

  async releaseUnacceptedPrompt(id: string, _directory: string, messageId: string): Promise<void> {
    this.clearSendBody(await this.resolve(id), messageId);
  }

  private async sendAttachments(threadId: string, messageId: string, files: readonly FilePart[], signal?: AbortSignal) {
    const specs = files.map((file, index) => {
      const { mimeType, bytes } = dataUrl(file.url);
      return { name: file.filename ?? `attachment-${index + 1}`, mimeType: file.mime || mimeType, bytes };
    });
    const fingerprint = createHash("sha256").update(JSON.stringify(specs.map(spec => [spec.name, spec.mimeType,
      createHash("sha256").update(spec.bytes).digest("hex")]))).digest("hex");
    const key = `send-files:${createHash("sha256").update(JSON.stringify([threadId, messageId])).digest("hex")}`;
    const entry = this.firstTurnStore?.get<{ fingerprint: string; attachments: Awaited<ReturnType<ControlClient["upload"]>>[] }>(key)
      ?? this.sendFiles.get(key) ?? { fingerprint, attachments: [] };
    if (entry.fingerprint !== fingerprint) throw new Error("Robob attachment retry changed");
    this.sendFiles.set(key, entry);
    this.firstTurnStore?.set(key, entry);
    for (const spec of specs.slice(entry.attachments.length)) {
      if (signal?.aborted) throw new ControlError(0, "upload_failed");
      entry.attachments.push(await this.client.upload(spec, signal));
      this.firstTurnStore?.set(key, entry);
    }
    return entry.attachments;
  }

  /**
   * One send per prompt. `clientRequestId` is the router's prompt id, so a
   * retried POST replays instead of sending twice, and the message reads back
   * under that id. The send returns once Robob durably accepted it.
   *
   * The message text is only what the owner wrote. Channel guidance (and any
   * quote of the message he replied to) goes in `guidance`, which Robob gives
   * the agent framed as not his. With `owner` set the text is his typed words
   * exactly, and `inboundId` lets Robob check them against this store.
   */
  async prompt(id: string, _directory: string, messageId: string, text: string, system = "", files: readonly FilePart[] = [],
    model?: PreferredModel, owner?: OwnerWords, beforeSend?: () => void): Promise<void> {
    const threadId = await this.resolve(id);
    const attachments = await this.sendAttachments(threadId, messageId, files);
    const words = owner !== undefined && text.endsWith(owner.text) ? owner : undefined;
    const lead = words ? text.slice(0, text.length - words.text.length).trim() : "";
    const guidance = [system.trim(), lead].filter(Boolean).join("\n\n");
    const receiptKey = `send-run:${threadId}:${messageId}`;
    const receipt = this.firstTurnStore?.get<{ at: number; runId?: string }>(receiptKey) ?? this.sendRuns.get(receiptKey) ?? { at: Date.now() };
    this.sendRuns.set(receiptKey, receipt);
    this.firstTurnStore?.set(receiptKey, receipt);
    beforeSend?.();
    this.messageCache.afterWrite(threadId);
    try {
      const accepted = await this.client.request<{ runId?: string }>("POST", `/threads/${encodeURIComponent(threadId)}/send`, this.sendBody(threadId, messageId, {
        text: words ? words.text : text, mode: "auto", clientRequestId: messageId,
        ...(guidance ? { guidance } : {}),
        ...(words ? { inboundId: words.inboundId } : {}),
        ...(model ? controlModelFields(model) : {}),
        ...(attachments.length ? { attachments } : {}),
      }), { timeoutMs: 60_000 }).catch(async error => {
        toolError("robob", "robob.send_failed", error);
        if (controlDisposition(error) === "reconcile" && await this.reconcileControl(threadId, messageId, error)) return { runId: undefined };
        throw error;
      });
      if (accepted.runId) {
        const bound = { ...receipt, runId: accepted.runId };
        this.sendRuns.set(receiptKey, bound);
        this.firstTurnStore?.set(receiptKey, bound);
      }
    } finally { this.messageCache.afterWrite(threadId); }
  }

  /**
   * `mode: "steer"` never queues: with no steerable run Robob answers 409 and
   * dispatches nothing. A retried POST replays under the same `clientRequestId`.
   */
  async steer(id: string, _directory: string, messageId: string, text: string, guidance = "", files: readonly FilePart[] = [], guard?: SteerGuard): Promise<SteerDelivery> {
    if (guard?.signal.aborted) return "refused";
    const threadId = await this.resolve(id);
    const attachments = await this.sendAttachments(threadId, messageId, files, guard?.signal);
    if (guard && (guard.signal.aborted || !await guard.beforeSend() || guard.signal.aborted)) return "refused";
    this.messageCache.afterWrite(threadId);
    try {
      const { delivery } = await this.client.request<{ delivery?: string }>("POST", `/threads/${encodeURIComponent(threadId)}/send`, this.sendBody(threadId, messageId, {
        text, mode: "steer", clientRequestId: messageId, ...(guidance.trim() ? { guidance: guidance.trim() } : {}),
        ...(attachments.length ? { attachments } : {}),
      }), { timeoutMs: 60_000, signal: guard?.signal });
      return delivery === "started" || delivery === "queued" ? delivery : "steered";
    } catch (error) { toolError("robob", "robob.catch8", error);
      guard?.onFailure?.(error);
      if (controlDisposition(error) === "refused") { this.clearSendBody(threadId, messageId); return "refused"; }
      if (controlDisposition(error) === "reconcile") {
        if (await this.reconcileControl(threadId, messageId, error)) return "steered";
        this.clearSendBody(threadId, messageId);
        return "refused";
      }
      throw error;
    } finally { this.messageCache.afterWrite(threadId); }
  }

  async abort(id: string, _directory?: string, cancelReason?: Parameters<ChatBackend["abort"]>[2]): Promise<boolean> {
    const threadId = await this.resolve(id);
    const result = await this.client.request<{ interrupted?: unknown }>("POST", `/threads/${encodeURIComponent(threadId)}/interrupt`, cancelReason === undefined ? {} : { cancelReason });
    return result.interrupted === true;
  }

  /** Busy threads, keyed by thread id and, for imported threads, by their `ses_` id too. */
  async statuses(complete = false): Promise<Record<string, SessionStatus>> {
    const { total, threads } = await this.client.listThreads({ active: true, includeSubagents: true, limit: 500 });
    if (complete && total > threads.length) throw new Error("Incomplete active family discovery");
    const alias = new Map([...this.native].map(([session, threadId]) => [threadId, session]));
    const statuses: Record<string, SessionStatus> = {};
    for (const thread of threads) {
      if (!BUSY.has(thread.state)) continue;
      // Routes may be stored under an imported `ses_` id, so name the root the way the router knows it.
      const root = thread.parentThreadId === null ? null : alias.get(thread.rootThreadId) ?? thread.rootThreadId;
      const busy: SessionStatus = { type: "busy", root };
      statuses[thread.threadId] = busy;
      if (thread.nativeSessionId) statuses[thread.nativeSessionId] = busy;
    }
    for (const [session, threadId] of this.native) if (statuses[threadId]) statuses[session] = statuses[threadId];
    return statuses;
  }

  /** One thread's detail answers in well under a second; the thread list behind `statuses()` takes several. */
  async sessionBusy(id: string): Promise<boolean> {
    return BUSY.has((await this.detail(id)).state);
  }

  /** Busy, or waiting on background work a reset would cut off (see `resetBlocked` in openchamber.ts). */
  async resetBlocked(id: string): Promise<boolean> {
    const state = (await this.detail(id)).state;
    return BUSY.has(state) || state === "waiting";
  }

  async permissions(sessionId: string, _directory?: string): Promise<PermissionRequest[]> {
    const thread = await this.detail(sessionId);
    return thread.pendingRequests.filter(request => request.kind === "approval").map(request => permissionFrom(request, sessionId));
  }

  async questions(sessionId: string, _directory?: string): Promise<QuestionRequest[]> {
    const thread = await this.detail(sessionId);
    return thread.pendingRequests.filter(request => request.kind === "question").map(request => questionFrom(request, sessionId));
  }

  /** With `inboundId`, Robob checks the owner's reply before it counts the answer as his. */
  async permissionReply(sessionId: string, requestId: string, _directory: string, reply: "once" | "reject", inboundId?: string, beforeSend?: () => boolean): Promise<boolean> {
    if (reply !== "once" && reply !== "reject") throw new Error("Invalid permission reply");
    return this.respondControl(sessionId, requestId, {
      decision: reply === "once" ? "approve" : "deny", ...(inboundId ? { inboundId } : {}),
    }, beforeSend);
  }

  /** Answers keyed by question id; values are the option labels (or free text where allowed). */
  async questionReply(request: QuestionRequest, _directory: string, answers: string[][], inboundId?: string, beforeSend?: () => boolean): Promise<boolean> {
    if (request.unsupported || answers.length !== request.questions.length) throw new Error("Invalid form answer");
    const body = Object.fromEntries(request.questions.map((question, index) =>
      [question.key, question.multiple === true ? answers[index]! : answers[index]![0]!]));
    return this.respondControl(request.sessionID, request.id, { answers: body, ...(inboundId ? { inboundId } : {}) }, beforeSend);
  }

  async cancelQuestion(sessionId: string, requestId: string, _directory?: string, inboundId?: string): Promise<boolean> {
    await this.respondControl(sessionId, requestId, { dismiss: true, ...(inboundId ? { inboundId } : {}) });
    return true;
  }

  private async respondControl(sessionId: string, requestId: string, body: Record<string, unknown>, beforeSend?: () => boolean): Promise<boolean> {
    const threadId = await this.resolve(sessionId);
    const response = { ...body, clientRequestId: `respond_${createHash("sha256").update(JSON.stringify([requestId, body])).digest("hex")}` };
    if (beforeSend && !beforeSend()) return false;
    try { await this.client.respond(threadId, requestId, response); }
    catch (error) {
      toolError("robob", "robob.respond_failed", error);
      if (controlDisposition(error) === "reconcile") {
        try {
          await this.responseResolved(threadId, "", requestId);
          if (error instanceof ControlError) error.reconciled = true;
          // Resolution can be cancellation or another actor's answer. It prevents
          // another response POST, but cannot count this human's text as accepted.
        } catch (readError) { toolError("robob", "robob.respond_reconcile", readError); }
      }
      throw error;
    }
    return true;
  }

  /** Robob threads in full-access mode never ask; subagents inherit the mode. Undefined when unknown. */
  async isSessionAutoAccepting(sessionId: string, _directory?: string): Promise<boolean | undefined> {
    try { return (await this.detail(sessionId)).runtimeMode === "full-access"; } catch (caughtError) { toolError("robob", "robob.catch9", caughtError); return undefined; }
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
  } catch (error) { toolError("robob", "robob.catch10", error);
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
