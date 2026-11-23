import { setTimeout as delay } from "node:timers/promises";
import type { ControlClient, ControlEventFrame, ThreadState, ThreadSummary } from "./control.ts";
import type { SessionStatus } from "./openchamber.ts";
import { ROSTER_TRIGGER_ACTIONS, type RosterTrigger } from "./log-active-roster.ts";
import { toolError, toolLog } from "./toollog.ts";

export const ROSTER_REASONS = ["startup", "roster_event", "safety", "stream_down", "incomplete", "error_retry"] as const;
type Reason = typeof ROSTER_REASONS[number];
const BUSY = new Set<ThreadState>(["running", "needs-input", "queued"]);
const STATES = new Set<unknown>(["idle", "running", "waiting", "needs-input", "queued"]);
const SAFETY_MS = 30_000;
const STREAM_DOWN_MS = 10_000;
const ROSTER_EVENT_MS = 5_000;
const MAX_EVENT_DETAILS = 2;
const CHANGES: Record<string, RosterTrigger> = {
  "thread.archived": "updated_archived", "thread.unarchived": "updated_unarchived", "thread.deleted": "updated_deleted",
  "thread.settled": "updated_settled", "thread.unsettled": "updated_unsettled",
};

/** Keep imported route identities local to each backend, as before sharing the roster. */
export function rosterStatuses(threads: Iterable<ThreadSummary>, native: ReadonlyMap<string, string> = new Map()): Record<string, SessionStatus> {
  const alias = new Map([...native].map(([session, threadId]) => [threadId, session]));
  const statuses: Record<string, SessionStatus> = {};
  for (const thread of threads) {
    if (!BUSY.has(thread.state)) continue;
    const root = thread.parentThreadId === null ? null : alias.get(thread.rootThreadId) ?? thread.rootThreadId;
    const busy: SessionStatus = { type: "busy", root };
    statuses[thread.threadId] = busy;
    if (thread.nativeSessionId) statuses[thread.nativeSessionId] = busy;
  }
  for (const [session, threadId] of native) if (statuses[threadId]) statuses[session] = statuses[threadId];
  return statuses;
}

type Snapshot = { threads: ThreadSummary[]; total: number; fetchedAt: number; complete: boolean };
type DetailRead = { ticket: number; revision: number; fetch: number; fetching: boolean; event?: boolean };
function clearsEvidence(previous: ThreadSummary, next?: ThreadSummary): boolean {
  return BUSY.has(previous.state) && (!next || !BUSY.has(next.state))
    || !!previous.pendingRequest && previous.pendingRequest.requestId !== next?.pendingRequest?.requestId
    || previous.state === "needs-input" && next?.state !== "needs-input";
}
function sameRow(a: ThreadSummary, b: ThreadSummary): boolean {
  return a.state === b.state && a.status === b.status && a.parentThreadId === b.parentThreadId
    && a.rootThreadId === b.rootThreadId && a.nativeSessionId === b.nativeSessionId
    && a.pendingRequest?.requestId === b.pendingRequest?.requestId
    && a.activeRunId === b.activeRunId && a.latestRunId === b.latestRunId;
}
const triggerCounters = () => Object.fromEntries(ROSTER_TRIGGER_ACTIONS.map(key => [key, 0])) as Record<typeof ROSTER_TRIGGER_ACTIONS[number], number>;
const counters = () => ({ ...triggerCounters(), fetches: 0, startup: 0, roster_event: 0, safety: 0, stream_down: 0, incomplete: 0, error_retry: 0,
  joins: 0, hits: 0, patches: 0, misses: 0, streamUp: 0, streamDown: 0, errors: 0, children: 0, ambiguous: 0, detailReads: 0, detailJoins: 0, detailErrors: 0, detailOverflow: 0, drops: 0 });

