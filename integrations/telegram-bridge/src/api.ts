import { createHash } from "node:crypto";
import { MAX_FILE_BYTES, parseCommand, validFileName, validMimeType } from "./cli.ts";
import type { ReminderRecord, Store } from "./store.ts";

type Options = {
  store: Store;
  enabled: () => boolean;
  chatId: () => number | undefined;
  timezone: string;
  health: () => Record<string, unknown>;
};

const MAX_BODY = 20 * 1024;
// Main's Bun.serve maxRequestBodySize must permit this; other routes keep MAX_BODY.
export const MAX_FILE_BODY = 28 * 1024 * 1024;
const MAX_RESPONSE = 128 * 1024;
const errors = {
  400: "Invalid request", 403: "Forbidden", 404: "Not found",
  409: "Operation could not be completed", 413: "Request body too large", 503: "Bridge is not ready",
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

function list(name: "reminders" | "notifications", rows: Record<string, unknown>[], limit: number): Response {
  const items: Record<string, unknown>[] = [];
  let bytes = 128;
  let truncated = rows.length > limit;
  for (const row of rows.slice(0, limit)) {
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (bytes + size > MAX_RESPONSE) { truncated = true; break; }
    bytes += size;
    items.push(row);
  }
  return json({ [name]: items, truncated });
}

/** Fetch-compatible handler only; socket ownership and listening belong to main. */
export function createApi({ store, enabled, chatId, timezone, health }: Options): (request: Request) => Promise<Response> {
  return async request => {
    try {
      if (request.headers.has("origin")) throw new ApiError(403);
      const path = new URL(request.url).pathname;
      if (request.method === "GET") {
        if (path === "/health") {
          const state = health();
          // Project known scalar health fields, never config, errors, or credentials.
          const safe: Record<string, unknown> = {};
          for (const key of ["ok", "connected", "telegramConnected", "openchamberConnected"]) {
            if (typeof state[key] === "boolean") safe[key] = state[key];
          }
          for (const key of ["uptimeSeconds", "lastEventAt", "lastTickAt"]) {
            const value = state[key];
            if (typeof value === "number" && Number.isFinite(value) && value >= 0) safe[key] = value;
          }
          if (["ok", "healthy", "degraded", "starting", "stopped"].includes(state.status as string)) safe.status = state.status;
          const active = enabled();
          const paired = chatId() !== undefined;
          return json({ ...safe, enabled: active, paired, ready: active && paired });
        }
        if (path === "/reminders") {
          const rows = store.db.query<Record<string, unknown>, []>(`SELECT
            substr(id, 1, 200) AS id, substr(text, 1, 512) AS text, dueAt,
            substr(timezone, 1, 128) AS timezone,
            CASE WHEN status IN ('scheduled', 'queued', 'sent', 'cancelled') THEN status ELSE 'unknown' END AS status,
            revision, substr(operationId, 1, 200) AS operationId,
            (length(text) > 512 OR instr(text, char(0)) > 0 OR length(id) > 200 OR instr(id, char(0)) > 0
              OR length(timezone) > 128 OR instr(timezone, char(0)) > 0
              OR length(COALESCE(operationId, '')) > 200 OR instr(COALESCE(operationId, ''), char(0)) > 0) AS truncated
            FROM reminders ORDER BY rowid DESC LIMIT 101`).all();
          return list("reminders", rows, 100);
        }
        if (path === "/notifications") {
          const rows = store.db.query<Record<string, unknown>, []>(`SELECT
            substr(o.id, 1, 200) AS id, 'notification' AS kind,
            substr(CAST(json_extract(o.payload, '$.text') AS TEXT), 1, 512) AS text,
            CASE WHEN o.state IN ('pending', 'sending', 'sent', 'uncertain', 'cancelled', 'failed') THEN o.state ELSE 'unknown' END AS state,
            o.attempts, o.providerId,
            CASE WHEN json_type(o.payload, '$.attachment') = 'object' THEN json_object(
              'sha256', substr(CAST(json_extract(o.payload, '$.attachment.sha256') AS TEXT), 1, 64),
              'name', substr(CAST(json_extract(o.payload, '$.attachment.name') AS TEXT), 1, 255),
              'mimeType', substr(CAST(json_extract(o.payload, '$.attachment.mimeType') AS TEXT), 1, 100),
              'size', CASE WHEN json_type(o.payload, '$.attachment.size') = 'integer'
                AND json_extract(o.payload, '$.attachment.size') BETWEEN 1 AND ${MAX_FILE_BYTES}
                THEN json_extract(o.payload, '$.attachment.size') END) END AS attachment,
            CASE WHEN json_extract(k.value, '$.severity') IN ('info', 'attention', 'error') THEN json_extract(k.value, '$.severity') END AS severity,
            (length(json_extract(o.payload, '$.text')) > 512 OR instr(json_extract(o.payload, '$.text'), char(0)) > 0
              OR length(o.id) > 200 OR instr(o.id, char(0)) > 0) AS truncated
            FROM outbox o LEFT JOIN kv k ON k.key = 'api:notification:' || o.id
            WHERE json_extract(o.payload, '$.kind') = 'notification' ORDER BY o.rowid DESC LIMIT 51`).all();
          return list("notifications", rows.map(({ attachment, ...row }) => ({
            ...row, ...(typeof attachment === "string" ? { attachment: JSON.parse(attachment) } : {}),
          })), 50);
        }
        const notification = /^\/notifications\/([^/]+)$/.exec(path);
        if (notification) {
          let id: string;
          try { id = decodeURIComponent(notification[1]!); } catch { throw new ApiError(400); }
          if (!string(id, 200) || /[\x00-\x1f\x7f]/.test(id)) throw new ApiError(400);
          const operation = store.findOutbox(id);
          if (!operation || operation.kind !== "notification") throw new ApiError(404);
          return json({ id: operation.id, text: operation.text.slice(0, 12_000) });
        }
        throw new ApiError(404);
      }
      const reminderAction = /^\/reminders\/([^/]+)\/(cancel|snooze)$/.exec(path);
      if (request.method !== "POST" || !["/notify", "/files", "/reminders"].includes(path) && !reminderAction) throw new ApiError(404);
      const body = await readBody(request, path === "/files" ? MAX_FILE_BODY : MAX_BODY);
      if (!enabled() || chatId() === undefined) throw new ApiError(503);

      if (path === "/files") {
        fields(body, ["base64", "name", "mimeType", "text", "dedupeKey"]);
        const { base64, name, mimeType, dedupeKey } = body;
        const text = body.text === undefined ? "" : body.text;
        if (typeof base64 !== "string" || !base64.length || !validFileName(name) || !validMimeType(mimeType)
          || typeof text !== "string" || text.length > 12_000 || !string(dedupeKey, 200)) throw new ApiError(400);
        if (base64.length > 4 * Math.ceil(MAX_FILE_BYTES / 3)) throw new ApiError(413);
        // Buffer.from accepts whitespace, URL-safe forms, and noncanonical padding; explicitly refuse them.
        if (base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(base64)) throw new ApiError(400);
        const data = Buffer.from(base64, "base64");
        if (data.toString("base64") !== base64 || data.length === 0) throw new ApiError(400);
        if (data.length > MAX_FILE_BYTES) throw new ApiError(413);
        const id = `file:${hash(dedupeKey)}`;
        const attachment = { sha256: createHash("sha256").update(data).digest("hex"), name, mimeType, size: data.length };
        const created = store.db.transaction(() => {
          const operation = { id, kind: "notification" as const, text, attachment };
          const key = `api:file:${id}`;
          const spec = JSON.stringify(operation);
          const saved = store.get<{ spec: string }>(key);
          if (saved && saved.spec !== spec) throw new ApiError(409);
          store.putBlob(data);
          const created = store.enqueue(operation);
          store.set(key, { spec });
          return created;
        }).immediate();
        // Durable queue acceptance only; upload and delivery happen outside this handler.
        return json({ id, created }, created ? 202 : 200);
      }

      if (path === "/notify") {
        fields(body, ["source", "severity", "text", "dedupeKey"]);
        const { source, severity, text, dedupeKey } = body;
        if (!string(source, 40) || /[^A-Za-z0-9 ._-]/.test(source)
          || !string(severity, 20) || !["info", "attention", "error"].includes(severity)
          || !string(text, 12_000) || !string(dedupeKey, 200)) throw new ApiError(400);
        const id = `notify:${hash(dedupeKey)}`;
        const created = store.db.transaction(() => {
          const key = `api:notification:${id}`;
          const metadata = store.get<{ severity: string }>(key);
          if (metadata && metadata.severity !== severity) throw new ApiError(409);
          const created = store.enqueue({ id, kind: "notification", text: `[${source}] ${text}` });
          store.set(key, { severity });
          return created;
        }).immediate();
        return json({ id, created }, created ? 202 : 200);
      }

      if (!enabled()) throw new ApiError(503);
      if (path === "/reminders") {
        fields(body, ["text", "at", "timezone", "idempotencyKey"]);
        const { text, at, idempotencyKey } = body;
        const zone = body.timezone === undefined ? timezone : body.timezone;
        if (!string(text, 12_000) || !string(at, 100) || !string(idempotencyKey, 200) || !string(zone, 128)) throw new ApiError(400);
        try {
          parseCommand(["remind", `--text=${text}`, `--at=${at}`, `--key=${idempotencyKey}`, `--timezone=${zone}`]);
        } catch { throw new ApiError(400); }
        const digest = hash(idempotencyKey);
        const id = `R${digest.slice(0, 12)}`;
        const spec = JSON.stringify({ text, at, timezone: zone });
        const result = store.db.transaction(() => {
          const key = `api:reminder:${digest}`;
          const saved = store.get<{ spec: string; result: ReminderRecord }>(key);
          // Replay the original create result even after its deadline, cancellation, or snooze.
          if (saved) {
            if (saved.spec !== spec) throw new ApiError(409);
            return { reminder: saved.result, created: false };
          }
          const dueAt = Date.parse(at);
          if (!Number.isSafeInteger(dueAt) || dueAt <= 0 || dueAt <= Date.now()) throw new ApiError(400);
          const reminder = store.createReminder({ id, text, dueAt, timezone: zone });
          store.set(key, { spec, result: reminder });
          return { reminder, created: true };
        }).immediate();
        return json(result.reminder, result.created ? 201 : 200);
      }

      fields(body, reminderAction![2] === "cancel" ? [] : ["at"]);
      let id: string;
      try { id = decodeURIComponent(reminderAction![1]!); } catch { throw new ApiError(400); }
      if (!string(id, 200) || /[\x00-\x1f\x7f]/.test(id)) throw new ApiError(400);
      let reminder: ReminderRecord;
      if (reminderAction![2] === "cancel") {
        reminder = store.cancelReminder(id);
      } else {
        if (!string(body.at, 100)) throw new ApiError(400);
        try { parseCommand(["snooze", id, `--at=${body.at}`]); } catch { throw new ApiError(400); }
        const dueAt = Date.parse(body.at);
        if (!Number.isSafeInteger(dueAt) || dueAt <= 0 || dueAt <= Date.now()) throw new ApiError(400);
        reminder = store.snoozeReminder(id, dueAt);
      }
      // Pre-existing reminders may not have been created through this bounded API.
      return json({ id: reminder.id, status: reminder.status, dueAt: reminder.dueAt, revision: reminder.revision });
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 409;
      return json({ error: errors[status] }, status);
    }
  };
}
