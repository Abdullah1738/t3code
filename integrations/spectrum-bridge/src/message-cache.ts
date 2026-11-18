import { AsyncLocalStorage } from "node:async_hooks";
import { ControlError, type ControlClient, type ControlMessage, type ThreadDetail, type ThreadSummary, type RunEvidence } from "./control.ts";
import { randomUUID } from "node:crypto";
import { toolLog } from "./toollog.ts";

type Snapshot = { messages: ControlMessage[]; updatedAt: number; fullAt: number; readAt: number; full: boolean; marker?: string };
type Read = { generation: number; writes: number | undefined; key: string; promise: Promise<Snapshot> };
type FullReason = "first-read" | "route-change" | "missing-until" | "resync" | "merge-conflict" | "clock-skew";
const RESYNC_MS = 10 * 60_000;
const SKEW_MS = 2_000;
const BEGINNING = -8640000000000000;
const OVERLAP_MS = 30_000;
type Tick = { id: string; ready: Promise<void>; messages: Map<string, Snapshot>; summaries: Map<string, ThreadSummary>;
  details: Map<string, Promise<ThreadDetail>>; evidence: Map<string, Promise<RunEvidence>>; accepted: Set<string>; failed: Set<string> };

/** Marker snapshots share messages and metadata; run evidence is shared for one tick only. */
export class MessageCache {
  private readonly entries = new Map<string, Snapshot>();
  private readonly pending = new Map<string, Read>();
  private readonly scope = new AsyncLocalStorage<Map<string, Read>>();
  private routeChanged = false;
  private readonly changedRoutes = new Set<string>();
  private generation = 0;
  private readonly readVersions = new Map<string, number>();
  private readonly writes = new Map<string, number>();
  private tick?: Tick;
  private polling = false;
  private readonly details = new Map<string, ThreadDetail>();
  private readonly archived = new Map<string, ThreadDetail>();
  private readonly metadataScope = new AsyncLocalStorage<Map<string, Promise<RunEvidence>>>();

  constructor(private readonly client: ControlClient) {}

  withinTick<T>(body: () => Promise<T>): Promise<T> {
    return this.metadataScope.run(new Map(), () => this.scope.run(new Map(), body));
  }

  /** Called once by the sender timer, before either completion producers or router ticks run. */
  beginTick(threadIds: string[]): Promise<void> {
    if (this.polling) return this.tick!.ready;
    const tracked = new Set(threadIds);
    for (const id of this.entries.keys()) if (!tracked.has(id)) {
      this.routeChange(id);
      this.details.delete(id);
      this.archived.delete(id);
    }
    const tick: Tick = { id: randomUUID(), ready: Promise.resolve(), messages: new Map(), summaries: new Map(), details: new Map(), evidence: new Map(), accepted: new Set(), failed: new Set() };
    this.tick = tick;
    for (const id of threadIds) if (this.archived.has(id) && this.entries.has(id)) {
      tick.messages.set(id, this.entries.get(id)!);
      tick.summaries.set(id, this.archived.get(id)!);
    }
    this.client.beginReadTick(tick.id);
    this.polling = true;
    tick.ready = this.poll(tick, [...new Set(threadIds)].filter(id => !this.archived.has(id)))
      .finally(() => { this.polling = false; });
    return tick.ready;
  }

  private pollLog(tick: Tick, threadId: string, props: Record<string, string | number>, callBatchId?: string): void {
    toolLog.capture(() => toolLog.write({ component: "robob", kind: "perf", name: "robob.messages_read",
      ids: { threadId, tickId: tick.id, ...(callBatchId ? { callBatchId } : {}) }, props }));
  }

  private reason(cached: Snapshot | undefined, now: number, threadId: string): FullReason | undefined {
    return !cached ? this.routeChanged || this.changedRoutes.has(threadId) ? "route-change" : "first-read"
      : cached.updatedAt - SKEW_MS >= Math.min(now, cached.readAt) || now <= cached.readAt - SKEW_MS ? "clock-skew"
      : now - cached.fullAt >= RESYNC_MS || now - cached.readAt >= RESYNC_MS ? "resync" : undefined;
  }

