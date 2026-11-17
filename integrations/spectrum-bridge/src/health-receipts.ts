import { createHash } from "node:crypto";
import { appendFileSync, closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Store } from "./store.ts";

export type HealthSidecar = {
  version: 1; runId: string; kind: "card"; createdAt: string;
  cardId: string; cardIds: string[]; sha256: string;
};
const keys = ["version", "runId", "kind", "createdAt", "cardId", "cardIds", "sha256"].sort().join(",");
const id = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{32}$/.test(value);

export function parseHealthSidecar(raw: unknown, hash: string): HealthSidecar | undefined {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 8192) return;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return; }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== keys) return;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || v.kind !== "card" || !id(v.runId) || !id(v.cardId)
    || !Array.isArray(v.cardIds) || v.cardIds.length < 1 || v.cardIds.length > 128 || !v.cardIds.every(id)
    || new Set(v.cardIds).size !== v.cardIds.length || !v.cardIds.includes(v.cardId)
    || typeof v.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(v.sha256) || v.sha256 !== hash
    || typeof v.createdAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.createdAt)
    || !Number.isFinite(Date.parse(v.createdAt)) || new Date(v.createdAt).toISOString() !== v.createdAt) return;
  return { version: 1, runId: v.runId, kind: "card", createdAt: v.createdAt,
    cardId: v.cardId, cardIds: [...v.cardIds], sha256: v.sha256 };
}

export function readHealthSidecar(file: string, data: Uint8Array): HealthSidecar | undefined {
  if (!file.endsWith(".png")) return;
  let fd: number | undefined;
  try {
    fd = openSync(`${file}.delivery.json`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 8192) return;
    return parseHealthSidecar(readFileSync(fd, "utf8"), createHash("sha256").update(data).digest("hex"));
  } catch { return; }
  finally { if (fd !== undefined) closeSync(fd); }
}

type HealthFailureTag = "timeout" | "io_error" | "not_authorized" | "subprocess_failed" | "internal_error";
const failureTags = new Set<string>(["timeout", "io_error", "not_authorized", "subprocess_failed", "internal_error"]);
type HealthReceipt = HealthSidecar & { ok: boolean; errorTag: HealthFailureTag | "none"; acceptedAt: string };

// Fixed health tags only: transport exception text/captions never cross this boundary.
export function healthFailureTag(code: string): HealthFailureTag {
  if (/timeout/i.test(code)) return "timeout";
  if (code === "invalidAttachment") return "io_error";
  if (code === "unsupported") return "not_authorized";
  return "subprocess_failed";
}

/** Called inside Store's state transaction; fallback cannot erase a terminal outcome. */
export function rememberHealthReceipt(store: Store, id: string, state: string): void {
  if (state !== "sent" && state !== "failed") return;
  const key = `${id}:${state}`;
  if (store.get(`health-receipt-emitted:${key}`) === true) return;
  const item = store.getOperation(id);
  if (!item?.healthReceipt || !item.attachment) return;
  const sidecar = parseHealthSidecar(JSON.stringify(item.healthReceipt), item.attachment.sha256);
  if (!sidecar) return;
  const previous = store.get<HealthReceipt>(`health-receipt-pending:${key}`);
  const tag = store.get<unknown>(`health-receipt-error:${id}`);
  const ok = state === "sent";
  store.set(`health-receipt-pending:${key}`, { ...sidecar, ok,
    errorTag: ok ? "none" : typeof tag === "string" && failureTags.has(tag) ? tag : "internal_error",
    acceptedAt: previous?.acceptedAt ?? new Date().toISOString() });
}

export function flushHealthReceipts(store: Store): void {
  try {
    flush(store);
  } catch { /* Receipt I/O cannot interrupt the provider delivery loop. */ }
}

function flush(store: Store): void {
  const root = process.env.HEALTH_TOOLLOG_DIR
    ?? (process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test" ? undefined
      : join(homedir(), ".robob/logs/tools/health"));
  if (!root) return;
  // Pending outcomes are independent of outbox state, including a later fallback/retry.
  const rows = store.db.query<{ key: string; value: string }, []>(
    "SELECT key, value FROM kv WHERE key GLOB 'health-receipt-pending:*' ORDER BY key LIMIT 10",
  ).all();
  for (const row of rows) {
    try {
      const { ok, errorTag, acceptedAt, ...metadata } = JSON.parse(row.value);
      const sidecar = parseHealthSidecar(JSON.stringify(metadata), metadata.sha256);
      if (!sidecar || typeof ok !== "boolean" || (ok ? errorTag !== "none" : !failureTags.has(errorTag))
        || typeof acceptedAt !== "string" || new Date(acceptedAt).toISOString() !== acceptedAt) continue;
      const receipt = { ...sidecar, ok, errorTag, acceptedAt };
      const dir = join(root, "receipts");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      appendFileSync(join(dir, `${sidecar.createdAt.slice(0, 10)}.ndjson`), `\n${JSON.stringify(receipt)}\n`, { mode: 0o600 });
      store.db.transaction(() => {
        store.set(row.key.replace("health-receipt-pending:", "health-receipt-emitted:"), true);
        store.db.query("DELETE FROM kv WHERE key = ?").run(row.key);
      }).immediate();
    } catch {
      // Leave the durable pending outcome intact for the next tick/restart.
      // No provider send is retried here. Replay after append-before-checkpoint is safe.
    }
  }
}
