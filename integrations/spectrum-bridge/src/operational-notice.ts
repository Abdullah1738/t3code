import { createHash } from "node:crypto";
import type { Store } from "./store.ts";
import type { Post } from "./telegram-fallback.ts";
import { toolError, toolLog } from "./toollog.ts";

export const OPERATIONAL_NOTICE_KINDS = [
  "dropped",
  "outage",
  "failed",
  "interrupted",
  "command_failed",
  "attachment_failed",
  "guest_note",
] as const;

export type OperationalNoticeKind = (typeof OPERATIONAL_NOTICE_KINDS)[number];
export type OperationalNoticeSeverity = "info" | "attention" | "error";

export type OperationalNoticePayload = {
  id: string;
  chat: string;
  kind: OperationalNoticeKind;
  severity: OperationalNoticeSeverity;
  text: string;
  createdAt: number;
};

export type OperationalNoticeRecord = OperationalNoticePayload & {
  state: "pending" | "sent" | "failed";
  attempts: number;
  nextAt: number;
};

const MAX_TEXT = 12_000;
const MAX_KEY = 200;
const MAX_SOURCE = 40;
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 5 * 60_000;

const inFlight = new WeakMap<Store, Promise<void>>();

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function normalizeChatSlug(chat?: string): string {
  const cleaned = (chat ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return cleaned || "owner";
}

export function operationalChatLabel(chat?: string): string {
  const slug = normalizeChatSlug(chat);
  if (slug === "owner") return "Owner chat";
  if (slug === "moni") return "Moni chat";
  return `Chat ${slug}`;
}

/** Matches telegram-bridge /notify source validation: <= 40 chars of [A-Za-z0-9 ._#-]. */
export function operationalSource(chat?: string): string {
  const slug = normalizeChatSlug(chat);
  if (slug === "owner") return "iMessage bridge - owner chat";
  if (slug === "moni") return "iMessage bridge - Moni chat";
  const prefix = "iMessage bridge - ";
  const suffix = " chat";
  const room = Math.max(1, MAX_SOURCE - prefix.length - suffix.length);
  const clean = slug.replace(/[^A-Za-z0-9 ._#-]+/g, "-").slice(0, room).replace(/^-+|-+$/g, "") || "other";
  return `${prefix}${clean}${suffix}`;
}

/** Stable, bounded dedupeKey safe for both telegram-bridge /notify and toollog. */
export function operationalKey(kindPrefix: string, chat: string | undefined, suffix: string): string {
  const cleanKind = kindPrefix.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 32) || "notice";
  const slug = normalizeChatSlug(chat);
  const head = `imessage:${cleanKind}:${slug}:`;
  const candidate = `${head}${suffix}`;
  if (candidate.length <= MAX_KEY && /^[a-zA-Z0-9_.:-]+$/.test(candidate)) return candidate;
  return `${head}${digest(suffix).slice(0, 32)}`;
}

export function enqueueOperationalNotice(
  store: Store,
  input: {
    id: string;
    chat?: string;
    kind: OperationalNoticeKind;
    severity?: OperationalNoticeSeverity;
    text: string;
    now?: number;
  },
): boolean {
  const text = input.text.trim().slice(0, MAX_TEXT);
  if (!text) return false;
  const chat = normalizeChatSlug(input.chat);
  const severity: OperationalNoticeSeverity = input.severity ?? "attention";
  const createdAt = input.now ?? Date.now();
  return store.enqueueOperationalNotice({
    id: input.id,
    chat,
    kind: input.kind,
    severity,
    text,
    createdAt,
  });
}

function logRouteDecision(record: OperationalNoticeRecord, telegram: "sent" | "failed" | "retry"): void {
  toolLog.capture(() => toolLog.write({
    component: "router",
    kind: telegram === "failed" ? "error" : "event",
    name: "notice.routed",
    ok: telegram === "sent",
    ids: { chat: record.chat },
    props: { chat: record.chat, kind: record.kind, key: record.id, telegram },
    ...(telegram === "failed" ? { error: { tag: "notice.telegram_failed", message: "" } } : {}),
  }));
}

async function flushOnce(store: Store, post: Post, nowFn: () => number, limit: number): Promise<void> {
  const due = store.dueOperationalNotices(nowFn(), limit);
  for (const record of due) {
    let status: number | undefined;
    try {
      status = await post("/notify", {
        source: operationalSource(record.chat),
        severity: record.severity,
        text: record.text.slice(0, MAX_TEXT),
        dedupeKey: record.id,
      });
    } catch (caughtError) {
      toolError("operational-notice", "operational-notice.post", caughtError);
      status = undefined;
    }
    const now = nowFn();
    const attempts = record.attempts + 1;
    // Identical retries receive 200. A 409 signals a conflict in the notification metadata.
    if (status === 200 || status === 202) {
      store.updateOperationalNotice(record.id, "sent", attempts, now);
      logRouteDecision(record, "sent");
    } else if (status === 400 || status === 409 || status === 413) {
      store.updateOperationalNotice(record.id, "failed", attempts, now);
      logRouteDecision(record, "failed");
    } else {
      const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(attempts - 1, 8));
      store.updateOperationalNotice(record.id, "pending", attempts, now + backoff);
      logRouteDecision(record, "retry");
      if (status === undefined || status >= 500) break;
    }
  }
}

export function flushOperationalNotices(
  store: Store,
  post: Post,
  opts: { now?: () => number; limit?: number } = {},
): Promise<void> {
  const existing = inFlight.get(store);
  if (existing) return existing;
  const run = Promise.resolve()
    .then(() => flushOnce(store, post, opts.now ?? Date.now, opts.limit ?? 20))
    .finally(() => { inFlight.delete(store); });
  inFlight.set(store, run);
  return run;
}

/** Move unsent notices from earlier builds before the chat sender starts. */
export function migrateOperationalNotices(store: Store, chat: string): void {
  store.db.transaction(() => {
    const rows = store.db.query<{ id: string; payload: string }, []>(
      "SELECT id, payload FROM outbox WHERE state IN ('pending', 'sending', 'uncertain')",
    ).all();
    for (const { id, payload } of rows) {
      const { text, kind } = JSON.parse(payload) as { text?: string; kind?: string };
      const migrated = legacyNotice(id, text, kind);
      if (!migrated) continue;
      const [noticeKind, suffix, summary] = migrated;
      enqueueOperationalNotice(store, {
        id: operationalKey(noticeKind.replaceAll("_", "-"), chat, suffix), chat, kind: noticeKind,
        text: `${operationalChatLabel(chat)}: ${summary}`,
      });
      store.outboxState(id, "cancelled");
    }
  }).immediate();
}

function legacyNotice(id: string, text?: string, kind?: string): [OperationalNoticeKind, string, string] | undefined {
  if (id.startsWith("guest-note:")) return ["guest_note", id.slice(11), text ?? "A guest notice was queued."];
  if (kind !== "control") return;
  if (id.startsWith("outage:")) return ["outage", id.slice(7), "The agent was temporarily unavailable for an incoming message."];
  if (id.startsWith("synthetic-dropped:")) return ["dropped", id, "The bridge could not deliver a background update to the agent."];
  const exhausted = /^failed:(.+):exhausted$/.exec(id);
  if (exhausted) return ["failed", `${exhausted[1]!}:exhausted`, "An incoming message failed repeatedly and was not answered; it will not be retried."];
  const failure = /^turn:(.+):failed$/.exec(id);
  if (failure) return ["failed", failure[1]!, "The agent could not complete a turn due to a system error."];
  if (!id.startsWith("control:") || !text) return;
  const suffix = id.slice(8);
  if (text.startsWith("Something interrupted that one")) return ["interrupted", suffix, "An incoming message was interrupted."];
  if (/^Couldn't (start fresh|check that question)/.test(text)) return ["command_failed", suffix, "The bridge could not complete a chat command."];
  if (/^(That attachment came through broken|I couldn't download that attachment|I couldn't save those files)/.test(text)) {
    return ["attachment_failed", suffix, "The bridge could not process an incoming attachment."];
  }
}
