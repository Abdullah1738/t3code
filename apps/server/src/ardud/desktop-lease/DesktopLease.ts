// @effect-diagnostics nodeBuiltinImport:off - the host-global store is separate from every server home.
// @effect-diagnostics globalDate:off - the clock can be injected in tests.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

export const STALE_MS = 120_000;
export const QUIET_MS = 600_000;
export const QUEUE_POLL_TIMEOUT_MS = 120_000;
export type DesktopMode = "native" | "cua-driver";
export type LeaseState = "held" | "stopping" | "quarantined";
export type RequestState = "queued" | LeaseState | "finished" | "cancelled";
export type CallOutcome = "completed" | "failed";

/** This identity must come from the server's ExecutionIdentity resolver. */
export interface Caller {
  readonly robobThreadId: string;
  readonly rootThreadId: string;
}

export interface LeaseRequest {
  readonly taskId: string;
  readonly scope: string;
  readonly mode: DesktopMode;
}

interface IdentifiedRequest extends LeaseRequest {
  readonly ticket: string;
  readonly rootThreadId: string;
  readonly childThreadId: string;
}

export interface Lease extends IdentifiedRequest {
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly state: LeaseState;
}

export interface QueuedRequest extends IdentifiedRequest {
  readonly enqueuedAt: string;
  readonly position: number;
}

export interface LeaseStatus {
  readonly lease: Lease | null;
  readonly queue: ReadonlyArray<QueuedRequest>;
}

export interface AcquireResult {
  readonly ticket: string;
  readonly state: RequestState;
  readonly position: number | null;
  readonly status: LeaseStatus;
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
  stopping_reason: "stale" | "release" | null;
};

type CallRow = { ticket: string; state: "started" | CallOutcome };