  private async poll(tick: Tick, ids: string[]): Promise<void> {
    const generation = this.generation;
    const versions = new Map(ids.map(id => [id, this.readVersions.get(id)]));
    const writes = new Map(ids.map(id => [id, this.writes.get(id)]));
    let fallbackReason = "marker-error";
    const missing = new Set<string>();
    try {
      for (let offset = 0; offset < ids.length; offset += 50) {
        const chunk = ids.slice(offset, offset + 50);
        const callBatchId = randomUUID();
        chunk.forEach((id, index) => this.pollLog(tick, id, { markerPolls: index === 0 ? 1 : 0, markerChecks: 1, trackedThreads: chunk.length }, callBatchId));
        const result = await this.client.threadSummaries(chunk);
        for (const id of chunk) {
          let summary = result.threads.find(thread => thread.threadId === id);
          if (!summary) {
            const { thread } = await this.client.thread(id);
            this.details.set(id, thread);
            tick.details.set(id, Promise.resolve(thread));
            summary = thread;
            // An omitted summary is a repair boundary, never proof that the old transcript is empty.
            missing.add(id);
            if (thread.archived) this.archived.set(id, thread);
          }
          if (!Number.isSafeInteger(summary.changeMarker) || summary.changeMarker! < 0) {
            fallbackReason = "missing-marker";
            throw new Error("Missing change marker");
          }
          tick.summaries.set(id, summary);
        }
      }
      fallbackReason = "cross-thread-error";
      const changed = ids.filter(id => {
        const cached = this.entries.get(id);
        if (missing.has(id) || this.reason(cached, Date.now(), id) || String(tick.summaries.get(id)!.changeMarker) !== cached?.marker) return true;
        tick.messages.set(id, { ...cached!, full: false });
        this.pollLog(tick, id, { markerSkips: 1 });
        return false;
      });
      for (let offset = 0; offset < changed.length; offset += 50) {
        const chunk = changed.slice(offset, offset + 50);
        const now = Date.now();
        const rebuild = new Map(chunk.map(id => {
          const cached = this.entries.get(id);
          const marker = tick.summaries.get(id)!.changeMarker!;
          return [id, missing.has(id) ? "merge-conflict" as const : this.reason(cached, now, id)
            ?? (cached?.updatedAt === BEGINNING ? "first-read" as const : cached?.marker !== undefined && marker < Number(cached.marker) ? "merge-conflict" as const : undefined)];
        }));
        // A single full window can cover mixed rebuild/incremental threads; only rebuilds replace history.
        const since = [...rebuild.values()].some(Boolean) ? BEGINNING
          : Math.max(BEGINNING, Math.min(...chunk.map(id => this.entries.get(id)!.updatedAt)) - OVERLAP_MS);
        const incoming = await this.drain(tick, chunk, since);
        for (const id of chunk) {
          let reason = rebuild.get(id);
          let messages = this.merge(this.entries.get(id), incoming.get(id)!, !!reason);
          if (!messages) {
            reason = "merge-conflict";
            messages = (await this.drain(tick, [id], BEGINNING)).get(id)!;
          }
          const cached = this.entries.get(id);
          tick.messages.set(id, { messages, updatedAt: this.watermark(messages), fullAt: reason ? Date.now() : cached!.fullAt,
            readAt: Math.min(now, Date.now()), full: !!reason, marker: String(tick.summaries.get(id)!.changeMarker) });
          if (reason) this.pollLog(tick, id, { fullReason: reason });
        }
      }
      // Nothing becomes a skip candidate until all pages drain. Writes/route changes during the walk invalidate it.
      for (const [id, snapshot] of tick.messages) {
        if (!versions.has(id)) continue;
        if (generation !== this.generation || writes.get(id) !== this.writes.get(id) || versions.get(id) !== this.readVersions.get(id)) {
          tick.messages.delete(id);
          tick.failed.add(id);
          this.pollLog(tick, id, { fallbacks: 1, fallbackReason: "state-raced" });
        } else { this.entries.set(id, snapshot); this.changedRoutes.delete(id); }
      }
    } catch (error) {
      const status = error instanceof ControlError ? error.status : 0;
      tick.messages.clear();
      tick.summaries.clear();
      for (const id of ids) {
        tick.failed.add(id);
        this.pollLog(tick, id, { fallbacks: 1, fallbackReason, status });
      }
    }
  }

