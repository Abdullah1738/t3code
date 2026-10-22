// Dependency-free client for the ardud control API (/api/ardud/control/*).
// Node 18+ (global fetch). Copy or import this file directly; it has no imports
// beyond node: builtins.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** @param {string} [home] */
const robobHome = (home = NodeOS.homedir()) => NodePath.join(home, ".robob");
/** The old shared credential, read last while it still exists. */
export const SHARED_TOKEN_FILE = NodePath.join(robobHome(), "ardud-control.json");
/** @param {string} component @param {string} [home] */
export const componentTokenFile = (component, home) =>
  NodePath.join(robobHome(home), "components", `${component}.json`);
const PREFIX = "/api/ardud/control";

/**
 * @typedef {"idle" | "running" | "waiting" | "needs-input" | "queued"} ThreadState
 * @typedef {{ instanceId: string, model: string, variant?: string }} ModelRef
 * @typedef {{
 *   threadId: string, projectId: string, title: string, state: ThreadState, status: string,
 *   origin: string | null, nativeSessionId: string | null, model: ModelRef,
 *   runtimeMode: string, interactionMode: string, parentThreadId: string | null,
 *   rootThreadId: string, worktreePath: string | null,
 *   pendingRequest: { requestId: string, kind: "approval" | "question", requestKind: string } | null,
 *   latestMessage: { messageId: string, role: string, text: string } | null,
 *   createdAt: string, updatedAt: string,
 * }} ThreadSummary
 * @typedef {{
 *   type: string, threadId?: string, runId?: string | null, status?: string, state?: ThreadState,
 *   messageId?: string, role?: string, text?: string, requestId?: string,
 *   kind?: "approval" | "question", origin?: string | null, sequence?: number,
 * }} ControlEvent
 */