export class DesktopLeaseError extends Error {
  readonly code: "invalid_request" | "conflict" | "not_found";
  constructor(code: "invalid_request" | "conflict" | "not_found", message: string) {
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
const validateCaller = (caller: Caller) => {
  nonempty(caller?.robobThreadId, "robobThreadId");
  nonempty(caller?.rootThreadId, "rootThreadId");
};
const iso = (time: number | null) => new Date(time!).toISOString();
const requestOf = (row: Row): IdentifiedRequest => ({
  ticket: row.ticket,
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
  NodePath.join(NodeOS.userInfo().homedir, ".robob", "desktop-lease", "lease.sqlite");

const requestsTable = `CREATE TABLE IF NOT EXISTS ardud_desktop_requests (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket TEXT NOT NULL UNIQUE,
  root_thread_id TEXT NOT NULL,
  child_thread_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('native', 'cua-driver')),
  request_state TEXT NOT NULL CHECK (request_state IN ('queued', 'held', 'finished', 'cancelled')),
  lease_state TEXT CHECK (lease_state IN ('held', 'stopping', 'quarantined')),
  enqueued_at INTEGER NOT NULL,
  last_polled_at INTEGER,
  acquired_at INTEGER,
  heartbeat_at INTEGER,
  stopping_at INTEGER,
  stopping_reason TEXT CHECK (stopping_reason IN ('stale', 'release')),
  evidence TEXT,
  UNIQUE (root_thread_id, child_thread_id, task_id)
)`;
const callsTable = `CREATE TABLE IF NOT EXISTS ardud_desktop_calls (
  call_id TEXT PRIMARY KEY,
  ticket TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('started', 'completed', 'failed')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER
)`;

/** One host-wide lock, independent of T3 home and project database. */
export class DesktopLease {
  private readonly db: NodeSqlite.DatabaseSync;
  private readonly now: () => number;

  constructor(options: { filename?: string; now?: () => number } = {}) {
    const filename = options.filename ?? defaultDesktopLeasePath();
    if (filename !== ":memory:") {
      const directory = NodePath.dirname(filename);
      NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (options.filename === undefined) {
        NodeFS.chmodSync(directory, 0o700);
      } else if ((NodeFS.statSync(directory).mode & 0o777) !== 0o700) {
        // Do not chmod an arbitrary injected parent such as a shared temp directory.
        throw new Error("Desktop lease directory must be private (0700).");
      }
      const fd = NodeFS.openSync(filename, "a", 0o600);
      try {
        NodeFS.fchmodSync(fd, 0o600);
      } finally {
        NodeFS.closeSync(fd);
      }
    }
    this.now = options.now ?? Date.now;
    this.db = new NodeSqlite.DatabaseSync(filename);
    try {
      // Failure to get the writer is a closed failure, never an uncoordinated grant.
      this.db.exec(`PRAGMA busy_timeout = 1000; PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL; PRAGMA fullfsync = ON;`);
      this.initialize();
      if (filename !== ":memory:") {
        for (const suffix of ["-wal", "-shm"]) {
          try {
            NodeFS.chmodSync(filename + suffix, 0o600);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private initialize() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const requestColumns = this.db.prepare("PRAGMA table_info(ardud_desktop_requests)").all() as {
        name: string;
      }[];
      const oldRequests =
        requestColumns.length > 0 &&
        (requestColumns.some((column) => column.name === "quiescent") ||
          !requestColumns.some((column) => column.name === "stopping_reason"));
      const hasLastPoll = requestColumns.some((column) => column.name === "last_polled_at");
      const calls = this.db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ardud_desktop_calls'",
        )
        .get() as { sql: string } | undefined;
      const oldCalls = calls !== undefined && !calls.sql.includes("'failed'");
      if (oldRequests) {
        this.db.exec(`ALTER TABLE ardud_desktop_requests RENAME TO ardud_desktop_requests_old;
          DROP INDEX IF EXISTS ardud_desktop_one_holder;
          DROP INDEX IF EXISTS ardud_desktop_one_child;`);
      }
      if (oldCalls)
        this.db.exec("ALTER TABLE ardud_desktop_calls RENAME TO ardud_desktop_calls_old");
      this.db.exec(`${requestsTable}; ${callsTable};`);
      if (!oldRequests && requestColumns.length > 0 && !hasLastPoll) {
        this.db.exec("ALTER TABLE ardud_desktop_requests ADD COLUMN last_polled_at INTEGER");
      }
      if (oldRequests) {
        // Earlier stopped leases have no reliable release reason; retain the quiet window.
        this.db.exec(`INSERT INTO ardud_desktop_requests
          (seq, ticket, root_thread_id, child_thread_id, task_id, scope, mode, request_state,
           lease_state, enqueued_at, acquired_at, heartbeat_at, stopping_at, stopping_reason, evidence,
           last_polled_at)
          SELECT seq, ticket, root_thread_id, child_thread_id, task_id, scope, mode, request_state,
           lease_state, enqueued_at, acquired_at, heartbeat_at, stopping_at,
           CASE WHEN lease_state IN ('stopping', 'quarantined') THEN 'stale' ELSE NULL END, evidence,
           ${hasLastPoll ? "last_polled_at" : "NULL"}
          FROM ardud_desktop_requests_old;
          DROP TABLE ardud_desktop_requests_old;`);
      }
      if (oldRequests || (requestColumns.length > 0 && !hasLastPoll)) {
        // Existing waiters get a full poll interval after migration, not from their original enqueue.
        this.db
          .prepare(`UPDATE ardud_desktop_requests SET last_polled_at = ?
          WHERE request_state = 'queued' AND last_polled_at IS NULL`)
          .run(this.now());
      }
      if (oldCalls) {
        this.db.exec(`INSERT INTO ardud_desktop_calls (call_id, ticket, state, started_at, ended_at)
          SELECT call_id, ticket, CASE WHEN state = 'uncertain' THEN 'failed' ELSE state END,
            started_at, ended_at FROM ardud_desktop_calls_old;
          DROP TABLE ardud_desktop_calls_old;`);
      }
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ardud_desktop_one_holder
        ON ardud_desktop_requests(request_state) WHERE request_state = 'held';
        CREATE INDEX IF NOT EXISTS ardud_desktop_open_calls
        ON ardud_desktop_calls(ticket, started_at) WHERE state = 'started';
        COMMIT;`);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  private transaction<T>(f: (now: number) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = f(this.now());
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      // Domain rejections follow any stale transition, but precede their own mutation.
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

  private ownedHolder(caller: Caller, ticket: string) {
    const row = this.byTicket(ticket);
    if (
      row.request_state !== "held" ||
      row.root_thread_id !== caller.rootThreadId ||
      row.child_thread_id !== caller.robobThreadId
    )
      return fail("Only the current lease holder may perform this operation.");
    return row;
  }

  private hasOpenCall(ticket: string) {
    return (
      this.db
        .prepare("SELECT 1 FROM ardud_desktop_calls WHERE ticket = ? AND state = 'started' LIMIT 1")
        .get(ticket) !== undefined
    );
  }

  private finish(row: Row) {
    this.db
      .prepare("UPDATE ardud_desktop_requests SET request_state = 'finished' WHERE seq = ?")
      .run(row.seq);
  }

  private advance(now: number) {
    // A returning caller at the deadline must observe cancellation, not revive its old ticket.
    this.db
      .prepare(`UPDATE ardud_desktop_requests SET request_state = 'cancelled'
      WHERE request_state = 'queued' AND last_polled_at <= ?`)
      .run(now - QUEUE_POLL_TIMEOUT_MS);
    let holder = this.holder();
    if (!holder || holder.lease_state === "quarantined") return;
    if (holder.lease_state === "held" && now - holder.heartbeat_at! >= STALE_MS) {
      this.db
        .prepare(`UPDATE ardud_desktop_requests
        SET lease_state = 'stopping', stopping_at = ?, stopping_reason = 'stale' WHERE seq = ?`)
        .run(now, holder.seq);
      holder = this.holder()!;
    }
    // On-demand checks enforce the age limit even while a caller heartbeats.
    const expiredCall = this.db
      .prepare(`SELECT 1 FROM ardud_desktop_calls
      WHERE ticket = ? AND state = 'started' AND started_at <= ? LIMIT 1`)
      .get(holder.ticket, now - QUIET_MS);
    if (expiredCall) {
      this.db
        .prepare("UPDATE ardud_desktop_requests SET lease_state = 'quarantined' WHERE seq = ?")
        .run(holder.seq);
      return;
    }
    if (holder.lease_state === "stopping" && !this.hasOpenCall(holder.ticket)) {
      if (holder.stopping_reason === "release" || now - holder.stopping_at! >= QUIET_MS) {
        this.finish(holder);
      }
    }
  }

  private snapshot(): LeaseStatus {
    const holder = this.holder();
    const queued = this.db
      .prepare("SELECT * FROM ardud_desktop_requests WHERE request_state = 'queued' ORDER BY seq")
      .all() as Row[];
    return {
      lease: holder ? leaseOf(holder) : null,
      queue: queued.map((row, index) => ({
        ...requestOf(row),
        enqueuedAt: iso(row.enqueued_at),
        position: index + 1,
      })),
    };
  }

  status(): LeaseStatus {
    return this.transaction((now) => {
      this.advance(now);
      return this.snapshot();
    });
  }

  acquire(caller: Caller, input: LeaseRequest): AcquireResult {
    validateCaller(caller);
    nonempty(input?.taskId, "taskId");
    nonempty(input?.scope, "scope");
    if (input.mode !== "native" && input.mode !== "cua-driver") {
      throw new DesktopLeaseError("invalid_request", "mode must be native or cua-driver.");
    }
    return this.transaction((now) => {
      this.advance(now);
      let row = this.one(
        `SELECT * FROM ardud_desktop_requests
        WHERE root_thread_id = ? AND child_thread_id = ? AND task_id = ?`,
        caller.rootThreadId,
        caller.robobThreadId,
        input.taskId,
      );
      if (row) {
        // Terminal retries are observable but must not create an obsolete queue entry.
        if (row.scope !== input.scope || row.mode !== input.mode) {
          return fail("This caller and taskId already have a different lease request.");
        }
        if (row.request_state === "queued") {
          this.db
            .prepare(`UPDATE ardud_desktop_requests SET last_polled_at = MAX(COALESCE(last_polled_at, ?), ?)
            WHERE seq = ?`)
            .run(now, now, row.seq);
        }
      } else {
        const ticket = NodeCrypto.randomUUID();
        this.db
          .prepare(`INSERT INTO ardud_desktop_requests
          (ticket, root_thread_id, child_thread_id, task_id, scope, mode, request_state, enqueued_at, last_polled_at)
          VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`)
          .run(
            ticket,
            caller.rootThreadId,
            caller.robobThreadId,
            input.taskId,
            input.scope,
            input.mode,
            now,
            now,
          );
        row = this.byTicket(ticket);
      }
      if (row.request_state === "queued" && !this.holder()) {
        const head = this.one(
          "SELECT * FROM ardud_desktop_requests WHERE request_state = 'queued' ORDER BY seq LIMIT 1",
        );
        if (head?.seq === row.seq) {
          this.db
            .prepare(`UPDATE ardud_desktop_requests SET request_state = 'held', lease_state = 'held',
            acquired_at = ?, heartbeat_at = ? WHERE seq = ?`)
            .run(now, now, row.seq);
          row = this.byTicket(row.ticket);
        }
      }
      const status = this.snapshot();
      return {
        ticket: row.ticket,
        state: row.request_state === "held" ? row.lease_state! : row.request_state,
        position: status.queue.find((request) => request.ticket === row.ticket)?.position ?? null,
        status,
      };
    });
  }

  heartbeat(caller: Caller, ticket: string): LeaseStatus {
    validateCaller(caller);
    return this.transaction((now) => {
      this.advance(now);
      const row = this.ownedHolder(caller, ticket);
      if (row.lease_state !== "held") return fail("Lease is not held; do not start desktop work.");
      this.db
        .prepare("UPDATE ardud_desktop_requests SET heartbeat_at = ? WHERE seq = ?")
        .run(now, row.seq);
      return this.snapshot();
    });
  }

  release(caller: Caller, ticket: string): LeaseStatus {
    validateCaller(caller);
    return this.transaction((now) => {
      this.advance(now);
      const row = this.ownedHolder(caller, ticket);
      if (row.lease_state === "held") {
        if (this.hasOpenCall(ticket)) {
          this.db
            .prepare(`UPDATE ardud_desktop_requests SET lease_state = 'stopping',
            stopping_at = ?, stopping_reason = 'release' WHERE seq = ?`)
            .run(now, row.seq);
        } else {
          this.finish(row);
        }
      }
      // A stale or quarantined lease cannot be accelerated by a manual release.
      return this.snapshot();
    });
  }

  callStart(caller: Caller, toolUseId: string): LeaseStatus {
    validateCaller(caller);
    nonempty(toolUseId, "toolUseId");
    return this.transaction((now) => {
      this.advance(now);
      const row = this.holder();
      if (
        !row ||
        row.lease_state !== "held" ||
        row.root_thread_id !== caller.rootThreadId ||
        row.child_thread_id !== caller.robobThreadId
      )
        return fail("Only the current lease holder may start desktop work.");
      if (this.db.prepare("SELECT 1 FROM ardud_desktop_calls WHERE call_id = ?").get(toolUseId)) {
        return fail("toolUseId was already used; do not replay the call.");
      }
      this.db
        .prepare(
          "INSERT INTO ardud_desktop_calls (call_id, ticket, state, started_at) VALUES (?, ?, 'started', ?)",
        )
        .run(toolUseId, row.ticket, now);
      return this.snapshot();
    });
  }

  callEnd(toolUseId: string, outcome: CallOutcome): LeaseStatus {
    nonempty(toolUseId, "toolUseId");
    if (outcome !== "completed" && outcome !== "failed") {
      throw new DesktopLeaseError("invalid_request", "Invalid call outcome.");
    }
    return this.transaction((now) => {
      const call = this.db
        .prepare("SELECT ticket, state FROM ardud_desktop_calls WHERE call_id = ?")
        .get(toolUseId) as CallRow | undefined;
      if (!call) throw new DesktopLeaseError("not_found", "Unknown desktop call.");
      if (call.state !== "started") {
        if (call.state === outcome) return this.snapshot();
        return fail("Desktop call already has a different outcome.");
      }
      // A delayed completion may close its own row, never advance a newer holder.
      const isCurrent = this.holder()?.ticket === call.ticket;
      if (isCurrent) this.advance(now);
      this.db
        .prepare("UPDATE ardud_desktop_calls SET state = ?, ended_at = ? WHERE call_id = ?")
        .run(outcome, now, toolUseId);
      if (isCurrent && this.holder()?.ticket === call.ticket) this.advance(now);
      return this.snapshot();
    });
  }

  /** Caller authorization for maintenance is enforced by the service transport. */
  reconcile(ticket: string, evidence: string): LeaseStatus {
    nonempty(evidence, "evidence");
    return this.transaction((now) => {
      this.advance(now);
      const row = this.byTicket(ticket);
      if (row.request_state !== "held" || row.lease_state !== "quarantined") {
        return fail("Only a quarantined lease may be reconciled.");
      }
      this.db
        .prepare("UPDATE ardud_desktop_requests SET evidence = ? WHERE seq = ?")
        .run(evidence, row.seq);
      this.finish(row);
      return this.snapshot();
    });
  }
}