  private async drain(tick: Tick, ids: string[], since: number): Promise<Map<string, ControlMessage[]>> {
    const messages = new Map(ids.map(id => [id, new Map<string, ControlMessage>()]));
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const callBatchId = randomUUID();
      ids.forEach((id, index) => this.pollLog(tick, id, { crossThreadReads: index === 0 && cursor === undefined ? 1 : 0,
        crossThreadPages: index === 0 ? 1 : 0, crossThreadChecks: 1 }, callBatchId));
      const response = await this.client.crossThreadMessages({ threadIds: ids, since, cursor, limit: 1000 });
      if (!Array.isArray(response.messages) || !(response.nextCursor === null || typeof response.nextCursor === "string")) throw new Error("Invalid message page");
      this.pollLog(tick, ids[0]!, { bytesReturned: Buffer.byteLength(JSON.stringify(response)) });
      const counts = new Map<string, number>();
      for (const { threadId, ...message } of response.messages) {
        const rows = messages.get(threadId);
        if (!rows) throw new Error("Unexpected message thread");
        counts.set(threadId, (counts.get(threadId) ?? 0) + 1);
        if (message.role !== "system") rows.set(message.messageId, message);
      }
      for (const [id, rowsReturned] of counts) this.pollLog(tick, id, { rowsReturned });
      cursor = response.nextCursor ?? undefined;
      if (cursor !== undefined && seen.has(cursor)) throw new Error("Repeated message cursor");
      if (cursor !== undefined) seen.add(cursor);
    } while (cursor !== undefined);
    return new Map([...messages].map(([id, rows]) => [id, [...rows.values()]]));
  }

  private watermark(messages: ControlMessage[]): number {
    return messages.reduce((max, message) => {
      const at = Date.parse(message.updatedAt ?? "");
      return Number.isFinite(at) ? Math.max(max, at) : max;
    }, BEGINNING);
  }

  private merge(cached: Snapshot | undefined, incoming: ControlMessage[], full: boolean): ControlMessage[] | undefined {
    const byId = new Map(full ? [] : cached?.messages.map(message => [message.messageId, message]));
    for (const message of incoming) {
      const prior = byId.get(message.messageId);
      if (!full && (!Number.isFinite(Date.parse(message.updatedAt ?? "")) || prior && (prior.runId !== message.runId || prior.role !== message.role
        || prior.createdAt !== message.createdAt || Date.parse(message.updatedAt!) < Date.parse(prior.updatedAt ?? "")))) return;
      byId.set(message.messageId, message);
    }
    return [...byId.values()].sort((a, b) => Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? "") || a.messageId.localeCompare(b.messageId));
  }

  async detail(threadId: string): Promise<ThreadDetail> {
    const tick = this.tick;
    await tick?.ready;
    const summary = tick?.summaries.get(threadId) ?? this.archived.get(threadId);
    const shared = tick?.details;
    if (!summary) {
      let read = shared?.get(threadId);
      if (!read) { read = this.client.thread(threadId).then(({ thread }) => thread); shared?.set(threadId, read); }
      return read;
    }
    let read = shared?.get(threadId);
    if (!read) {
      const prior = this.details.get(threadId);
      // Summary-only stream changes retain the full run metadata. Transitions need exact completion/error/request details.
      if (prior && prior.latestRunId === summary.latestRunId && prior.activeRunId === summary.activeRunId
        && prior.status === summary.status && JSON.stringify(prior.pendingRequest) === JSON.stringify(summary.pendingRequest)
        && (!summary.pendingRequest || prior.changeMarker === summary.changeMarker)) {
        read = Promise.resolve({ ...prior, ...summary });
      } else read = this.client.thread(threadId).then(({ thread }) => thread);
      shared?.set(threadId, read);
    }
    const thread = await read;
    this.details.set(threadId, thread);
    return thread;
  }

  async evidence(threadId: string, runId: string): Promise<RunEvidence> {
    const tick = this.tick;
    await tick?.ready;
    const shared = tick?.evidence ?? this.metadataScope.getStore();
    const key = `${threadId}\0${runId}`;
    let read = shared?.get(key);
    if (!read) { read = this.client.runEvidence(threadId, runId); shared?.set(key, read); }
    return read;
  }

  async prepared(threadId: string): Promise<boolean> {
    const tick = this.tick;
    await tick?.ready;
    return tick?.messages.has(threadId) ?? false;
  }

  accept(threadId: string, promptId: string): void { this.tick?.accepted.add(`${threadId}\0${promptId}`); }
  accepted(threadId: string, promptId: string): boolean { return this.tick?.accepted.has(`${threadId}\0${promptId}`) ?? false; }

  routeChange(threadId?: string): void {
    if (threadId !== undefined) {
      this.changedRoutes.add(threadId);
      this.entries.delete(threadId);
      this.tick?.messages.delete(threadId);
      this.readVersions.set(threadId, (this.readVersions.get(threadId) ?? 0) + 1);
      return;
    }
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

  private log(threadId: string, mode: string, rows = 0, bytes = 0, reason?: FullReason, tickId = this.tick?.id): void {
    toolLog.capture(() => toolLog.write({ component: "robob", kind: "perf", name: "robob.messages_read", ids: { threadId, ...(tickId ? { tickId } : {}) },
      props: { readMode: mode, rowsReturned: rows, bytesReturned: bytes, ...(reason ? { fullReason: reason } : {}) } }));
  }

  async read(threadId: string, key: string, contains?: (messages: ControlMessage[]) => boolean, provenMarker?: string): Promise<ControlMessage[]> {
    const tick = this.tick;
    await tick?.ready;
    const prepared = tick?.messages.get(threadId);
    if (prepared && (!contains || contains(prepared.messages) || prepared.full)) {
      this.log(threadId, "cached-skip");
      return prepared.messages;
    }
    if (prepared) return this.rebuild(threadId, "missing-until");
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
    if (await this.prepared(threadId)) return this.rebuild(threadId, "merge-conflict");
    const read = this.refresh(threadId, key, "merge-conflict");
    this.scope.getStore()?.set(threadId, read);
    return (await read.promise).messages;
  }

  private async rebuild(threadId: string, reason: FullReason): Promise<ControlMessage[]> {
    const tick = this.tick!;
    const version = this.readVersions.get(threadId);
    const writes = this.writes.get(threadId);
    try {
      const incoming = (await this.drain(tick, [threadId], BEGINNING)).get(threadId)!;
      const messages = this.merge(undefined, incoming, true)!;
      const snapshot: Snapshot = { messages, updatedAt: this.watermark(messages), fullAt: Date.now(), readAt: Date.now(), full: true,
        marker: String(tick.summaries.get(threadId)!.changeMarker) };
      if (version === this.readVersions.get(threadId) && writes === this.writes.get(threadId)) {
        this.entries.set(threadId, snapshot);
        tick.messages.set(threadId, snapshot);
      }
      this.pollLog(tick, threadId, { fullReason: reason });
      return messages;
    } catch {
      tick.failed.add(threadId);
      tick.messages.delete(threadId);
      this.pollLog(tick, threadId, { fallbacks: 1, fallbackReason: "cross-thread-error" });
      return (await this.refresh(threadId, "rebuild-fallback", reason).promise).messages;
    }
  }

  private refresh(threadId: string, key: string, force?: FullReason, marker?: string): Read {
    const read = { generation: this.generation, writes: this.writes.get(threadId), key, promise: this.load(threadId, force, marker) };
    this.pending.set(threadId, read);
    void read.promise.finally(() => { if (this.pending.get(threadId) === read) this.pending.delete(threadId); }).catch(() => {});
    return read;
  }

  private async load(threadId: string, force?: FullReason, marker?: string): Promise<Snapshot> {
    const tick = this.tick;
    const version = (this.readVersions.get(threadId) ?? 0) + 1;
    this.readVersions.set(threadId, version);
    const generation = this.generation;
    const writes = this.writes.get(threadId);
    const cached = this.entries.get(threadId);
    const now = Date.now();
    // Remember a future cursor at capture too: a delayed poll after clock correction can still miss earlier errors.
    const reason = force ?? (!cached ? this.routeChanged || this.changedRoutes.has(threadId) ? "route-change" : "first-read"
      : cached.updatedAt - SKEW_MS >= Math.min(now, cached.readAt) || now <= cached.readAt - SKEW_MS ? "clock-skew"
      : now - cached.fullAt >= RESYNC_MS ? "resync" : undefined);
    if (!reason && cached && marker !== undefined && marker === cached.marker) {
      this.log(threadId, "cached-skip");
      return { ...cached, full: false };
    }
    const since = reason ? undefined : Math.max(0, cached!.updatedAt - SKEW_MS);
    const response = await this.client.messages(threadId, since).catch(error => {
      this.log(threadId, reason ? "full" : "incremental", 0, 0, reason, tick?.id);
      throw error;
    });
    const incoming = response.messages;
    this.log(threadId, reason ? "full" : "incremental", incoming.length, Buffer.byteLength(JSON.stringify(response)), reason, tick?.id);
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
    if (generation === this.generation && writes === this.writes.get(threadId) && version === this.readVersions.get(threadId)
      && tick === this.tick && !tick?.failed.has(threadId)) this.entries.set(threadId, result);
    return result;
  }
}