/** One active-family read and one event connection for all of the process's chats. */
export class ActiveRoster {
  private cache?: Snapshot;
  private busy: Record<string, SessionStatus> = {};
  private known = new Map<string, ThreadSummary>();
  private fetching?: Promise<void>;
  private sequences = new Map<string, number>();
  private fetchVersion = 0;
  private ambiguousRefresh = false;
  private ambiguousGeneration = -1;
  private revisions = new Map<string, number>();
  private removed = new Set<string>();
  // One start clock also orders a list's not-yet-discovered threads; fences stay per thread.
  private ticket = 0;
  private details = new Map<string, Map<number, DetailRead>>();
  private confirmations = new Map<string, DetailRead>();
  private dirty = 0;
  private pendingTrigger?: RosterTrigger;
  private urgent = false;
  private lastRosterFetch = -Infinity;
  private eventDetails = new Map<string, Promise<void>>();
  private provisional = new Set<string>();
  private clean = 0;
  private stream = false;
  private epoch = 0;
  private fetchedEpoch = -1;
  private fetchEpoch = -1;
  private retryAt = 0;
  private failures = 0;
  private failure?: unknown;
  private controller?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly counts = counters();
  private durations: number[] = [];
  private lastReason: Reason | null = null;
  private lastFetchAt: number | null = null;
  generation = 0;

  constructor(private readonly client: Pick<ControlClient, "listThreads" | "events"> & Partial<Pick<ControlClient, "thread">>, private readonly now: () => number = Date.now) {}

  status() {
    const sorted = [...this.durations].sort((a, b) => a - b);
    return { ...this.counts, fetchMsP50: sorted[Math.max(0, Math.ceil(sorted.length / 2) - 1)] ?? 0,
      fetchMsMax: sorted.at(-1) ?? 0, rows: this.cache?.threads.length ?? 0, total: this.cache?.total ?? 0,
      complete: this.cache?.complete ?? false, generation: this.generation, streamHealthy: this.stream,
      lastFetchAt: this.lastFetchAt, lastFetchReason: this.lastReason, retryAt: this.retryAt };
  }

  private count(key: keyof ReturnType<typeof counters>, durationMs?: number) {
    this.counts[key]++;
    toolLog.write({ component: "robob", kind: "perf", name: "robob.roster_action",
      ...(durationMs === undefined ? {} : { durationMs }), props: { rosterAction: key,
        rows: this.cache?.threads.length ?? 0, total: this.cache?.total ?? 0 } });
  }

  childrenRead(): void { this.count("children"); }

  start(): void {
    if (this.controller) return;
    this.controller = new AbortController();
    void this.listen(this.controller.signal);
    this.background();
  }

  stop(): void {
    this.controller?.abort();
    this.controller = undefined;
    clearTimeout(this.timer);
    this.streamState(false);
  }

  streamState(up: boolean): void {
    if (up === this.stream) return;
    this.stream = up;
    this.epoch++;
    this.count(up ? "streamUp" : "streamDown");
  }

  private invalidate(trigger: RosterTrigger): void {
    this.pendingTrigger ??= trigger;
    this.urgent ||= trigger === "ready" || trigger === "resync";
    this.generation++;
    this.dirty++;
    this.background();
  }

  checkpoint(threadId: string): DetailRead {
    const ticket = ++this.ticket;
    const read = { ticket, revision: this.revision(threadId), fetch: this.fetchVersion, fetching: !!this.fetching };
    let details = this.details.get(threadId);
    if (!details) this.details.set(threadId, details = new Map());
    details.set(ticket, read);
    return read;
  }

  finish(threadId: string, read: DetailRead): void {
    const details = this.details.get(threadId);
    details?.delete(read.ticket);
    if (!details?.size) this.details.delete(threadId);
  }

