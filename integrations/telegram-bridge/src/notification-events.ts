import type { JsonValue } from "./openchamber.ts";

type SessionIdentity = { sessionId: string; directory: string };
export type NotificationEvent =
  | { type: "invalidate" }
  | { type: "board"; entries: Array<{ identity: string; fingerprint: string }> }
  | { type: "wake" }
  | (SessionIdentity & { type: "asked" | "resolved"; kind: "question" | "approval"; requestId: string })
  | (SessionIdentity & { type: "status"; status: "busy" | "idle" })
  | (SessionIdentity & { type: "changed" });

function fields(value: JsonValue | undefined): { [key: string]: JsonValue } {
  if (!value || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return {};
  // SAFETY: parsed JSON contains only plain objects, arrays and primitives. The
  // prototype check above accepts only its plain-object variant.
  return value as { [key: string]: JsonValue };
}

function identifier(value: JsonValue | undefined): string | undefined {
  if (Object.prototype.toString.call(value) !== "[object String]") return;
  // JSON parsing produces primitive strings here. The tag check rejects
  // arrays, objects, numbers, booleans and null without coercing them.
  const text = String.prototype.valueOf.call(value);
  return /^[^\p{Cc}]{1,4096}$/u.test(text) ? text : undefined;
}

/** OpenCode 2 wire events that change a pending request, a session's activity, or its turn. */
const ASKED = new Set(["form.created", "permission.asked"]);
const RESOLVED = new Set(["form.replied", "form.cancelled", "permission.replied"]);
const BUSY = new Set(["session.execution.started"]);
const IDLE = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]);
const CHANGED = new Set(["session.inbox.enqueued", "session.renamed", "session.moved"]);

/**
 * Decode OpenCode 2 wire events from `/api/event` and OpenChamber control
 * events from `/api/openchamber/events`. OpenCode 2 sends one flat payload
 * `{ id, type, created, location?: { directory }, data }` and no
 * `session.status`, `session.idle` or `question.*` events of its own
 * (packages/schema/src/{form,permission,session-event}.ts). Execution events
 * carry no location: `directories` remembers where each session was last seen
 * on a located event, and an unknown session only wakes a recheck.
 */
export function parseNotificationEvent(input: JsonValue, directories?: Map<string, string>): NotificationEvent | undefined {
  const payload = fields(input);
  const properties = fields(payload.properties);
  const data = fields(payload.data);
  const type = payload.type;
  if (type === "openchamber:permission-auto-accept.updated" || type === "server.connected" || type === "global.disposed"
    || type === "location.shutdown") return { type: "invalidate" };
  if (type === "openchamber:session-board.updated") {
    if (!Array.isArray(properties.entries)) return { type: "invalidate" };
    const entries: Array<{ identity: string; fingerprint: string }> = [];
    const seen = new Set<string>();
    for (const item of properties.entries) {
      const entry = fields(item);
      const sessionId = identifier(entry.sessionId);
      const directory = identifier(entry.directory);
      if (!sessionId || !directory || directory === "global") return { type: "invalidate" };
      const identity = `${directory}\0${sessionId}`;
      if (seen.has(identity)) return { type: "invalidate" };
      seen.add(identity);
      const attention = fields(entry.attention);
      // This is an invalidation signature, never an authoritative state value.
      // A malformed field can force a recheck but cannot approve a send.
      entries.push({ identity, fingerprint: JSON.stringify([entry.state, entry.status, entry.workRevision, entry.parentId, attention.kind, attention.count]) });
    }
    return { type: "board", entries };
  }
  if (typeof type !== "string") return;
  const asked = ASKED.has(type);
  const resolved = RESOLVED.has(type);
  const busy = BUSY.has(type);
  const idle = IDLE.has(type);
  const changed = CHANGED.has(type);
  if (!asked && !resolved && !busy && !idle && !changed) return;
  // A shutdown keeps the execution claim: OpenCode resumes the same turn after restart.
  if (type === "session.execution.interrupted" && data.reason === "shutdown") return;
  const form = fields(data.form);
  const sessionId = type === "form.created" ? identifier(form.sessionID) : identifier(data.sessionID);
  const located = identifier(fields(payload.location).directory);
  if (sessionId && located && located !== "global" && directories) {
    directories.delete(sessionId);
    directories.set(sessionId, located);
    // Bounded, oldest first: a forgotten session only degrades to a wake.
    if (directories.size > 1_000) directories.delete(directories.keys().next().value!);
  }
  const directory = located ?? (sessionId ? directories?.get(sessionId) : undefined);
  // `global` owns MCP elicitation forms that belong to no session.
  if (!sessionId || sessionId === "global" || !directory || directory === "global") return { type: "wake" };
  if (asked || resolved) {
    const requestId = type === "form.created" ? identifier(form.id)
      : type === "permission.replied" ? identifier(data.requestID) : identifier(data.id);
    if (!requestId) return { type: "wake" };
    return { type: asked ? "asked" : "resolved", sessionId, directory, requestId,
      kind: type.startsWith("form.") ? "question" : "approval" };
  }
  if (busy || idle) return { type: "status", sessionId, directory, status: busy ? "busy" : "idle" };
  if (type === "session.inbox.enqueued" && fields(data.item).type !== "user") return;
  return { type: "changed", sessionId, directory };
}
