// @effect-diagnostics nodeBuiltinImport:off globalDate:off - serialized worker has no Effect runtime; these are its native boundary types and clock.
import type * as NodeSqlite from "node:sqlite";
import type * as NodeFS from "node:fs";
import type * as NodePath from "node:path";
import { resolveHistoryBasePath } from "./historySourceFiles.ts";

export interface ReadonlyReplicaOptions {
  readonly sourcePath: string;
  readonly replicaPath: string;
  readonly boardPath?: string;
  readonly archivePath?: string;
  readonly batchSize?: number;
  /** A second automatic rebuild for the same reason waits this long (default 6 h). */
  readonly rebuildBackoffMs?: number;
  /** While a rebuild is held back, the failure is reported this often (default 1 h). */
  readonly rebuildNoticeMs?: number;
  readonly onRebuildEvent?: (event: ReadonlyRebuildEvent) => void;
  readonly onDiagnosticEvent?: (event: ReadonlyExportDiagnosticEvent) => void;
}

export type ReadonlyExportDiagnosticEvent =
  | {
      readonly event: "open";
      readonly sequence: number;
      readonly identitySequence: number;
      readonly sourceSequence: number;
    }
  | { readonly event: "replay"; readonly replayEvents: number; readonly replayMs: number };

export interface ReadonlyRebuildEvent {
  readonly event: "start" | "progress" | "publish" | "abort";
  readonly kind: "additive" | "full" | "events_reset";
  readonly reason: string;
  readonly generation: number;
  readonly table: string;
  readonly rows: number;
  readonly pages: number;
  readonly elapsedMs: number;
  readonly bytes?: number;
  readonly sequence?: number;
  readonly identitySequence?: number;
  readonly error?: string;
  readonly cursor?: number;
  readonly cycleTarget?: number;
  readonly firstMissingSequence?: number;
  readonly rowsReturned?: number;
  readonly rowsDone?: number;
  readonly publishedReady?: string;
  readonly readyReason?: string;
}

export interface LineageRepairBump {
  readonly revision: number;
  readonly cause:
    | "fast_lane_insert"
    | "fast_lane_update"
    | "reconcile_change"
    | "reconcile_delete"
    | "reset";
  readonly table: string;
  readonly ids: number;
}

export interface ReadonlyExportMetrics {
  readonly lineageRepairCounts: Record<string, number>;
  readonly lineageRepairs: LineageRepairBump[];
  readonly phaseMs: Record<string, number>;
  readonly phaseSteps: Record<string, number>;
  readonly identityRows: number;
  readonly identityLagMaxMs: number;
}