  /** Route detail reads also reconcile state while the event stream is reconnecting. */
  observe(thread: ThreadSummary, read = this.checkpoint(thread.threadId)): void {
    this.finish(thread.threadId, read);
    // A startup deadline cannot discard newer detail evidence; only lists establish completeness.
    if (read.ticket < this.revision(thread.threadId)) return;
    const row: ThreadSummary = { threadId: thread.threadId, projectId: thread.projectId, title: thread.title,
      state: thread.state, status: thread.status, origin: thread.origin, nativeSessionId: thread.nativeSessionId,
      runtimeMode: thread.runtimeMode, parentThreadId: thread.parentThreadId, rootThreadId: thread.rootThreadId,
      worktreePath: thread.worktreePath, pendingRequest: thread.pendingRequest, createdAt: thread.createdAt, updatedAt: thread.updatedAt,
      activeRunId: thread.activeRunId, latestRunId: thread.latestRunId };
    const previous = this.known.get(row.threadId);
    // Reaffirming busy is not a state change, but an older list still cannot clear that evidence.
    if ((BUSY.has(row.state) || row.pendingRequest) && read.ticket > (this.confirmations.get(row.threadId)?.ticket ?? 0)) {
      this.confirmations.set(row.threadId, read);
    }
    // Identical facts must not change state or perpetuate a reconciliation fetch.
    if (previous ? sameRow(previous, row) : !BUSY.has(row.state) && !row.pendingRequest) return;
    // Only ordered facts may clear a thread. A concurrent detail can still bring busy/request
    // evidence; retain that evidence and share reconciliation until the read order is known.
    const clears = previous && clearsEvidence(previous, row);
    if (read.fetching || this.fetching || read.fetch !== this.fetchVersion || read.revision !== this.revision(row.threadId)
      || clears && (this.details.has(row.threadId) || read.ticket < (this.confirmations.get(row.threadId)?.ticket ?? 0))) {
      this.ambiguous(row, read); return;
    }
    this.patch(row, read.ticket);
  }

  revision(threadId: string): number { return this.revisions.get(threadId) ?? 0; }

  private advance(threadId: string, ticket: number): void {
    this.revisions.set(threadId, Math.max(this.revision(threadId), ticket));
    this.generation++;
  }

  private ambiguous(row?: ThreadSummary, read?: DetailRead, trigger: RosterTrigger = "detail_ambiguous"): void {
    if (row) {
      const current = this.known.get(row.threadId) ?? row;
      const request = current.pendingRequest ?? row.pendingRequest;
      this.patch({ ...(BUSY.has(row.state) ? row : current), pendingRequest: request,
        state: request ? "needs-input" : BUSY.has(row.state) ? row.state : BUSY.has(current.state) ? current.state : "running" },
      read?.ticket ?? this.revision(row.threadId));
    }
    this.reconcile(read?.fetch ?? this.fetchVersion, trigger);
  }

  private miss(trigger: RosterTrigger): void {
    this.count("misses");
    this.count(`miss_${trigger}`);
  }

  private reconcile(generation: number, trigger: RosterTrigger = "list_held"): void {
    this.miss(trigger);
    // A read started during a fetch needs one follow-up, even if its response lands later.
    // Repeated evidence from that same generation joins the already queued reconciliation.
    if (generation < this.fetchVersion || this.ambiguousGeneration >= generation) {
      this.count("joins"); return;
    }
    this.ambiguousGeneration = generation;
    this.ambiguousRefresh = true;
    this.invalidate(trigger);
  }

  private patch(row: ThreadSummary, ticket: number): void {
    if (ticket < this.revision(row.threadId)) return;
    this.removed.delete(row.threadId);
    const previous = this.known.get(row.threadId);
    this.known.set(row.threadId, row);
    if (previous && sameRow(previous, row)) return;
    this.advance(row.threadId, ticket);
    if (this.cache) {
      const index = this.cache.threads.findIndex(thread => thread.threadId === row.threadId);
      if (index < 0) this.cache.threads.push(row);
      else this.cache.threads[index] = row;
    }
    this.rebuild();
    this.count("patches");
  }

  private hold(threadId: string, ticket: number, state?: unknown): void {
    const previous = this.known.get(threadId);
    if (!previous) this.provisional.add(threadId);
    const row = previous ?? { threadId, projectId: "", title: "", state: "running", status: "running", origin: null,
      nativeSessionId: null, runtimeMode: "full-access", parentThreadId: null, rootThreadId: threadId,
      worktreePath: null, pendingRequest: null, createdAt: null, updatedAt: null };
    this.patch({ ...row, state: row.pendingRequest ? "needs-input" : BUSY.has(state as ThreadState) ? state as ThreadState
      : BUSY.has(row.state) ? row.state : "running" }, ticket);
  }

