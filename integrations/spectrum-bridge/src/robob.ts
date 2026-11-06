import { IMESSAGE_ORIGIN, type ChatBackend, type FilePart, type MessageRecord, type OwnerWords, type PermissionRequest, type QuestionRequest, type SessionRecord, type SessionStatus, type SteerDelivery } from "./openchamber.ts";
import {
  ControlClient, ControlError, epoch, permissionFrom, questionFrom, ThreadDirectories,
  type ControlConfigOptions, type ControlMessage, type RunSummary, type ThreadDetail, type ThreadSummary,
} from "./control.ts";
import { nativeMessageId, opencodeFinishes, opencodeRunEvidence, type RunEvidence, type StepFinishes } from "./opencode-steps.ts";
import { controlModelFields, imessagePreferences, type PreferredModel } from "./preferred-model.ts";
import type { Store } from "./store.ts";

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
  return (latest && thread.lastError) || complaint || (run.status === "failed" ? "Run failed without error details" : undefined);
}

/** The send route derives the message id from `clientRequestId`; this maps it back to the bridge's prompt id. */
export const sentMessagePrefix = (threadId: string) => `ardud-control:send:${threadId}:`;

function promptId(threadId: string, message: ControlMessage): string {
  const prefix = sentMessagePrefix(threadId);
  if (!message.messageId.startsWith(prefix)) return message.messageId;
  try { return decodeURIComponent(message.messageId.slice(prefix.length)); } catch { return message.messageId; }
}

/** The router's prompt ids (`msg_` plus a sha256), which it sends as `clientRequestId`. */
const BRIDGE_PROMPT = /^msg_[0-9a-f]{64}$/;
const runOrdinal = (runId: string) => Number(/:ordinal:(\d+)$/.exec(runId)?.[1] ?? 0);

