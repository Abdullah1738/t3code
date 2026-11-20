import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { ControlClient, ControlError, type ControlConfigOptions } from "./control.ts";
import { RobobLinkDown } from "./robob-link-gate.ts";
import { object } from "./remote-protocol.ts";
import { Store, MAX_BLOB_BYTES } from "./store.ts";
import { toolLog } from "./toollog.ts";
import { LineError, type Line } from "./line.ts";

export const MIRROR_CUTOVER = Date.parse("2026-11-17T00:11:00Z");
export const MIRROR_START_NOTE = "Mirror starts here; earlier box replies aren't on the Mac";
export type MirrorItem = { id: string; role: "user" | "assistant"; at: string; text: string; attachments?: { attachmentId: string }[] };
export interface MirrorSink {
  readonly linkAvailable?: boolean;
  ensure(signal: AbortSignal): Promise<{ threadId: string }>;
  append(threadId: string, items: MirrorItem[], signal: AbortSignal): Promise<unknown>;
  upload(file: { name: string; mimeType: string; bytes: Uint8Array }, signal: AbortSignal): Promise<{ attachmentId: string }>;
}
export class HttpMirrorSink implements MirrorSink {
  private readonly client: ControlClient;
  constructor(options: ControlConfigOptions = {}) {
    this.client = new ControlClient({ ...options, linkGate: options.linkGate ?? true });
  }
  get linkAvailable(): boolean { return this.client.linkGate?.available ?? true; }
  private async request(path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    return this.client.request("POST", path, body, { signal, directResponse: true });
  }
  async ensure(signal: AbortSignal) {
    const result = await this.request("/mirror-threads", {
      mirrorKey: "imessage:moni", title: "Moni (read-only)", source: "iMessage (Moni's box)", origin: "imessage",
    }, signal);
    if (!object(result) || typeof result.threadId !== "string" || !result.threadId) throw new ControlError(502);
    return { threadId: result.threadId };
  }
  async append(threadId: string, items: MirrorItem[], signal: AbortSignal) {
    const result = await this.request(`/threads/${encodeURIComponent(threadId)}/history`, { items }, signal);
    if (!object(result) || !Number.isSafeInteger(result.appended) || !Number.isSafeInteger(result.skipped)
      || Number(result.appended) < 0 || Number(result.skipped) < 0 || Number(result.appended) + Number(result.skipped) !== items.length) throw new ControlError(502);
    return result;
  }
  upload(file: { name: string; mimeType: string; bytes: Uint8Array }, signal: AbortSignal) { return this.client.upload(file, signal); }
}

type FileRef = { name: string; mimeType: string; sha256?: string; path?: string; url?: string; attachmentId?: string };
type Pending = { item: MirrorItem; files: FileRef[] };
type QueueRow = { id: string; payload: string; attempt: number; rejected: number; next_at: number };
type MirrorOptions = { now?: () => number; timeoutMs?: number; maxQueue?: number; maxAttempts?: number; download?: Line["download"] };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const stableId = (id: string) => id.length <= 200 ? id : `sha256:${digest(id)}`;
const mediaName = (url: string) => { try { return basename(new URL(url).pathname) || "file"; } catch { return "file"; } };
const placeholder = (file: FileRef) => file.mimeType.startsWith("image/") ? "[image]" : `[file ${file.name}]`;

