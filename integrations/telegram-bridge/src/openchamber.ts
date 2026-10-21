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

const ID = /^[^\p{Cc}]{1,4096}$/u;

/**
 * `metadata.openchamber.origin` of sessions the iMessage bridge created. Those
 * conversations (and their subagents, which inherit the metadata) ask their
 * questions and approvals over iMessage, never on Telegram.
 */
export const IMESSAGE_ORIGIN = "imessage";

export function sessionOrigin(session: SessionRecord | undefined): string | undefined {
  const openchamber = isRecord(session?.metadata) ? session.metadata.openchamber : undefined;
  const origin = isRecord(openchamber) ? openchamber.origin : undefined;
  return typeof origin === "string" && origin ? origin : undefined;
}

function requestError(status: number, signal?: AbortSignal): Error & { status: number } {
  // Never expose response bodies, URLs, headers, parser errors, or abort reasons.
  const error = Object.assign(new Error(`OpenChamber request failed (HTTP ${status})`), { status });
  if (signal?.aborted) error.name = "AbortError";
  return error;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

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

/**
 * What the alert logic in attention.ts needs from a backend. OpenChamber
 * implements it here; Robob's control API implements it in robob.ts.
 */
export interface AlertBackend {
  /** How notices name the app and its review board. Defaults to OpenChamber and Sessions. */
  readonly brand?: { app: string; board: string };
  health(): Promise<{ status: string; openchamberVersion?: string; [key: string]: unknown } | undefined>;
  sessionBoard(): Promise<BoardSnapshot>;
  getSession(id: string, directory: string): Promise<SessionRecord | undefined>;
  statuses(): Promise<Record<string, SessionStatus>>;
  permissions(directory: string): Promise<PermissionRequest[]>;
  questions(directory: string): Promise<QuestionRequest[]>;
  permissionReply(sessionId: string, requestId: string, directory: string, reply: "once" | "reject"): Promise<boolean>;
  questionReply(request: QuestionRequest, directory: string, answers: string[][]): Promise<boolean>;
  isSessionAutoAccepting(sessionId: string, directory: string): Promise<boolean | undefined>;
  /**
   * True when the session's questions go to its mission lead, not the owner:
   * a mission thread other than the master. Unknown or unreadable is false.
   */
  leadAnswers?(sessionId: string): Promise<boolean>;
}

export class OpenChamber implements AlertBackend {
  private readonly baseUrl: string;
  private readonly headers: Headers;

  constructor(baseUrl: string, headers: Record<string, string> = {}) {
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

  async getSession(id: string, directory: string): Promise<SessionRecord | undefined> {
    return sessionRecord(await this.request<unknown>(`/api/session/${encodeURIComponent(id)}`, { directory }));
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

  /** Pending permission requests of one location (`{ location, data }`). */
  async permissions(directory: string): Promise<PermissionRequest[]> {
    const requests = unwrap<unknown>(await this.request<unknown>("/api/permission/request", { directory }));
    assert.ok(Array.isArray(requests), "Invalid pending permissions");
    for (const request of requests) {
      assert.match(request?.id, ID);
      assert.match(request.sessionID, ID);
      assert.ok(typeof request.action === "string" && Array.isArray(request.resources), "Invalid permission request");
    }
    return requests as PermissionRequest[];
  }

  /**
   * Pending forms of one location, as questions. `global` marks an MCP
   * elicitation that belongs to no session; it has nothing to route to.
   */
  async questions(directory: string): Promise<QuestionRequest[]> {
    const forms = unwrap<unknown>(await this.request<unknown>("/api/form", { directory }));
    assert.ok(Array.isArray(forms), "Invalid pending questions");
    for (const form of forms) {
      assert.match(form?.id, ID);
      assert.match(form.sessionID, ID);
      assert.ok(typeof form.title === "string" && Array.isArray(form.fields), "Invalid form");
    }
    return (forms as FormInfo[]).filter(form => form.sessionID !== "global").map(questionFromForm);
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