/**
 * Rebuilds OpenCode-2-style session records from Robob runs and messages, the
 * shape the router reads turns from: each run's user prompt, its assistant
 * steps, then an `idle` marker once the run has settled. User messages the
 * agent or server sent to itself (background completion wakes) are left out:
 * to the router a user record means the owner wrote something. The bridge's
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
    group.sort((a, b) => epoch(a.createdAt) - epoch(b.createdAt) || a.messageId.localeCompare(b.messageId));
    // Runs older than the detail's recent window settled long ago.
    const status = runs.get(runId)?.status ?? "completed";
    const settled = TERMINAL.has(status);
    let last: Extract<MessageRecord, { type: "assistant" }> | undefined;
    for (const message of group) {
      const created = epoch(message.createdAt);
      if (message.role === "user") {
        const id = promptId(thread.threadId, message);
        const bridgeSent = id !== message.messageId && BRIDGE_PROMPT.test(id);
        if (message.createdBy !== undefined && message.createdBy !== "user" && !bridgeSent) continue;
        records.push({ id, type: "user", text: withoutGuidance(message.text), time: { created } });
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
    if (!settled) continue;
    const run = runs.get(runId) ?? { runId, ordinal: ordinal(runId), status };
    const failure = runFailure(thread, run, group, runId === latest);
    const result = failure ? "failed" : outcome(status);
    if (failure) {
      // Carries the provider's error text, which is how a refusal is recognised.
      const error = { type: "provider", message: failure };
      if (last) last.error = error;
      else records.push({ id: `${runId}:error`, type: "assistant", content: [], runId, finish: "error", error, time: { created: epoch(group.at(-1)?.updatedAt ?? null), completed: epoch(group.at(-1)?.updatedAt ?? null) } });
    }
    records.push({ id: `idle:${runId}`, type: "idle", outcome: result,
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
  private readonly runEvidence: RunEvidence;
  /** A step's finish never changes once written, so each is looked up once. */
  private readonly finished = new Map<string, string>();
  /**
   * Proven evidence for runs that have settled, keyed by thread and run. Only `ran` or `none` is kept:
   * an `unknown` can still resolve, so it is always asked again. A settled run's proof never changes.
   */
  private readonly settledEvidence = new Map<string, "ran" | "none">();
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
    this.finishes = options.finishes ?? opencodeFinishes();
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
    } catch {
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
    const model = await (this.options.model ?? (async () => (await imessagePreferences()).model))().catch(() => undefined);
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
      const firstId = messages.find(message => message.runId !== null && runOrdinal(message.runId) === 1)?.runId;
      // Messages outlive the five-run detail window; their diagnostic still proves failure.
      const first = runs.find(run => run.ordinal === 1) ?? (firstId && runs.some(run => run.ordinal > 1)
        ? { runId: firstId, ordinal: 1, status: "completed", model: undefined }
        : undefined);
      // The bounded recent-runs window no longer contains the first turn. Never mistake a later failure for it.
      if (!first && runs.some(run => run.ordinal > 1)) {
        this.firstTurns.delete(thread.threadId);
        this.saveFirstTurns();
        return;
      }
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
    } catch { /* The durable payload is attempted on the next read. */ }
    finally { this.checkingFirstTurns.delete(id); }
  }

  /** Backend for one non-owner Sendblue chat: same server and client, its own folder and thread title. */
  forChat(subdir: string, title: string): RobobBackend {
    return new RobobBackend({ ...this.options, client: this.client, finishes: this.finishes, subdir, title });
  }

  private chatFolder(): string {
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
      // Each Sendblue chat retires only its own threads; another person's live chat is not stale.
      if (!this.ownsFolder(thread.worktreePath)) continue;
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
    // Read messages after the run state: an earlier page must not make a just-completed
    // first turn look successful before its selected-model error text has arrived.
    const { thread } = await this.client.thread(threadId);
    const { messages } = await this.client.messages(threadId);
    await this.checkFirstTurn(thread, messages);
    await this.flushFirstTurnAlert();
    const records = recordsFromThread(thread, messages);
    const found = until === undefined ? -1 : records.findIndex(record => record.id === until);
    // Like the OpenChamber pager: the newest page, extended back to `until` when it is present.
    const start = found >= 0 ? Math.min(found, Math.max(0, records.length - limit)) : Math.max(0, records.length - limit);
    const page = records.slice(start);
    // Evidence is fetched for the runs on this page only, never the whole history.
    await this.markRunEvidence(thread, page);
    // OpenCode's own step rows are a fallback for OpenCode threads only; every other driver is judged by Robob.
    return this.isOpenCodeThread(thread) ? this.markAnswers(page) : page;
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
    for (const runId of runIds) {
      const key = `${thread.threadId}\u0000${runId}`;
      const proven = this.settledEvidence.get(key);
      if (proven !== undefined) {
        byRun.set(runId, proven);
        continue;
      }
      try {
        const evidence = (await this.client.runEvidence(thread.threadId, runId)).toolEvidence;
        byRun.set(runId, evidence);
        const run = thread.recentRuns.find(candidate => candidate.runId === runId) ?? (thread.run?.runId === runId ? thread.run : undefined);
        // Only a settled run's proof is final. A running run may still call tools, so it is never cached.
        if (evidence !== "unknown" && run !== undefined && TERMINAL.has(run.status)) {
          // Clearing is safe: an entry dropped here is only fetched again.
          if (this.settledEvidence.size > 5_000) this.settledEvidence.clear();
          this.settledEvidence.set(key, evidence);
        }
      } catch {
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
    }
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
    const { messages } = await this.client.messages(threadId);
    return messages.some(message => message.role === "user" && promptId(threadId, message) === messageId);
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
    model?: PreferredModel, owner?: OwnerWords): Promise<void> {
    const threadId = await this.resolve(id);
    const attachments = [];
    for (const [index, file] of files.entries()) {
      const { mimeType, bytes } = dataUrl(file.url);
      attachments.push(await this.client.upload({ name: file.filename ?? `attachment-${index + 1}`, mimeType: file.mime || mimeType, bytes }));
    }
    const words = owner !== undefined && text.endsWith(owner.text) ? owner : undefined;
    const lead = words ? text.slice(0, text.length - words.text.length).trim() : "";
    const guidance = [system.trim(), lead].filter(Boolean).join("\n\n");
    await this.client.request("POST", `/threads/${encodeURIComponent(threadId)}/send`, {
      text: words ? words.text : text, mode: "auto", clientRequestId: messageId,
      ...(guidance ? { guidance } : {}),
      ...(words ? { inboundId: words.inboundId } : {}),
      ...(model ? controlModelFields(model) : {}),
      ...(attachments.length ? { attachments } : {}),
    }, { timeoutMs: 60_000 });
  }

  /**
   * `mode: "steer"` never queues: with no steerable run Robob answers 409 and
   * dispatches nothing. A retried POST replays under the same `clientRequestId`.
   */
  async steer(id: string, _directory: string, messageId: string, text: string, guidance = ""): Promise<SteerDelivery> {
    const threadId = await this.resolve(id);
    try {
      const { delivery } = await this.client.request<{ delivery?: string }>("POST", `/threads/${encodeURIComponent(threadId)}/send`, {
        text, mode: "steer", clientRequestId: messageId, ...(guidance.trim() ? { guidance: guidance.trim() } : {}),
      }, { timeoutMs: 60_000 });
      return delivery === "started" || delivery === "queued" ? delivery : "steered";
    } catch (error) {
      if (error instanceof ControlError && error.status === 409) return "refused";
      throw error;
    }
  }

  async abort(id: string, _directory?: string): Promise<boolean> {
    const threadId = await this.resolve(id);
    const result = await this.client.request<{ interrupted?: unknown }>("POST", `/threads/${encodeURIComponent(threadId)}/interrupt`, {});
    return result.interrupted === true;
  }

  /** Busy threads, keyed by thread id and, for imported threads, by their `ses_` id too. */
  async statuses(): Promise<Record<string, SessionStatus>> {
    const { threads } = await this.client.listThreads({ active: true, includeSubagents: true, limit: 500 });
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
  async permissionReply(sessionId: string, requestId: string, _directory: string, reply: "once" | "reject", inboundId?: string): Promise<boolean> {
    if (reply !== "once" && reply !== "reject") throw new Error("Invalid permission reply");
    await this.client.respond(await this.resolve(sessionId), requestId, {
      decision: reply === "once" ? "approve" : "deny", ...(inboundId ? { inboundId } : {}),
    });
    return true;
  }

  /** Answers keyed by question id; values are the option labels (or free text where allowed). */
  async questionReply(request: QuestionRequest, _directory: string, answers: string[][], inboundId?: string): Promise<boolean> {
    if (request.unsupported || answers.length !== request.questions.length) throw new Error("Invalid form answer");
    const body = Object.fromEntries(request.questions.map((question, index) =>
      [question.key, question.multiple === true ? answers[index]! : answers[index]![0]!]));
    await this.client.respond(await this.resolve(request.sessionID), request.id, { answers: body, ...(inboundId ? { inboundId } : {}) });
    return true;
  }

  async cancelQuestion(sessionId: string, requestId: string, _directory?: string, inboundId?: string): Promise<boolean> {
    await this.client.respond(await this.resolve(sessionId), requestId, { dismiss: true, ...(inboundId ? { inboundId } : {}) });
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
