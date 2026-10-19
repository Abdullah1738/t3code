import assert from "node:assert/strict";

// JSON.parse establishes this representation; notification consumers decode its
// event variants before using them as session/request identities.
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** OpenCode 2 scopes location reads by the `x-opencode-directory` header. */
  directory?: string;
  signal?: AbortSignal;
}

/** OpenCode 2 `ModelRef`. */
export type ModelRef = { providerID: string; id: string; variant?: string };

/**
 * OpenCode 2 session records carry no session id, role or parent link: the
 * list is session-scoped and ordered by the server's durable sequence. A turn
 * is every record after its user prompt up to the next `idle` marker
 * (packages/schema/src/session-message.ts, `Idle`).
 */
export type AssistantContent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; id: string; name: string; state: { status: "streaming" | "running" | "completed" | "error"; [key: string]: unknown } };

export type MessageRecord =
  | { id: string; type: "user"; text: string; time: { created: number }; [key: string]: unknown }
  | {
      id: string;
      type: "assistant";
      content: AssistantContent[];
      finish?: string;
      error?: unknown;
      retry?: unknown;
      time: { created: number; completed?: number };
      [key: string]: unknown;
    }
  | { id: string; type: "idle"; outcome: "succeeded" | "failed" | "interrupted"; time: { created: number }; [key: string]: unknown }
  | { id: string; type: "agent-switched" | "model-switched" | "location-switched" | "synthetic" | "system" | "skill" | "shell" | "compaction"; time: { created: number }; [key: string]: unknown };

/** A native attachment the router prepared; sent as an OpenCode 2 prompt file (`uri` data URL). */
export interface FilePart {
  type: "file";
  mime: string;
  url: string;
  filename?: string;
  id?: string;
}

/** OpenCode 2 `SessionInfo`, with `directory` flattened from `location.directory`. */
export interface SessionRecord {
  id: string;
  directory: string;
  title?: string;
  parentID?: string;
  time: { created: number; updated: number; archived?: number };
  [key: string]: unknown;
}

/** `GET /api/session/active` lists running sessions only; an absent id is idle. */
export type SessionStatus = { type: "busy" };

/** OpenCode 2 `Permission.Request` (packages/schema/src/permission.ts). */
export interface PermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  metadata?: Record<string, unknown>;
  source?: { type: string; messageID: string; id: string };
  message?: string;
}

/**
 * A pending OpenCode 2 form (packages/schema/src/form.ts) in the bridge's
 * question vocabulary. The question tool asks one `string` or `multiselect`
 * field per question (packages/core/src/tool/plugin/question.ts). Forms whose
 * fields a text reply cannot answer stay visible but `unsupported`.
 */
export interface QuestionRequest {
  id: string;
  sessionID: string;
  title: string;
  questions: Array<{
    key: string;
    question: string;
    header: string;
    options: Array<{ label: string; value?: string; description?: string }>;
    multiple?: boolean;
    custom?: boolean;
  }>;
  unsupported?: boolean;
  tool?: { messageID: string; id: string };
}

export interface FormInfo {
  id: string;
  sessionID: string;
  title: string;
  metadata?: Record<string, unknown>;
  fields: Array<{
    key: string;
    type: string;
    title?: string;
    description?: string;
    required?: boolean;
    hidden?: boolean;
    when?: unknown[];
    options?: Array<{ value: string; label: string; description?: string }>;
    custom?: boolean;
    [key: string]: unknown;
  }>;
}

export interface Health {
  status: string;
  timestamp: string;
  openchamberVersion: string;
  [key: string]: unknown;
}

export interface BoardEntry {
  sessionId: string;
  directory: string;
  title: string;
  parentId?: string;
  projectId?: string;
  state: "running" | "waiting" | "backlog" | "scheduled";
  status?: string;
  workRevision: number;
  updatedAt: number;
  attention?: { kind: "question" | "approval"; count: number; label?: string };
}

export interface BoardSnapshot {
  version: 1;
  revision: number;
  activatedAt: number;
  migrationComplete: boolean;
  entries: BoardEntry[];
  syncError?: string | null;
}

export interface AutoAcceptPolicy {
  defaultEnabled: boolean;
  sessions: Record<string, boolean>;
  revision: number;
}