// This queue owns only the read-only copy. No network operation runs on accept/send's call stack.
export class ChatMirror {
  private busy = false;
  private readonly now: () => number;
  constructor(readonly store: Store, private readonly sink: MirrorSink, private readonly options: MirrorOptions = {}) {
    this.now = options.now ?? Date.now;
    store.db.exec(`CREATE TABLE IF NOT EXISTS mirror_items (
      seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, payload TEXT, attempt INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS mirror_pending ON mirror_items(seq) WHERE payload IS NOT NULL;
      CREATE TABLE IF NOT EXISTS mirror_files (id TEXT PRIMARY KEY, name TEXT, mime TEXT, data BLOB);`);
  }
  private emit(name: string, props: Record<string, string | number | boolean> = {}, ok?: boolean) {
    toolLog.capture(() => toolLog.write({ component: "mirror", kind: "event", name, ids: { chat: "moni" }, props,
      ...(ok === undefined ? {} : { ok }) }));
  }
  private safely(work: () => void) {
    try { work(); } catch { this.emit("mirror-fail", { cause: "store", attempt: 1 }); }
  }
  private depth() { return this.store.db.query<{ n: number; bytes: number }, []>("SELECT count(*) n, COALESCE(sum(bytes),0) bytes FROM mirror_items WHERE payload IS NOT NULL").get()!; }
  enqueue(item: MirrorItem, files: FileRef[] = []): boolean {
    if (this.store.db.query("SELECT 1 FROM mirror_items WHERE id=?").get(stableId(item.id))) return false;
    const payload = JSON.stringify({ item: { ...item, id: stableId(item.id) }, files } satisfies Pending);
    const bytes = Buffer.byteLength(payload), depth = this.depth();
    const drop = depth.n >= (this.options.maxQueue ?? 1000) || depth.bytes + bytes > 32 * 1024 * 1024 || bytes > 256 * 1024;
    this.store.db.query("INSERT INTO mirror_items(id,payload,bytes) VALUES (?,?,?)").run(stableId(item.id), drop ? null : payload, drop ? 0 : bytes);
    if (drop) this.emit("mirror-fail", { cause: "queue_full", attempt: 1 });
    this.emit("mirror-queue", { depth: depth.n + (drop ? 0 : 1) });
    return !drop;
  }
  inbound(id: string, input: unknown) {
    this.safely(() => {
      if (!object(input)) return;
      const files: FileRef[] = Array.isArray(input.attachments) ? input.attachments.filter(object).map(a => ({
        name: typeof a.fileName === "string" ? a.fileName : "file", mimeType: typeof a.mimeType === "string" ? a.mimeType : "application/octet-stream",
        ...(typeof a.path === "string" ? { path: a.path } : {}), ...(typeof a.sha256 === "string" ? { sha256: a.sha256 } : {}),
        ...(typeof a.guid === "string" && a.guid.startsWith("https://") ? { url: a.guid } : {}),
      })) : [];
      const at = typeof input.sentAt === "number" && Number.isFinite(input.sentAt) ? input.sentAt : this.now();
      this.enqueue({ id, role: "user", at: new Date(at).toISOString(), text: typeof input.text === "string" ? input.text : "" }, files);
    });
  }
  outbound(id: string, text: string, mediaUrl: string | undefined, at = this.now()) {
    this.safely(() => {
      const saved = mediaUrl ? this.store.db.query<{ name: string; mime: string }, [string]>("SELECT name,mime FROM mirror_files WHERE id=?").get(digest(mediaUrl)) : null;
      this.enqueue({ id: `send:${id}`, role: "assistant", at: new Date(at).toISOString(), text }, mediaUrl ? [{
        name: saved?.name ?? mediaName(mediaUrl), mimeType: saved?.mime ?? "application/octet-stream", url: mediaUrl,
        ...(saved ? { sha256: `media:${digest(mediaUrl)}` } : {}),
      }] : []);
    });
  }
  rememberFile(url: string, file: { name: string; mimeType: string; data: Uint8Array }) {
    this.safely(() => {
      if (this.store.db.query("SELECT 1 FROM mirror_files WHERE id=?").get(digest(url))) return;
      // Only unreferenced uploads can expire; queued attachments keep their bytes until delivered.
      this.store.db.query(`DELETE FROM mirror_files WHERE rowid NOT IN (SELECT rowid FROM mirror_files ORDER BY rowid DESC LIMIT 20)
        AND NOT EXISTS (SELECT 1 FROM mirror_items WHERE payload IS NOT NULL AND instr(payload, 'media:' || mirror_files.id) > 0)`).run();
      let size = this.store.db.query<{ n: number }, []>("SELECT COALESCE(sum(length(data)),0) n FROM mirror_files").get()!.n;
      if (file.data.length <= MAX_BLOB_BYTES && size + file.data.length > 40 * 1024 * 1024) {
        const unused = this.store.db.query<{ id: string; bytes: number }, []>(`SELECT id,length(data) bytes FROM mirror_files
          WHERE NOT EXISTS (SELECT 1 FROM mirror_items WHERE payload IS NOT NULL AND instr(payload, 'media:' || mirror_files.id) > 0) ORDER BY rowid`).all();
        for (const cached of unused) {
          if (size + file.data.length <= 40 * 1024 * 1024) break;
          this.store.db.query("DELETE FROM mirror_files WHERE id=?").run(cached.id); size -= cached.bytes;
        }
      }
      if (file.data.length > MAX_BLOB_BYTES || size + file.data.length > 40 * 1024 * 1024) { this.emit("mirror-fail", { cause: "file_cap", attempt: 1 }); return; }
      this.store.db.query("INSERT OR IGNORE INTO mirror_files VALUES (?,?,?,?)").run(digest(url), file.name, file.mimeType, file.data);
    });
  }
  // Remote relay rows hold ciphertext and send handles only. Use plaintext already in the chat store.
  backfill() {
    if (this.store.get("mirror-backfill-v1")) return;
    this.safely(() => this.store.db.transaction(() => {
      const rows = this.store.db.query<{ id: string; payload: string }, [number]>("SELECT id,payload FROM inbound WHERE json_extract(payload,'$.sentAt') >= ? ORDER BY rowid").all(MIRROR_CUTOVER);
      const items: { at: number; id: string; input: Record<string, unknown> }[] = [];
      for (const row of rows) {
        const input: unknown = JSON.parse(row.payload);
        if (object(input) && input.source === "typed" && typeof input.sentAt === "number" && input.sentAt >= MIRROR_CUTOVER) items.push({ at: input.sentAt, id: row.id, input });
      }
      const replies = this.store.db.query<{ id: string; payload: string }, []>("SELECT id,payload FROM outbox WHERE state='sent' ORDER BY rowid").all();
      let replyCount = 0;
      for (const row of replies) {
        const input: unknown = JSON.parse(row.payload), at = this.store.get<number>(`sent-at:${row.id}`);
        if (object(input) && typeof input.text === "string" && typeof at === "number" && at >= MIRROR_CUTOVER) {
          items.push({ at, id: `send:${row.id}`, input: { ...input, mirrorReply: true } }); replyCount++;
        }
      }
      let count = 0;
      if (!replyCount && this.enqueue({ id: "mirror-start-note", role: "assistant", at: new Date(MIRROR_CUTOVER).toISOString(), text: MIRROR_START_NOTE })) count++;
      for (const row of items.sort((a, b) => a.at - b.at)) {
        if (row.input.mirrorReply) {
          const file = object(row.input.attachment) ? row.input.attachment : undefined;
          const files: FileRef[] = file && typeof file.sha256 === "string" && typeof file.name === "string" && typeof file.mimeType === "string" ? [{ name: file.name, mimeType: file.mimeType, sha256: file.sha256 }] : [];
          if (this.enqueue({ id: row.id, role: "assistant", at: new Date(row.at).toISOString(), text: row.input.text as string }, files)) count++;
        } else { const before = this.depth().n; this.inbound(row.id, row.input); count += this.depth().n - before; }
      }
      this.store.set("mirror-backfill-v1", true);
      this.emit("mirror-backfill", { count });
    })());
  }
  async tick(): Promise<void> {
    if (this.busy) return;
    const linkDown = () => this.sink.linkAvailable === false;
    if (linkDown()) { toolLog.skipRobob("mirror.tick"); return; }
    this.busy = true;
    const started = this.now();
    let row: QueueRow | null = null;
    let attempted = false;
    try {
      row = this.store.db.query<QueueRow, []>("SELECT id,payload,attempt,rejected,next_at FROM mirror_items WHERE payload IS NOT NULL ORDER BY seq LIMIT 1").get();
      if (!row || row.next_at > this.now()) return;
      attempted = true;
      const current = row;
      const pending: Pending = JSON.parse(row.payload);
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error("Mirror timeout")); }, this.options.timeoutMs ?? 10_000); });
      try {
        await Promise.race([timeout, (async () => {
          let threadId = this.store.get<string | null>("mirror-thread-id");
          if (!threadId) {
            const created = await this.sink.ensure(abort.signal);
            if (abort.signal.aborted) return;
            if (!created.threadId) throw new Error("Invalid mirror thread");
            threadId = created.threadId; this.store.set("mirror-thread-id", threadId);
          }
          const missing: string[] = [], attachments: { attachmentId: string }[] = [];
          for (const file of pending.files) {
            if (abort.signal.aborted) return;
            if (!file.attachmentId) {
              let bytes: Uint8Array | undefined;
              try {
                if (file.sha256?.startsWith("media:")) bytes = this.store.db.query<{ data: Uint8Array }, [string]>("SELECT data FROM mirror_files WHERE id=?").get(file.sha256.slice(6))?.data;
                else if (file.sha256) bytes = this.store.getBlob(file.sha256);
                else if (file.path) { const f = Bun.file(file.path); if (f.size <= MAX_BLOB_BYTES) bytes = await readFile(file.path); }
              } catch { /* Unavailable local files are represented in the transcript. */ }
              if (!bytes?.length && file.url && this.options.download) {
                try {
                  const downloaded = await this.options.download(file.url, MAX_BLOB_BYTES, Math.min(5_000, this.options.timeoutMs ?? 10_000));
                  if (abort.signal.aborted) return;
                  bytes = downloaded.data;
                  file.mimeType = downloaded.mimeType || file.mimeType;
                  if (file.name === "file") file.name = downloaded.name || file.name;
                  if (bytes.length && bytes.length <= MAX_BLOB_BYTES) {
                    this.rememberFile(file.url, { name: file.name, mimeType: file.mimeType, data: bytes });
                    if (this.store.db.query("SELECT 1 FROM mirror_files WHERE id=?").get(digest(file.url))) file.sha256 = `media:${digest(file.url)}`;
                    this.store.db.query("UPDATE mirror_items SET payload=? WHERE id=?").run(JSON.stringify(pending), current.id);
                  }
                } catch (error) {
                  if (!(error instanceof LineError) || error.retryable) throw error;
                  // Expired media and files over the byte cap still leave a visible placeholder.
                }
              }
              if (!bytes?.length || bytes.length > MAX_BLOB_BYTES) { missing.push(placeholder(file)); continue; }
              file.attachmentId = (await this.sink.upload({ name: file.name, mimeType: file.mimeType, bytes }, abort.signal)).attachmentId;
              if (abort.signal.aborted) return;
              this.store.db.query("UPDATE mirror_items SET payload=? WHERE id=?").run(JSON.stringify(pending), current.id);
            }
            attachments.push({ attachmentId: file.attachmentId });
          }
          if (abort.signal.aborted) return;
          await this.sink.append(threadId, [{ ...pending.item, text: [pending.item.text, ...missing].filter(Boolean).join("\n"), ...(attachments.length ? { attachments } : {}) }], abort.signal);
          if (abort.signal.aborted) return;
          this.store.db.query("UPDATE mirror_items SET payload=NULL,bytes=0 WHERE id=?").run(current.id);
        })()]);
        this.emit("mirror-append", { direction: pending.item.role === "user" ? "inbound" : "outbound", kind: pending.files.length ? "file" : "text", latency_ms: Math.max(0, this.now() - started) }, true);
      } catch (error) {
        abort.abort();
        if (error instanceof ControlError && (error.status === 404 || error.status === 409 && error.code === "not_mirror")) this.store.set("mirror-thread-id", null);
        throw error;
      } finally { clearTimeout(timer); }
    } catch (error) {
      if (error instanceof RobobLinkDown || linkDown()) { toolLog.skipRobob("mirror.tick"); attempted = false; return; }
      const attempt = Math.min((row?.attempt ?? 0) + 1, this.options.maxAttempts ?? 12);
      // Authentication and link outages retain content; only consecutive item rejections count toward a drop.
      const rejected = error instanceof ControlError && [400, 413, 422].includes(error.status) ? (row?.rejected ?? 0) + 1 : 0;
      const drop = rejected >= (this.options.maxAttempts ?? 12);
      if (row) this.store.db.query("UPDATE mirror_items SET attempt=?, rejected=?, next_at=?, payload=CASE WHEN ? THEN NULL ELSE payload END, bytes=CASE WHEN ? THEN 0 ELSE bytes END WHERE id=?")
        .run(attempt, rejected, this.now() + Math.min(300_000, 1000 * 2 ** Math.min(attempt, 9)), drop ? 1 : 0, drop ? 1 : 0, row.id);
      this.emit("mirror-fail", { cause: drop ? "retry_exhausted" : error instanceof ControlError ? "http" : "sink", attempt });
      const pending = row ? JSON.parse(row.payload) as Pending : undefined;
      this.emit("mirror-append", { direction: pending?.item.role === "user" ? "inbound" : "outbound", kind: pending?.files.length ? "file" : "text", latency_ms: Math.max(0, this.now() - started) }, false);
    } finally {
      this.busy = false;
      if (attempted) this.emit("mirror-queue", { depth: this.depth().n });
    }
  }
}

export function createChatMirror(enabled: boolean | undefined, store: Store, sink: () => MirrorSink = () => new HttpMirrorSink(), options: MirrorOptions = {}): ChatMirror | undefined {
  if (enabled !== true) return;
  return new ChatMirror(store, sink(), options);
}