  private confirm(threadId: string, trigger: RosterTrigger): void {
    if (this.eventDetails.has(threadId)) { this.count("detailJoins"); return; }
    // Reserve the other poll permits for route/reply reads; a burst shares roster discovery.
    if (this.eventDetails.size >= MAX_EVENT_DETAILS) { this.count("detailOverflow"); this.invalidate(trigger); return; }
    const read = this.checkpoint(threadId);
    read.event = true;
    this.count("detailReads");
    const work = (async () => {
      try {
        if (!this.client.thread) throw new Error("Thread detail unavailable");
        const result = await this.client.thread(threadId);
        const thread = result.thread.archived ? { ...result.thread, state: "idle" as const, pendingRequest: null, activeRunId: null } : result.thread;
        this.finish(threadId, read);
        if (read.ticket < this.revision(threadId)) {
          // Newer busy evidence is already safe. An unresolved identity still needs discovery.
          if (this.provisional.has(threadId)) this.invalidate(trigger);
          return;
        }
        const previous = this.known.get(threadId);
        const changedFamily = this.provisional.has(threadId) || !previous
          || previous.parentThreadId !== thread.parentThreadId || previous.rootThreadId !== thread.rootThreadId;
        // An inactive creation cannot add busy family members, even when its root is absent.
        const inactiveCreation = trigger === "created" && !BUSY.has(thread.state) && !thread.pendingRequest;
        if (thread.threadId !== threadId || changedFamily && !inactiveCreation && thread.parentThreadId !== null
          && (!thread.rootThreadId || !this.known.has(thread.rootThreadId))) {
          this.invalidate(trigger); return;
        }
        if (previous && clearsEvidence(previous, thread)
          && ([...this.details.get(threadId)?.values() ?? []].some(other => other.ticket >= this.revision(threadId))
            || read.ticket < (this.confirmations.get(threadId)?.ticket ?? 0))) {
          this.invalidate(trigger); return;
        }
        // Unlike a run event, detail is the thread's aggregate state. Its start ticket
        // fences later events/lists; unrelated in-flight lists cannot invalidate it.
        this.provisional.delete(threadId);
        if (inactiveCreation) {
          // Forget idle identity so its first busy event must place the family afresh.
          this.advance(threadId, read.ticket);
          this.removed.add(threadId);
          this.known.delete(threadId);
          if (this.cache) this.cache.threads = this.cache.threads.filter(row => row.threadId !== threadId);
          this.rebuild();
          this.count("drops");
          return;
        }
        this.patch(thread, read.ticket);
      } catch (error) {
        this.count("detailErrors");
        toolError("robob", "robob.roster_detail", error);
        this.invalidate(trigger);
      } finally { this.finish(threadId, read); }
    })().finally(() => { this.eventDetails.delete(threadId); });
    this.eventDetails.set(threadId, work);
  }

