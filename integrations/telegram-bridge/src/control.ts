// Client for Robob's local control API (/api/ardud/control/*), plus the
// mapping from its thread and request shapes onto the bridge vocabulary.
// spectrum-bridge carries its own variant of this file, since each package is
// deployed on its own; they differ in which control credential they read.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PermissionRequest, QuestionRequest } from "./openchamber.ts";

const COMPONENT = "telegram-bridge";
const PREFIX = "/api/ardud/control";
const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?\/?$/i;

export type ThreadState = "idle" | "running" | "waiting" | "needs-input" | "queued";

export interface ThreadSummary {
  threadId: string;
  projectId: string;
  title: string;
  state: ThreadState;
  status: string;
  origin: string | null;
  nativeSessionId: string | null;
  model?: { instanceId: string; model: string; variant?: string };
  runtimeMode: string;
  interactionMode?: string;
  createdBy?: string;
  creationSource?: string;
  parentThreadId: string | null;
  rootThreadId: string;
  relationshipToParent?: string | null;
  worktreePath: string | null;
  latestRunId?: string | null;
  activeRunId?: string | null;
  pendingRequest: { requestId: string; kind: "approval" | "question"; requestKind: string } | null;
  lastError?: string | null;
  archived?: boolean;
  settled?: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface RunSummary {
  runId: string;
  ordinal: number;
  status: string;
  requestedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface PendingRequest {
  requestId: string;
  kind: "approval" | "question";
  requestKind: string;
  status?: string;
  createdAt?: string | null;
  canRespond?: boolean;
  prompt?: string | null;
  title?: string | null;
  questions?: Array<{
    id: string;
    header: string;
    question: string;
    options: Array<{ label: string; description?: string; value?: string }>;
    multiSelect?: boolean;
    allowCustomAnswer?: boolean;
  }>;
}

export interface ThreadDetail extends ThreadSummary {
  run: RunSummary | null;
  recentRuns: RunSummary[];
  pendingRequests: PendingRequest[];
}

export interface ControlMessage {
  messageId: string;
  runId: string | null;
  role: "user" | "assistant" | "system";
  text: string;
  streaming: boolean;
  createdBy?: string;
  creationSource?: string;
  createdAt: string | null;
  updatedAt: string | null;
}

/** A mission as the missions status snapshot lists it; only the fields the bridge reads. */
export interface MissionThreads {
  id: string;
  /** Threads that belong to the mission. */
  threadIds?: string[];
  /** The master's threads; older servers leave it out. */
  masterThreadIds?: string[];
}

export interface ControlEventFrame {
  id?: string;
  event?: string;
  data: Record<string, unknown>;
}

export class ControlError extends Error {
  constructor(readonly status: number, readonly code = "") {
    // Never carry response bodies, URLs or tokens into errors.
    super(`Robob control request failed (HTTP ${status})`);
    this.name = "ControlError";
  }
}

export interface ControlConfigOptions {
  url?: string;
  token?: string;
  tokenFile?: string;
  env?: Record<string, string | undefined>;
  home?: string;
}

/**
 * Explicit options, then T3_CONTROL_URL / T3_CONTROL_TOKEN, then a token file.
 * A file named by `tokenFile` or T3_CONTROL_TOKEN_FILE must exist, so a typo
 * never acts as another component. Otherwise this bridge's own component
 * credential, then the shared ~/.robob/ardud-control.json, whichever exists
 * first. Token files must be chmod 600. Same order as the control API's own
 * client.mjs.
 */
export function discoverControlConfig(options: ControlConfigOptions = {}): { url: string; token: string } {
  const env = options.env ?? process.env;
  let url = options.url ?? env.T3_CONTROL_URL;
  let token = options.token ?? env.T3_CONTROL_TOKEN;
  const named = options.tokenFile ?? env.T3_CONTROL_TOKEN_FILE;
  const robob = join(options.home ?? homedir(), ".robob");
  const files = named ? [named] : [join(robob, "components", `${COMPONENT}.json`), join(robob, "ardud-control.json")];
  for (const file of url && token ? [] : files) {
    let stored: { url?: unknown; token?: unknown };
    try {
      if (statSync(file).mode & 0o077) throw new Error("Robob control token file must be chmod 600");
      stored = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !named) continue;
      throw error;
    }
    url ??= typeof stored?.url === "string" ? stored.url : undefined;
    token ??= typeof stored?.token === "string" ? stored.token : undefined;
    break;
  }
  if (!url || !LOOPBACK.test(url)) throw new Error("Robob control URL must be an HTTP origin on 127.0.0.1 or localhost");
  if (!token || /[\s\x00-\x1f\x7f]/.test(token)) throw new Error("Robob control token unavailable");
  return { url: new URL(url).origin, token };
}

export class ControlClient {
  readonly url: string;
  private readonly token: string;