/**
 * `metadata.openchamber.origin` of every session this bridge creates. OpenChamber
 * keeps these sessions off its Sessions board and out of review, question and
 * approval alerts: the conversation happens here, over iMessage. OpenCode copies
 * metadata onto subagents, so they carry it too.
 */
export const IMESSAGE_ORIGIN = "imessage";
export const IMESSAGE_METADATA = { openchamber: { origin: IMESSAGE_ORIGIN } } as const;

export const DEFAULT_CHANNEL_SYSTEM =
  "Reply concisely for a messaging channel. Prefer plain text and avoid tables.";

const MESSAGE_PAGE = 100;
const MAX_MESSAGE_PAGES = 10;
const ID = /^[^\p{Cc}]{1,4096}$/u;

function requestError(status: number, signal?: AbortSignal): Error & { status: number } {
  // Never expose response bodies, URLs, headers, parser errors, or abort reasons.
  const error = Object.assign(new Error(`OpenChamber request failed (HTTP ${status})`), { status });
  if (signal?.aborted) error.name = "AbortError";
  return error;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const SESSION_NOT_FOUND = Symbol("SessionNotFoundError");

/**
 * OpenCode 2 wraps answers in `{ data }`, `{ location, data }` or pages as
 * `{ data, cursor }`. Records and lists unwrap; pages keep their cursor.
 * Mirrors OpenChamber's server/lib/opencode/response-envelope.js.
 */
export function unwrap<T>(body: unknown): T {
  return (isRecord(body) && "data" in body && !("cursor" in body) ? body.data : body) as T;
}

function sessionRecord(body: unknown): SessionRecord | undefined {
  const row = unwrap<unknown>(body);
  if (!isRecord(row)) return;
  const location = isRecord(row.location) ? row.location : {};
  const directory = typeof location.directory === "string" ? location.directory : row.directory;
  return { ...row, directory } as SessionRecord;
}

/** Field types a text reply can answer. Conditional forms stay in OpenChamber. */
function textField(field: FormInfo["fields"][number]): boolean {
  if (field.when?.length) return false;
  if (field.type === "multiselect") return Array.isArray(field.options);
  return field.type === "string";
}

export function questionFromForm(form: FormInfo): QuestionRequest {
  const tool = isRecord(form.metadata?.tool) && typeof form.metadata.tool.messageID === "string" && typeof form.metadata.tool.id === "string"
    ? { messageID: form.metadata.tool.messageID, id: form.metadata.tool.id } : undefined;
  // A hidden optional field keeps its default; a hidden required one cannot be answered here.
  const fields = form.fields.filter(field => field.hidden !== true);
  const unsupported = !fields.length || form.fields.some(field => field.hidden === true && field.required === true)
    || !fields.every(textField);
  return {
    id: form.id,
    sessionID: form.sessionID,
    title: form.title,
    questions: unsupported ? [] : fields.map(field => ({
      key: field.key,
      question: field.description ?? field.title ?? form.title,
      header: field.title ?? "",
      options: (field.options ?? []).map(option => ({
        label: option.label, value: option.value, ...(option.description === undefined ? {} : { description: option.description }),
      })),
      multiple: field.type === "multiselect",
      // A string field with listed options is closed unless it allows custom text.
      custom: field.type === "multiselect" ? field.custom === true : !field.options?.length || field.custom === true,
    })),
    ...(unsupported ? { unsupported: true } : {}),
    ...(tool ? { tool } : {}),
  };
}

/** Maps displayed labels back to option values, one entry per form field. */
export function formAnswer(request: QuestionRequest, answers: string[][]): Record<string, string | string[]> {
  if (request.unsupported || answers.length !== request.questions.length) throw new Error("Invalid form answer");
  return Object.fromEntries(request.questions.map((question, index) => {
    const values = answers[index]!.map(value => question.options.find(option => option.label === value)?.value ?? value);
    return [question.key, question.multiple === true ? values : values[0]!];
  }));
}

function validRoot(root: unknown): root is string {
  return typeof root === "string" && root.startsWith("/") && !root.includes("\0");
}

/** The owner's own typed message inside a prompt: its inbound id and exact text. */
export type OwnerWords = { inboundId: string; text: string };

/**
 * What the router and the origin backfill need from a backend. OpenChamber
 * implements it here; Robob's control API implements it in robob.ts.
 */
export interface ChatBackend {
  /** How owner-facing text names the app. Defaults to OpenChamber. */
  readonly brand?: { app: string };
  health(): Promise<{ status: string; openchamberVersion?: string; [key: string]: unknown } | undefined>;
  createChat(title?: string): Promise<{ id: string; directory: string }>;
  markImessageOrigin(id: string, directory?: string): Promise<"marked" | "already" | "missing">;
  /** Settles every other idle iMessage chat once the route moves to `keepId`. Best effort; returns how many it settled. */
  retireOthers?(keepId: string): Promise<number>;
  /** True when the agent in this chat can reset its own context in place (Robob's t3_context_reset tool). */
  resetsContext?(id: string): boolean;
  getSession(id: string, directory: string): Promise<SessionRecord | undefined>;
  children(id: string, directory: string): Promise<SessionRecord[]>;
  messages(id: string, directory: string, options?: { until?: string; since?: number; limit?: number }): Promise<MessageRecord[]>;
  promptAccepted(id: string, directory: string, messageId: string): Promise<boolean>;
  /**
   * `owner` is set only when `text` ends with one message the owner typed,
   * exactly as he sent it; a backend that checks iMessages (Robob) sends those
   * words alone, with the inbound id, and everything else as guidance.
   */
  prompt(id: string, directory: string, messageId: string, text: string, system?: string, files?: readonly FilePart[],
    model?: { providerID: string; modelID: string; variant?: string }, owner?: OwnerWords): Promise<void>;
  abort(id: string, directory: string): Promise<boolean>;
  statuses(): Promise<Record<string, SessionStatus>>;
  permissions(sessionId: string, directory: string): Promise<PermissionRequest[]>;
  questions(sessionId: string, directory: string): Promise<QuestionRequest[]>;
  /** `inboundId` is the owner's typed reply the answer came from, when there is one. */
  permissionReply(sessionId: string, requestId: string, directory: string, reply: "once" | "reject", inboundId?: string): Promise<boolean>;
  questionReply(request: QuestionRequest, directory: string, answers: string[][], inboundId?: string): Promise<boolean>;
  cancelQuestion(sessionId: string, formId: string, directory: string, inboundId?: string): Promise<boolean>;
  isSessionAutoAccepting(sessionId: string, directory: string): Promise<boolean | undefined>;
}

export class OpenChamber implements ChatBackend {
  private readonly baseUrl: string;
  private readonly headers: Headers;
  private readonly chatRoot: string | undefined;

  /**
   * `chatRoot` places new iMessage chat directories under a dedicated root
   * (registered as its own OpenChamber project) instead of the shared Chats root.
   */
  constructor(baseUrl: string, headers: Record<string, string> = {}, options: { chatRoot?: string } = {}) {
    if (options.chatRoot !== undefined && !validRoot(options.chatRoot)) {
      throw new Error("Invalid iMessage chat root");
    }
    this.chatRoot = options.chatRoot;
    try {
      if (!/^http:\/\/(?:127\.0\.0\.1|localhost)(?::[0-9]+)?\/?$/i.test(baseUrl)) {
        throw new Error();
      }
      this.baseUrl = new URL(baseUrl).origin;
    } catch {
      throw new Error("OpenChamber URL must be an HTTP origin on 127.0.0.1 or localhost");
    }
    try {
      this.headers = new Headers(headers);
    } catch {
      throw new Error("Invalid OpenChamber headers");
    }
  }

  private async response(
    path: string,
    { method = "GET", body, directory, signal }: RequestOptions = {},
    accept = "application/json",
    /** Hands a failed response to the caller before it is turned into an error. */
    inspectFailure?: (response: Response) => Promise<void>,
  ): Promise<Response> {
    let response: Response;
    try {
      if (!path.startsWith("/") || path.startsWith("//") || /[\\\x00-\x20\x7f]/.test(path)) {
        throw new Error();
      }
      const url = new URL(path, this.baseUrl);
      if (url.origin !== this.baseUrl || url.hash) throw new Error();
      const headers = new Headers(this.headers);
      headers.set("Accept", accept);
      // OpenCode 2 reads the location from this header and decodes it; its own
      // client sends it percent-encoded so non-ASCII paths stay valid.
      if (directory !== undefined) headers.set("x-opencode-directory", encodeURIComponent(directory));
      if (body !== undefined) headers.set("Content-Type", "application/json");
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        redirect: "manual",
        proxy: "",
        verbose: false,
      });
    } catch {
      throw requestError(0, signal);
    }
    if (!response.ok) {
      await inspectFailure?.(response);
      await response.body?.cancel().catch(() => {});
      throw requestError(response.status, signal);
    }
    return response;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T | undefined> {
    const timeout = AbortSignal.timeout(15_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await this.response(path, { ...options, signal });
    if (response.status === 204) return undefined;
    try {
      return (await response.json()) as T;
    } catch {
      throw requestError(response.status, signal);
    }
  }

  health() {
    return this.request<Health>("/health");
  }

  async sessionBoard(): Promise<BoardSnapshot> {
    const board = await this.request<BoardSnapshot>("/api/session-board");
    assert.ok(board && board.version === 1, "Invalid session board snapshot");
    assert.ok(Number.isSafeInteger(board.revision) && board.revision >= 0);
    assert.ok(Number.isSafeInteger(board.activatedAt) && board.activatedAt >= 0);
    assert.ok([true, false].includes(board.migrationComplete));
    assert.ok(Array.isArray(board.entries));
    if (board.syncError != null) assert.match(board.syncError, /^[\s\S]*$/u);
    for (const entry of board.entries) {
      assert.match(entry.sessionId, ID);
      assert.match(entry.directory, ID);
      assert.match(entry.title, /^[\s\S]*$/u);
      assert.ok(["running", "waiting", "backlog", "scheduled"].includes(entry.state));
      assert.ok(Number.isSafeInteger(entry.workRevision) && entry.workRevision >= 0);
      assert.ok(Number.isSafeInteger(entry.updatedAt) && entry.updatedAt >= 0);
      if (entry.parentId !== undefined) assert.match(entry.parentId, ID);
      if (entry.projectId !== undefined) assert.match(entry.projectId, ID);
      if (entry.status !== undefined) assert.match(entry.status, /^[^\p{Cc}]{1,100}$/u);
      if (entry.attention !== undefined) {
        assert.ok(["question", "approval"].includes(entry.attention.kind));
        assert.ok(Number.isSafeInteger(entry.attention.count) && entry.attention.count > 0);
        if (entry.attention.label !== undefined) assert.match(entry.attention.label, /^[\s\S]*$/u);
      }
    }
    return board;
  }

  async autoAcceptPolicy(): Promise<AutoAcceptPolicy> {
    const policy = await this.request<AutoAcceptPolicy>("/api/permission-auto-accept");
    assert.ok(policy?.sessions && Object.getPrototypeOf(policy.sessions) === Object.prototype, "Invalid auto-accept policy");
    assert.ok(policy.defaultEnabled === undefined || [true, false].includes(policy.defaultEnabled));
    assert.ok(Number.isSafeInteger(policy.revision) && policy.revision >= 0);
    assert.ok(Object.values(policy.sessions).every(value => [true, false].includes(value)));
    return { ...policy, defaultEnabled: policy.defaultEnabled !== false };
  }

  /** Undefined means policy or lineage could not be verified. Never grants permission. */
  async isSessionAutoAccepting(sessionId: string, directory: string): Promise<boolean | undefined> {
    try {
      const policy = await this.autoAcceptPolicy();
      const seen = new Set<string>();
      let id = sessionId;
      while (id && !seen.has(id) && seen.size < 128) {
        if (Object.hasOwn(policy.sessions, id)) return policy.sessions[id];
        seen.add(id);
        const session = await this.getSession(id, directory);
        if (!session || session.id !== id || session.directory !== directory) return;
        if (session.parentID === undefined || session.parentID === null) return policy.defaultEnabled;
        assert.match(session.parentID, ID);
        id = session.parentID;
      }
    } catch { /* Keep pending permissions visible when the policy owner is unavailable. */ }
  }

  async createChat(title?: string): Promise<{ id: string; directory: string }> {
    let root = this.chatRoot;
    if (root === undefined) {
      const home = await this.request<{ home: string; chatsRoot: string }>("/api/fs/home");
      const chatsRoot = home?.chatsRoot;
      if (!validRoot(chatsRoot)) throw new Error("Invalid OpenChamber chats root");
      root = chatsRoot;
    }
    const now = new Date();
    const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
    const directory = `${root.replace(/\/+$/, "")}/${date}/session-${crypto.randomUUID()}`;
    await this.request("/api/fs/mkdir", { method: "POST", body: { path: directory } });
    // OpenCode 2 takes the location in the body; without it the session lands
    // in the server's working directory. A custom title disables title generation.
    const session = sessionRecord(await this.request<unknown>("/api/session", {
      method: "POST",
      directory,
      body: { location: { directory }, metadata: IMESSAGE_METADATA, ...(title === undefined ? {} : { title }) },
    }));
    if (typeof session?.id !== "string" || !session.id) {
      throw new Error("Invalid OpenChamber session response");
    }
    return { id: session.id, directory };
  }

  /**
   * Marks an existing session as an iMessage conversation. The write goes
   * through OpenChamber's metadata route, which reads the record, applies an
   * RFC 7386 merge patch (nested objects merge key by key, so goal, assist and
   * every other `openchamber.*` key survive) and writes it back one write per
   * session at a time, the same queue OpenChamber's own writers use. Resolves
   * `"marked"`, `"already"` when the record already names the origin, or
   * `"missing"` only on OpenCode's own `SessionNotFoundError` for this id.
   * Anything else throws; the next pass tries again.
   */
  async markImessageOrigin(id: string, directory?: string): Promise<"marked" | "already" | "missing"> {
    let session: SessionRecord | undefined;
    try {
      // An id-only read: OpenCode resolves the session's own location.
      session = sessionRecord(await this.readOrNotFound(`/api/session/${encodeURIComponent(id)}`, id, directory));
    } catch (error) {
      if (error === SESSION_NOT_FOUND) return "missing";
      throw error;
    }
    if (!session || session.id !== id || typeof session.directory !== "string") throw new Error("Invalid OpenChamber session response");
    const openchamber = isRecord(session.metadata) && isRecord(session.metadata.openchamber) ? session.metadata.openchamber : {};
    if (openchamber.origin === IMESSAGE_ORIGIN) return "already";
    const result = await this.request<{ metadata?: unknown }>(`/api/openchamber/sessions/${encodeURIComponent(id)}/metadata`, {
      method: "POST",
      body: { patch: IMESSAGE_METADATA, directory: session.directory },
    });
    const merged = isRecord(result?.metadata) && isRecord(result.metadata.openchamber) ? result.metadata.openchamber : {};
    if (merged.origin !== IMESSAGE_ORIGIN) throw new Error("Invalid OpenChamber metadata response");
    return "marked";
  }

  /**
   * A GET whose 404 counts as not-found only when OpenCode's own
   * `SessionNotFoundError` names this exact session. A proxy or route 404 is
   * an ordinary failure.
   */
  private async readOrNotFound(path: string, id: string, directory?: string): Promise<unknown> {
    const signal = AbortSignal.timeout(15_000);
    const response = await this.response(path, { signal, ...(directory === undefined ? {} : { directory }) }, "application/json",
      async failed => {
        if (failed.status !== 404) return;
        const body = await failed.json().catch(() => undefined) as { _tag?: unknown; sessionID?: unknown } | undefined;
        if (body?._tag === "SessionNotFoundError" && body.sessionID === id) throw SESSION_NOT_FOUND;
      });
    try {
      return await response.json();
    } catch {
      throw requestError(response.status, signal);
    }
  }

  async getSession(id: string, directory: string): Promise<SessionRecord | undefined> {
    return sessionRecord(await this.request<unknown>(`/api/session/${encodeURIComponent(id)}`, { directory }));
  }

  /** Direct child sessions (subagents) of one session. */
  async children(id: string, directory: string): Promise<SessionRecord[]> {
    const body = await this.request<unknown>(`/api/session?parentID=${encodeURIComponent(id)}`, { directory });
    const rows = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.data) ? body.data : undefined;
    assert.ok(rows, "Invalid child sessions");
    return rows.map(row => sessionRecord(row)).filter((row): row is SessionRecord =>
      row !== undefined && typeof row.id === "string" && ID.test(row.id) && row.parentID === id);
  }

  /**
   * Session records in chronological order. Pages walk back from the newest
   * record until `until` (a record id) is included, a record older than
   * `since` shows it cannot be further back, or the page budget ends.
   * OpenCode 2 lists `desc` by default and rejects a cursor combined with `order`.
   */
  async messages(
    id: string,
    directory: string,
    { until, since, limit = MESSAGE_PAGE }: { until?: string; since?: number; limit?: number } = {},
  ): Promise<MessageRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid message limit");
    const records: MessageRecord[] = [];
    const seen = new Set<string>();
    let query = `limit=${limit}&order=desc`;
    for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
      const body = await this.request<{ data?: unknown; cursor?: { next?: unknown } }>(
        `/api/session/${encodeURIComponent(id)}/message?${query}`, { directory });
      assert.ok(isRecord(body) && Array.isArray(body.data), "Invalid session messages");
      for (const row of body.data) {
        assert.ok(isRecord(row) && typeof row.id === "string" && typeof row.type === "string", "Invalid session message");
        records.push(row as MessageRecord);
      }
      const next = body.cursor?.next;
      const oldest = records.at(-1)?.time?.created;
      if (until === undefined || body.data.length < limit || records.some(row => row.id === until)
        || (since !== undefined && typeof oldest === "number" && oldest < since)
        || typeof next !== "string" || !next || seen.has(next)) break;
      seen.add(next);
      query = `limit=${limit}&cursor=${encodeURIComponent(next)}`;
    }
    return records.reverse();
  }

  /**
   * True once OpenCode admitted the prompt: it is either still in the session
   * inbox or already promoted to a user record with the same id.
   */
  async promptAccepted(id: string, directory: string, messageId: string): Promise<boolean> {
    try {
      const message = unwrap<{ id?: unknown; type?: unknown } | undefined>(await this.request<unknown>(
        `/api/session/${encodeURIComponent(id)}/message/${encodeURIComponent(messageId)}`, { directory }));
      if (message?.id === messageId && message.type === "user") return true;
    } catch (error) {
      // 404 is OpenCode's MessageNotFoundError: not promoted yet, or never admitted.
      if ((error as { status?: unknown }).status !== 404) throw error;
    }
    const inbox = unwrap<unknown>(await this.request<unknown>(`/api/session/${encodeURIComponent(id)}/inbox`, { directory }));
    assert.ok(Array.isArray(inbox), "Invalid session inbox");
    return inbox.some(item => isRecord(item) && item.id === messageId && item.type === "user");
  }

  /**
   * OpenCode 2 prompts carry text and files only (packages/schema/src/prompt-input.ts).
   * The model is a session property, switched first (a no-op when unchanged),
   * and the per-turn channel guidance travels as a synthetic context record
   * admitted ahead of the prompt without starting execution, the way
   * OpenChamber sends standing context. The prompt then wakes the session.
   */
  async prompt(
    id: string,
    directory: string,
    messageId: string,
    text: string,
    system = DEFAULT_CHANNEL_SYSTEM,
    files: readonly FilePart[] = [],
    model?: { providerID: string; modelID: string; variant?: string },
  ): Promise<void> {
    const session = `/api/session/${encodeURIComponent(id)}`;
    if (model) {
      await this.request(`${session}/model`, {
        method: "POST", directory,
        body: { model: { providerID: model.providerID, id: model.modelID, ...(model.variant ? { variant: model.variant } : {}) } },
      });
    }
    if (system) {
      await this.request(`${session}/synthetic`, {
        method: "POST", directory,
        body: {
          id: `${messageId}_context`, text: system, description: "Messaging channel guidance",
          metadata: { source: "spectrum-bridge", kind: "channel-guidance" }, resume: false,
        },
      });
    }
    await this.request(`${session}/prompt`, {
      method: "POST", directory,
      body: {
        id: messageId, text,
        ...(files.length ? { files: files.map(file => ({ uri: file.url, ...(file.filename ? { name: file.filename } : {}) })) } : {}),
      },
    });
  }

  async abort(id: string, directory: string): Promise<boolean> {
    const result = await this.request<{ interrupted?: unknown }>(`/api/session/${encodeURIComponent(id)}/interrupt`, { method: "POST", directory });
    return result?.interrupted === true;
  }

  /** Global: every running session across locations. Absent means idle. */
  async statuses(): Promise<Record<string, SessionStatus>> {
    const active = unwrap<unknown>(await this.request<unknown>("/api/session/active"));
    assert.ok(isRecord(active) && Object.getPrototypeOf(active) === Object.prototype, "Invalid session statuses");
    const statuses: Record<string, SessionStatus> = {};
    for (const [id, status] of Object.entries(active)) {
      assert.ok(ID.test(id) && isRecord(status) && typeof status.type === "string", "Invalid session status");
      statuses[id] = { type: "busy" };
    }
    return statuses;
  }

  /** Pending permission requests owned by one session (session-scoped route). */
  async permissions(sessionId: string, directory: string): Promise<PermissionRequest[]> {
    const requests = unwrap<unknown>(await this.request<unknown>(`/api/session/${encodeURIComponent(sessionId)}/permission`, { directory }));
    assert.ok(Array.isArray(requests), "Invalid pending permissions");
    for (const request of requests) {
      assert.match(request?.id, ID);
      assert.match(request.sessionID, ID);
      assert.ok(typeof request.action === "string" && Array.isArray(request.resources), "Invalid permission request");
    }
    return requests as PermissionRequest[];
  }

  /** Pending forms owned by one session, as questions. */
  async questions(sessionId: string, directory: string): Promise<QuestionRequest[]> {
    const forms = unwrap<unknown>(await this.request<unknown>(`/api/session/${encodeURIComponent(sessionId)}/form`, { directory }));
    assert.ok(Array.isArray(forms), "Invalid pending questions");
    for (const form of forms) {
      assert.match(form?.id, ID);
      assert.match(form.sessionID, ID);
      assert.ok(typeof form.title === "string" && Array.isArray(form.fields), "Invalid form");
    }
    return (forms as FormInfo[]).map(questionFromForm);
  }

  /** OpenCode 2.0.8 renamed the reply body field `reply` to `decision`; the route is session-scoped. */
  async permissionReply(sessionId: string, requestId: string, directory: string, reply: "once" | "reject"): Promise<boolean> {
    if (reply !== "once" && reply !== "reject") throw new Error("Invalid permission reply");
    await this.request(`/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`, {
      method: "POST", directory, body: { decision: reply },
    });
    return true;
  }

  /** Answers a form with one entry per field, keyed by field and carrying option values. */
  async questionReply(request: QuestionRequest, directory: string, answers: string[][]): Promise<boolean> {
    const answer = formAnswer(request, answers);
    await this.request(`/api/session/${encodeURIComponent(request.sessionID)}/form/${encodeURIComponent(request.id)}/reply`, {
      method: "POST", directory, body: { answer },
    });
    return true;
  }

  /** Dismisses a form; the asking tool fails with "The user dismissed this question". */
  async cancelQuestion(sessionId: string, formId: string, directory: string): Promise<boolean> {
    await this.request(`/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}`, { method: "DELETE", directory });
    return true;
  }

  /** Yields JSON data, including initial events; callers own reconnects and event validation. */
  async *events(
    path: "/api/event" | "/api/openchamber/events",
    signal: AbortSignal,
  ): AsyncGenerator<JsonValue, void, unknown> {
    if (path !== "/api/event" && path !== "/api/openchamber/events") throw requestError(0);
    const response = await this.response(path, { signal }, "text/event-stream");
    if (response.status === 204) return;
    if (!response.body || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "text/event-stream") {
      await response.body?.cancel().catch(() => {});
      throw requestError(response.status, signal);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let data: string[] = [];
    let skipLF = false;
    try {
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        if (skipLF && buffer.length) {
          if (buffer.startsWith("\n")) buffer = buffer.slice(1);
          skipLF = false;
        }
        let ending: RegExpExecArray | null;
        while ((ending = /[\r\n]/.exec(buffer))) {
          const index = ending.index;
          // Dispatch CR immediately, but swallow its optional LF in the next chunk.
          skipLF = buffer[index] === "\r" && index === buffer.length - 1;
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + (buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1));
          if (line === "") {
            if (data.length) {
              const payload = data.join("\n");
              data = [];
              if (payload.trim()) {
                signal.throwIfAborted();
                yield JSON.parse(payload);
              }
            }
          } else if (line === "data") {
            data.push("");
          } else if (line.startsWith("data:")) {
            data.push(line.slice(5).replace(/^ /, ""));
          }
        }
        // SSE dispatch requires a blank line; discard incomplete frames at EOF.
        if (done) return;
      }
    } catch {
      throw requestError(response.status, signal);
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

/** Visible answer text of one assistant step; never reasoning or tool output. */
export function assistantText(record: MessageRecord): string {
  if (record.type !== "assistant" || !Array.isArray(record.content)) return "";
  return record.content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map(part => part.text)
    .join("\n\n")
    .trim();
}
