// @effect-diagnostics nodeBuiltinImport:off - this host-global database is deliberately separate from every server home.
// @effect-diagnostics globalDate:off - the clock can be injected in tests.
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const STALE_MS = 120_000;
export const QUIET_MS = 600_000;
export type DesktopMode = "native" | "cua-driver";
export type LeaseState = "held" | "stopping" | "quarantined";
export interface LeaseRequest {
  readonly rootThreadId: string;
  readonly childThreadId: string;
  readonly taskId: string;
  readonly scope: string;
  readonly mode: DesktopMode;
}
export interface Lease extends LeaseRequest {
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly state: LeaseState;
}
export interface QueuedRequest extends LeaseRequest {
  readonly enqueuedAt: string;
  readonly position: number;
}
export interface LeaseStatus {
  readonly lease: Lease | null;
  readonly queue: ReadonlyArray<QueuedRequest>;
}
type Row = {
  seq: number;
  ticket: string;
  root_thread_id: string;
  child_thread_id: string;
  task_id: string;
  scope: string;
  mode: DesktopMode;
  request_state: "queued" | "held" | "finished" | "cancelled";
  lease_state: LeaseState | null;
  enqueued_at: number;
  acquired_at: number | null;
  heartbeat_at: number | null;
  stopping_at: number | null;
  quiescent: number;
};
export class DesktopLeaseError extends Error {
  readonly code: "invalid_request" | "conflict" | "not_found";
  constructor(
    code: "invalid_request" | "conflict" | "not_found",
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

const fail = (message: string): never => {
  throw new DesktopLeaseError("conflict", message);
};
const nonempty = (value: unknown, name: string) => {
  if (typeof value !== "string" || value.trim() !== value || !value || value.length > 1024) {
    throw new DesktopLeaseError("invalid_request", `${name} must be a nonempty string (max 1024).`);
  }
  return value;
};
const iso = (time: number | null) => new Date(time!).toISOString();
const requestOf = (row: Row): LeaseRequest => ({
  rootThreadId: row.root_thread_id,
  childThreadId: row.child_thread_id,
  taskId: row.task_id,
  scope: row.scope,
  mode: row.mode,
});
const leaseOf = (row: Row): Lease => ({
  ...requestOf(row),
  acquiredAt: iso(row.acquired_at),
  heartbeatAt: iso(row.heartbeat_at),
  state: row.lease_state!,
});

export const defaultDesktopLeasePath = () =>
  Path.join(OS.userInfo().homedir, ".robob", "desktop-lease", "lease.sqlite");

/** One host-wide lock, independent of T3 home and project database. */
export class DesktopLease {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(options: { filename?: string; now?: () => number } = {}) {
    const filename = options.filename ?? defaultDesktopLeasePath();
    if (filename !== ":memory:") {
      const directory = Path.dirname(filename);
      FS.mkdirSync(directory, { recursive: true, mode: 0o700 });
      // The live host-global database contains task scopes and fencing tickets.
      if (options.filename === undefined) FS.chmodSync(directory, 0o700);
      const fd = FS.openSync(filename, "a", 0o600);
      try {
        if (options.filename === undefined) FS.fchmodSync(fd, 0o600);
      } finally {
        FS.closeSync(fd);
      }
    }
    this.now = options.now ?? Date.now;
    this.db = new DatabaseSync(filename);
    // Failure to get the writer is a closed failure, never an uncoordinated grant.
    this.db.exec(`PRAGMA busy_timeout = 1000; PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL; PRAGMA fullfsync = ON;
      CREATE TABLE IF NOT EXISTS ardud_desktop_requests (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket TEXT NOT NULL UNIQUE,
        root_thread_id TEXT NOT NULL,
        child_thread_id TEXT NOT NULL,
        task_id TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('native', 'cua-driver')),
        request_state TEXT NOT NULL CHECK (request_state IN ('queued', 'held', 'finished', 'cancelled')),
        lease_state TEXT CHECK (lease_state IN ('held', 'stopping', 'quarantined')),
        enqueued_at INTEGER NOT NULL,
        acquired_at INTEGER,
        heartbeat_at INTEGER,
        stopping_at INTEGER,
        quiescent INTEGER NOT NULL DEFAULT 0 CHECK (quiescent IN (0, 1)),
        evidence TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ardud_desktop_one_holder
        ON ardud_desktop_requests(request_state) WHERE request_state = 'held';
      CREATE UNIQUE INDEX IF NOT EXISTS ardud_desktop_one_child
        ON ardud_desktop_requests(child_thread_id) WHERE request_state IN ('queued', 'held');
      CREATE TABLE IF NOT EXISTS ardud_desktop_calls (
        call_id TEXT PRIMARY KEY,
        ticket TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('started', 'completed', 'uncertain')),
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );`);
  }

  close() {
    this.db.close();
  }

  private transaction<T>(f: (now: number) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = this.now();
      const result = f(now);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      // Rejected requests must not roll back a stale holder's stop/quarantine.
      // Every domain rejection occurs before its own mutation.
      this.db.exec(error instanceof DesktopLeaseError ? "COMMIT" : "ROLLBACK");
      throw error;
    }
  }

  private one(query: string, ...args: string[]): Row | undefined {
    return this.db.prepare(query).get(...args) as Row | undefined;
  }

  private holder() {
    return this.one("SELECT * FROM ardud_desktop_requests WHERE request_state = 'held'");
  }

  private byTicket(ticket: string) {
    nonempty(ticket, "ticket");
    const row = this.one("SELECT * FROM ardud_desktop_requests WHERE ticket = ?", ticket);
    if (!row) throw new DesktopLeaseError("not_found", "Unknown desktop lease ticket.");
    return row;
  }

  private byTask(taskId: string) {
    nonempty(taskId, "taskId");
    const row = this.one("SELECT * FROM ardud_desktop_requests WHERE task_id = ?", taskId);
    if (!row) throw new DesktopLeaseError("not_found", "Unknown desktop lease task.");
    return row;
  }

  private finish(row: Row) {
    this.db.prepare("UPDATE ardud_desktop_requests SET request_state = 'finished' WHERE seq = ?").run(row.seq);
  }

  private advance(now: number) {
    let holder = this.holder();
    if (holder?.lease_state === "held" && now - holder.heartbeat_at! >= STALE_MS) {
      this.db.prepare("UPDATE ardud_desktop_requests SET lease_state = 'stopping', stopping_at = ? WHERE seq = ?").run(now, holder.seq);
      holder = this.holder();
    }
    if (holder?.lease_state === "stopping" && now - holder.stopping_at! >= QUIET_MS) {
      if (holder.quiescent === 1) {
        this.finish(holder);
        holder = undefined;
      } else {
        this.db.prepare("UPDATE ardud_desktop_requests SET lease_state = 'quarantined' WHERE seq = ?").run(holder.seq);
      }
    }
    // A queued child may have been cancelled or its parent may have crashed.
    // Only its own retry can activate the head, never an unrelated release.
  }

  private snapshot(): LeaseStatus {
    const holder = this.holder();
    const queued = this.db.prepare("SELECT * FROM ardud_desktop_requests WHERE request_state = 'queued' ORDER BY seq").all() as Row[];
    return {
      lease: holder ? leaseOf(holder) : null,
      queue: queued.map((row, index) => ({ ...requestOf(row), enqueuedAt: iso(row.enqueued_at), position: index + 1 })),
    };
  }

  status(): LeaseStatus {
    return this.transaction((now) => {
      this.advance(now);
      return this.snapshot();
    });
  }

  acquire(input: LeaseRequest): { ticket: string; state: "queued" | LeaseState; status: LeaseStatus } {
    for (const key of ["rootThreadId", "childThreadId", "taskId", "scope"] as const) nonempty(input[key], key);
    if (input.mode !== "native" && input.mode !== "cua-driver") {
      throw new DesktopLeaseError("invalid_request", "mode must be native or cua-driver.");
    }
    return this.transaction((now) => {
      this.advance(now);
      let row = this.one("SELECT * FROM ardud_desktop_requests WHERE task_id = ?", input.taskId);
      if (row) {
        const previous = requestOf(row);
        if (Object.keys(previous).some((key) => previous[key as keyof LeaseRequest] !== input[key as keyof LeaseRequest])) {
          return fail("taskId already belongs to a different lease request.");
        }
        if (row.request_state !== "queued" && row.request_state !== "held") return fail("This task's lease is already closed.");
      } else {
        const activeChild = this.one("SELECT * FROM ardud_desktop_requests WHERE child_thread_id = ? AND request_state IN ('queued', 'held')", input.childThreadId);
        if (activeChild) return fail("This child already has a desktop request.");
        const ticket = Crypto.randomUUID();
        this.db.prepare(`INSERT INTO ardud_desktop_requests
          (ticket, root_thread_id, child_thread_id, task_id, scope, mode, request_state, enqueued_at)
          VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`).run(ticket, input.rootThreadId, input.childThreadId, input.taskId, input.scope, input.mode, now);
        this.advance(now);
        row = this.byTicket(ticket);
      }
      if (row.request_state === "queued" && !this.holder()) {
        const head = this.one("SELECT * FROM ardud_desktop_requests WHERE request_state = 'queued' ORDER BY seq LIMIT 1");
        if (head?.seq === row.seq) {
          this.db.prepare(`UPDATE ardud_desktop_requests SET request_state = 'held', lease_state = 'held',
            acquired_at = ?, heartbeat_at = ? WHERE seq = ?`).run(now, now, row.seq);
          row = this.byTicket(row.ticket);
        }
      }
      return { ticket: row.ticket, state: row.request_state === "queued" ? "queued" : row.lease_state!, status: this.snapshot() };
    });
  }

  heartbeat(ticket: string): LeaseStatus {
    return this.transaction((now) => {
      this.advance(now);
      const row = this.byTicket(ticket);
      if (row.request_state !== "held" || row.lease_state !== "held") return fail("Lease is not held; do not start desktop work.");
      this.db.prepare("UPDATE ardud_desktop_requests SET heartbeat_at = ? WHERE seq = ?").run(now, row.seq);
      return this.snapshot();
    });
  }

  /** Stop never revokes a running native operation. It prevents new authorized starts. */
  stop(ticket: string): LeaseStatus {
    return this.transaction((now) => {
      this.advance(now);
      const row = this.byTicket(ticket);
      if (row.request_state === "queued") {
        this.db.prepare("UPDATE ardud_desktop_requests SET request_state = 'cancelled' WHERE seq = ?").run(row.seq);
      } else if (row.request_state === "held" && row.lease_state === "held") {
        this.db.prepare("UPDATE ardud_desktop_requests SET lease_state = 'stopping', stopping_at = ? WHERE seq = ?").run(now, row.seq);
      }
      this.advance(now);
      return this.snapshot();
    });
  }

  /** Called by the delegation lifecycle when a pending or active task is stopped. */
  stopTask(taskId: string): LeaseStatus {
    return this.transaction((now) => {
      this.advance(now);
      const row = this.byTask(taskId);
      if (row.request_state === "queued") {
        this.db.prepare("UPDATE ardud_desktop_requests SET request_state = 'cancelled' WHERE seq = ?").run(row.seq);
      } else if (row.request_state === "held" && row.lease_state === "held") {
        this.db.prepare("UPDATE ardud_desktop_requests SET lease_state = 'stopping', stopping_at = ? WHERE seq = ?").run(now, row.seq);
      }
      return this.snapshot();
    });
  }

  /** A release is only final after an independent quiescence proof. */
  release(ticket: string): LeaseStatus {
    return this.transaction((now) => {
      this.advance(now);
      const row = this.byTicket(ticket);
      if (row.request_state === "queued") {
        this.db.prepare("UPDATE ardud_desktop_requests SET request_state = 'cancelled' WHERE seq = ?").run(row.seq);
      } else if (row.request_state === "held") {
        if (row.quiescent === 1 && row.lease_state !== "held" && now - row.stopping_at! >= QUIET_MS) {
          this.finish(row);
        } else if (row.lease_state === "held") {
          this.db.prepare("UPDATE ardud_desktop_requests SET lease_state = 'stopping', stopping_at = ? WHERE seq = ?").run(now, row.seq);
        }
      }
      this.advance(now);
      return this.snapshot();
    });
  }

  startCall(ticket: string, callId: string): LeaseStatus {
    nonempty(callId, "callId");
    return this.transaction((now) => {
      this.advance(now);
      const row = this.byTicket(ticket);
      if (row.request_state !== "held" || row.lease_state !== "held") return fail("Lease is not held; do not start desktop work.");
      if (this.db.prepare("SELECT 1 FROM ardud_desktop_calls WHERE call_id = ?").get(callId)) return fail("callId was already used; do not replay the call.");
      if (this.db.prepare("SELECT 1 FROM ardud_desktop_calls WHERE ticket = ? AND state = 'started'").get(ticket)) return fail("Another desktop call has not completed.");
      this.db.prepare("INSERT INTO ardud_desktop_calls (call_id, ticket, state, started_at) VALUES (?, ?, 'started', ?)").run(callId, ticket, now);
      return this.snapshot();
    });
  }

  endCall(ticket: string, callId: string, outcome: "completed" | "uncertain"): LeaseStatus {
    nonempty(callId, "callId");
    if (outcome !== "completed" && outcome !== "uncertain") throw new DesktopLeaseError("invalid_request", "Invalid call outcome.");
    return this.transaction((now) => {
      this.advance(now);
      const row = this.byTicket(ticket);
      const call = this.db.prepare("SELECT state FROM ardud_desktop_calls WHERE call_id = ? AND ticket = ?").get(callId, ticket) as { state: string } | undefined;
      if (!call) throw new DesktopLeaseError("not_found", "Unknown desktop call.");
      if (call.state !== "started") {
        if (call.state === outcome) return this.snapshot();
        return fail("Desktop call already has a different outcome.");
      }
      this.db.prepare("UPDATE ardud_desktop_calls SET state = ?, ended_at = ? WHERE call_id = ?").run(outcome, now, callId);
      if (outcome === "uncertain" && row.request_state === "held") {
        this.db.prepare("UPDATE ardud_desktop_requests SET lease_state = 'quarantined', stopping_at = COALESCE(stopping_at, ?), quiescent = 0 WHERE seq = ?").run(now, row.seq);
      }
      return this.snapshot();
    });
  }

  /**
   * Only an in-process supervisor that has independently stopped the controller
   * and verified native-service quiescence may call this. A JS return, timeout,
   * heartbeat, or elapsed quiet period is not that proof. Not exposed to hooks.
   */
  recordVerifiedQuiescence(ticket: string, evidence: string): LeaseStatus {
    nonempty(evidence, "evidence");
    return this.transaction((now) => {
      this.advance(now);
      const row = this.byTicket(ticket);
      if (row.request_state !== "held" || row.lease_state === "held") return fail("Stop the controller before recording quiescence.");
      this.db.prepare("UPDATE ardud_desktop_requests SET quiescent = 1, evidence = ? WHERE seq = ?").run(evidence, row.seq);
      this.advance(now);
      return this.snapshot();
    });
  }

  /** Privileged manual reconciliation is an assertion, not automatic proof. */
  reconcile(ticket: string, evidence: string): LeaseStatus {
    nonempty(evidence, "evidence");
    return this.transaction((now) => {
      this.advance(now);
      const row = this.byTicket(ticket);
      if (row.request_state !== "held" || row.lease_state === "held") return fail("Stop the controller before reconciliation.");
      this.db.prepare("UPDATE ardud_desktop_requests SET evidence = ?, quiescent = 1 WHERE seq = ?").run(evidence, row.seq);
      this.finish(row);
      this.advance(now);
      return this.snapshot();
    });
  }
}