/** Self-contained for the packaged server's eval worker. No live write handle. */
export function createReadonlyReplica(
  sqlite: typeof NodeSqlite,
  fs: typeof NodeFS,
  path: typeof NodePath,
  options: ReadonlyReplicaOptions,
  resolveBasePath = resolveHistoryBasePath,
) {
  const emptyMetrics = (): ReadonlyExportMetrics => ({
    lineageRepairCounts: {
      fast_lane_insert: 0,
      fast_lane_update: 0,
      reconcile_change: 0,
      reconcile_delete: 0,
      reset: 0,
    },
    lineageRepairs: [],
    phaseMs: {},
    phaseSteps: {},
    identityRows: 0,
    identityLagMaxMs: 0,
  });
  let metrics = emptyMetrics();
  const measure = <A>(phase: string, body: () => A): A => {
    const started = Date.now();
    try {
      return body();
    } finally {
      metrics.phaseMs[phase] = (metrics.phaseMs[phase] ?? 0) + Date.now() - started;
      metrics.phaseSteps[phase] = (metrics.phaseSteps[phase] ?? 0) + 1;
    }
  };
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 100, 500));
  const rebuildBackoffMs = options.rebuildBackoffMs ?? 6 * 60 * 60 * 1000;
  const rebuildNoticeMs = options.rebuildNoticeMs ?? 60 * 60 * 1000;
  // Pages a publish may drain inside one pinned source snapshot. Doubles after
  // each miss so a busy source cannot keep a cycle open (see publishStep).
  const drainPagesInitial = 20;
  const drainPagesMax = 640;
  if (!Number.isInteger(batchSize))
    throw new Error("Readonly export batch size must be an integer");
  const replicaName = path.resolve(options.replicaPath);
  if (
    path.basename(replicaName) === "statev2.sqlite" ||
    path.basename(replicaName) === "opencode.db" ||
    options.replicaPath.startsWith("file:")
  ) {
    throw new Error("Readonly export destination must not name a live database");
  }
  const q = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const projections = [
    "orchestration_v2_projection_threads",
    "orchestration_v2_projection_runs",
    "orchestration_v2_projection_run_attempts",
    "orchestration_v2_projection_provider_threads",
    "orchestration_v2_projection_provider_turns",
    "orchestration_v2_projection_subagents",
    "orchestration_v2_projection_messages",
    "orchestration_v2_projection_turn_items",
  ];
  const auxiliary = [
    "scheduled_tasks",
    "ardud_opencode_import",
    "ardud_kanban_cards",
    "ardud_kanban_threads",
    "ardud_kanban_slot_events",
  ];
  const selectedItems = new Set(["user_message", "error", "run_interrupt_request"]);
  const origin = (
    error: unknown,
    file: string,
    role: "primary" | "replica",
    operation: string,
  ): never => {
    if (typeof error === "object" && error !== null)
      Object.assign(error, { sqliteFile: file, sqliteRole: role, sqliteOperation: operation });
    throw error;
  };
  const protect = <T extends object>(target: T, file: string, role: "primary" | "replica"): T =>
    new Proxy(target, {
      get(object, key) {
        const value: unknown = Reflect.get(object, key, object);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          try {
            const result: unknown = Reflect.apply(value, object, args);
            return key === "prepare" && typeof result === "object" && result !== null
              ? protect(result, file, role)
              : result;
          } catch (error) {
            return origin(error, file, role, String(key));
          }
        };
      },
    });
  const open = (
    file: string,
    settings: NodeSqlite.DatabaseSyncOptions,
    role: "primary" | "replica",
  ) => {
    try {
      return protect(new sqlite.DatabaseSync(file, settings), file, role);
    } catch (error) {
      return origin(error, file, role, "open");
    }
  };
  const source = open(options.sourcePath, { readOnly: true }, "primary");
  let boards: NodeSqlite.DatabaseSync | undefined;
  let archive: NodeSqlite.DatabaseSync | undefined;
  let baseArchive: NodeSqlite.DatabaseSync | undefined;
  let boardsReady = false;
  let target: NodeSqlite.DatabaseSync | undefined;
  /** Best effort: the failure stays readable in meta after the worker exits. */
  let recordFailure = (_error: unknown) => {};
  try {
    const setupReader = (db: NodeSqlite.DatabaseSync, requireWal = true) => {
      db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=0; PRAGMA cache_size=-8192;");
      if (requireWal && db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal")
        throw new Error("Readonly export requires a WAL source");
    };
    setupReader(source);
    const assertRedactionComplete = () => {
      if (
        source
          .prepare("SELECT 1 FROM sqlite_schema WHERE name='ardud_thread_redaction_recovery'")
          .get() &&
        source
          .prepare("SELECT 1 FROM ardud_thread_redaction_recovery WHERE pending=1 LIMIT 1")
          .get()
      ) {
        const error = new Error("Readonly export is paused for incomplete redaction maintenance.");
        Object.assign(error, { code: "REDACTION_PENDING" });
        throw error;
      }
    };
    assertRedactionComplete();
    const readBasePath = () => {
      if (
        !source.prepare("SELECT 1 FROM sqlite_schema WHERE name='ardud_history_base_archive'").get()
      )
        return undefined;
      return resolveBasePath(
        path,
        options.sourcePath,
        source
          .prepare("SELECT filename FROM ardud_history_base_archive LIMIT 2")
          .all()
          .map((row) => ({ filename: row.filename })),
      );
    };
    const basePath = readBasePath();
    if (basePath) {
      if (!fs.existsSync(basePath)) throw new Error("Readonly history base unavailable");
      baseArchive = open(basePath, { readOnly: true }, "primary");
      // The offline installer checkpoints the original before preserving it;
      // this immutable base need not retain WAL journal mode or sidecars.
      setupReader(baseArchive, false);
      if (
        !baseArchive
          .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='orchestration_events'")
          .get()
      )
        throw new Error("Readonly history base events unavailable");
    }
    if (options.archivePath && fs.existsSync(options.archivePath)) {
      archive = open(options.archivePath, { readOnly: true }, "primary");
      setupReader(archive);
      const mainIdentity = source
        .prepare("SELECT identity FROM ardud_history_archive_identity")
        .get()?.identity;
      const archiveIdentity = archive
        .prepare("SELECT identity FROM ardud_identity")
        .get()?.identity;
      if (!mainIdentity || mainIdentity !== archiveIdentity)
        throw new Error("Readonly archive identity does not match source");
    }
    if (options.boardPath && fs.existsSync(options.boardPath)) {
      boards = open(options.boardPath, { readOnly: true }, "primary");
      setupReader(boards);
      if (boards.prepare("SELECT 1 FROM sqlite_schema WHERE name='ardud_boards_migration'").get()) {
        boardsReady =
          boards.prepare("SELECT completed FROM ardud_boards_migration WHERE table_name='*'").get()
            ?.completed === 1;
      }
    }
    fs.mkdirSync(path.dirname(options.replicaPath), { recursive: true, mode: 0o700 });
    for (const candidate of [
      options.sourcePath,
      options.boardPath,
      options.archivePath,
      basePath,
    ].filter((p): p is string => Boolean(p))) {
      if (!fs.existsSync(options.replicaPath) || !fs.existsSync(candidate)) continue;
      const a = fs.statSync(candidate),
        b = fs.statSync(options.replicaPath);
      if (a.dev === b.dev && a.ino === b.ino)
        throw new Error("Replica cannot be a source database");
    }
    target = open(options.replicaPath, {}, "replica");
    fs.chmodSync(options.replicaPath, 0o600);
    // Export bookkeeping; a rebuild drops and recreates all of it except meta.
    const bookkeeping = `CREATE TABLE IF NOT EXISTS ardud_readonly_progress (name TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS orchestration_events (
        sequence INTEGER PRIMARY KEY, event_type TEXT NOT NULL, stream_id TEXT, payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ardud_readonly_seen (name TEXT NOT NULL, id TEXT NOT NULL, generation INTEGER NOT NULL, PRIMARY KEY(name,id));
      CREATE INDEX IF NOT EXISTS ardud_readonly_seen_generation ON ardud_readonly_seen(name,generation);
      CREATE TABLE IF NOT EXISTS ardud_readonly_dirty_items (thread_id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, item_id TEXT NOT NULL, target_cursor INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ardud_readonly_item_fences (item_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL);`;
    target.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=0;
      PRAGMA journal_size_limit=33554432; PRAGMA cache_size=-8192;
      CREATE TABLE IF NOT EXISTS ardud_readonly_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      ${bookkeeping}
      CREATE TABLE IF NOT EXISTS ardud_readonly_lineage_touches (
        revision INTEGER PRIMARY KEY, table_name TEXT NOT NULL, id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('insert','update')), at TEXT NOT NULL
      );`);
    const out = target;
    const replicaStat = fs.statSync(replicaName);
    const meta = (key: string, value: string) =>
      out
        .prepare(
          "INSERT INTO ardud_readonly_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(key, value);
    recordFailure = (error) => {
      try {
        meta("last_error", String((error as Error)?.message ?? error).slice(0, 1000));
        meta("last_error_at", new Date().toISOString());
      } catch {
        // The replica itself may be what failed.
      }
    };
    const getMeta = (key: string) =>
      out.prepare("SELECT value FROM ardud_readonly_meta WHERE key=?").get(key)?.value as
        | string
        | undefined;
    if (getMeta("lineage_touch_revision") === undefined) meta("lineage_touch_revision", "0");
    if (getMeta("lineage_touch_min_revision") === undefined)
      meta("lineage_touch_min_revision", "0");
    const insertTouch = out.prepare(
      "INSERT INTO ardud_readonly_lineage_touches VALUES (?,?,?,?,?)",
    );
    const touchIdentity = (
      name: string,
      id: NodeSqlite.SQLInputValue,
      kind: "insert" | "update",
    ) => {
      const revision = Number(getMeta("lineage_touch_revision")) + 1;
      insertTouch.run(revision, name, id, kind, new Date(Date.now()).toISOString());
      meta("lineage_touch_revision", String(revision));
    };
    const pruneTouches = () => {
      // Keep 20k touches so slow readers can overlay without unbounded replica growth.
      const through = Math.max(0, Number(getMeta("lineage_touch_revision")) - 20_000);
      out.prepare("DELETE FROM ardud_readonly_lineage_touches WHERE revision<=?").run(through);
      const oldest = out
        .prepare("SELECT min(revision) AS n FROM ardud_readonly_lineage_touches")
        .get()?.n;
      meta("lineage_touch_min_revision", String(oldest ?? 0));
    };
    const nextGeneration = () => {
      // Seen/prune epochs are not published generations. A bootstrap may page
      // many tables or resume several times before publishing once.
      const n = Number(getMeta("scan_generation") ?? getMeta("generation") ?? 0) + 1;
      meta("scan_generation", String(n));
      return n;
    };
    const hasCompactedEvents = () =>
      Boolean(
        source
          .prepare("SELECT 1 FROM sqlite_schema WHERE name='ardud_history_compacted_events'")
          .get(),
      );
    const sequence = () =>
      Math.max(
        Number(source.prepare("SELECT max(sequence) AS n FROM orchestration_events").get()?.n ?? 0),
        hasCompactedEvents()
          ? Number(
              source.prepare("SELECT max(sequence) AS n FROM ardud_history_compacted_events").get()
                ?.n ?? 0,
            )
          : 0,
        Number(archive?.prepare("SELECT max(sequence) AS n FROM ardud_events").get()?.n ?? 0),
        Number(
          baseArchive?.prepare("SELECT max(sequence) AS n FROM orchestration_events").get()?.n ?? 0,
        ),
      );
    const checkpoint = (name: string, value: object) =>
      out
        .prepare(
          "INSERT INTO ardud_readonly_progress VALUES (?,?) ON CONFLICT(name) DO UPDATE SET json=excluded.json",
        )
        .run(name, JSON.stringify(value));
    const progress = (
      name: string,
    ): {
      cursor: number;
      done: boolean;
      pruning?: boolean;
      pruneCursor?: number;
      generation?: number;
    } =>
      JSON.parse(
        String(
          out.prepare("SELECT json FROM ardud_readonly_progress WHERE name=?").get(name)?.json ??
            '{"cursor":0,"done":false}',
        ),
      );
    // Auxiliary pages are staged privately before the atomic publication transaction.
    // WAL readers keep the previous completed generation (ready=1, old
    // updated_at) until it commits, so readiness is not cleared per cycle.
    let pendingRepairs: LineageRepairBump[] = [];
    const flushRepairs = () => {
      for (const bump of pendingRepairs) {
        metrics.lineageRepairCounts[bump.cause] =
          (metrics.lineageRepairCounts[bump.cause] ?? 0) + 1;
        metrics.lineageRepairs.push(bump);
      }
      pendingRepairs = [];
    };
    const bumpRepair = (causes: ReadonlyArray<Omit<LineageRepairBump, "revision">>) => {
      const revision = Number(getMeta("lineage_repair_revision") ?? 0) + 1;
      meta("lineage_repair_revision", String(revision));
      pendingRepairs.push(...causes.map((cause) => ({ ...cause, revision })));
    };
    let cycleTransaction = false;
    let cycleSession: NodeSqlite.Session | undefined;
    const beginCycle = (trackChanges = true) => {
      // Parent and child rows can change in either copy order. Every
      // publication must satisfy its foreign keys at the atomic commit.
      out.exec("BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON");
      cycleTransaction = true;
      if (trackChanges) cycleSession = out.createSession();
    };
    const commitCycle = () => {
      cycleSession?.close();
      cycleSession = undefined;
      out.exec("COMMIT");
      cycleTransaction = false;
      flushRepairs();
    };
    let invalidated: string | undefined;
    const transaction = <A>(body: () => A) => {
      const pendingCount = pendingRepairs.length;
      if (cycleTransaction) {
        out.exec("SAVEPOINT readonly_page");
        try {
          const result = body();
          out.exec("RELEASE readonly_page");
          return result;
        } catch (error) {
          try {
            out.exec("ROLLBACK TO readonly_page");
            out.exec("RELEASE readonly_page");
          } catch {
            // The cycle transaction itself is gone; step() discards the cycle.
          }
          pendingRepairs.length = pendingCount;
          throw error;
        }
      }
      out.exec("BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON");
      try {
        const result = body();
        out.exec("COMMIT");
        flushRepairs();
        return result;
      } catch (error) {
        out.exec("ROLLBACK");
        pendingRepairs.length = pendingCount;
        throw error;
      }
    };
    const abortCycle = () => {
      if (!cycleTransaction) return false;
      cycleSession?.close();
      cycleSession = undefined;
      cycleTransaction = false;
      pendingRepairs = [];
      try {
        out.exec("ROLLBACK");
      } catch {
        // SQLite may already have rolled the transaction back after an I/O error.
      }
      return true;
    };
    /** Structural changes discard unpublished work; a completed generation survives. */
    const invalidate = (message: string, keepPublished = false) => {
      invalidated = message;
      abortCycle();
      if (!keepPublished || getMeta("ready") !== "1") meta("ready", "0");
      return new Error(message);
    };
    // Path and inode only. st_dev is not stable: an external volume gets a new
    // device number on every remount or reboot, and the 9 Nov SSD remount left
    // the old dev-based identity failing every open, forever (ready=0, stale).
    const sourceStat = fs.statSync(options.sourcePath);
    const sourceRealPath = fs.realpathSync(options.sourcePath);
    const identity = `${sourceRealPath}#${sourceStat.ino}`;
    const sameSource = (stored: string) => {
      if (stored === identity) return true;
      // Before 2026-11-10 the identity was `${realpath}:${dev}:${ino}`.
      const legacy = /^(.*):\d+:(\d+)$/.exec(stored);
      return (
        legacy !== null && legacy[1] === sourceRealPath && legacy[2] === String(sourceStat.ino)
      );
    };
    const sourceTables = [...projections, ...auxiliary].map((name) => {
      const db =
        boards &&
        boardsReady &&
        auxiliary.includes(name) &&
        boards.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name)
          ? boards
          : source;
      const schema = db
        .prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?")
        .get(name)?.sql;
      if (typeof schema !== "string")
        throw invalidate(`Readonly export source table missing: ${name}`);
      return { name, db, schema };
    });
    const copyIndexes = (name: string, db: NodeSqlite.DatabaseSync) => {
      // These indexes touch the exported copy only; no live schema changes.
      for (const row of db
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name=? AND sql IS NOT NULL",
        )
        .all(name)) {
        out.exec(
          String(row.sql).replace(
            /^CREATE (UNIQUE )?INDEX\s+(?:IF NOT EXISTS\s+)?/i,
            "CREATE $1INDEX IF NOT EXISTS ",
          ),
        );
      }
    };
    const exportIndexPrefix = "ardud_readonly_";
    const ensureExportIndexes = () => {
      // Match the discovery predicates in integrations/stream-recovery/lib/io.mjs exactly.
      const definitions = [
        ["items_thread", "turn_items", ["thread_id"], [], ""],
        [
          "runs_restart_completed",
          "runs",
          ["completed_at"],
          ["status"],
          "status IN ('cancelled','failed','interrupted')",
        ],
        ["runs_failed_completed", "runs", ["completed_at"], ["status"], "status='failed'"],
        [
          "subagents_cancelled_completed",
          "subagents",
          ["origin", "completed_at"],
          ["status"],
          "status IN ('cancelled','interrupted')",
        ],
        [
          "subagents_failed_completed",
          "subagents",
          ["completed_at"],
          ["status"],
          "status='failed'",
        ],
        ["items_run_interrupt", "turn_items", ["run_id"], ["type"], "type='run_interrupt_request'"],
        ["items_run_user_message", "turn_items", ["run_id"], ["type"], "type='user_message'"],
        ["items_run_error", "turn_items", ["run_id"], ["type"], "type='error'"],
      ] as const;
      const columns = new Map<string, Set<string>>();
      for (const [suffix, projection, indexed, predicateColumns, predicate] of definitions) {
        const table = `orchestration_v2_projection_${projection}`;
        const available =
          columns.get(table) ??
          new Set(
            out
              .prepare(`PRAGMA table_info(${q(table)})`)
              .all()
              .map((row) => String(row.name)),
          );
        columns.set(table, available);
        // Older source schemas may not expose completion or run identity columns yet.
        if (![...indexed, ...predicateColumns].every((column) => available.has(column))) continue;
        out.exec(
          `CREATE INDEX IF NOT EXISTS ${q(exportIndexPrefix + suffix)} ON ${q(table)}(${indexed.map(q).join(",")})${predicate ? ` WHERE ${predicate}` : ""}`,
        );
      }
    };
    const createExportedTable = ({ schema }: (typeof sourceTables)[number]) => {
      out.exec(
        schema.replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?/i, "CREATE TABLE IF NOT EXISTS "),
      );
    };
    const ensureIdentityVersions = () => {
      const covered = [
        ["orchestration_v2_projection_threads", "thread_id", "threads"],
        ["orchestration_v2_projection_provider_threads", "provider_thread_id", "providers"],
        ["orchestration_v2_projection_provider_turns", "provider_turn_id", "turns"],
        ["orchestration_v2_projection_subagents", "subagent_id", "subagents"],
        ["ardud_opencode_import", "native_session_id", "imports"],
      ] as const;
      const installed = out
        .prepare(
          "SELECT type,name,tbl_name FROM sqlite_schema WHERE name LIKE 'ardud_identity_%' OR name='ardud_readonly_identity_versions'",
        )
        .all();
      const certified =
        getMeta("identity_versions_schema") === "1" &&
        installed.some(
          (row) => row.type === "table" && row.name === "ardud_readonly_identity_versions",
        );
      const repair = covered.filter(
        ([name, , suffix]) =>
          !certified ||
          ["insert", "update", "delete"].some(
            (action) =>
              !installed.some(
                (row) =>
                  row.type === "trigger" &&
                  row.tbl_name === name &&
                  row.name === `ardud_identity_${suffix}_${action}`,
              ),
          ),
      );
      if (!repair.length) return;
      const install = () => {
        out.exec(`CREATE TABLE IF NOT EXISTS ardud_readonly_identity_versions (
          version INTEGER PRIMARY KEY AUTOINCREMENT,
          table_name TEXT NOT NULL,
          row_id TEXT NOT NULL,
          UNIQUE(table_name,row_id)
        )`);
        for (const [name, primary, suffix] of repair) {
          for (const action of ["insert", "update", "delete"]) {
            const trigger = q(`ardud_identity_${suffix}_${action}`);
            out.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
            const keys =
              action === "update"
                ? `IN (OLD.${q(primary)},NEW.${q(primary)})`
                : `=${action === "delete" ? "OLD" : "NEW"}.${q(primary)}`;
            out.exec(`CREATE TRIGGER ${trigger} AFTER ${action.toUpperCase()} ON ${q(name)} FOR EACH ROW BEGIN
              DELETE FROM ardud_readonly_identity_versions WHERE table_name='${name}' AND row_id ${keys};
              ${action === "delete" ? "" : `INSERT INTO ardud_readonly_identity_versions(table_name,row_id) VALUES ('${name}',NEW.${q(primary)});`}
            END`);
          }
          // A recreated table may reuse keys; retain the sequence but replace its census.
          out.prepare("DELETE FROM ardud_readonly_identity_versions WHERE table_name=?").run(name);
          out.exec(
            `INSERT INTO ardud_readonly_identity_versions(table_name,row_id) SELECT '${name}',${q(primary)} FROM ${q(name)}`,
          );
        }
        meta("identity_versions_schema", "1");
      };
      // Bootstrap/reset publications can own a transaction without a cycle session.
      if (out.isTransaction) install();
      else transaction(install);
    };
    const pendingAuxiliarySchemas = new Map<string, (typeof sourceTables)[number]>();
    const refreshAuxiliarySchemas = (changed: typeof sourceTables) => {
      // Schema, indexes, rows and markers switch inside the publication transaction.
      for (const { name } of changed) out.exec(`DROP TABLE IF EXISTS ${q(name)}`);
      for (const table of changed) createExportedTable(table);
      for (const { name, db, schema } of changed) {
        copyIndexes(name, db);
        meta(`schema:${name}`, schema);
      }
      ensureIdentityVersions();
      ensureExportIndexes();
      meta(
        "last_aux_schema_refresh",
        JSON.stringify({ tables: changed.map(({ name }) => name), at: new Date().toISOString() }),
      );
    };
    // Compare complete column clauses, including constraints and quoted defaults.
    // Splitting only at top-level commas keeps CHECK/default expressions intact.
    const schemaParts = (sql: string) => {
      const begin = sql.indexOf("(");
      let depth = 0,
        quote = "",
        part = begin + 1;
      const clauses: string[] = [];
      for (let i = begin; i < sql.length; i++) {
        const c = sql[i]!;
        if (quote) {
          if (c === quote) {
            if (sql[i + 1] === quote) i++;
            else quote = "";
          }
        } else if (c === "'" || c === '"' || c === "`" || c === "[") {
          quote = c === "[" ? "]" : c;
        } else if (c === "(") depth++;
        else if (c === ")") {
          if (--depth === 0) {
            clauses.push(sql.slice(part, i).trim());
            return { clauses, suffix: sql.slice(i + 1).trim() };
          }
        } else if (c === "," && depth === 1) {
          clauses.push(sql.slice(part, i).trim());
          part = i + 1;
        }
      }
      throw new Error("Unsupported export schema");
    };
    const changedTables = sourceTables.filter(({ name, schema }) => {
      const previous = getMeta(`schema:${name}`);
      return previous !== undefined && previous !== schema;
    });
    const restrictiveIndexesChanged = (
      left: NodeSqlite.DatabaseSync,
      right: NodeSqlite.DatabaseSync,
      name: string,
    ) =>
      left
        .prepare(`PRAGMA index_list(${q(name)})`)
        .all()
        .some((index) => {
          if (String(index.name).startsWith(exportIndexPrefix)) return false;
          const needsCompleteRows =
            Number(index.unique) === 1 ||
            Number(index.partial) === 1 ||
            left
              .prepare(`PRAGMA index_xinfo(${q(String(index.name))})`)
              .all()
              .some((column) => Number(column.cid) === -2);
          if (!needsCompleteRows) return false;
          const previous = left
            .prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?")
            .get(index.name!);
          const current = right
            .prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?")
            .get(index.name!);
          return !current || previous?.sql !== current.sql;
        });
    // Index DDL does not change CREATE TABLE text, including when a later
    // migration arrives while a persisted column backfill is unfinished.
    const changedIndexes = new Set(
      sourceTables
        .filter(
          ({ name, db }) =>
            getMeta(`schema:${name}`) !== undefined &&
            (restrictiveIndexesChanged(db, out, name) || restrictiveIndexesChanged(out, db, name)),
        )
        .map(({ name }) => name),
    );
    const additions = new Map<string, { clauses: string[]; columns: string[] }>();
    for (const { name, db, schema } of changedTables) {
      if (!projections.includes(name)) continue;
      const before = schemaParts(getMeta(`schema:${name}`)!);
      const after = schemaParts(schema);
      const remaining = [...after.clauses];
      for (const clause of before.clauses) {
        const at = remaining.indexOf(clause);
        if (at < 0) break;
        remaining.splice(at, 1);
      }
      const oldInfo = out.prepare(`PRAGMA table_xinfo(${q(name)})`).all();
      const newInfo = db.prepare(`PRAGMA table_xinfo(${q(name)})`).all();
      if (
        // These indexes need a complete generation: defaults can collide or
        // fail an expression on rows awaiting an atomic update/deletion.
        changedIndexes.has(name) ||
        JSON.stringify(db.prepare(`PRAGMA foreign_key_list(${q(name)})`).all()) !==
          JSON.stringify(out.prepare(`PRAGMA foreign_key_list(${q(name)})`).all()) ||
        // A CHECK can depend on older columns that intentionally stay at the
        // published snapshot during a column-only backfill.
        remaining.some((clause) =>
          /\bCHECK\b/i.test(clause.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, "")),
        ) ||
        before.suffix !== after.suffix ||
        after.clauses.length - remaining.length !== before.clauses.length ||
        newInfo.length <= oldInfo.length ||
        remaining.length !== newInfo.length - oldInfo.length ||
        oldInfo.some((row, i) => JSON.stringify(row) !== JSON.stringify(newInfo[i])) ||
        newInfo
          .slice(oldInfo.length)
          .some(
            (row) =>
              Number(row.pk) !== 0 ||
              Number(row.hidden) !== 0 ||
              (Number(row.notnull) === 1 &&
                (row.dflt_value === null || String(row.dflt_value).toUpperCase() === "NULL")),
          )
      )
        continue;
      // SQLite's ADD rules are stricter than CREATE (e.g. CURRENT_TIMESTAMP
      // defaults on populated tables). Let SQLite check them without exposing
      // a schema change or guessing which default expressions are constant.
      let supportsAlter = true;
      out.exec("SAVEPOINT readonly_schema_probe");
      try {
        for (const clause of remaining) out.exec(`ALTER TABLE ${q(name)} ADD COLUMN ${clause}`);
      } catch (error) {
        if (!/^Cannot add /i.test(String((error as Error)?.message ?? error))) throw error;
        supportsAlter = false;
      } finally {
        out.exec("ROLLBACK TO readonly_schema_probe; RELEASE readonly_schema_probe");
      }
      if (!supportsAlter) continue;
      additions.set(name, {
        clauses: remaining,
        columns: newInfo.slice(oldInfo.length).map((row) => String(row.name)),
      });
    }
    const storedSource = getMeta("source");
    const storedSequence = getMeta("sequence");
    // A full rebuild replaces these keys inside its private publication transaction.
    const storedIdentitySequence = getMeta("identity_sequence");
    const changedProjection =
      changedTables.find(({ name }) => projections.includes(name) && !additions.has(name)) ??
      sourceTables.find(({ name }) => projections.includes(name) && changedIndexes.has(name));
    const rebuildReason =
      storedSource !== undefined && !sameSource(storedSource)
        ? "source database was replaced"
        : changedProjection
          ? `source schema changed: ${changedProjection.name}`
          : storedSequence !== undefined && sequence() < Number(storedSequence)
            ? "source event sequence regressed"
            : undefined;
    let rebuild:
      | {
          kind: ReadonlyRebuildEvent["kind"];
          reason: string;
          started: number;
          rows: number;
          tableRows: number;
          pages: number;
          table: string;
          loggedAt: number;
          cursor?: number;
          details: Pick<
            ReadonlyRebuildEvent,
            | "cursor"
            | "cycleTarget"
            | "firstMissingSequence"
            | "rowsReturned"
            | "publishedReady"
            | "readyReason"
          >;
        }
      | undefined;
    const rebuildEvent = (event: ReadonlyRebuildEvent["event"], error?: unknown) => {
      if (!rebuild) return;
      const value: ReadonlyRebuildEvent = {
        event,
        kind: rebuild.kind,
        reason: rebuild.reason,
        ...rebuild.details,
        ...(rebuild.cursor === undefined ? {} : { cursor: rebuild.cursor }),
        generation:
          Number(getMeta("generation") ?? 0) +
          (rebuild.kind !== "additive" && event !== "publish" ? 1 : 0),
        table: rebuild.table,
        rows: rebuild.rows,
        rowsDone: rebuild.tableRows,
        pages: rebuild.pages,
        elapsedMs: Date.now() - rebuild.started,
        ...(event === "publish"
          ? {
              sequence: Number(getMeta("sequence") ?? 0),
              identitySequence: Number(getMeta("identity_sequence") ?? 0),
              bytes:
                fs.statSync(options.replicaPath).size +
                (fs.existsSync(options.replicaPath + "-wal")
                  ? fs.statSync(options.replicaPath + "-wal").size
                  : 0),
            }
          : {}),
        ...(error === undefined
          ? {}
          : { error: String((error as Error)?.message ?? error).slice(0, 1000) }),
      };
      meta("rebuild_progress", JSON.stringify(value));
      // A full rebuild holds the SQLite writer until publication. Commit
      // diagnostics separately so mode=ro readers can see its latest page.
      let diagnosticsDir: string | undefined;
      try {
        diagnosticsDir = fs.mkdtempSync(replicaName + ".diagnostics-");
        const temporary = path.join(diagnosticsDir, "progress.json");
        fs.writeFileSync(
          temporary,
          JSON.stringify({
            replica_identity: [replicaStat.dev, replicaStat.ino],
            rebuild_started_at: new Date(rebuild.started).toISOString(),
            rebuild_finished_at: event === "publish" ? new Date(Date.now()).toISOString() : "",
            rebuild_progress: JSON.stringify(value),
          }),
          { mode: 0o600 },
        );
        fs.renameSync(temporary, replicaName + ".rebuild.json");
      } catch {
        // Diagnostics must not prevent publication; meta and logs still work.
      } finally {
        try {
          if (diagnosticsDir) fs.rmSync(diagnosticsDir, { recursive: true, force: true });
        } catch {
          // A cleanup failure must not turn diagnostics into an export failure.
        }
      }
      options.onRebuildEvent?.(value);
      rebuild.loggedAt = Date.now();
    };
    const startRebuild = (
      kind: ReadonlyRebuildEvent["kind"],
      reason: string,
      details: Pick<
        ReadonlyRebuildEvent,
        "cursor" | "cycleTarget" | "firstMissingSequence" | "rowsReturned" | "publishedReady"
      > = {},
      started = Date.now(),
    ) => {
      rebuild = {
        kind,
        reason,
        started,
        rows: 0,
        tableRows: 0,
        pages: 0,
        table: "",
        loggedAt: Date.now(),
        details: {
          publishedReady: getMeta("ready") ?? "0",
          readyReason:
            kind === "events_reset"
              ? reason
              : reason.startsWith("source schema")
                ? "schema"
                : reason.includes("bootstrap")
                  ? "bootstrap"
                  : reason,
          ...details,
        },
      };
      meta("rebuild_started_at", new Date(rebuild.started).toISOString());
      meta("rebuild_finished_at", "");
      meta("rebuild_kind", kind);
      rebuildEvent("start");
    };
    const oldRecordFailure = recordFailure;
    recordFailure = (error) => {
      oldRecordFailure(error);
      if (rebuild) {
        rebuildEvent("abort", error);
        rebuild = undefined;
      }
    };
    const heartbeatRebuild = () => {
      if (rebuild && Date.now() - rebuild.loggedAt >= 30_000) rebuildEvent("progress");
    };
    const notePage = (table: string, rows: number, cursor?: number) => {
      if (!rebuild) return;
      rebuild.tableRows = (rebuild.table === table ? rebuild.tableRows : 0) + rows;
      rebuild.table = table;
      rebuild.rows += rows;
      rebuild.pages++;
      if (cursor === undefined) delete rebuild.cursor;
      else rebuild.cursor = cursor;
      heartbeatRebuild();
    };
    if (rebuildReason) {
      const lastReason = getMeta("last_rebuild_reason");
      const lastAt = Date.parse(getMeta("last_rebuild_at") ?? "");
      const now = Date.now();
      const insideWindow =
        lastReason === rebuildReason && Number.isFinite(lastAt) && now - lastAt < rebuildBackoffMs;
      // Persist the single recovery allowance across worker/server restarts.
      const immediateRetry =
        insideWindow &&
        getMeta("ready") !== "1" &&
        rebuildReason.startsWith("source schema changed:") &&
        getMeta("schema_retry_at") !== String(lastAt);
      if (insideWindow && !immediateRetry) {
        const lastNotice = Date.parse(getMeta("rebuild_held_notice_at") ?? "");
        const notify = !(Number.isFinite(lastNotice) && now - lastNotice < rebuildNoticeMs);
        const until = new Date(lastAt + rebuildBackoffMs).toISOString();
        meta("rebuild_held_until", until);
        if (notify) meta("rebuild_held_notice_at", new Date(now).toISOString());
        throw Object.assign(
          new Error(`Automatic rebuild held back: ${rebuildReason}; next allowed after ${until}`),
          { code: "READONLY_REBUILD_HELD", notify },
        );
      }
      if (immediateRetry) meta("schema_retry_at", String(lastAt));
      meta("last_rebuild_reason", rebuildReason);
      if (!insideWindow) meta("last_rebuild_at", new Date(now).toISOString());
      out
        .prepare(
          "DELETE FROM ardud_readonly_meta WHERE key IN ('rebuild_held_until','rebuild_held_notice_at')",
        )
        .run();
      startRebuild("full", rebuildReason);
      // SQLite WAL sidecars are tied to the pathname. Renaming just the main
      // file beneath mode=ro readers can pair a new main with the old WAL/SHM.
      // Publish by WAL commit instead: old snapshots stay valid on this inode.
      // No reader lock protocol is shared with state.sqlite readers (the
      // OpenCode .export.lock guards only that export's writer).
      beginCycle(false);
      transaction(() => {
        for (const name of [
          ...projections,
          ...auxiliary,
          "ardud_readonly_progress",
          "orchestration_events",
          "ardud_readonly_seen",
          "ardud_readonly_dirty_items",
          "ardud_readonly_item_fences",
        ])
          out.exec(`DROP TABLE IF EXISTS ${q(name)}`);
        out.exec(bookkeeping);
        out
          .prepare(
            "DELETE FROM ardud_readonly_meta WHERE key LIKE 'schema:%' OR key LIKE 'identity_%' OR key LIKE 'additive:%' OR key IN ('archive_deletion_sequence','compaction_revision','resetting_events')",
          )
          .run();
        meta("source", identity);
        meta("sequence", String(sequence()));
        meta("schema_version", "1");
        // Only the private, uncommitted generation is unready.
        meta("ready", "0");
      });
    } else {
      for (const table of sourceTables) {
        if (
          auxiliary.includes(table.name) &&
          (changedTables.some(({ name }) => name === table.name) || changedIndexes.has(table.name))
        )
          pendingAuxiliarySchemas.set(table.name, table);
      }
      if (storedSource !== undefined && storedSource !== identity) meta("source", identity);
      if (additions.size) {
        startRebuild("additive", `source schema added columns: ${[...additions.keys()].join(",")}`);
        transaction(() => {
          for (const { name, schema } of changedTables.filter(({ name }) => additions.has(name))) {
            for (const clause of additions.get(name)!.clauses)
              out.exec(`ALTER TABLE ${q(name)} ADD COLUMN ${clause}`);
            meta(`schema:${name}`, schema);
            const pending = getMeta(`additive:${name}`);
            const previous =
              pending === undefined ? [] : (JSON.parse(pending) as { columns: string[] }).columns;
            meta(
              `additive:${name}`,
              JSON.stringify({
                cursor: 0,
                columns: [...previous, ...additions.get(name)!.columns],
              }),
            );
          }
        });
      }
    }
    if (!getMeta("sequence"))
      transaction(() => {
        meta("source", identity);
        meta("sequence", String(sequence()));
        meta("ready", "0");
        meta("schema_version", "1");
      });
    let resettingEvents = getMeta("resetting_events") === "1";
    /** A completed generation is published and no bootstrap/reset is pending. */
    const published = () =>
      getMeta("ready") === "1" &&
      !resettingEvents &&
      projections.every((name) => progress(name).done);
    // Reopening (e.g. a worker restart) keeps a published replica readable;
    // updated_at only advances at completed cycles, so a stall still goes stale.
    if (!published()) {
      meta("ready", "0");
      if (!rebuild) startRebuild("full", "bootstrap or interrupted bootstrap");
    }

    const tables = new Map<
      string,
      {
        db: NodeSqlite.DatabaseSync;
        columns: string[];
        primary: string;
        upsert: NodeSqlite.StatementSync | undefined;
      }
    >();
    const sourceSchemas = new Map<string, string>();
    const eventPage = (
      db: NodeSqlite.DatabaseSync,
      table: string,
      cursor: number,
      through: number,
    ) =>
      db
        .prepare(`SELECT sequence,event_type,stream_id,
      CASE WHEN event_type LIKE 'thread.%' OR event_type IN ('provider-thread.updated','subagent.updated') THEN payload_json ELSE '{}' END AS payload_json,
      CASE WHEN event_type IN ('run.created','run.updated','run-attempt.created','run-attempt.updated',
        'provider-thread.updated','provider-turn.updated','subagent.updated','message.updated') THEN json_extract(payload_json,'$.id')
        WHEN event_type='run.background-work-cancelled' THEN json_extract(payload_json,'$.runId') END AS entity_id
      FROM ${q(table)} WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT ?`)
        .all(cursor, through, batchSize);
    const threadEventSources = [
      { db: source, table: "orchestration_events" },
      ...(archive ? [{ db: archive, table: "ardud_events" }] : []),
      ...(baseArchive ? [{ db: baseArchive, table: "orchestration_events" }] : []),
    ].map(({ db, table }) => {
      const versioned = db
        .prepare(`PRAGMA table_info(${q(table)})`)
        .all()
        .some((row) => row.name === "application_event_version");
      return db.prepare(
        `SELECT max(sequence) AS n FROM ${q(table)} WHERE stream_id=? ${versioned ? "AND application_event_version=2 AND aggregate_kind='thread'" : ""}`,
      );
    });
    const threadSequence = (threadId: NodeSqlite.SQLInputValue) =>
      // Journal fences must include events already moved out of main, too.
      Math.max(...threadEventSources.map((statement) => Number(statement.get(threadId)?.n ?? 0)));
    // All referenced tables must exist before SQLite prepares any upsert,
    // even when foreign-key checks are deferred until publication.
    for (const table of sourceTables) {
      if (!pendingAuxiliarySchemas.has(table.name)) {
        meta(`schema:${table.name}`, table.schema);
        createExportedTable(table);
      }
    }
    for (const { name, db } of sourceTables) {
      // Expressions may be invalid for temporary defaults until backfilled.
      if (!pendingAuxiliarySchemas.has(name) && getMeta(`additive:${name}`) === undefined)
        copyIndexes(name, db);
    }
    ensureIdentityVersions();
    const configureTable = ({ name, db, schema }: (typeof sourceTables)[number]) => {
      // Pending auxiliary columns do not exist in main until their rows publish.
      sourceSchemas.set(name, schema);
      const info = db.prepare(`PRAGMA table_info(${q(name)})`).all();
      const columns = info.map((row) => String(row.name));
      const primary = String(info.find((row) => row.pk === 1)?.name ?? "");
      if (!primary || info.some((row) => Number(row.pk) > 1))
        throw new Error(`Unsupported export key: ${name}`);
      const values = columns.filter((c) => c !== primary);
      tables.set(name, {
        db,
        columns,
        primary,
        // Auxiliary rows use staging. Projection upserts leave identical rows alone.
        upsert: auxiliary.includes(name)
          ? undefined
          : out.prepare(
              `INSERT INTO ${q(name)} (${columns.map(q).join(",")}) VALUES (${columns.map(() => "?").join(",")}) ON CONFLICT(${q(primary)}) ${values.length ? `DO UPDATE SET ${values.map((c) => `${q(c)}=excluded.${q(c)}`).join(",")} WHERE ${values.map((c) => `${q(c)} IS NOT excluded.${q(c)}`).join(" OR ")}` : "DO NOTHING"}`,
            ),
      });
    };
    for (const table of sourceTables) configureTable(table);
    ensureExportIndexes();
    const copyRow = (name: string, row: Record<string, NodeSqlite.SQLOutputValue>) => {
      const table = tables.get(name)!;
      if (name.endsWith("_turn_items") && !selectedItems.has(String(row.type))) {
        return out
          .prepare(`DELETE FROM ${q(name)} WHERE ${q(table.primary)}=?`)
          .run(row[table.primary]!).changes;
      } else {
        const changes = table.upsert!.run(...table.columns.map((c) => row[c]!)).changes;
        if (name.endsWith("_turn_items"))
          out
            .prepare(
              "INSERT INTO ardud_readonly_item_fences VALUES (?,?) ON CONFLICT(item_id) DO UPDATE SET sequence=excluded.sequence",
            )
            .run(row[table.primary]!, threadSequence(row.thread_id!));
        return changes;
      }
    };
    // Match recall_core.py's cached identities and live subagent traversal.
    // Early publications advertise tuple changes through the touch log until events export.
    const lineageStatements = new Map([
      [
        "orchestration_v2_projection_threads",
        out.prepare(
          "SELECT json_array(thread_id,json_extract(payload_json,'$.lineage.parentThreadId'),json_extract(payload_json,'$.lineage.rootThreadId')) AS identity FROM orchestration_v2_projection_threads WHERE thread_id=?",
        ),
      ],
      [
        "orchestration_v2_projection_provider_threads",
        out.prepare(
          "SELECT json_array(provider_thread_id,thread_id,json_extract(payload_json,'$.nativeThreadRef.nativeId')) AS identity FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?",
        ),
      ],
      [
        "orchestration_v2_projection_subagents",
        out.prepare(
          "SELECT json_array(subagent_id,thread_id,child_thread_id,json_extract(payload_json,'$.nativeTaskRef.nativeId')) AS identity FROM orchestration_v2_projection_subagents WHERE subagent_id=?",
        ),
      ],
    ]);
    const lineageIdentity = (name: string, id: NodeSqlite.SQLInputValue) =>
      lineageStatements.get(name)?.get(id)?.identity;
    const selectColumns = (name: string) =>
      tables
        .get(name)!
        .columns.map((c) =>
          c === "payload_json" && name.endsWith("_turn_items")
            ? `CASE WHEN type IN ('user_message','error','run_interrupt_request') THEN payload_json ELSE '{}' END AS payload_json`
            : q(c),
        )
        .join(",");
    const refresh = (name: string, id: NodeSqlite.SQLInputValue) => {
      const table = tables.get(name)!;
      const row = table.db
        .prepare(`SELECT ${selectColumns(name)} FROM ${q(name)} WHERE ${q(table.primary)}=?`)
        .get(id);
      if (row) return copyRow(name, row);
      return out.prepare(`DELETE FROM ${q(name)} WHERE ${q(table.primary)}=?`).run(id).changes;
    };
    const page = (name: string, cursor: number) => {
      const table = tables.get(name)!;
      // Tool transcripts dwarf all the data readers need. Do not even fetch them.
      return table.db
        .prepare(
          `SELECT rowid AS __rowid,${selectColumns(name)} FROM ${q(name)} WHERE rowid>? ORDER BY rowid LIMIT ?`,
        )
        .all(cursor, batchSize);
    };
    // TEMP staging keeps auxiliary page pacing outside the publication lock.
    // No partial auxiliary generation is visible to outside readers.
    const createAuxiliaryStage = (name: string) => {
      const table = tables.get(name)!;
      const stage = `readonly_stage_${name}`;
      // Pending columns may not exist in main. Untyped columns preserve source
      // storage values, and TEMP foreign keys would incorrectly resolve in temp.
      out.exec(`CREATE TEMP TABLE ${q(stage)} (${table.columns.map(q).join(",")})`);
      out.exec(
        `CREATE UNIQUE INDEX temp.${q(`${stage}_primary`)} ON ${q(stage)}(${q(table.primary)})`,
      );
      return {
        stage,
        insert: out.prepare(
          `INSERT OR REPLACE INTO temp.${q(stage)} (${table.columns.map(q)}) VALUES (${table.columns.map(() => "?")})`,
        ),
      };
    };
    const auxiliaryStages = new Map(auxiliary.map((name) => [name, createAuxiliaryStage(name)]));
    const applyAuxiliary = () => {
      if (pendingAuxiliarySchemas.size)
        refreshAuxiliarySchemas([...pendingAuxiliarySchemas.values()]);
      for (const name of auxiliary) {
        const { stage } = auxiliaryStages.get(name)!;
        const { primary, columns } = tables.get(name)!;
        const values = columns.filter((c) => c !== primary);
        // Release obsolete unique owners before copying replacements. Import
        // bindings can also swap owners while both session keys survive.
        out.exec(
          `DELETE FROM main.${q(name)} WHERE NOT EXISTS (SELECT 1 FROM temp.${q(stage)} s WHERE s.${q(primary)}=main.${q(name)}.${q(primary)}${name === "ardud_opencode_import" ? ` AND s.thread_id IS main.${q(name)}.thread_id` : ""})`,
        );
        out.exec(`INSERT INTO main.${q(name)} (${columns.map(q)}) SELECT ${columns.map(q)} FROM temp.${q(stage)} WHERE 1
          ON CONFLICT(${q(primary)}) ${values.length ? `DO UPDATE SET ${values.map((c) => `${q(c)}=excluded.${q(c)}`).join(",")} WHERE ${values.map((c) => `${q(name)}.${q(c)} IS NOT excluded.${q(c)}`).join(" OR ")}` : "DO NOTHING"}`);
      }
    };
    const upsertEvent = out.prepare("INSERT OR REPLACE INTO orchestration_events VALUES (?,?,?,?)");
    const routes: Record<string, string> = {
      run: "runs",
      "run-attempt": "run_attempts",
      "provider-thread": "provider_threads",
      "provider-turn": "provider_turns",
      subagent: "subagents",
      message: "messages",
    };
    let cycleTarget: number | undefined;
    let auxiliaryCapturedAt: number | undefined;
    const pendingAdditions = () =>
      projections.some((name) => getMeta(`additive:${name}`) !== undefined);
    // Ordinary published reopens retain their existing generation allocation.
    // Schema backfills and full rebuilds advance only when their work publishes.
    if (published() && !pendingAdditions())
      meta("generation", String(Number(getMeta("generation") ?? 0) + 1));
    nextGeneration();
    let auxiliaryIndex = 0,
      auxiliaryCursor = 0,
      reconcileIndex = 0,
      closed = false;
    const schemaVersion = (db: NodeSqlite.DatabaseSync) =>
      Number(db.prepare("PRAGMA schema_version").get()?.schema_version);
    const sourceSchemaVersions = new Map(sourceTables.map(({ db }) => [db, schemaVersion(db)]));
    const markSeen = (name: string, id: NodeSqlite.SQLInputValue, generation: number) =>
      out
        .prepare(
          "INSERT INTO ardud_readonly_seen VALUES (?,?,?) ON CONFLICT(name,id) DO UPDATE SET generation=excluded.generation",
        )
        .run(name, id, generation);
    const prune = (name: string, cursor: number, generation: number) => {
      const table = tables.get(name)!;
      const rows = out
        .prepare(
          `SELECT rowid AS __rowid,${q(table.primary)} AS id FROM ${q(name)} WHERE rowid>? ORDER BY rowid LIMIT ?`,
        )
        .all(cursor, batchSize);
      for (const row of rows) {
        if (
          !out
            .prepare("SELECT 1 FROM ardud_readonly_seen WHERE name=? AND id=? AND generation=?")
            .get(name, row.id!, generation)
        ) {
          out.prepare(`DELETE FROM ${q(name)} WHERE ${q(table.primary)}=?`).run(row.id!);
          out.prepare("DELETE FROM ardud_readonly_seen WHERE name=? AND id=?").run(name, row.id!);
        }
      }
      // Old tracking rows can outlive removed source rows, but cleanup remains a page.
      out
        .prepare(
          "DELETE FROM ardud_readonly_seen WHERE rowid IN (SELECT rowid FROM ardud_readonly_seen WHERE name=? AND generation<? LIMIT ?)",
        )
        .run(name, generation, batchSize);
      return { pruneCursor: Number(rows.at(-1)?.__rowid ?? cursor), done: rows.length < batchSize };
    };
    // While a publish drains its backlog, every source read shares one
    // pinned snapshot (main, delta archive and base, pinned in that order).
    let pinned = false;
    const rollback = (db: NodeSqlite.DatabaseSync | undefined) => {
      try {
        db?.exec("ROLLBACK");
      } catch {
        // No transaction was open.
      }
    };
    const unpin = () => {
      pinned = false;
      rollback(baseArchive);
      rollback(archive);
      rollback(source);
    };
    const pin = () => {
      try {
        // Pin main first: if it sees a deletion, the copy-first archive
        // commit is already visible to the later archive snapshot.
        source.exec("BEGIN");
        source.prepare("SELECT max(sequence) AS n FROM orchestration_events").get();
        archive?.exec("BEGIN");
        archive?.prepare("SELECT max(sequence) AS n FROM ardud_events").get();
        baseArchive?.exec("BEGIN");
        baseArchive?.prepare("SELECT max(sequence) AS n FROM orchestration_events").get();
        pinned = true;
      } catch (error) {
        unpin();
        throw error;
      }
    };
    /** One read snapshot of main for one page, or the pinned one. */
    const sourceRead = <A>(body: () => A): A => {
      if (pinned) return body();
      source.exec("BEGIN");
      try {
        return body();
      } finally {
        source.exec("ROLLBACK");
      }
    };
    /** Event pages read main, then the archives, each in its own snapshot. */
    const eventRead = (body: () => void) => {
      if (pinned) return body();
      try {
        pin();
        body();
      } finally {
        unpin();
      }
    };
    const eventReadFirst = (cursor: number) => {
      let first = Infinity;
      eventRead(() => {
        for (const { db, table } of [
          { db: source, table: "orchestration_events" },
          ...(archive ? [{ db: archive, table: "ardud_events" }] : []),
          ...(baseArchive ? [{ db: baseArchive, table: "orchestration_events" }] : []),
          ...(hasCompactedEvents()
            ? [{ db: source, table: "ardud_history_compacted_events" }]
            : []),
        ]) {
          const row = db
            .prepare(`SELECT sequence FROM ${q(table)} WHERE sequence>? ORDER BY sequence LIMIT 1`)
            .get(cursor);
          if (row) first = Math.min(first, Number(row.sequence));
        }
      });
      return first;
    };
    const identityNames = [
      "orchestration_v2_projection_threads",
      "orchestration_v2_projection_provider_threads",
      "orchestration_v2_projection_subagents",
    ];
    // Source rowids are insertion ordered; never use replica rowids as cursors.
    // Restarted workers resume only committed cursors. Bootstrap covers history.
    const identityCursors = new Map(
      identityNames.map((name) => [
        name,
        Number(
          getMeta(`identity_cursor:${name}`) ??
            source.prepare(`SELECT max(rowid) AS n FROM ${q(name)}`).get()?.n ??
            0,
        ),
      ]),
    );
    let identitySequence = Number(
      getMeta("identity_sequence") ?? getMeta("sequence") ?? sequence(),
    );
    transaction(() => {
      for (const [name, cursor] of identityCursors) meta(`identity_cursor:${name}`, String(cursor));
      meta("identity_sequence", String(identitySequence));
    });
    options.onDiagnosticEvent?.({
      event: "open",
      sequence: Number(storedSequence ?? getMeta("sequence") ?? 0),
      identitySequence: Number(
        storedIdentitySequence ?? storedSequence ?? getMeta("identity_sequence") ?? 0,
      ),
      sourceSequence: sequence(),
    });
    const replayStarted = Date.now();
    let replayEvents = 0;
    let replayComplete = false;
    const noteReplay = (events: number, sourceSequence: number) => {
      if (replayComplete) return;
      replayEvents += events;
      if (identitySequence < sourceSequence) return;
      replayComplete = true;
      options.onDiagnosticEvent?.({
        event: "replay",
        replayEvents,
        replayMs: Date.now() - replayStarted,
      });
    };
    let identityCheckedAt = Number.NEGATIVE_INFINITY;
    const identityCreatedAt = (row: Record<string, NodeSqlite.SQLOutputValue>) => {
      const timestamp = row.created_at ?? row.started_at ?? row.updated_at;
      const created = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
      return Number.isFinite(created) ? created : undefined;
    };
    const publishIdentities = (): boolean => {
      if (!published() || pendingAdditions() || Date.now() - identityCheckedAt < 1_000)
        return false;
      identityCheckedAt = Date.now();
      return measure("identity", () =>
        sourceRead(() => {
          assertRedactionComplete();
          const pages = identityNames.map((name) => ({
            name,
            rows: page(name, identityCursors.get(name)!),
          }));
          // Bindings may acquire their native id after insertion. A bounded event
          // scan also catches those updates without scanning updated_at columns.
          const sourceSequence = sequence();
          const events = eventPage(
            source,
            "orchestration_events",
            identitySequence,
            sourceSequence,
          );
          const changed =
            pages.some(({ rows }) => rows.length > 0) ||
            events.some(
              (row) =>
                row.event_type === "provider-thread.updated" ||
                row.event_type === "subagent.updated" ||
                row.event_type === "thread.created",
            );
          let suspended: Uint8Array | undefined;
          if (changed && cycleTransaction) {
            // Save the pending replica diff before releasing its write lock.
            // Replaying it after the short identity commit preserves catch-up
            // progress even when new children arrive throughout a long cycle.
            suspended = measure("identitySuspend", () => cycleSession!.changeset());
            abortCycle();
          }
          if (cycleTransaction) {
            // This cursor is a source scan, independent of the full-cycle
            // sequence. Do not rescan the same non-identity prefix forever.
            identitySequence = Number(events.at(-1)?.sequence ?? identitySequence);
            noteReplay(events.length, sourceSequence);
            if (events.length === batchSize) identityCheckedAt = Number.NEGATIVE_INFINITY;
            return events.length === batchSize;
          }
          if (!changed && events.length === 0) {
            noteReplay(0, sourceSequence);
            return false;
          }
          const nextCursors = new Map(identityCursors);
          let oldestCreated: number | undefined;
          transaction(() => {
            let changes = 0;

            const copyIdentityRow = (
              name: string,
              row: Record<string, NodeSqlite.SQLOutputValue>,
            ) => {
              const id = row[tables.get(name)!.primary]!;
              const before = lineageIdentity(name, id);
              changes += Number(copyRow(name, row));
              if (before !== lineageIdentity(name, id))
                touchIdentity(name, id, before === undefined ? "insert" : "update");
            };
            const copyIdentity = (name: string, row: Record<string, NodeSqlite.SQLOutputValue>) => {
              // A provider/subagent page may outrun the thread page. Resolve its
              // lineage by indexed primary key in this same source snapshot.
              for (const key of ["thread_id", "child_thread_id"]) {
                if (name === identityNames[0] || typeof row[key] !== "string") continue;
                const thread = source
                  .prepare(`SELECT * FROM ${q(identityNames[0]!)} WHERE thread_id=?`)
                  .get(row[key]!);
                if (thread) copyIdentityRow(identityNames[0]!, thread);
              }
              copyIdentityRow(name, row);
            };
            for (const { name, rows } of pages) {
              for (const row of rows) {
                copyIdentity(name, row);
                const created = identityCreatedAt(row);
                if (created !== undefined)
                  oldestCreated = Math.min(oldestCreated ?? created, created);
              }
              nextCursors.set(name, Number(rows.at(-1)?.__rowid ?? identityCursors.get(name)!));
              meta(`identity_cursor:${name}`, String(nextCursors.get(name)));
            }
            for (const event of events) {
              const name =
                event.event_type === "provider-thread.updated"
                  ? identityNames[1]
                  : event.event_type === "subagent.updated"
                    ? identityNames[2]
                    : event.event_type === "thread.created"
                      ? identityNames[0]
                      : undefined;
              const id = event.event_type === "thread.created" ? event.stream_id : event.entity_id;
              if (name && id) {
                const table = tables.get(name)!;
                const row = source
                  .prepare(`SELECT * FROM ${q(name)} WHERE ${q(table.primary)}=?`)
                  .get(id);
                if (row) copyIdentity(name, row);
              }
            }
            // These rows precede their events; readers overlay touches without
            // invalidating the full snapshot or advancing its publication markers.
            pruneTouches();
            metrics = { ...metrics, identityRows: metrics.identityRows + changes };
            meta("identity_sequence", String(Number(events.at(-1)?.sequence ?? identitySequence)));
          });
          // Measure at COMMIT, and only newly inserted rows. A later status
          // event must not report the age of a long-running subagent as lag.
          if (oldestCreated !== undefined)
            metrics = {
              ...metrics,
              identityLagMaxMs: Math.max(metrics.identityLagMaxMs, Date.now() - oldestCreated),
            };
          for (const [name, cursor] of nextCursors) identityCursors.set(name, cursor);
          identitySequence = Number(events.at(-1)?.sequence ?? identitySequence);
          if (suspended)
            measure("identityResume", () => {
              beginCycle();
              // Early identity rows shadow the older pending identity values.
              // Every other table must replay without conflicts: run/Stop state
              // and publication markers still switch together at cycle end.
              if (
                !out.applyChangeset(suspended, {
                  // Replayed projection writes run the triggers again. Their old
                  // versions can collide with the intervening identity commit.
                  filter: (name) =>
                    !identityNames.includes(name) && name !== "ardud_readonly_identity_versions",
                }) ||
                !out.applyChangeset(suspended, {
                  filter: (name) => identityNames.includes(name),
                  onConflict: () => sqlite.constants.SQLITE_CHANGESET_OMIT,
                })
              )
                throw new Error("Readonly cycle could not resume after identity publication");
            });
          // Drain a backlog in bounded pages at the worker's 10 ms cadence.
          noteReplay(events.length, sourceSequence);
          if (pages.some(({ rows }) => rows.length === batchSize) || events.length === batchSize)
            identityCheckedAt = Number.NEGATIVE_INFINITY;
          return changed || identityCheckedAt === Number.NEGATIVE_INFINITY;
        }),
      );
    };
    const validate = () => {
      if (closed) throw new Error("Readonly exporter is closed");
      if (invalidated) throw new Error(invalidated);
      if (readBasePath() !== basePath)
        throw invalidate("History base changed; reopen readonly sources");
      if (options.archivePath && !archive && fs.existsSync(options.archivePath))
        throw invalidate("History archive appeared; reopen readonly sources");
      if (
        !archive &&
        source
          .prepare("SELECT 1 FROM sqlite_schema WHERE name='ardud_history_archive_state'")
          .get() &&
        source.prepare("SELECT has_cold_rows FROM ardud_history_archive_state LIMIT 1").get()
          ?.has_cold_rows === 1
      )
        throw invalidate("History archive unavailable; outside export deferred");
      // A split can finish while a long first bootstrap is in flight. Reopen
      // all small-table readers together at that cutover, never mix sources.
      if (options.boardPath && !boardsReady && fs.existsSync(options.boardPath)) {
        if (!boards) throw invalidate("Board split appeared; reopen readonly sources");
        if (
          boards.prepare("SELECT 1 FROM sqlite_schema WHERE name='ardud_boards_migration'").get() &&
          boards.prepare("SELECT completed FROM ardud_boards_migration WHERE table_name='*'").get()
            ?.completed === 1
        ) {
          throw invalidate("Board split completed; reopen readonly sources");
        }
      }
      if ([...sourceSchemaVersions].some(([db, version]) => schemaVersion(db) !== version)) {
        const changed = sourceTables.flatMap(({ name, db }) => {
          const schema = db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name)?.sql;
          if (typeof schema !== "string")
            throw invalidate(`Readonly export source table missing: ${name}`, true);
          return schema === sourceSchemas.get(name) &&
            !restrictiveIndexesChanged(db, out, name) &&
            !restrictiveIndexesChanged(out, db, name)
            ? []
            : [{ name, db, schema }];
        });
        if (changed.some(({ name }) => projections.includes(name)))
          throw invalidate("Readonly source schema changed; restart export", true);
        if (changed.length) {
          // Routine pending diffs must restart at the new auxiliary shape.
          // Private resets and full rebuilds keep their projection pages; aborting
          // here would let the next reset step mutate the published generation.
          if (getMeta("ready") === "1") abortCycle();
          for (const table of changed) {
            pendingAuxiliarySchemas.set(table.name, table);
            configureTable(table);
            out.exec(`DROP TABLE temp.${q(auxiliaryStages.get(table.name)!.stage)}`);
            auxiliaryStages.set(table.name, createAuxiliaryStage(table.name));
          }
          auxiliaryIndex = 0;
          auxiliaryCursor = 0;
          auxiliaryCapturedAt = undefined;
          cycleTarget = undefined;
        }
        for (const db of sourceSchemaVersions.keys())
          sourceSchemaVersions.set(db, schemaVersion(db));
      }
    };
    const stepOnce = (): boolean => {
      for (const name of projections) {
        const pending = getMeta(`additive:${name}`);
        if (pending === undefined) continue;
        if (!rebuild) startRebuild("additive", `resume column backfill: ${name}`);
        const saved = JSON.parse(pending) as { cursor: number; columns: string[] };
        const rows = page(name, saved.cursor);
        const table = tables.get(name)!;
        // Only the new columns may change outside a publication. Existing
        // status/payload fields and new rows must wait for their events/Stop
        // items to publish together through the normal refresh transaction.
        const update = out.prepare(
          `UPDATE ${q(name)} SET ${saved.columns.map((column) => `${q(column)}=?`).join(",")} WHERE ${q(table.primary)}=?`,
        );
        transaction(() => {
          for (const row of rows)
            update.run(...saved.columns.map((column) => row[column]!), row[table.primary]!);
          if (rows.length < batchSize) {
            copyIndexes(name, table.db);
            out.prepare("DELETE FROM ardud_readonly_meta WHERE key=?").run(`additive:${name}`);
          } else
            meta(
              `additive:${name}`,
              JSON.stringify({ ...saved, cursor: Number(rows.at(-1)!.__rowid) }),
            );
        });
        notePage(name, rows.length, Number(rows.at(-1)?.__rowid ?? saved.cursor));
        if (!pendingAdditions()) {
          meta("rebuild_finished_at", new Date(Date.now()).toISOString());
          rebuildEvent("publish");
          rebuild = undefined;
          return getMeta("ready") !== "1";
        }
        return true;
      }
      // Only projection/event catch-up and the final staged auxiliary diff hold
      // the publication transaction. Bootstrap/reset pages remain resumable.
      if (!cycleTransaction && auxiliaryIndex >= auxiliary.length && published()) {
        beginCycle();
      }
      if (resettingEvents) {
        return measure("resetDelete", () => {
          const result = out
            .prepare(
              "DELETE FROM orchestration_events WHERE sequence IN (SELECT sequence FROM orchestration_events LIMIT ?)",
            )
            .run(batchSize);
          notePage("orchestration_events", Number(result.changes));
          resettingEvents = Number(result.changes) >= batchSize;
          if (!resettingEvents) meta("resetting_events", "0");
          return true;
        });
      }
      if (sequence() < Number(getMeta("sequence")))
        throw invalidate("Readonly event sequence regressed", true);
      for (const name of projections) {
        const saved = progress(name);
        if (saved.done) continue;
        return measure("resetScan", () => {
          const generation = saved.generation ?? nextGeneration();
          if (saved.pruning) {
            notePage(name, 0, saved.pruneCursor ?? 0);
            transaction(() =>
              checkpoint(name, { ...saved, ...prune(name, saved.pruneCursor ?? 0, generation) }),
            );
            return true;
          }
          source.exec("BEGIN");
          try {
            const rows = page(name, saved.cursor);
            notePage(name, rows.length, Number(rows.at(-1)?.__rowid ?? saved.cursor));
            transaction(() => {
              for (const row of rows) {
                copyRow(name, row);
                if (!name.endsWith("_turn_items") || selectedItems.has(String(row.type)))
                  markSeen(name, row[tables.get(name)!.primary]!, generation);
              }
              checkpoint(name, {
                cursor: Number(rows.at(-1)?.__rowid ?? saved.cursor),
                done: false,
                pruning: rows.length < batchSize,
                generation,
              });
            });
          } finally {
            source.exec("ROLLBACK");
          }
          return true;
        });
      }
      if (auxiliaryIndex === 0 && auxiliaryCursor === 0 && cycleTarget === undefined) {
        cycleTarget = sequence();
        const cursor = Number(getMeta("sequence"));
        if (cursor < cycleTarget) {
          const first = eventReadFirst(cursor);
          if (first !== cursor + 1) return measure("eventCatchup", catchUpWork);
        }
      }
      if (auxiliaryIndex < auxiliary.length) {
        return measure("auxiliary", () => {
          auxiliaryCapturedAt ??= Date.now();
          const name = auxiliary[auxiliaryIndex]!;
          const stage = auxiliaryStages.get(name)!;
          if (auxiliaryCursor === 0) out.exec(`DELETE FROM temp.${q(stage.stage)}`);
          const rows = page(name, auxiliaryCursor);
          notePage(name, rows.length, Number(rows.at(-1)?.__rowid ?? auxiliaryCursor));
          transaction(() => {
            for (const row of rows)
              stage.insert.run(...tables.get(name)!.columns.map((c) => row[c]!));
          });
          auxiliaryCursor = Number(rows.at(-1)?.__rowid ?? auxiliaryCursor);
          if (rows.length < batchSize) {
            auxiliaryIndex++;
            auxiliaryCursor = 0;
          }
          return true;
        });
      }
      if (cycleTarget === undefined) cycleTarget = sequence();
      if (measure("eventCatchup", catchUpWork)) return true;
      return measure("publish", publishStep);
    };
    /**
     * Event catchup, dirty turn items and the archive deletion journal: one
     * bounded page of whichever is pending. False when caught up to cycleTarget.
     */
    const catchUpWork = (): boolean => {
      const cursor = Number(getMeta("sequence"));
      if (cursor < cycleTarget!) {
        eventRead(() => {
          const through = cycleTarget!;
          const liveRows = eventPage(source, "orchestration_events", cursor, through);
          const merged = new Map<number, Record<string, NodeSqlite.SQLOutputValue>>();
          if (archive) {
            for (const row of eventPage(archive, "ardud_events", cursor, through))
              merged.set(Number(row.sequence), row);
          }
          if (baseArchive) {
            for (const row of eventPage(baseArchive, "orchestration_events", cursor, through)) {
              if (!merged.has(Number(row.sequence))) merged.set(Number(row.sequence), row);
            }
          }
          // Immutable base events never change; delta shadows base and main
          // shadows both. No cold mutable projection values are exported.
          for (const row of liveRows) merged.set(Number(row.sequence), row);
          if (hasCompactedEvents()) {
            for (const row of source
              .prepare(
                "SELECT sequence FROM ardud_history_compacted_events WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT ?",
              )
              .all(cursor, through, batchSize)) {
              merged.set(Number(row.sequence), {
                sequence: row.sequence!,
                event_type: "readonly.compacted",
                stream_id: "",
                payload_json: "{}",
              });
            }
          }
          const rows = [...merged.values()]
            .sort((a, b) => Number(a.sequence) - Number(b.sequence))
            .slice(0, batchSize);
          notePage("orchestration_events", rows.length, Number(rows.at(-1)?.sequence ?? cursor));
          // Only unjournalled holes require revisiting the projections.
          const missingIndex = rows.findIndex(
            (row, i) => Number(row.sequence) !== (i ? Number(rows[i - 1]!.sequence) : cursor) + 1,
          );
          if (!rows.length || missingIndex !== -1) {
            const firstMissingSequence =
              missingIndex > 0 ? Number(rows[missingIndex - 1]!.sequence) + 1 : cursor + 1;
            const publishedReady = rebuild?.details.publishedReady ?? getMeta("ready") ?? "0";
            // Discard a routine partial cycle before publishing diagnostics.
            // A private build can own main or TEMP schemas. Its transaction,
            // prepared statements and advertised start survive nested resets.
            const privateStarted =
              cycleTransaction && getMeta("ready") === "0" ? rebuild?.started : undefined;
            if (privateStarted === undefined) abortCycle();
            cycleSession?.close();
            cycleSession = undefined;
            startRebuild(
              "events_reset",
              rows.length ? "gap" : "empty_page",
              {
                cursor,
                cycleTarget: through,
                firstMissingSequence,
                rowsReturned: rows.length,
                publishedReady,
              },
              privateStarted,
            );
            if (!cycleTransaction) beginCycle(false);
            transaction(() => {
              meta("ready", "0");
              meta("sequence", String(sequence()));
              out.prepare("DELETE FROM ardud_readonly_progress").run();
              meta("resetting_events", "1");
              bumpRepair([{ cause: "reset", table: "orchestration_events", ids: 0 }]);
            });
            resettingEvents = true;
            cycleTarget = undefined;
            auxiliaryIndex = 0;
            auxiliaryCursor = 0;
            auxiliaryCapturedAt = undefined;
            nextGeneration();
            return;
          }
          transaction(() => {
            for (const row of rows) {
              if (row.event_type === "readonly.compacted") {
                out.prepare("DELETE FROM orchestration_events WHERE sequence=?").run(row.sequence!);
                continue;
              }
              const kind = String(row.event_type),
                family = kind.split(".")[0]!;
              if (
                kind.startsWith("thread.") ||
                kind === "provider-thread.updated" ||
                kind === "subagent.updated"
              )
                upsertEvent.run(row.sequence!, kind, row.stream_id!, row.payload_json!);
              if (family === "thread")
                refresh("orchestration_v2_projection_threads", row.stream_id!);
              if (routes[family] && row.entity_id)
                refresh(`orchestration_v2_projection_${routes[family]}`, row.entity_id);
              if (family === "provider-thread")
                refresh("orchestration_v2_projection_threads", row.stream_id!);
              if (family === "turn-item")
                out
                  .prepare(
                    "INSERT INTO ardud_readonly_dirty_items VALUES (?,-1,'',0) ON CONFLICT(thread_id) DO UPDATE SET ordinal=-1,item_id='',target_cursor=0",
                  )
                  .run(row.stream_id!);
            }
            meta("sequence", String(rows.at(-1)!.sequence));
          });
        });
        return true;
      }
      const dirty = out
        .prepare(
          "SELECT thread_id,ordinal,item_id,target_cursor FROM ardud_readonly_dirty_items LIMIT 1",
        )
        .get();
      if (dirty) {
        const name = "orchestration_v2_projection_turn_items";
        if (Number(dirty.target_cursor) >= 0) {
          // Every item the replica holds for the thread is re-read by id, so
          // a type change or removal is applied here...
          const rows = out
            .prepare(
              `SELECT rowid AS __rowid,turn_item_id FROM ${q(name)} WHERE thread_id=? AND rowid>? ORDER BY rowid LIMIT ?`,
            )
            .all(dirty.thread_id!, dirty.target_cursor!, batchSize);
          sourceRead(() =>
            transaction(() => {
              for (const row of rows) refresh(name, row.turn_item_id!);
              out
                .prepare("UPDATE ardud_readonly_dirty_items SET target_cursor=? WHERE thread_id=?")
                .run(rows.length < batchSize ? -1 : rows.at(-1)!.__rowid!, dirty.thread_id!);
            }),
          );
          return true;
        }
        // ...and the source scan only has to find exported types the replica
        // lacks. Scanning every tool item of an active thread (thousands)
        // after each turn-item event kept busy cycles from finishing.
        sourceRead(() => {
          const rows = source
            .prepare(`SELECT ${selectColumns(name)} FROM ${q(name)}
            WHERE thread_id=? AND type IN ('user_message','error','run_interrupt_request')
              AND (ordinal,turn_item_id)>(?,?) ORDER BY ordinal,turn_item_id LIMIT ?`)
            .all(dirty.thread_id!, dirty.ordinal!, dirty.item_id!, batchSize);
          transaction(() => {
            for (const row of rows) copyRow(name, row);
            if (rows.length < batchSize)
              out
                .prepare("DELETE FROM ardud_readonly_dirty_items WHERE thread_id=?")
                .run(dirty.thread_id!);
            else {
              const last = rows.at(-1)!;
              out
                .prepare(
                  "UPDATE ardud_readonly_dirty_items SET ordinal=?,item_id=? WHERE thread_id=?",
                )
                .run(last.ordinal!, last.turn_item_id!, dirty.thread_id!);
            }
          });
        });
        return true;
      }
      return sourceRead(() => {
        if (hasCompactedEvents()) {
          const removals = source
            .prepare(
              "SELECT revision,sequence FROM ardud_history_compacted_events WHERE revision>? ORDER BY revision LIMIT ?",
            )
            .all(Number(getMeta("compaction_revision") ?? 0), batchSize);
          if (removals.length) {
            transaction(() => {
              for (const removal of removals)
                out
                  .prepare("DELETE FROM orchestration_events WHERE sequence=?")
                  .run(removal.sequence!);
              meta("compaction_revision", String(removals.at(-1)!.revision));
            });
            return true;
          }
        }
        if (
          !source
            .prepare("SELECT 1 FROM sqlite_schema WHERE name='ardud_history_archive_deletions'")
            .get()
        )
          return false;
        const journalCursor = Number(getMeta("archive_deletion_sequence") ?? 0);
        const removals = source
          .prepare(
            "SELECT sequence,table_name,row_key,through_event_sequence FROM ardud_history_archive_deletions WHERE sequence>? ORDER BY sequence LIMIT ?",
          )
          .all(journalCursor, batchSize);
        if (!removals.length) return false;
        transaction(() => {
          for (const removal of removals) {
            if (removal.table_name !== "orchestration_v2_projection_turn_items") continue;
            const fence = out
              .prepare("SELECT sequence FROM ardud_readonly_item_fences WHERE item_id=?")
              .get(removal.row_key!);
            if (!fence || Number(fence.sequence) <= Number(removal.through_event_sequence)) {
              out
                .prepare("DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id=?")
                .run(removal.row_key!);
              out
                .prepare("DELETE FROM ardud_readonly_item_fences WHERE item_id=?")
                .run(removal.row_key!);
            }
          }
          meta("archive_deletion_sequence", String(removals.at(-1)!.sequence));
        });
        return true;
      });
    };
    let drainPages = drainPagesInitial;
    /**
     * Publish a generation. Refreshing a projection may observe a commit
     * beyond the catchup window, so its companion events (especially Stop
     * items) must be included first, or the replica could combine a new run
     * with an older interrupt view. Before 2026-11-10 this step went back for
     * another lap whenever the source had moved on; at the ~34 events/s a busy
     * evening writes, that almost never stopped, and a cycle stayed open for
     * minutes (readers saw "replica is stale"). Now the remaining backlog is
     * drained inside one pinned source snapshot, so nothing can arrive in
     * between: the publish is exactly as fresh as that snapshot. The snapshot
     * holds a page budget; a miss keeps the pages done and doubles the budget.
     */
    const publishStep = (): boolean => {
      // Gradually reconcile physical archival deletes / out-of-band updates.
      const name = projections[reconcileIndex % projections.length]!,
        table = tables.get(name)!;
      const saved = progress(`reconcile:${name}`);
      const rows = out
        .prepare(
          `SELECT rowid AS __rowid,${q(table.primary)} AS id FROM ${q(name)} WHERE rowid>? ORDER BY rowid LIMIT ?`,
        )
        .all(saved.cursor, batchSize);
      // Taken before the snapshot starts: it never claims more than it holds.
      const confirmedAt = Date.now();
      pin();
      try {
        cycleTarget = Math.max(cycleTarget!, sequence());
        let pages = 0;
        while (catchUpWork()) {
          if (resettingEvents) return true;
          if (++pages >= drainPages) {
            drainPages = Math.min(drainPages * 2, drainPagesMax);
            return true;
          }
        }
        reconcileIndex++;
        transaction(() => {
          measure("auxiliaryCommit", applyAuxiliary);
          const causes = new Map<string, Omit<LineageRepairBump, "revision">>();
          for (const row of rows) {
            const before = lineageIdentity(name, row.id!);
            refresh(name, row.id!);
            const after = lineageIdentity(name, row.id!);
            if (before !== undefined && before !== after) {
              const cause = after === undefined ? "reconcile_delete" : "reconcile_change";
              causes.set(cause, { cause, table: name, ids: (causes.get(cause)?.ids ?? 0) + 1 });
            }
          }
          // Eventless repairs cannot be replayed from orchestration_events.
          // Readers invalidate only for those repairs, not ordinary publishes.
          if (causes.size) bumpRepair([...causes.values()]);
          else if (getMeta("lineage_repair_revision") === undefined)
            meta("lineage_repair_revision", "0");
          checkpoint(`reconcile:${name}`, {
            cursor: rows.length < batchSize ? 0 : Number(rows.at(-1)!.__rowid),
            done: false,
          });
          out
            .prepare("DELETE FROM orchestration_events WHERE event_type='readonly.watermark'")
            .run();
          out
            .prepare(
              "INSERT OR IGNORE INTO orchestration_events VALUES (?, 'readonly.watermark', '', '{}')",
            )
            .run(cycleTarget!);
          // Readers rebuild if this retained prefix no longer covers their overlay.
          // They do not need an unbounded copy of the event history.
          out
            .prepare(
              "DELETE FROM orchestration_events WHERE sequence IN (SELECT sequence FROM orchestration_events WHERE sequence<? ORDER BY sequence LIMIT ?)",
            )
            .run(Math.max(0, cycleTarget! - 20_000), batchSize);
          // Readers treat updated_at as "everything up to here is in the
          // replica" (stream-recovery defers threads newer than it). Events
          // and projections are current to the drain snapshot; the small
          // tables to the start of their copy. The older of the two is honest.
          const previous = Date.parse(getMeta("updated_at") ?? "") || 0;
          meta(
            "updated_at",
            new Date(
              Math.max(Math.min(confirmedAt, auxiliaryCapturedAt ?? confirmedAt), previous + 1),
            ).toISOString(),
          );
          // Bind capability evidence to this publication. An older exporter
          // leaves it behind, so readers safely fall back after a downgrade.
          meta("lineage_repair_watermark", getMeta("updated_at")!);
          ensureIdentityVersions();
          meta("ready", "1");
          meta("generation", String(Number(getMeta("generation") ?? 0) + 1));
          if (rebuild) meta("rebuild_finished_at", new Date(Date.now()).toISOString());
          // Full catch-up already copied every identity through this snapshot.
          // Persist that scan progress so a restart cannot replay an old prefix.
          meta("identity_sequence", String(Math.max(identitySequence, cycleTarget!)));
          out
            .prepare(
              "DELETE FROM ardud_readonly_meta WHERE key IN ('rebuild_held_until','rebuild_held_notice_at')",
            )
            .run();
        });
      } finally {
        unpin();
      }
      drainPages = drainPagesInitial;
      // Readers switch from the previous generation to this one atomically.
      if (cycleTransaction) {
        commitCycle();
      }
      pendingAuxiliarySchemas.clear();
      identitySequence = Math.max(identitySequence, cycleTarget!);
      cycleTarget = undefined;
      auxiliaryIndex = 0;
      auxiliaryCursor = 0;
      auxiliaryCapturedAt = undefined;
      if (rebuild) {
        meta("rebuild_finished_at", new Date(Date.now()).toISOString());
        rebuildEvent("publish");
        rebuild = undefined;
      }
      return false;
    };
    return {
      pollIdentities() {
        try {
          assertRedactionComplete();
          validate();
          return publishIdentities();
        } catch (error) {
          if (abortCycle()) invalidated ??= "Readonly refresh cycle aborted; reopen exporter";
          recordFailure(error);
          throw error;
        }
      },
      takeMetrics() {
        const result = metrics;
        metrics = emptyMetrics();
        return result;
      },
      /** One bounded page; false means caught up, ready for the next interval. */
      step(): boolean {
        try {
          assertRedactionComplete();
          validate();
          publishIdentities();
          return measure("step", stepOnce);
        } catch (error) {
          // Discarding a routine cycle leaves the in-memory cursors ahead of
          // the replica; this exporter must be reopened. Readers keep the last
          // published generation, which goes stale if the failure persists.
          if (abortCycle()) invalidated ??= "Readonly refresh cycle aborted; reopen exporter";
          recordFailure(error);
          throw error;
        } finally {
          heartbeatRebuild();
        }
      },
      close() {
        if (!closed) {
          closed = true;
          // An unfinished cycle is discarded; readers keep the last generation.
          abortCycle();
          if (rebuild) {
            rebuildEvent("abort", new Error("exporter closed before publication"));
            rebuild = undefined;
          }
          out.close();
          boards?.close();
          archive?.close();
          baseArchive?.close();
          source.close();
        }
      },
    };
  } catch (error) {
    if (target?.isOpen) recordFailure(error);
    target?.close();
    boards?.close();
    archive?.close();
    baseArchive?.close();
    source.close();
    throw error;
  }
}