export class ControlApiError extends Error {
  /**
   * @param {number} status @param {string} code @param {string} message
   * @param {unknown} [body] the parsed response, for refusals that carry more than a message
   */
  constructor(status, code, message, body) {
    super(message);
    this.name = "ControlApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/**
 * Finds the base URL and token: explicit options, then T3_CONTROL_URL /
 * T3_CONTROL_TOKEN, then a token file. A file named by `tokenFile` or
 * T3_CONTROL_TOKEN_FILE must exist, so a typo never acts as another component.
 * Otherwise the component's own credential (~/.robob/components/<component>.json)
 * and then the shared ~/.robob/ardud-control.json, whichever exists first.
 * Token files must not be readable by group or others.
 * @param {{ url?: string, token?: string, tokenFile?: string, component?: string, home?: string }} [options]
 */
export function discoverConfig(options = {}) {
  let url = options.url ?? process.env.T3_CONTROL_URL;
  let token = options.token ?? process.env.T3_CONTROL_TOKEN;
  const named = options.tokenFile ?? process.env.T3_CONTROL_TOKEN_FILE;
  const files = named
    ? [named]
    : [
        options.component ? componentTokenFile(options.component, options.home) : undefined,
        NodePath.join(robobHome(options.home), "ardud-control.json"),
      ].filter(Boolean);
  for (const file of url && token ? [] : files) {
    let stored;
    try {
      const mode = NodeFS.statSync(file).mode & 0o077;
      if (mode !== 0) throw new Error(`${file} must be chmod 600`);
      stored = JSON.parse(NodeFS.readFileSync(file, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT" && !named) continue;
      throw error;
    }
    url ??= stored?.url;
    token ??= stored?.token;
    break;
  }
  const where = `set T3_CONTROL_URL / T3_CONTROL_TOKEN or write one of ${files.join(", ")}`;
  if (!url) throw new Error(`No control URL: ${where}`);
  if (!token) throw new Error(`No control token: ${where}`);
  return { url: url.replace(/\/+$/, ""), token };
}

export class ControlClient {
  /** @param {{ url?: string, token?: string, tokenFile?: string, component?: string, home?: string, timeoutMs?: number }} [options] */
  constructor(options = {}) {
    const { url, token } = discoverConfig(options);
    this.url = url;
    this.token = token;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /**
   * @param {string} method @param {string} path @param {unknown} [body]
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
   */
  async request(method, path, body, options = {}) {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await fetch(`${this.url}${PREFIX}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON bodies only come from proxies or crashes.
    }
    if (!response.ok || data?.ok === false) {
      throw new ControlApiError(
        response.status,
        data?.error?.code ?? "http_error",
        data?.error?.message ?? `HTTP ${response.status}`,
        data,
      );
    }
    return data;
  }

  /** Checks the token and returns the latest event sequence. */
  health() {
    return this.request("GET", "/health");
  }

  /**
   * Every pending approval and question across active threads.
   * @param {{ origin?: string }} [filters]
   */
  pendingRequests(filters = {}) {
    const suffix = filters.origin ? `?origin=${encodeURIComponent(filters.origin)}` : "";
    return this.request("GET", `/requests${suffix}`);
  }

  /** @returns {Promise<{ projects: Array<{ projectId: string, title: string, workspaceRoot: string, scratch: boolean }> }>} */
  projects() {
    return this.request("GET", "/projects");
  }

  models() {
    return this.request("GET", "/models");
  }

  /**
   * @param {{ origin?: string, active?: boolean, state?: string, updatedSince?: string | number,
   *   projectId?: string, parentThreadId?: string, includeSubagents?: boolean, archived?: boolean, limit?: number,
   *   ids?: string[] }} [filters]
   * @returns {Promise<{ total: number, threads: ThreadSummary[] }>}
   */
  listThreads(filters = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined || value === null) continue;
      query.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }
    const suffix = query.size > 0 ? `?${query}` : "";
    return this.request("GET", `/threads${suffix}`);
  }

  /**
   * Starts a thread. `model` is "provider/model" (OpenCode slug), `variant` the
   * reasoning variant. Pick the folder with one of projectId, directory or
   * scratch (default: scratch, a fresh folder per thread).
   * @param {{ prompt?: string, title?: string, projectId?: string, directory?: string,
   *   scratch?: boolean, model?: string, variant?: string, runtimeMode?: string,
   *   interactionMode?: "default" | "plan", origin?: string, clientRequestId?: string,
   *   worktree?: { baseRef: string, branch?: string, startFromOrigin?: boolean },
   *   attachments?: Array<{ attachmentId: string, name: string, mimeType: string, sizeBytes: number, type?: "image" | "file" }> }} input
   */
  createThread(input) {
    return this.request("POST", "/threads", input);
  }

  /** @param {string} threadId */
  thread(threadId) {
    return this.request("GET", `/threads/${encodeURIComponent(threadId)}`);
  }

  /** Looks up the thread for an OpenCode session id (ses_...). @param {string} sessionId */
  threadByNativeSession(sessionId) {
    return this.request("GET", `/threads/by-native/${encodeURIComponent(sessionId)}`);
  }

  /**
   * @param {string} threadId
   * @param {{ limit?: number, all?: boolean, role?: "user" | "assistant" | "all",
   *   runId?: string, since?: string | number, afterMessageId?: string }} [options]
   */
  messages(threadId, options = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined && value !== null) query.set(key, String(value));
    }
    const suffix = query.size > 0 ? `?${query}` : "";
    return this.request("GET", `/threads/${encodeURIComponent(threadId)}/messages${suffix}`);
  }

  /** @param {string} threadId @returns {Promise<string | null>} */
  async lastAssistantText(threadId) {
    const result = await this.messages(threadId, { limit: 1, role: "assistant" });
    return result.lastAssistant?.text ?? null;
  }

  /**
   * @param {string} threadId @param {string} text
   * @param {{ mode?: "auto" | "queue" | "steer" | "restart", model?: string, variant?: string,
   *   clientRequestId?: string, attachments?: Array<object> }} [options]
   */
  send(threadId, text, options = {}) {
    return this.request("POST", `/threads/${encodeURIComponent(threadId)}/send`, {
      text,
      ...options,
    });
  }

  /** @param {string} threadId @param {{ reason?: string }} [options] */
  interrupt(threadId, options = {}) {
    return this.request("POST", `/threads/${encodeURIComponent(threadId)}/interrupt`, options);
  }

  /**
   * Answers an approval (decision: approve | deny | always, or a t3 decision)
   * or a question (answers keyed by question id, or dismiss: true).
   * @param {string} threadId @param {string} requestId
   * @param {{ decision?: string, answers?: Record<string, string | string[]>, dismiss?: boolean }} response
   */
  respond(threadId, requestId, response) {
    return this.request(
      "POST",
      `/threads/${encodeURIComponent(threadId)}/requests/${encodeURIComponent(requestId)}/respond`,
      response,
    );
  }

  /** @param {string} threadId @param {string | null} origin */
  setOrigin(threadId, origin) {
    return this.request("PUT", `/threads/${encodeURIComponent(threadId)}/origin`, { origin });
  }

  /**
   * @param {string} threadId
   * @param {{ runtimeMode?: string, interactionMode?: string, model?: string,
   *   variant?: string | null, title?: string, archived?: boolean, settled?: boolean }} settings
   */
  updateThread(threadId, settings) {
    return this.request("PATCH", `/threads/${encodeURIComponent(threadId)}`, settings);
  }

  /**
   * Archives the thread only if it is idle when the server takes it, and, with
   * `expectedSession`, still on that native session. A refusal resolves to
   * `{ ok: false, archived: false, error: { code: "not_idle", reason, message } }`
   * and leaves the thread alone.
   * @param {string} threadId
   * @param {{ expectedSession?: string }} [options]
   */
  async archiveIfIdle(threadId, options = {}) {
    try {
      return await this.request(
        "POST",
        `/threads/${encodeURIComponent(threadId)}/archive-if-idle`,
        options.expectedSession ? { expectedSession: options.expectedSession } : {},
      );
    } catch (error) {
      if (error instanceof ControlApiError && error.code === "not_idle") return error.body;
      throw error;
    }
  }

  /**
   * Blocks until the thread is idle, waiting on background work, or asking for
   * input. `drain: true` also waits out background work.
   * @param {string} threadId
   * @param {{ timeoutMs?: number, runId?: string, drain?: boolean }} [options]
   */
  wait(threadId, options = {}) {
    const timeoutMs = options.timeoutMs ?? 10 * 60_000;
    const query = new URLSearchParams({ timeoutMs: String(timeoutMs) });
    if (options.runId) query.set("runId", options.runId);
    if (options.drain) query.set("drain", "1");
    return this.request(
      "GET",
      `/threads/${encodeURIComponent(threadId)}/wait?${query}`,
      undefined,
      {
        timeoutMs: timeoutMs + 30_000,
      },
    );
  }

  /**
   * Uploads a file for use as an attachment on createThread/send.
   * @param {{ name: string, mimeType: string, bytes: Uint8Array, type?: "image" | "file" }} file
   */
  async upload(file) {
    const type = file.type ?? (file.mimeType.startsWith("image/") ? "image" : "file");
    const issued = await this.request("POST", "/attachments", {
      type,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.bytes.byteLength,
    });
    const response = await fetch(`${this.url}${issued.relativeUrl}`, {
      method: "POST",
      headers: { "content-length": String(file.bytes.byteLength) },
      body: file.bytes,
    });
    if (!response.ok) {
      throw new ControlApiError(response.status, "upload_failed", await response.text());
    }
    return {
      attachmentId: issued.attachmentId,
      type,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.bytes.byteLength,
    };
  }

  /**
   * Streams control events. Reconnects with Last-Event-ID until `signal` aborts.
   * @param {{ signal?: AbortSignal, after?: number, threadId?: string, origin?: string,
   *   types?: string[], reconnect?: boolean, onError?: (error: unknown) => void }} [options]
   * @returns {AsyncGenerator<ControlEvent & { sequence: number }>}
   */
  async *events(options = {}) {
    let lastId = options.after;
    let backoff = 1_000;
    while (!options.signal?.aborted) {
      try {
        const query = new URLSearchParams();
        if (options.threadId) query.set("threadId", options.threadId);
        if (options.origin) query.set("origin", options.origin);
        if (options.types?.length) query.set("types", options.types.join(","));
        const suffix = query.size > 0 ? `?${query}` : "";
        const response = await fetch(`${this.url}${PREFIX}/events${suffix}`, {
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: "text/event-stream",
            ...(lastId === undefined ? {} : { "last-event-id": String(lastId) }),
          },
          signal: options.signal,
        });
        if (!response.ok || !response.body) {
          throw new ControlApiError(
            response.status,
            "events_unavailable",
            `HTTP ${response.status}`,
          );
        }
        backoff = 1_000;
        for await (const frame of parseSse(response.body)) {
          if (frame.id !== undefined && /^\d+$/.test(frame.id)) lastId = Number(frame.id);
          if (frame.event === "ready" || !frame.data) continue;
          const data = JSON.parse(frame.data);
          yield { ...data, sequence: lastId };
        }
      } catch (error) {
        if (options.signal?.aborted) return;
        options.onError?.(error);
        if (error instanceof ControlApiError && (error.status === 401 || error.status === 403)) {
          throw error;
        }
      }
      if (options.reconnect === false) return;
      await new Promise((resolve) => setTimeout(resolve, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

/** @param {ReadableStream<Uint8Array>} body */
async function* parseSse(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  let frame = {};
  let data = [];
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.search(/\r?\n/)) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + (buffer[index] === "\r" ? 2 : 1));
      if (line === "") {
        if (data.length > 0 || frame.event) yield { ...frame, data: data.join("\n") };
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
  }
}