  event(frame: ControlEventFrame): void {
    const ticket = ++this.ticket;
    const data = frame.data;
    if (data.type === "error") { this.streamState(false); this.invalidate("error"); return; }
    if (data.type === "ready") { this.streamState(true); this.invalidate("ready"); return; }
    if (data.type === "resync") { this.invalidate("resync"); return; }
    const id = typeof data.threadId === "string" ? data.threadId : undefined;
    const sequence = frame.id && /^\d+$/.test(frame.id) ? Number(frame.id) : NaN;
    const ordered = Number.isSafeInteger(sequence) && sequence > (id ? this.sequences.get(id) ?? -1 : -1);
    if (id && ordered) this.sequences.set(id, sequence);
    if (data.type === "thread.updated" && data.change === "thread.metadata-updated") { this.count("drops"); return; }
    const change = data.type === "thread.updated" ? CHANGES[String(data.change)] : undefined;
    if (data.type !== "thread.status" && data.type !== "request.opened" && data.type !== "request.resolved"
      && data.type !== "thread.created" && !change) return;
    const trigger: RosterTrigger = data.type === "thread.created" ? "created" : change ?? (data.type === "request.resolved" ? "request_resolved"
      : data.type === "request.opened" ? "request_opened_unknown" : "status_unknown");
    if (!id) { this.miss(trigger); this.invalidate(trigger); return; }
    const thread = this.known.get(id);
    if (ordered && change === "updated_deleted") {
      this.advance(id, ticket);
      if (thread) this.patch({ ...thread, state: "idle", status: "idle", pendingRequest: null, activeRunId: null }, ticket);
      else this.count("drops");
      this.provisional.delete(id);
      return;
    }
    if (data.type === "thread.status" && !thread && STATES.has(data.state) && !BUSY.has(data.state as ThreadState) && !data.pendingRequest) {
      this.miss("status_unknown"); this.count("drops"); return;
    }
    if (data.type === "thread.created" && STATES.has(data.state) && !BUSY.has(data.state as ThreadState) && !data.pendingRequest) {
      this.count("drops"); return;
    }
    this.advance(id, ticket);
    if (data.type === "thread.created" || change || data.type === "request.resolved") {
      this.miss(trigger);
      if (thread || data.type === "request.resolved" || BUSY.has(data.state as ThreadState)) this.hold(id, ticket, data.state);
      this.confirm(id, trigger); return;
    }
    if (!thread || thread.parentThreadId !== null && !thread.rootThreadId) {
      const cause = thread ? "subagent_no_root" : trigger;
      this.miss(cause); this.hold(id, ticket, data.state); this.confirm(id, cause); return;
    }
    if (data.type === "request.opened") {
      if (typeof data.requestId !== "string" || (data.kind !== "question" && data.kind !== "approval") || typeof data.requestKind !== "string") {
        this.miss("request_opened_bad"); this.hold(id, ticket); this.confirm(id, "request_opened_bad"); return;
      }
      const pendingRequest: NonNullable<ThreadSummary["pendingRequest"]> = { requestId: data.requestId, kind: data.kind, requestKind: data.requestKind };
      this.patch({ ...thread, state: "needs-input", pendingRequest }, ticket);
      if (!ordered || this.fetching) {
        const cause = !ordered ? "request_opened_unordered" : "request_opened_during_fetch";
        this.miss(cause); this.confirm(id, cause);
      }
      return;
    }
    const runId = typeof data.runId === "string" ? data.runId : undefined;
    const current = thread.activeRunId ?? thread.latestRunId;
    if (!ordered || this.fetching || !STATES.has(data.state) || runId && current && runId !== current
      || !BUSY.has(data.state as ThreadState) && !thread.pendingRequest) {
      const cause = !ordered ? "status_unordered" : this.fetching ? "status_during_fetch"
        : !STATES.has(data.state) ? "status_invalid" : runId && current && runId !== current ? "status_run_changed" : "status_terminal";
      this.miss(cause); this.hold(id, ticket, data.state); this.confirm(id, cause); return;
    }
    this.patch({ ...thread, state: thread.pendingRequest ? "needs-input" : data.state as ThreadState,
      status: typeof data.status === "string" ? data.status : thread.status }, ticket);
  }

  private async listen(signal: AbortSignal): Promise<void> {
    let after: number | undefined;
    let backoff = 1_000;
    while (!signal.aborted) {
      try {
        for await (const frame of this.client.events({ signal, ...(after === undefined ? {} : { after }) })) {
          if (signal.aborted) break;
          // Sequence numbers are global; filtered/non-control events legitimately leave gaps.
          // Every ready frame invalidates the cache, including an unresumable reconnect.
          if (frame.id !== undefined && /^\d+$/.test(frame.id)) after = Number(frame.id);
          this.event(frame);
          if (frame.data.type === "error") break;
          backoff = 1_000;
        }
      } catch (error) {
        if (!signal.aborted) toolError("robob", "robob.roster_stream", error);
      } finally { this.streamState(false); this.schedule(); }
      if (!signal.aborted) await delay(backoff, undefined, { signal }).catch(() => {});
      backoff = Math.min(backoff * 2, 30_000);
    }
  }

