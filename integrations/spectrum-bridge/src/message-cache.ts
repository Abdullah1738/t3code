import { AsyncLocalStorage } from "node:async_hooks";
import { ControlError, type ControlClient, type ControlMessage, type ThreadDetail, type ThreadSummary, type RunEvidence } from "./control.ts";
import { randomUUID } from "node:crypto";
import { toolLog } from "./toollog.ts";
import { RobobLinkDown } from "./robob-link-gate.ts";
import { probeDeferred } from "./probe-policy.ts";

type Snapshot = { messages: ControlMessage[]; updatedAt: number; fullAt: number; readAt: number; full: boolean; marker?: string; detail?: ThreadDetail };
type Read = { generation: number; writes: number | undefined; key: string; promise: Promise<Snapshot> };
type FullReason = "first-read" | "route-change" | "missing-until" | "resync" | "merge-conflict" | "clock-skew";
const RESYNC_MS = 10 * 60_000;
const SKEW_MS = 2_000;
const BEGINNING = -8640000000000000;
const OVERLAP_MS = 30_000;
export const DETAIL_DEADLINE_MS = 2000;
type Tick = { id: string; ready: Promise<void>; messages: Map<string, Snapshot>; summaries: Map<string, ThreadSummary>;
  details: Map<string, Promise<ThreadDetail>>; evidence: Map<string, Promise<RunEvidence>>; accepted: Set<string>; deferred: Set<string>; failed: Set<string>; detailDeferred: Set<string> };

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
  private readonly detailStreaks = new Map<string, number>();
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
    const tick: Tick = { id: randomUUID(), ready: Promise.resolve(), messages: new Map(), summaries: new Map(), details: new Map(), evidence: new Map(), accepted: new Set(), deferred: new Set(), failed: new Set(), detailDeferred: new Set() };
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

  private pollLog(tick: Tick, threadId: string, props: Record<string, string | number>): void {
    toolLog.capture(() => toolLog.write({ component: "robob", kind: "perf", name: "robob.messages_read",
      ids: { threadId, tickId: tick.id }, props }));
  }

  private reason(cached: Snapshot | undefined, now: number, threadId: string): FullReason | undefined {
    return !cached ? this.routeChanged || this.changedRoutes.has(threadId) ? "route-change" : "first-read"
      : cached.updatedAt - SKEW_MS >= Math.min(now, cached.readAt) || now <= cached.readAt - SKEW_MS ? "clock-skew"
      : now - cached.fullAt >= RESYNC_MS || now - cached.readAt >= RESYNC_MS ? "resync" : undefined;
  }

  private async poll(tick: Tick, ids: string[]): Promise<void> {
    if (this.client.linkGate?.available === false) {
      toolLog.skipRobob("robob.marker_poll");
      return;
    }
    const generation = this.generation;
    const versions = new Map(ids.map(id => [id, this.readVersions.get(id)]));
    const writes = new Map(ids.map(id => [id, this.writes.get(id)]));
    let fallbackReason = "marker-error";
    const missing = new Set<string>();
    const details = new Map<string, ThreadDetail>();
    try {
      for (let offset = 0; offset < ids.length; offset += 50) {
        const chunk = ids.slice(offset, offset + 50);
        const result = await this.client.threadSummaries(chunk);
        for (const id of chunk) {
          const summary = result.threads.find(thread => thread.threadId === id);
          if (!summary) {
            // An omitted summary is a repair boundary, never proof that the old transcript is empty.
            missing.add(id);
            continue;
          }
          if (!Number.isSafeInteger(summary.changeMarker) || summary.changeMarker! < 0) {
            fallbackReason = "missing-marker";
            throw new Error("Missing change marker");
          }
          tick.summaries.set(id, summary);
        }
      }
      // Like #50, capture exact run/error state before reading its messages. A terminal detail
      // fetched afterwards could otherwise seal partial text or permanently clear a first-turn check.
      const started = performance.now(), controller = new AbortController();
      const timeout = Symbol("detail-deadline");
      const deadline = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(timeout), { once: true });
      });
      const timer = setTimeout(() => controller.abort(), DETAIL_DEADLINE_MS);
      let missingMarker = false;
      try { await Promise.all(ids.map(async id => {
        const summary = tick.summaries.get(id);
        const prior = this.details.get(id);
        const read = prior && summary && this.canReuseDetail(prior, summary) ? Promise.resolve({ ...prior, ...summary })
          : this.client.thread(id, { signal: controller.signal }).then(({ thread }) => thread);
        let detail: ThreadDetail;
        try { detail = await Promise.race([read, deadline]); }
        catch (error) {
          this.deferDetail(tick, id, error === timeout ? "timeout" : error instanceof ControlError ? "status" : "error", performance.now() - started, error);
          return;
        }
        if (!Number.isSafeInteger(detail.changeMarker) || detail.changeMarker! < 0) {
          missingMarker = true;
          return;
        }
        this.detailStreaks.delete(id);
        // Detail reads runs before its marker. Omitted summaries only have the previous poll's boundary.
        const captured = { ...detail, changeMarker: missing.has(id) ? prior?.changeMarker : summary!.changeMarker };
        details.set(id, captured);
        tick.details.set(id, Promise.resolve(captured));
        tick.summaries.set(id, captured);
      })); } finally { clearTimeout(timer); }
      if (missingMarker) { fallbackReason = "missing-marker"; throw new Error("Missing change marker"); }
      fallbackReason = "cross-thread-error";
      const changed = ids.filter(id => !tick.detailDeferred.has(id)).filter(id => {
        const cached = this.entries.get(id);
        if (missing.has(id) || this.reason(cached, Date.now(), id) || tick.summaries.get(id)!.changeMarker?.toString() !== cached?.marker) return true;
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
            readAt: Math.min(now, Date.now()), full: !!reason, marker: tick.summaries.get(id)!.changeMarker?.toString() });
          if (reason) this.pollLog(tick, id, { fullReason: reason });
        }
      }
      // Nothing becomes a skip candidate until all pages drain. Writes/route changes during the walk invalidate it.
      for (const [id, snapshot] of tick.messages) {
        if (tick.detailDeferred.has(id)) continue;
        if (!versions.has(id)) continue;
        if (generation !== this.generation || writes.get(id) !== this.writes.get(id) || versions.get(id) !== this.readVersions.get(id)) {
          tick.messages.delete(id);
          tick.failed.add(id);
          this.pollLog(tick, id, { fallbacks: 1, fallbackReason: "state-raced" });
        } else {
          snapshot.detail = details.get(id)!;
          this.entries.set(id, snapshot);
          this.changedRoutes.delete(id);
          const detail = details.get(id)!;
          this.details.set(id, detail);
          // Final archive suppression belongs to the same successful checkpoint as the transcript.
          if (detail.archived) this.archived.set(id, detail);
        }
      }
    } catch (error) {
      const status = error instanceof ControlError ? error.status : 0;
      for (const id of tick.messages.keys()) if (!tick.detailDeferred.has(id)) tick.messages.delete(id);
      for (const id of tick.summaries.keys()) if (!tick.detailDeferred.has(id)) tick.summaries.delete(id);
      for (const id of ids) {
        if (tick.detailDeferred.has(id)) continue;
        tick.failed.add(id);
        if (!(error instanceof RobobLinkDown)) this.pollLog(tick, id, { fallbacks: 1, fallbackReason, status });
      }
    }
  }

  private deferDetail(tick: Tick, threadId: string, reason: "timeout" | "error" | "status", elapsedMs: number, error: unknown): void {
    tick.detailDeferred.add(threadId);
    const cached = this.entries.get(threadId), prior = cached?.detail;
    // Expose only a committed pair. A first-read miss must never look like an empty transcript.
    if (prior && cached) {
      tick.details.set(threadId, Promise.resolve(prior));
      tick.summaries.set(threadId, prior);
      tick.messages.set(threadId, cached);
    } else tick.summaries.delete(threadId);
    const streak = (this.detailStreaks.get(threadId) ?? 0) + 1;
    this.detailStreaks.set(threadId, streak);
    this.pollLog(tick, threadId, { detailDeferred: 1 });
    const entry = { component: "robob", kind: "event" as const, ids: { threadId, tickId: tick.id },
      props: { reason, elapsedMs, streak, ...(error instanceof ControlError ? { status: error.status } : {}) } };
    toolLog.capture(() => {
      toolLog.write({ ...entry, name: "detail_deferred" });
      if (streak === 5) toolLog.write({ ...entry, name: "detail_deferred_streak", level: "warn" });
    });
  }

  private async drain(tick: Tick, ids: string[], since: number): Promise<Map<string, ControlMessage[]>> {
    const messages = new Map(ids.map(id => [id, new Map<string, ControlMessage>()]));
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const response = await this.client.crossThreadMessages({ threadIds: ids, since, cursor, limit: 1000 });
      if (!Array.isArray(response.messages) || !(response.nextCursor === null || typeof response.nextCursor === "string")) throw new Error("Invalid message page");
      this.pollLog(tick, ids[0]!, { bytesReturned: Buffer.byteLength(JSON.stringify(response)) });
      const counts = new Map<string, number>();
      for (const row of response.messages) {
        if (!this.validRow(row)) throw new Error("Invalid message row");
        const { threadId, ...message } = row;
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

  private validRow(row: unknown): row is ControlMessage & { threadId: string } {
    if (!row || typeof row !== "object") return false;
    const value = row as Record<string, unknown>;
    const time = (at: unknown) => typeof at === "string" && Number.isFinite(Date.parse(at));
    return typeof value.threadId === "string" && value.threadId.length > 0
      && typeof value.messageId === "string" && value.messageId.length > 0
      && (value.runId === null || typeof value.runId === "string" && value.runId.length > 0)
      && (value.role === "user" || value.role === "assistant" || value.role === "system")
      && typeof value.text === "string" && typeof value.streaming === "boolean"
      && time(value.createdAt) && time(value.updatedAt)
      && (value.phase === undefined || value.phase === "answer" || value.phase === "narration" || value.phase === "unknown")
      && (value.createdBy === undefined || typeof value.createdBy === "string")
      && (value.creationSource === undefined || typeof value.creationSource === "string");
  }

  private canReuseDetail(prior: ThreadDetail, summary: ThreadSummary): boolean {
    if (!Number.isSafeInteger(prior.changeMarker) || summary.changeMarker! < prior.changeMarker!) return false;
    // Provider rewinds can roll back even completed older runs without changing the latest run.
    const retainedHistory = prior.recentRuns.some(run => run.runId !== summary.latestRunId);
    return prior.latestRunId === summary.latestRunId && prior.activeRunId === summary.activeRunId
      && prior.status === summary.status && JSON.stringify(prior.pendingRequest) === JSON.stringify(summary.pendingRequest)
      && (!(summary.pendingRequest || retainedHistory) || prior.changeMarker === summary.changeMarker);
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
    if (tick?.detailDeferred.has(threadId)) {
      const prior = tick.details.get(threadId);
      if (!prior) throw probeDeferred;
      return prior;
    }
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
      if (prior && this.canReuseDetail(prior, summary)) {
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
  deferReconciliation(threadId: string, operationId: string): void { this.tick?.deferred.add(`${threadId}\0${operationId}`); }
  reconciliationDeferred(threadId: string, operationId: string): boolean { return this.tick?.detailDeferred.has(threadId) === true || this.tick?.deferred.has(`${threadId}\0${operationId}`) === true; }

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
    if (tick?.detailDeferred.has(threadId)) {
      if (!prepared) throw probeDeferred;
      return prepared.messages;
    }
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
    if (this.tick?.detailDeferred.has(threadId)) throw probeDeferred;
    if (await this.prepared(threadId)) return this.rebuild(threadId, "merge-conflict");
    const read = this.refresh(threadId, key, "merge-conflict");
    this.scope.getStore()?.set(threadId, read);
    return (await read.promise).messages;
  }

  private async rebuild(threadId: string, reason: FullReason): Promise<ControlMessage[]> {
    const tick = this.tick!;
    if (tick.detailDeferred.has(threadId)) throw probeDeferred;
    const version = this.readVersions.get(threadId);
    const writes = this.writes.get(threadId);
    try {
      const detail = await this.detail(threadId);
      const incoming = (await this.drain(tick, [threadId], BEGINNING)).get(threadId)!;
      const messages = this.merge(undefined, incoming, true)!;
      const snapshot: Snapshot = { messages, updatedAt: this.watermark(messages), fullAt: Date.now(), readAt: Date.now(), full: true,
        marker: tick.summaries.get(threadId)!.changeMarker?.toString(), detail };
      if (version === this.readVersions.get(threadId) && writes === this.writes.get(threadId)) {
        this.entries.set(threadId, snapshot);
        tick.messages.set(threadId, snapshot);
      }
      this.pollLog(tick, threadId, { fullReason: reason });
      return messages;
    } catch (error) {
      tick.failed.add(threadId);
      tick.messages.delete(threadId);
      if (error instanceof RobobLinkDown) throw error;
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
      if (!(error instanceof RobobLinkDown)) this.log(threadId, reason ? "full" : "incremental", 0, 0, reason, tick?.id);
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
