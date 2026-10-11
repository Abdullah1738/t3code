import { createHash } from "node:crypto";
import { MAX_FILE_BYTES, validAppUrl, validFileName, validMimeType } from "./cli.ts";
import { isEffect, type Photon, type ReactionKind } from "./photon.ts";
import type { Router } from "./router.ts";
import { forgetSecret, newToken, putSecretRequest, readSecret, SECRET_REQUEST_TTL_MS, SecretError, validFieldName, validFields,
  validToken } from "./secrets.ts";
import { sessionMatches } from "./session.ts";
import type { OutboxOperation, Store } from "./store.ts";

type Options = {
  store: Store;
  photon: Pick<Photon, "react">;
  router: () => Router | undefined;
  chatGuid: () => string | undefined;
  enabled: () => boolean;
  health: () => Record<string, unknown>;
  /** Secure credential forms; absent when the apps server is unavailable. */
  secrets?: {
    stateRoot: string;
    /** Returns the tailnet https base URL of the apps server, publishing it if needed. */
    publishApps: () => Promise<string>;
    now?: () => number;
  };
};

type SavedSecretRequest = { spec: string; result: { token: string; url: string; expiresAt: number } };

const MAX_BODY = 20 * 1024;
// 12000 UTF-16 units of JSON-escaped text can exceed MAX_BODY.
const MAX_SEND_BODY = 96 * 1024;
// Main's Bun.serve maxRequestBodySize must permit this; other routes keep MAX_BODY.
export const MAX_FILE_BODY = 28 * 1024 * 1024;
const MAX_RESPONSE = 128 * 1024;
const errors = {
  400: "Invalid request", 403: "Forbidden", 404: "Not found",
  409: "Operation could not be completed", 410: "Expired", 413: "Request body too large",
  502: "Tailnet publish failed", 503: "Bridge is not ready",
} as const;
class ApiError extends Error {
  constructor(readonly status: keyof typeof errors) { super(errors[status]); }
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const string = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max && value.trim().length > 0;

function json(value: unknown, status = 200): Response {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_RESPONSE) throw new ApiError(409);
  return new Response(body, {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

async function readBody(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) throw new ApiError(400);
  if (length !== null && Number(length) > maxBytes) {
    void request.body?.cancel().catch(() => {});
    throw new ApiError(413);
  }
  if (!request.body) return {};
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new ApiError(400);
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        // Do not wait for an untrusted stream's cancellation callback.
        void reader.cancel().catch(() => {});
        throw new ApiError(413);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400);
    return body as Record<string, unknown>;
  } catch (error) {
    throw error instanceof ApiError ? error : new ApiError(400);
  } finally {
    reader.releaseLock();
  }
}

function fields(body: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new ApiError(400);
}

const line = (value: unknown, max: number): value is string => string(value, max) && !/[\x00-\x1f\x7f-\x9f]/.test(value);
const optionalLine = (value: unknown, max: number) => value === undefined || line(value, max);
const validSession = (value: unknown): value is string => string(value, 200) && !/\s|[\x00-\x1f\x7f-\x9f]/.test(value);

/** Framing for a watcher event, so the agent never mistakes it for something the owner typed. */
export const wakeText = (source: string, text: string): string =>
  `[Watcher event from ${source}, not typed by the owner. Handle it; reply only if the owner needs to know or act now, otherwise log it to the activity log and end with NO_REPLY.]\n${text}`;

type SessionContent = Omit<OutboxOperation, "id" | "kind" | "sessionId" | "generation">;