  constructor(options: ControlConfigOptions = {}) {
    const { url, token } = discoverControlConfig(options);
    this.url = url;
    this.token = token;
  }

  async request<T>(method: string, path: string, body?: unknown, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(`${this.url}${PREFIX}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
        redirect: "manual",
        proxy: "",
        verbose: false,
      });
    } catch {
      throw new ControlError(0);
    }
    let data: { ok?: unknown; error?: { code?: unknown } } | undefined;
    try {
      data = await response.json() as typeof data;
    } catch { /* Non-JSON bodies only come from proxies or crashes. */ }
    if (!response.ok || data?.ok !== true) {
      throw new ControlError(response.status || 0, typeof data?.error?.code === "string" ? data.error.code : "");
    }
    return data as T;
  }

  thread(threadId: string): Promise<{ thread: ThreadDetail }> {
    return this.request("GET", `/threads/${encodeURIComponent(threadId)}`);
  }

  byNative(sessionId: string): Promise<{ thread: ThreadDetail }> {
    return this.request("GET", `/threads/by-native/${encodeURIComponent(sessionId)}`);
  }

  listThreads(filters: Record<string, string | number | boolean | string[] | undefined> = {}): Promise<{ total: number; threads: ThreadSummary[] }> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined) query.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }
    return this.request("GET", `/threads${query.size ? `?${query}` : ""}`);
  }

  messages(threadId: string): Promise<{ messages: ControlMessage[]; state: ThreadState; status: string; runId: string | null }> {
    return this.request("GET", `/threads/${encodeURIComponent(threadId)}/messages?all=true&role=all`);
  }

  projects(): Promise<{ projects: Array<{ projectId: string; title: string; workspaceRoot: string; scratch?: boolean }> }> {
    return this.request("GET", "/projects");
  }

  /** Robob's session board snapshot. It lives outside the control prefix and has no `ok` envelope. */
  board<T>(): Promise<T> {
    return this.outside<T>("/api/ardud/board", "board");
  }

  /** Every listed mission with its thread ids (`GET /api/ardud/missions/status`). */
  missions(): Promise<{ missions: MissionThreads[] }> {
    return this.outside("/api/ardud/missions/status", "missions");
  }

  /** A read-only GET outside the control prefix. */
  private async outside<T>(path: string, what: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.url}${path}`, {
        headers: { authorization: `Bearer ${this.token}`, accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
        redirect: "manual",
        proxy: "",
        verbose: false,
      });
    } catch {
      throw new ControlError(0);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ControlError(response.status, what);
    }
    return await response.json() as T;
  }