  private reason(complete: boolean): Reason | undefined {
    if (this.failure !== undefined) return "error_retry";
    if (!this.cache) return "startup";
    if (this.dirty !== this.clean) return "roster_event";
    if (!this.cache.complete && (complete || this.now() >= this.retryAt)) return "incomplete";
    if (complete && (!this.stream || this.epoch !== this.fetchedEpoch)) return "stream_down";
    if (this.now() - this.cache.fetchedAt >= (this.stream ? SAFETY_MS : STREAM_DOWN_MS)) return this.stream ? "safety" : "stream_down";
  }

  private rebuild(): void {
    this.busy = rosterStatuses(this.cache?.threads ?? this.known.values());
    this.generation++;
  }

  isBusy(threadId: string, includeQueued = true): boolean {
    return this.busy[threadId] !== undefined && (includeQueued || this.known.get(threadId)?.state !== "queued");
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (!this.controller || this.controller.signal.aborted) return;
    const due = this.failure !== undefined || this.cache && !this.cache.complete ? this.retryAt
      : this.dirty !== this.clean ? Math.min(this.urgent ? this.now() : Math.max(this.now(), this.lastRosterFetch + ROSTER_EVENT_MS),
        (this.cache?.fetchedAt ?? this.now()) + (this.stream ? SAFETY_MS : STREAM_DOWN_MS))
      : (this.cache?.fetchedAt ?? this.now()) + (this.stream ? SAFETY_MS : STREAM_DOWN_MS);
    this.timer = setTimeout(() => this.background(), Math.max(1, due - this.now()));
    this.timer.unref();
  }

  private background(): void { void this.refresh(false).catch(() => {}); }