/** Session-bound, idempotent enqueue shared by every agent-authored conversation route. */
function queueSession(store: Store, prefix: string, dedupeKey: string, sessionId: string,
  content: SessionContent, prepare?: () => void): { id: string; created: boolean } {
  const id = `${prefix}:${hash(dedupeKey)}`;
  const created = store.db.transaction(() => {
    const route = store.get<{ id: string; generation: number } | null>("route");
    if (!sessionMatches(route, sessionId)) throw new ApiError(409);
    // Delivery and the origin backfill match on the bare id.
    const operation: OutboxOperation = { id, kind: "conversation", ...content, sessionId: route.id, generation: route.generation };
    const key = `api:${prefix}:${id}`;
    const spec = JSON.stringify(operation);
    const saved = store.get<{ spec: string }>(key);
    if (saved && saved.spec !== spec) throw new ApiError(409);
    prepare?.();
    const created = store.enqueue(operation);
    store.set(key, { spec });
    return created;
  }).immediate();
  return { id, created };
}

/** Fetch-compatible handler only; socket ownership and listening belong to main. */
export function createApi({ store, photon, router, chatGuid, enabled, health, secrets }: Options): (request: Request) => Promise<Response> {
  const pairedChat = () => {
    const guid = chatGuid();
    return typeof guid === "string" && guid.trim() === guid && /^(?:any|iMessage);-;[^;\s\x00-\x1f\x7f]+$/.test(guid) ? guid : undefined;
  };
  return async request => {
    try {
      if (request.headers.has("origin")) throw new ApiError(403);
      const path = new URL(request.url).pathname;
      if (request.method === "GET") {
        if (path === "/health") {
          const state = health();
          // Project known scalar health fields, never config, errors, credentials, or Router.status().
          const safe: Record<string, unknown> = {};
          for (const key of ["ok", "connected", "photonConnected", "openchamberConnected", "catchingUp"]) {
            if (typeof state[key] === "boolean") safe[key] = state[key];
          }
          for (const key of ["uptimeSeconds", "lastEventAt", "lastTickAt"]) {
            const value = state[key];
            if (typeof value === "number" && Number.isFinite(value) && value >= 0) safe[key] = value;
          }
          if (["ok", "healthy", "degraded", "starting", "stopped"].includes(state.status as string)) safe.status = state.status;
          for (const key of ["appsUrl", "appsRoot"]) {
            if (typeof state[key] === "string" && line(state[key], 2048)) safe[key] = state[key];
          }
          const active = enabled();
          const paired = pairedChat() !== undefined;
          return json({ ...safe, enabled: active, paired, ready: active && paired && router() !== undefined });
        }
        if (path === "/router") {
          // Read-only attention ownership for the telegram alert bridge.
          // An absent router means nothing is owned; this route is never readiness-gated.
          const active = router();
          return json(active ? active.routerStatus() : { route: null, pending: [] });
        }
        throw new ApiError(404);
      }
      if (request.method !== "POST" || !["/files", "/react", "/send", "/poll", "/app", "/wake", "/secret-request", "/secret-read",
        "/secret-forget"].includes(path)) throw new ApiError(404);
      const body = await readBody(request, path === "/files" ? MAX_FILE_BODY : path === "/send" || path === "/wake" ? MAX_SEND_BODY : MAX_BODY);

      // Reading or discarding already-submitted values is local-only and never readiness-gated.
      if (path === "/secret-read" || path === "/secret-forget") {
        if (!secrets) throw new ApiError(404);
        fields(body, path === "/secret-read" ? ["token", "field"] : ["token"]);
        const { token, field } = body;
        if (!validToken(token) || (path === "/secret-read" && !validFieldName(field))) throw new ApiError(400);
        const deps = { store, stateRoot: secrets.stateRoot, ...(secrets.now ? { now: secrets.now } : {}) };
        try {
          if (path === "/secret-forget") {
            await forgetSecret(deps, token);
            return json({ forgotten: true });
          }
          return json({ value: await readSecret(deps, token, field as string) });
        } catch (error) {
          if (error instanceof SecretError) throw new ApiError(error.status);
          throw error;
        }
      }

      const chat = pairedChat();
      if (!enabled() || !chat) throw new ApiError(503);

      if (path === "/files") {
        fields(body, ["base64", "name", "mimeType", "text", "dedupeKey", "sessionId"]);
        const { base64, name, mimeType, dedupeKey, sessionId } = body;
        const text = body.text === undefined ? "" : body.text;
        // One-time notification attachments moved to the telegram bridge; only
        // interactive session-bound sends remain here.
        if (sessionId === undefined) throw new ApiError(400);
        if (typeof base64 !== "string" || !base64.length || !validFileName(name) || !validMimeType(mimeType)
          || typeof text !== "string" || text.length > 12_000 || !string(dedupeKey, 200)
          || !string(sessionId, 200) || /\s|[\x00-\x1f\x7f-\x9f]/.test(sessionId)) throw new ApiError(400);
        if (base64.length > 4 * Math.ceil(MAX_FILE_BYTES / 3)) throw new ApiError(413);
        // Buffer.from accepts whitespace, URL-safe forms, and noncanonical padding; explicitly refuse them.
        if (base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(base64)) throw new ApiError(400);
        const data = Buffer.from(base64, "base64");
        if (data.toString("base64") !== base64 || data.length === 0) throw new ApiError(400);
        if (data.length > MAX_FILE_BYTES) throw new ApiError(413);
        const attachment = { sha256: createHash("sha256").update(data).digest("hex"), name, mimeType, size: data.length };
        const { id, created } = queueSession(store, "file", dedupeKey, sessionId, { text, attachment }, () => store.putBlob(data));
        // Durable queue acceptance only; upload and delivery happen outside this handler.
        return json({ id, created }, created ? 202 : 200);
      }

      if (path === "/send") {
        fields(body, ["text", "effect", "subject", "dedupeKey", "sessionId"]);
        const { text, effect, subject, dedupeKey, sessionId } = body;
        if (!string(text, 12_000) || !string(dedupeKey, 200) || !validSession(sessionId)
          || (effect !== undefined && !isEffect(effect)) || !optionalLine(subject, 256)) throw new ApiError(400);
        const { id, created } = queueSession(store, "send", dedupeKey, sessionId, {
          text, ...(effect === undefined ? {} : { effect }), ...(subject === undefined ? {} : { subject: subject as string }),
        });
        return json({ id, created }, created ? 202 : 200);
      }

      if (path === "/wake") {
        // Watchers wake whichever session is live, so this route is deliberately not session-bound.
        fields(body, ["text", "source", "dedupeKey"]);
        const { text, source, dedupeKey } = body;
        if (!string(text, 12_000) || !line(source, 100) || !string(dedupeKey, 200)) throw new ApiError(400);
        const id = `wake:${hash(dedupeKey)}`;
        const created = store.db.transaction(() => {
          const key = `api:wake:${id}`;
          const spec = JSON.stringify({ text, source });
          const saved = store.get<{ spec: string }>(key);
          if (saved && saved.spec !== spec) throw new ApiError(409);
          const created = store.acceptInbound(id, { id, text: wakeText(source, text), attachments: [], isAudioMessage: false,
            receivedAt: Date.now() });
          store.set(key, { spec });
          return created;
        }).immediate();
        return json({ id, created }, created ? 202 : 200);
      }

      if (path === "/poll") {
        fields(body, ["title", "options", "dedupeKey", "sessionId"]);
        const { title, options, dedupeKey, sessionId } = body;
        if (!line(title, 200) || !Array.isArray(options) || options.length < 2 || options.length > 12
          || !options.every(option => line(option, 100)) || new Set(options.map(option => option.trim())).size !== options.length
          || !string(dedupeKey, 200) || !validSession(sessionId)) throw new ApiError(400);
        const { id, created } = queueSession(store, "poll", dedupeKey, sessionId, {
          text: "", poll: { title, options: options as string[] },
        });
        return json({ id, created }, created ? 202 : 200);
      }

      if (path === "/app") {
        fields(body, ["url", "caption", "subcaption", "trailingCaption", "trailingSubcaption", "summary", "dedupeKey", "sessionId"]);
        const { url, caption, subcaption, trailingCaption, trailingSubcaption, summary, dedupeKey, sessionId } = body;
        if (!validAppUrl(url) || !line(caption, 200) || !optionalLine(subcaption, 200) || !optionalLine(trailingCaption, 200)
          || !optionalLine(trailingSubcaption, 200) || !optionalLine(summary, 500)
          || !string(dedupeKey, 200) || !validSession(sessionId)) throw new ApiError(400);
        const optional = { subcaption, trailingCaption, trailingSubcaption, summary } as Record<string, string | undefined>;
        const app = { url, caption, ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)) };
        const { id, created } = queueSession(store, "app", dedupeKey, sessionId, { text: "", app });
        return json({ id, created }, created ? 202 : 200);
      }

      if (path === "/secret-request") {
        if (!secrets) throw new ApiError(503);
        fields(body, ["purpose", "fields", "dedupeKey", "sessionId"]);
        const { purpose, dedupeKey, sessionId } = body;
        if (!line(purpose, 200) || !validFields(body.fields) || !string(dedupeKey, 200) || !validSession(sessionId)) throw new ApiError(400);
        const formFields = body.fields.map(({ name, label, type }) => ({ name, label, type }));
        const id = `secret-form:${hash(dedupeKey)}`;
        const savedKey = `api:secret-form:${id}`;
        const currentRoute = () => {
          const route = store.get<{ id: string; generation: number } | null>("route");
          if (!sessionMatches(route, sessionId)) throw new ApiError(409);
          return route;
        };
        // The canonical chat id, so a retry may name the session either way. The
        // generation keeps a key reused after an in-place /new from replaying the
        // previous conversation's form.
        const asked = currentRoute();
        const spec = JSON.stringify({ purpose, fields: formFields, sessionId: asked.id, generation: asked.generation });
        const replay = () => {
          const saved = store.get<SavedSecretRequest>(savedKey);
          if (!saved) return;
          if (saved.spec !== spec) throw new ApiError(409);
          return saved.result;
        };
        const earlier = replay();
        if (earlier) return json(earlier, 200);
        let base: string;
        try { base = await secrets.publishApps(); } catch { throw new ApiError(502); }
        if (!validAppUrl(base)) throw new ApiError(502);
        const token = newToken();
        const now = secrets.now?.() ?? Date.now();
        const result = { token, url: `${base.replace(/\/+$/, "")}/_secret/${token}`, expiresAt: now + SECRET_REQUEST_TTL_MS };
        const outcome = store.db.transaction(() => {
          const route = currentRoute();
          if (route.generation !== asked.generation) throw new ApiError(409);
          // A concurrent request with the same key may have won while publishing.
          const raced = replay();
          if (raced) return { result: raced, created: false };
          putSecretRequest(store, token, { sessionId: route.id, generation: route.generation, purpose, fields: formFields,
            createdAt: now, expiresAt: result.expiresAt, state: "open" });
          store.enqueue({ id, kind: "conversation", text: "", sessionId: route.id, generation: route.generation,
            app: { url: result.url, caption: "Secure form", subcaption: purpose } });
          store.set(savedKey, { spec, result } satisfies SavedSecretRequest);
          return { result, created: true };
        }).immediate();
        return json(outcome.result, outcome.created ? 202 : 200);
      }

      if (path === "/react") {
        fields(body, ["target", "kind"]);
        const { target, kind } = body;
        // Bridge-injected rows (secure-form notices, watcher wakes) are not provider messages.
        if (typeof target === "string" && /^(?:secret|wake):/.test(target)) throw new ApiError(403);
        if (!string(target, 200) || /[\x00-\x1f\x7f]/.test(target) || !string(kind, 20)
          || !["like", "love", "dislike", "laugh", "emphasize", "question"].includes(kind)) throw new ApiError(400);
        const inbound = store.db.query<{ id: string }, [string]>("SELECT id FROM inbound WHERE id = ?").get(target);
        if (!inbound && !store.byProviderId(target)) throw new ApiError(403);
        const id = `reaction:${hash(target + kind)}`;
        await photon.react(chat, target, kind as ReactionKind, id);
        return json({ id });
      }

      throw new ApiError(404);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 409;
      return json({ error: errors[status] }, status);
    }
  };
}