  respond(threadId: string, requestId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/threads/${encodeURIComponent(threadId)}/requests/${encodeURIComponent(requestId)}/respond`, body);
  }

  /** Uploads one file through a signed URL and returns the attachment reference for send. */
  async upload(file: { name: string; mimeType: string; bytes: Uint8Array }) {
    const type = file.mimeType.startsWith("image/") ? "image" as const : "file" as const;
    const issued = await this.request<{ attachmentId: string; relativeUrl: string }>("POST", "/attachments", {
      type, name: file.name, mimeType: file.mimeType, sizeBytes: file.bytes.byteLength,
    });
    if (typeof issued.relativeUrl !== "string" || !issued.relativeUrl.startsWith("/") || issued.relativeUrl.startsWith("//")) {
      throw new ControlError(0, "upload_url");
    }
    let response: Response;
    try {
      response = await fetch(`${this.url}${issued.relativeUrl}`, {
        method: "POST",
        headers: { "content-length": String(file.bytes.byteLength) },
        body: new Blob([file.bytes as Uint8Array<ArrayBuffer>]),
        signal: AbortSignal.timeout(120_000),
        redirect: "manual",
        proxy: "",
        verbose: false,
      });
    } catch {
      throw new ControlError(0, "upload_failed");
    }
    await response.body?.cancel().catch(() => {});
    if (!response.ok) throw new ControlError(response.status, "upload_failed");
    return { attachmentId: issued.attachmentId, type, name: file.name, mimeType: file.mimeType, sizeBytes: file.bytes.byteLength };
  }

  /**
   * One SSE connection to /events. `after` resumes with Last-Event-ID; without
   * it the stream starts at the live head. Callers own reconnects.
   */
  async *events(options: { signal: AbortSignal; after?: number; types?: string[] }): AsyncGenerator<ControlEventFrame, void, unknown> {
    const query = new URLSearchParams();
    if (options.types?.length) query.set("types", options.types.join(","));
    let response: Response;
    try {
      response = await fetch(`${this.url}${PREFIX}/events${query.size ? `?${query}` : ""}`, {
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "text/event-stream",
          ...(options.after === undefined ? {} : { "last-event-id": String(options.after) }),
        },
        signal: options.signal,
        redirect: "manual",
        proxy: "",
        verbose: false,
      });
    } catch {
      throw new ControlError(0);
    }
    if (!response.ok || !response.body || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "text/event-stream") {
      await response.body?.cancel().catch(() => {});
      throw new ControlError(response.status);
    }
    yield* parseSse(response.body, options.signal);
  }
}

/** Minimal SSE framing: `id`, `event` and `data` lines, dispatched on a blank line. */
export async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<ControlEventFrame, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let frame: { id?: string; event?: string } = {};
  let data: string[] = [];
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let index: number;
      while ((index = buffer.search(/\r?\n/)) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + (buffer[index] === "\r" ? 2 : 1));
        if (line === "") {
          if (data.length) {
            let parsed: unknown;
            try { parsed = JSON.parse(data.join("\n")); } catch { parsed = undefined; }
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              yield { ...frame, data: parsed as Record<string, unknown> };
            }
          }
          frame = {};
          data = [];
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "data") data.push(value);
        else if (field === "id") frame.id = value;
        else if (field === "event") frame.event = value;
      }
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Epoch milliseconds of an ISO time, or `fallback`. */
export const epoch = (value: string | null | undefined, fallback = 0): number => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** An OpenCode-style approval as the bridges know it. `sessionID` is the id the caller asked with. */
export function permissionFrom(request: PendingRequest, sessionID: string): PermissionRequest {
  // The OpenCode adapter puts the permission action in `title` and its resources in `prompt`.
  const prompt = typeof request.prompt === "string" ? request.prompt : "";
  return {
    id: request.requestId,
    sessionID,
    action: request.title?.trim() || request.requestKind,
    resources: prompt.split("\n").map(line => line.trim()).filter(Boolean),
  };
}

export function questionFrom(request: PendingRequest, sessionID: string): QuestionRequest {
  const questions = request.questions ?? [];
  const unsupported = request.canRespond === false || questions.length === 0;
  return {
    id: request.requestId,
    sessionID,
    title: request.title?.trim() || "Question",
    questions: unsupported ? [] : questions.map(question => ({
      key: question.id,
      question: question.question,
      header: question.header,
      options: question.options.map(option => ({
        label: option.label,
        ...(option.value === undefined ? {} : { value: option.value }),
        ...(option.description === undefined || option.description === option.label ? {} : { description: option.description }),
      })),
      multiple: question.multiSelect === true,
      custom: question.allowCustomAnswer === true,
    })),
    ...(unsupported ? { unsupported: true } : {}),
  };
}

/** A thread runs at its worktree; a root thread without one runs at its project root. */
export class ThreadDirectories {
  private roots = new Map<string, string>();
  private loadedAt = 0;

  constructor(private readonly client: Pick<ControlClient, "projects">) {}

  async rootOf(projectId: string): Promise<string | undefined> {
    if (!this.roots.has(projectId) && Date.now() - this.loadedAt > 5_000) await this.refresh();
    return this.roots.get(projectId);
  }

  async refresh(): Promise<Array<{ projectId: string; workspaceRoot: string }>> {
    const { projects } = await this.client.projects();
    this.roots = new Map(projects.map(project => [project.projectId, project.workspaceRoot]));
    this.loadedAt = Date.now();
    return projects;
  }

  async of(thread: Pick<ThreadSummary, "worktreePath" | "projectId">): Promise<string> {
    return thread.worktreePath ?? await this.rootOf(thread.projectId) ?? "/";
  }
}
