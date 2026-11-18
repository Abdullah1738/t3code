import { AsyncLocalStorage } from "node:async_hooks";
import type { ControlClient, ControlMessage } from "./control.ts";
import { toolLog } from "./toollog.ts";

type Snapshot = { messages: ControlMessage[]; updatedAt: number; fullAt: number; readAt: number; full: boolean; marker?: string };
type Read = { generation: number; writes: number | undefined; key: string; promise: Promise<Snapshot> };
type FullReason = "first-read" | "route-change" | "missing-until" | "resync" | "merge-conflict" | "clock-skew";
const RESYNC_MS = 10 * 60_000;
const SKEW_MS = 2_000;

/** Only raw messages are cached. Run outcomes, evidence and reply classification stay fresh. */
export class MessageCache {
  private readonly entries = new Map<string, Snapshot>();
  private readonly pending = new Map<string, Read>();
  private readonly scope = new AsyncLocalStorage<Map<string, Read>>();
  private routeChanged = false;
  private generation = 0;
  private readonly readVersions = new Map<string, number>();
  private readonly writes = new Map<string, number>();

  constructor(private readonly client: ControlClient) {}

  withinTick<T>(body: () => Promise<T>): Promise<T> {
    return this.scope.run(new Map(), body);
  }

  routeChange(): void {
    this.generation++;
    this.entries.clear();
    this.pending.clear();
    this.scope.getStore()?.clear();
    this.routeChanged = true;
  }

  /** A write invalidates same-tick sharing, including ambiguous sends which may have landed. */
  afterWrite(threadId: string): void {
    this.writes.set(threadId, (this.writes.get(threadId) ?? 0) + 1);
    this.pending.delete(threadId);
    this.scope.getStore()?.delete(threadId);
  }

  private log(threadId: string, mode: string, rows = 0, bytes = 0, reason?: FullReason): void {
    toolLog.capture(() => toolLog.write({ component: "robob", kind: "perf", name: "robob.messages_read", ids: { threadId },
      props: { readMode: mode, rowsReturned: rows, bytesReturned: bytes, ...(reason ? { fullReason: reason } : {}) } }));
  }

  async read(threadId: string, key: string, contains?: (messages: ControlMessage[]) => boolean, provenMarker?: string): Promise<ControlMessage[]> {
    const scope = this.scope.getStore();
    let read = this.pending.get(threadId) ?? scope?.get(threadId);
    if (read?.key !== key || read.generation !== this.generation || read.writes !== this.writes.get(threadId)) read = undefined;
    if (read) this.log(threadId, "shared");
    else {
      read = this.refresh(threadId, key, undefined, provenMarker);
      scope?.set(threadId, read);
    }
    let snapshot: Snapshot;
    try { snapshot = await read.promise; }
    catch (error) { if (scope?.get(threadId) === read) scope.delete(threadId); throw error; }
    if (contains && !contains(snapshot.messages) && !snapshot.full) {
      const pending = this.pending.get(threadId);
      read = pending?.key === key ? pending : this.refresh(threadId, key, "missing-until");
      scope?.set(threadId, read);
      snapshot = await read.promise;
    }
    return snapshot.messages;
  }

  async resync(threadId: string, key: string): Promise<ControlMessage[]> {
    const read = this.refresh(threadId, key, "merge-conflict");
    this.scope.getStore()?.set(threadId, read);
    return (await read.promise).messages;
  }

  private refresh(threadId: string, key: string, force?: FullReason, marker?: string): Read {
    const read = { generation: this.generation, writes: this.writes.get(threadId), key, promise: this.load(threadId, force, marker) };
    this.pending.set(threadId, read);
    void read.promise.finally(() => { if (this.pending.get(threadId) === read) this.pending.delete(threadId); }).catch(() => {});
    return read;
  }

  private async load(threadId: string, force?: FullReason, marker?: string): Promise<Snapshot> {
    const version = (this.readVersions.get(threadId) ?? 0) + 1;
    this.readVersions.set(threadId, version);
    const generation = this.generation;
    const writes = this.writes.get(threadId);
    const cached = this.entries.get(threadId);
    const now = Date.now();
    // Remember a future cursor at capture too: a delayed poll after clock correction can still miss earlier errors.
    const reason = force ?? (!cached ? this.routeChanged ? "route-change" : "first-read"
      : cached.updatedAt - SKEW_MS >= Math.min(now, cached.readAt) || now <= cached.readAt - SKEW_MS ? "clock-skew"
      : now - cached.fullAt >= RESYNC_MS ? "resync" : undefined);
    // #1585 has not proven a marker on main. RobobBackend deliberately passes none.
    if (!reason && cached && marker !== undefined && marker === cached.marker) {
      this.log(threadId, "cached-skip");
      return { ...cached, full: false };
    }
    const since = reason ? undefined : Math.max(0, cached!.updatedAt - SKEW_MS);
    const response = await this.client.messages(threadId, since).catch(error => {
      this.log(threadId, reason ? "full" : "incremental", 0, 0, reason);
      throw error;
    });
    const incoming = response.messages;
    this.log(threadId, reason ? "full" : "incremental", incoming.length, Buffer.byteLength(JSON.stringify(response)), reason);
    const byId = new Map(cached?.messages.map(message => [message.messageId, message]));
    const seen = new Set<string>();
    let conflict = false;
    for (const message of incoming) {
      const prior = byId.get(message.messageId);
      if (seen.has(message.messageId) || !Number.isFinite(Date.parse(message.updatedAt ?? ""))
        || prior && (prior.runId !== message.runId || prior.role !== message.role || prior.createdAt !== message.createdAt
          || Date.parse(message.updatedAt!) < Date.parse(prior.updatedAt ?? ""))) conflict = true;
      seen.add(message.messageId);
      byId.set(message.messageId, message);
    }
    if (!reason && conflict) return this.load(threadId, "merge-conflict", marker);
    const messages = (reason ? [...incoming] : [...byId.values()]).sort((a, b) =>
      Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? "") || a.messageId.localeCompare(b.messageId));
    const updatedAt = messages.reduce((max, message) => Math.max(max, Date.parse(message.updatedAt ?? "") || 0), 0);
    const result: Snapshot = { messages, updatedAt, fullAt: reason ? Date.now() : cached!.fullAt, readAt: Math.min(now, Date.now()), full: reason !== undefined, marker };
    if (generation === this.generation && writes === this.writes.get(threadId) && version === this.readVersions.get(threadId)) this.entries.set(threadId, result);
    return result;
  }
}