  private async refresh(complete: boolean): Promise<void> {
    if (this.fetching) { this.count("joins"); return this.fetching; }
    let reason = this.reason(complete);
    if (!reason) { this.count("hits"); return; }
    if (this.failure !== undefined && this.now() < this.retryAt) {
      if (complete || !this.cache) throw this.failure;
      return;
    }
    if (reason === "roster_event" && !complete && !this.urgent && this.now() < this.lastRosterFetch + ROSTER_EVENT_MS) {
      if (this.cache && this.now() - this.cache.fetchedAt >= (this.stream ? SAFETY_MS : STREAM_DOWN_MS)) reason = this.stream ? "safety" : "stream_down";
      else { this.schedule(); return; }
    }
    const version = this.dirty;
    const epoch = this.epoch;
    const healthy = this.stream;
    // Tickets describe when a writer starts, never when its network response finishes.
    // A later-started writer or an outstanding detail prevents a list from clearing evidence.
    const ticket = ++this.ticket;
    this.fetchVersion++;
    if (this.ambiguousRefresh) { this.count("ambiguous"); this.ambiguousRefresh = false; }
    this.lastReason = reason;
    this.lastFetchAt = this.now();
    this.count("fetches"); this.count(reason);
    // One initiating trigger owns each full fetch; further triggers remain visible as misses.
    if (reason === "roster_event") { this.count(`fetch_${this.pendingTrigger ?? "list_held"}`); this.lastRosterFetch = this.now(); }
    this.urgent = false;
    this.pendingTrigger = undefined;
    this.fetching = (async () => {
      const started = this.now();
      try {
        const { total, threads } = await this.client.listThreads({ active: true, includeSubagents: true, limit: 500 });
        // Removal fences outlive known rows; an older list cannot restore their identity.
        const rows = threads.filter(thread => !this.removed.has(thread.threadId) || ticket >= this.revision(thread.threadId)).map(thread => ({ ...thread }));
        const held = new Set<string>();
        for (const [id, previous] of this.known) {
          const index = rows.findIndex(row => row.threadId === id);
          const next = rows[index];
          const details = [...this.details.get(id)?.values() ?? []].filter(read => read.ticket >= this.revision(id));
          const confirmation = this.confirmations.get(id);
          const reaffirmed = confirmation && confirmation.ticket > ticket;
          if (ticket >= this.revision(id) && !((details.length || reaffirmed) && clearsEvidence(previous, next))) continue;
          // A pending event detail cannot hide new busy/request evidence from a later list.
          // Retain the old request if necessary, but fence the older detail with the list ticket.
          if (ticket >= this.revision(id) && details.some(read => read.event) && next && (BUSY.has(next.state) || next.pendingRequest)) {
            rows[index] = { ...next, pendingRequest: next.pendingRequest ?? previous.pendingRequest,
              state: next.pendingRequest || previous.pendingRequest ? "needs-input" : next.state };
            this.advance(id, ticket);
            this.provisional.delete(id);
            continue;
          }
          held.add(id);
          if (index < 0) rows.push(previous);
          else rows[index] = previous;
          for (const read of details) if (!read.event) this.reconcile(read.fetch);
          if (reaffirmed) this.reconcile(confirmation.fetch);
        }
        const isComplete = total <= threads.length;
        // A truncated list cannot erase observed busy families, including bootstrap details.
        if (!isComplete) for (const row of this.known.values()) {
          if (BUSY.has(row.state) && !rows.some(next => next.threadId === row.threadId)) rows.push(row);
        }
        for (const id of new Set([...this.known.keys(), ...rows.map(row => row.threadId)])) {
          if (!held.has(id)) {
            this.advance(id, ticket);
            this.provisional.delete(id);
            if ((this.confirmations.get(id)?.ticket ?? 0) <= ticket) this.confirmations.delete(id);
          }
        }
        this.cache = { threads: rows, total, complete: isComplete, fetchedAt: this.now() };
        for (const id of this.removed) if (ticket >= this.revision(id)) this.removed.delete(id);
        for (const row of rows) this.known.set(row.threadId, row);
        if (isComplete || this.known.size > 2_000) {
          // Rows leaving the active set must not retain an old pending request for later run events.
          // Their fences still reject detail responses started before removal.
          const current = new Set(rows.map(row => row.threadId));
          for (const id of this.known.keys()) if (!current.has(id)) this.known.delete(id);
        }
        this.clean = version;
        this.fetchEpoch = epoch;
        this.fetchedEpoch = healthy && this.stream && epoch === this.epoch ? epoch : -1;
        this.failure = undefined; this.failures = 0; this.retryAt = 0;
        this.rebuild();
        if (!isComplete) this.retryAt = this.now() + 10_000;
      } catch (error) {
        this.failure = error;
        this.retryAt = this.now() + Math.min(1_000 * 2 ** Math.min(this.failures++, 5), 30_000);
        this.count("errors");
        toolError("robob", "robob.roster_fetch", error);
        throw error;
      } finally {
        const ms = Math.max(0, this.now() - started);
        this.durations.push(ms);
        if (this.durations.length > 2_000) this.durations.shift();
        toolLog.write({ component: "robob", kind: "perf", name: "robob.roster_action", durationMs: ms,
          props: { rosterAction: "duration", rows: this.cache?.threads.length ?? 0, total: this.cache?.total ?? 0 } });
      }
    })().finally(() => { this.fetching = undefined; this.schedule(); });
    return this.fetching;
  }

  /** Synchronous view for reply checks; refreshing never delays a route's own detail read. */
  view(native: ReadonlyMap<string, string>): Record<string, SessionStatus> {
    this.background();
    return native.size ? rosterStatuses(this.cache?.threads ?? this.known.values(), native) : { ...this.busy };
  }

  async read(complete: boolean, native: ReadonlyMap<string, string>): Promise<Record<string, SessionStatus>> {
    if (!complete && (this.cache || this.known.size)) return this.view(native);
    if (complete && this.eventDetails.size) await Promise.all(this.eventDetails.values());
    await this.refresh(complete);
    // Events may start confirmation while the list is in flight; admission must include those reads too.
    if (complete && this.eventDetails.size) await Promise.all(this.eventDetails.values());
    if (complete && (this.dirty !== this.clean || this.fetchEpoch !== this.epoch)) await this.refresh(true);
    if (complete && (this.eventDetails.size || this.provisional.size || !this.cache?.complete || this.dirty !== this.clean || this.fetchEpoch !== this.epoch || this.failure !== undefined)) throw new Error("Incomplete active family discovery");
    return native.size ? rosterStatuses(this.cache?.threads ?? this.known.values(), native) : { ...this.busy };
  }
}
