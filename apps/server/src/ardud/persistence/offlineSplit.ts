// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off - Offline installer owns synchronous SQLite and filesystem handles outside the server runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { validateOfflineArchive } from "./validateOfflineArchive.ts";

const EVENTS = "orchestration_events";
const ITEMS = "orchestration_v2_projection_turn_items";
const BASE = "ardud_history_base_archive";
const qi = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

export interface OfflineSplitOptions {
  readonly source: string;
  readonly acknowledgeStopped: boolean;
  readonly dryRun?: boolean;
  readonly idleDays?: number;
  readonly batchSize?: number;
  readonly now?: Date;
  readonly progress?: (line: string) => void;
  /** Read-only verification with the replacement closed, before and after swap. */
  readonly validate?: (filename: string) => void;
}

interface SchemaRow {
  type: string;
  name: string;
  sql: string | null;
}

interface TableProgress {
  lastRowid: number;
  copied: number;
  done: boolean;
}

interface SplitMarker {
  version: 1;
  phase: "copying" | "indexed" | "validated" | "linked" | "swapped" | "done";
  source: string;
  output: string;
  archive: string;
  cutoff: string;
  idleDays: number;
  sourceIdentity: string;
  tables: Record<string, TableProgress>;
}

export class OfflineSplitError extends Error {
  readonly exitCode: 1 | 70;
  constructor(message: string, exitCode: 1 | 70 = 1) {
    super(message);
    this.name = "OfflineSplitError";
    this.exitCode = exitCode;
  }
}

const exists = (file: string) => {
  try {
    NodeFS.lstatSync(file);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
};

const syncFile = (filename: string) => {
  const fd = NodeFS.openSync(filename, "r");
  try {
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
};

const identity = (filename: string) => {
  const stat = NodeFS.statSync(filename, { bigint: true });
  const fd = NodeFS.openSync(filename, "r");
  const header = Buffer.alloc(100);
  try {
    if (NodeFS.readSync(fd, header, 0, header.length, 0) !== header.length)
      throw new Error("Incomplete SQLite source header.");
  } finally {
    NodeFS.closeSync(fd);
  }
  // Some filesystems expose coarse mtimes. SQLite's change counter/schema
  // cookie still fence committed writes that leave file size and mtime equal.
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${header.toString("hex")}`;
};

const pragma = (db: NodeSqlite.DatabaseSync, name: string) => {
  const value = db.prepare(`PRAGMA ${name}`).get()?.[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`Invalid SQLite ${name}`);
  return value;
};

const count = (db: NodeSqlite.DatabaseSync, sql: string) => {
  const value = db.prepare(sql).get()?.n;
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error("Invalid SQLite row count");
  return value;
};

const assertStopped = (directory: string) => {
  const runtime = NodePath.join(directory, "server-runtime.json");
  if (!exists(runtime)) return;
  const state: unknown = JSON.parse(NodeFS.readFileSync(runtime, "utf8"));
  if (
    typeof state !== "object" ||
    state === null ||
    !("pid" in state) ||
    typeof state.pid !== "number" ||
    !Number.isSafeInteger(state.pid) ||
    state.pid <= 0
  )
    throw new Error("Cannot verify server-runtime.json; resolve it before offline maintenance.");
  try {
    process.kill(state.pid, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
    throw error;
  }
  throw new Error(`Server PID ${state.pid} is still alive. No process was stopped.`);
};

const assertDurable = (directory: string) => {
  for (const root of [NodeOS.tmpdir(), "/tmp", "/private/tmp", "/var/tmp", "/dev/shm"]) {
    const real = exists(root) ? NodeFS.realpathSync(root) : root;
    const relative = NodePath.relative(real, directory);
    if (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${NodePath.sep}`) &&
        !NodePath.isAbsolute(relative))
    )
      throw new Error("Refusing a temporary directory; use the source's durable filesystem.");
  }
};

const markerWrite = (filename: string, marker: SplitMarker) => {
  const pending = filename + ".next";
  NodeFS.writeFileSync(pending, JSON.stringify(marker, null, 2) + "\n", { mode: 0o600 });
  syncFile(pending);
  NodeFS.renameSync(pending, filename);
  syncFile(NodePath.dirname(filename));
};

const readMarker = (filename: string, source: string): SplitMarker => {
  const marker = JSON.parse(NodeFS.readFileSync(filename, "utf8")) as SplitMarker;
  const directory = NodePath.dirname(source);
  if (
    marker.version !== 1 ||
    marker.source !== source ||
    NodePath.dirname(marker.output) !== directory ||
    NodePath.dirname(marker.archive) !== directory ||
    !["copying", "indexed", "validated", "linked", "swapped", "done"].includes(marker.phase) ||
    marker.output === source ||
    marker.archive === source ||
    marker.archive === marker.output ||
    !Number.isFinite(Date.parse(marker.cutoff)) ||
    !marker.tables
  )
    throw new Error("Invalid split marker; preserve all files and inspect the marker.");
  for (const file of [marker.output, marker.archive])
    if (exists(file)) {
      const stat = NodeFS.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("Split marker paths must be regular sibling files, not symlinks.");
    }
  return marker;
};

const acquireJobLock = (filename: string) => {
  if (exists(filename)) {
    const previous = Number(NodeFS.readFileSync(filename, "utf8").trim());
    if (!Number.isSafeInteger(previous) || previous <= 0)
      throw new Error("Invalid split process lock.");
    try {
      process.kill(previous, 0);
      throw new Error(`Offline split PID ${previous} is still alive.`);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
    NodeFS.unlinkSync(filename);
  }
  const fd = NodeFS.openSync(filename, "wx", 0o600);
  NodeFS.writeFileSync(fd, `${process.pid}\n`);
  NodeFS.fsyncSync(fd);
  return fd;
};

const schema = (db: NodeSqlite.DatabaseSync) =>
  db
    .prepare(
      "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY rowid",
    )
    .all() as unknown as SchemaRow[];

const assertSpace = (directory: string, reserveBytes = 64 * 1024 ** 2) => {
  const disk = NodeFS.statfsSync(directory);
  if (disk.bavail * disk.bsize < reserveBytes)
    throw new Error(
      "Insufficient free disk headroom; original is preserved and the copy can be resumed.",
    );
};

const baseArchive = (db: NodeSqlite.DatabaseSync) => {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(BASE))
    return undefined;
  const rows = db.prepare(`SELECT filename FROM ${BASE}`).all();
  if (rows.length === 0) return undefined;
  const filename = rows[0]?.filename;
  if (rows.length !== 1 || typeof filename !== "string" || NodePath.basename(filename) !== filename)
    throw new Error("Invalid base archive pointer.");
  return filename;
};

const assertQuickCheck = (db: NodeSqlite.DatabaseSync) => {
  const rows = db.prepare("PRAGMA quick_check").all();
  if (rows.length !== 1 || rows[0]?.quick_check !== "ok")
    throw new Error("Replacement failed quick_check.");
};

const restoreOriginal = (marker: SplitMarker, markerPath: string, cause: unknown): never => {
  const restore = marker.archive + ".restore";
  try {
    if (!exists(restore)) NodeFS.linkSync(marker.archive, restore);
    if (identity(restore) !== identity(marker.archive))
      throw new Error("Rollback hardlink differs from original.");
    if (!exists(marker.output)) NodeFS.linkSync(marker.source, marker.output);
    for (const suffix of ["-wal", "-shm", "-journal"])
      if (exists(marker.source + suffix)) {
        if (exists(marker.output + suffix))
          throw new Error(`Rollback sidecar destination exists: ${suffix}`);
        NodeFS.renameSync(marker.source + suffix, marker.output + suffix);
      }
    NodeFS.renameSync(restore, marker.source);
    syncFile(NodePath.dirname(marker.source));
    marker.phase = "indexed";
    markerWrite(markerPath, marker);
  } catch (error) {
    throw new OfflineSplitError(
      `Split failed and original could not be restored: ${String(error)}; preserve all files.`,
      70,
    );
  }
  throw new OfflineSplitError(`Split failed; original restored: ${String(cause)}`);
};

/** Offline only. Never copies cold payloads or compacts the old database. */
export function offlineSplit(options: OfflineSplitOptions) {
  if (!options.acknowledgeStopped)
    throw new Error(
      "Pass --acknowledge-stopped after stopping Robob, supervisors, and all external readers.",
    );
  const source = NodeFS.realpathSync(options.source);
  const directory = NodePath.dirname(source);
  assertDurable(directory);
  if (!NodeFS.statSync(source).isFile()) throw new Error("Source must be a regular SQLite file.");
  const idleDays = options.idleDays ?? 7;
  const batchSize = options.batchSize ?? 2_000;
  if (
    !Number.isFinite(idleDays) ||
    idleDays < 0 ||
    !Number.isSafeInteger(batchSize) ||
    batchSize <= 0
  )
    throw new Error("idle-days must be nonnegative; batch-size must be a positive integer.");
  assertStopped(directory);
  const started = Date.now();
  const progress = (message: string) =>
    options.progress?.(
      `[offline-split +${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`,
    );
  const markerPath = source + ".offline-split.json";
  const lockPath = source + ".offline-split.lock";
  let lockFd: number | undefined;
  let owner: NodeSqlite.DatabaseSync | undefined;
  let input: NodeSqlite.DatabaseSync | undefined;
  let output: NodeSqlite.DatabaseSync | undefined;
  let marker: SplitMarker | undefined;
  let swapped = false;
  try {
    owner = new NodeSqlite.DatabaseSync(NodePath.join(directory, "server-owner.sqlite"));
    owner.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
    lockFd = acquireJobLock(lockPath);
    assertStopped(directory);
    marker = exists(markerPath) ? readMarker(markerPath, source) : undefined;
    // A crash after rename but before the marker write is detected by the pointer.
    const probe = new NodeSqlite.DatabaseSync(source, { readOnly: true });
    let installedBase: string | undefined;
    try {
      installedBase = baseArchive(probe);
    } finally {
      probe.close();
    }
    if (installedBase) {
      if (!exists(NodePath.join(directory, installedBase)))
        throw new OfflineSplitError("Base archive is missing; do not launch.", 70);
      if (marker && NodePath.basename(marker.archive) !== installedBase)
        throw new Error("Split marker and installed base differ.");
      if (marker && marker.phase !== "done" && !options.dryRun) {
        try {
          output = new NodeSqlite.DatabaseSync(source, { readOnly: true });
          assertQuickCheck(output);
          output.close();
          output = undefined;
          options.validate?.(source);
          marker.phase = "done";
          markerWrite(markerPath, marker);
        } catch (error) {
          output?.close();
          output = undefined;
          restoreOriginal(marker, markerPath, error);
        }
      }
      progress("already split; original archive and live database preserved");
      return { dryRun: !!options.dryRun, alreadyDone: true, source, archive: installedBase };
    }
    if (
      marker?.phase === "swapped" &&
      exists(marker.archive) &&
      identity(marker.archive) === identity(source)
    ) {
      // Rollback itself may have been interrupted after restoring the old name.
      marker.phase = "indexed";
      markerWrite(markerPath, marker);
    }
    if (marker?.phase === "done" || marker?.phase === "swapped")
      throw new OfflineSplitError(
        "Completed split marker but live pointer is missing; preserve files and restore before launch.",
        70,
      );
    input = new NodeSqlite.DatabaseSync(source, { readOnly: !!options.dryRun });
    // The owner lock prevents restart; exclusive SQLite locking also refuses
    // external readers. WAL readers must leave before checkpoint and swap.
    input.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;");
    const definitions = schema(input);
    const tables = definitions.filter((row) => row.type === "table");
    if (
      !tables.some((row) => row.name === EVENTS) ||
      !tables.some((row) => row.name === ITEMS) ||
      !tables.some((row) => row.name === "orchestration_v2_projection_threads")
    )
      throw new Error("Expected statev2 history and thread tables are missing.");
    if (tables.some((row) => /CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql ?? "")))
      throw new Error(
        "Virtual tables require an explicit copy strategy; original was not replaced.",
      );
    if (marker && marker.sourceIdentity !== identity(source))
      throw new Error(
        "Original changed since interrupted split; preserve files and inspect before retrying.",
      );
    const cutoff =
      marker?.cutoff ??
      new Date((options.now ?? new Date()).getTime() - idleDays * 86_400_000).toISOString();
    progress("discovering cold threads and retained history keys using metadata indexes");
    const hasColumns = (table: string, columns: string[]) => {
      if (!tables.some((row) => row.name === table)) return false;
      const present = input!.prepare(`PRAGMA table_info(${qi(table)})`).all();
      return columns.every((column) => present.some((row) => row.name === column));
    };
    const guards = [
      [
        "orchestration_v2_projection_runs",
        "status IN ('queued','preparing','pending','starting','running','waiting')",
        "status",
      ],
      [
        "orchestration_v2_projection_runtime_requests",
        "status IN ('pending','starting','running','waiting')",
        "status",
      ],
      [
        "orchestration_v2_effect_outbox",
        "status IN ('pending','starting','running','waiting')",
        "status",
      ],
      [
        "orchestration_v2_projection_subagents",
        "status IN ('pending','starting','running','waiting')",
        "status",
      ],
      [ITEMS, "status IN ('pending','starting','running','waiting')", "status"],
      [
        "orchestration_v2_legacy_imports",
        "transcript_imported_at IS NULL",
        "transcript_imported_at",
      ],
      [
        "orchestration_v2_projection_provider_threads",
        "json_array_length(payload_json, '$.pendingBackgroundTasks') > 0",
        "payload_json",
      ],
    ] as const;
    const availableGuards = guards.filter(([table, , column]) =>
      hasColumns(table, ["thread_id", column]),
    );
    const pendingGuards = availableGuards
      .map(
        ([table, condition]) =>
          `NOT EXISTS (SELECT 1 FROM ${qi(table)} AS pending WHERE pending.thread_id=thread.thread_id AND ${condition})`,
      )
      .join(" AND ");
    const indexes = input.prepare(`PRAGMA index_list(${EVENTS})`).all();
    const indexNamed = (name: string) =>
      indexes.some((row) => row.name === name) ? name : undefined;
    const coveringStream =
      indexNamed("idx_orch_events_stream_sequence") ??
      indexes.find((row) => {
        const columns = input!
          .prepare(`PRAGMA index_info(${qi(String(row.name))})`)
          .all()
          .map((column) => column.name);
        return (
          row.partial === 0 &&
          columns[0] === "aggregate_kind" &&
          columns[1] === "stream_id" &&
          columns[2] === "sequence"
        );
      })?.name;
    const streamHint = coveringStream ? `INDEXED BY ${qi(String(coveringStream))}` : "";
    const applicationIndex = indexNamed("idx_orchestration_events_application_sequence");
    const createdIndex = indexNamed("orchestration_events_v2_created_threads_idx");
    const itemIndexes = input.prepare(`PRAGMA index_list(${ITEMS})`).all();
    const itemThreadIndex = itemIndexes.find(
      (row) =>
        row.partial === 0 &&
        input!.prepare(`PRAGMA index_info(${qi(String(row.name))})`).all()[0]?.name === "thread_id",
    )?.name;
    const itemHint = itemThreadIndex ? `INDEXED BY ${qi(String(itemThreadIndex))}` : "";
    input.exec(`PRAGMA temp_store=MEMORY; PRAGMA cache_size=-32768;
      CREATE TEMP TABLE cold_threads(thread_id TEXT PRIMARY KEY) WITHOUT ROWID;
      INSERT INTO cold_threads SELECT thread.thread_id FROM orchestration_v2_projection_threads AS thread
      WHERE (thread.archived_at IS NOT NULL OR julianday(thread.updated_at) <= julianday(${literal(cutoff)}))
        ${pendingGuards ? `AND ${pendingGuards}` : ""};
      CREATE TEMP TABLE event_streams(aggregate_kind TEXT,stream_id TEXT,latest_sequence INTEGER,PRIMARY KEY(aggregate_kind,stream_id)) WITHOUT ROWID;
      INSERT INTO event_streams SELECT aggregate_kind,stream_id,MAX(sequence) FROM orchestration_events ${streamHint} GROUP BY aggregate_kind,stream_id;
      CREATE TEMP TABLE keep_event_keys(sequence INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO keep_event_keys SELECT latest_sequence FROM event_streams;
      INSERT OR IGNORE INTO keep_event_keys SELECT sequence FROM orchestration_events ${streamHint} WHERE aggregate_kind <> 'thread';
      INSERT OR IGNORE INTO keep_event_keys SELECT sequence FROM orchestration_events ${applicationIndex ? `INDEXED BY ${qi(applicationIndex)}` : ""} WHERE application_event_version <> 2;
      INSERT OR IGNORE INTO keep_event_keys SELECT sequence FROM orchestration_events ${createdIndex ? `INDEXED BY ${qi(createdIndex)}` : ""}
        WHERE aggregate_kind='thread' AND application_event_version=2 AND event_type='thread.created';
      INSERT OR IGNORE INTO keep_event_keys SELECT event.sequence FROM event_streams AS stream
        CROSS JOIN orchestration_events AS event ${streamHint}
        WHERE stream.aggregate_kind='thread' AND stream.stream_id NOT IN (SELECT thread_id FROM cold_threads)
          AND event.aggregate_kind=stream.aggregate_kind AND event.stream_id=stream.stream_id;
      CREATE TEMP TABLE keep_item_keys(item_rowid INTEGER PRIMARY KEY);
      INSERT INTO keep_item_keys SELECT rowid FROM ${ITEMS} ${itemHint} WHERE thread_id NOT IN (SELECT thread_id FROM cold_threads);`);
    const itemKeep = "thread_id NOT IN (SELECT thread_id FROM cold_threads)";
    const filter = (table: string) => (table === ITEMS ? itemKeep : "1");
    const pages = pragma(input, "page_count");
    const pageSize = pragma(input, "page_size");
    const freePages = pragma(input, "freelist_count");
    if (options.dryRun) {
      progress(
        "counting kept history rows exactly; full eligibility scan, without decoding payload JSON",
      );
      const events = count(input, `SELECT COUNT(*) AS n FROM ${EVENTS}`);
      const keepEvents = count(input, "SELECT COUNT(*) AS n FROM keep_event_keys");
      const items = count(input, `SELECT COUNT(*) AS n FROM ${ITEMS}`);
      const keepItems = count(input, "SELECT COUNT(*) AS n FROM keep_item_keys");
      const ratio = (keepEvents + keepItems) / Math.max(1, events + items);
      const estimatedCopyBytes = Math.ceil((pages - freePages) * pageSize * ratio);
      const disk = NodeFS.statfsSync(directory);
      return {
        dryRun: true,
        source,
        idleDays,
        cutoff,
        pageCount: pages,
        pageSize,
        freePages,
        coldThreads: count(input, "SELECT COUNT(*) AS n FROM cold_threads"),
        events: { keep: keepEvents, move: events - keepEvents },
        turnItems: { keep: keepItems, move: items - keepItems },
        estimatedCopyBytes,
        availableBytes: disk.bavail * disk.bsize,
        estimatedSecondsAt100MiBPerSecond: Math.ceil(estimatedCopyBytes / (100 * 1024 ** 2)),
        estimateNote:
          "Exact eligibility counts; byte/ETA estimate scales used pages by kept history row fraction. Control tables, payload skew, indexes and disk speed can change it. Cold rows stay in the original file; no payload move or VACUUM is performed.",
      };
    }
    const checkpoint = input.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (checkpoint && checkpoint.busy !== 0)
      throw new Error("Source WAL checkpoint is busy; original was not replaced.");
    // DELETE mode leaves the preserved base self-contained. Never pair its WAL
    // with the replacement; the old inode is untouched after this checkpoint.
    const journal = input.prepare("PRAGMA journal_mode=DELETE").get()?.journal_mode;
    if (journal !== "delete") throw new Error("Could not make the original WAL-free.");
    if (marker && marker.sourceIdentity !== identity(source))
      throw new Error(
        "Original changed since interrupted split; preserve files and inspect before retrying.",
      );
    if (!marker) {
      const stamp = (options.now ?? new Date()).toISOString().replaceAll(/[^0-9]/g, "");
      const stem = NodePath.basename(source).replace(/\.sqlite$/, "");
      marker = {
        version: 1,
        phase: "copying",
        source,
        output: NodePath.join(directory, `${stem}.split-${stamp}.sqlite`),
        archive: NodePath.join(directory, `${stem}.pre-shrink-${stamp}.sqlite`),
        cutoff,
        idleDays,
        sourceIdentity: identity(source),
        tables: {},
      };
      for (const filename of [marker.output, marker.archive])
        for (const suffix of ["", "-wal", "-shm", "-journal"])
          if (exists(filename + suffix))
            throw new Error(`Refusing to overwrite ${filename + suffix}`);
      markerWrite(markerPath, marker);
    }
    if (marker.idleDays !== idleDays)
      throw new Error("Resume with the marker's original --idle-days value.");
    progress(
      `phase=${marker.phase}; copying only kept rows; base=${NodePath.basename(marker.archive)}`,
    );
    if (marker.phase === "copying") {
      assertSpace(directory);
      const isNew = !exists(marker.output);
      if (isNew) NodeFS.closeSync(NodeFS.openSync(marker.output, "wx", 0o600));
      if (NodeFS.statSync(marker.output).dev !== NodeFS.statSync(source).dev)
        throw new Error("Replacement must be on the source volume.");
      output = new NodeSqlite.DatabaseSync(marker.output);
      output.exec(
        "PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=OFF; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-32768;",
      );
      if (isNew || !output.prepare("SELECT 1 FROM sqlite_schema WHERE type='table'").get()) {
        output.exec(`PRAGMA page_size=${pageSize}; PRAGMA auto_vacuum=INCREMENTAL;`);
        output.exec("BEGIN");
        try {
          for (const table of tables) if (table.sql) output.exec(table.sql);
          output.exec(`CREATE TABLE IF NOT EXISTS ${BASE}(filename TEXT NOT NULL)`);
          output.exec("COMMIT");
        } catch (error) {
          output.exec("ROLLBACK");
          throw error;
        }
      }
      // Read through the locked handle; an attached second connection would
      // conflict with the source's lifetime exclusive SQLite lock.
      for (const table of tables) {
        if (table.name === BASE) continue;
        const state = marker.tables[table.name] ?? {
          lastRowid: Number.MIN_SAFE_INTEGER,
          copied: 0,
          done: false,
        };
        marker.tables[table.name] = state;
        if (state.done) continue;
        const columns = input
          .prepare(`PRAGMA table_xinfo(${qi(table.name)})`)
          .all()
          .filter((row) => row.hidden === 0)
          .map((row) => String(row.name));
        const columnSql = columns.map(qi).join(", ");
        const withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(table.sql ?? "");
        const primaryKey = input
          .prepare(`PRAGMA table_info(${qi(table.name)})`)
          .all()
          .filter((row) => Number(row.pk) > 0)
          .sort((a, b) => Number(a.pk) - Number(b.pk))
          .map((row) => qi(String(row.name)))
          .join(", ");
        const copiedColumns = withoutRowid ? columns.map(qi) : ["rowid", ...columns.map(qi)];
        const insert = output.prepare(
          `INSERT OR REPLACE INTO ${qi(table.name)}(${copiedColumns.join(", ")}) VALUES(${copiedColumns.map(() => "?").join(",")})`,
        );
        const keyTable =
          table.name === EVENTS
            ? "keep_event_keys"
            : table.name === ITEMS
              ? "keep_item_keys"
              : undefined;
        const keyColumn = table.name === EVENTS ? "sequence" : "item_rowid";
        const readSql = keyTable
          ? `SELECT source.rowid AS __split_rowid, ${columns.map((column) => `source.${qi(column)}`).join(", ")}
            FROM (SELECT ${keyColumn} FROM ${keyTable} WHERE ${keyColumn} > ? ORDER BY ${keyColumn} LIMIT ?) AS retained
            CROSS JOIN ${qi(table.name)} AS source WHERE source.rowid=retained.${keyColumn} ORDER BY retained.${keyColumn}`
          : withoutRowid
            ? `SELECT ${columnSql} FROM ${qi(table.name)} WHERE ${filter(table.name)} ORDER BY ${primaryKey} LIMIT ? OFFSET ?`
            : `SELECT rowid AS __split_rowid, ${columnSql} FROM ${qi(table.name)} WHERE rowid > ? AND ${filter(table.name)} ORDER BY rowid LIMIT ?`;
        const read = input.prepare(readSql);
        if (keyTable) {
          const plan = input
            .prepare(`EXPLAIN QUERY PLAN ${readSql}`)
            .all(state.lastRowid, batchSize)
            .map((row) => String(row.detail))
            .join("; ");
          if (!plan.includes("SEARCH source USING INTEGER PRIMARY KEY"))
            throw new Error(`History copy must use retained-key primary lookups: ${plan}`);
          progress(`${table.name}: retained-key payload plan: ${plan}`);
        }
        while (true) {
          assertSpace(directory);
          const batch = withoutRowid
            ? read.iterate(batchSize, state.copied)
            : read.iterate(state.lastRowid, batchSize);
          let copied = 0;
          let lastRowid = state.lastRowid;
          output.exec("BEGIN");
          try {
            // A single tool payload can be megabytes; don't materialize an
            // entire row batch in memory just to copy it into SQLite again.
            for (const row of batch) {
              const values = columns.map((column) => row[column]!);
              insert.run(...(withoutRowid ? values : [row.__split_rowid!, ...values]));
              copied++;
              if (!withoutRowid) lastRowid = Number(row.__split_rowid);
            }
            output.exec("COMMIT");
          } catch (error) {
            output.exec("ROLLBACK");
            throw error;
          }
          state.lastRowid = lastRowid;
          state.copied += copied;
          state.done = copied < batchSize;
          markerWrite(markerPath, marker);
          progress(`${table.name}: ${state.copied} rows; rowid=${state.lastRowid}`);
          if (state.done) {
            progress(`${table.name}: ${state.copied} rows complete`);
            break;
          }
        }
      }
      progress("recreating indexes, views and triggers");
      assertSpace(directory);
      output.exec("BEGIN");
      try {
        for (const definition of definitions)
          if (definition.type !== "table" && definition.sql) {
            output.exec(`DROP ${definition.type.toUpperCase()} IF EXISTS ${qi(definition.name)}`);
            output.exec(definition.sql);
          }
        if (input.prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").get()) {
          output.exec("DELETE FROM sqlite_sequence");
          const insert = output.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES(?, ?)");
          for (const row of input.prepare("SELECT name, seq FROM sqlite_sequence").all())
            insert.run(row.name!, row.seq!);
        }
        output.exec(`DELETE FROM ${BASE}; INSERT INTO ${BASE}(filename) VALUES(${literal(NodePath.basename(marker.archive))});
          PRAGMA user_version=${pragma(input, "user_version")}; PRAGMA application_id=${pragma(input, "application_id")}; COMMIT;`);
      } catch (error) {
        output.exec("ROLLBACK");
        throw error;
      }
      output.close();
      output = undefined;
      syncFile(marker.output);
      marker.phase = "indexed";
      markerWrite(markerPath, marker);
    }
    if (marker.phase === "indexed") {
      progress("validating quick_check, row counts and schema versions");
      output = new NodeSqlite.DatabaseSync(marker.output, { readOnly: true });
      assertQuickCheck(output);
      for (const table of tables)
        if (table.name !== BASE) {
          const expected = marker.tables[table.name]?.copied;
          const actual = count(output, `SELECT COUNT(*) AS n FROM ${qi(table.name)}`);
          if (actual !== expected)
            throw new Error(`Row count mismatch for ${table.name}: ${actual} != ${expected}`);
        }
      for (const name of ["user_version", "application_id"])
        if (pragma(input, name) !== pragma(output, name))
          throw new Error(`Schema version mismatch: ${name}`);
      const actualSchema = schema(output);
      for (const expected of definitions)
        if (
          !actualSchema.some(
            (row) =>
              row.type === expected.type && row.name === expected.name && row.sql === expected.sql,
          )
        )
          throw new Error(`Schema mismatch for ${expected.name}`);
      output.close();
      output = undefined;
      marker.phase = "validated";
      markerWrite(markerPath, marker);
    }
    if (marker.sourceIdentity !== identity(source))
      throw new Error("Source changed before swap; original was not replaced.");
    if (marker.phase === "validated") {
      if (!exists(marker.archive)) NodeFS.linkSync(source, marker.archive);
      if (identity(marker.archive) !== identity(source))
        throw new Error("Preserved base is not the original inode.");
      syncFile(marker.archive);
      syncFile(directory);
      marker.phase = "linked";
      markerWrite(markerPath, marker);
    }
    if (marker.phase === "linked") {
      if (identity(marker.archive) !== identity(source))
        throw new Error("Preserved base is not the original inode.");
      // The durable hardlink means statev2.sqlite never vanishes. Close before
      // renaming so no connection can checkpoint into the preserved inode.
      input.close();
      input = undefined;
      for (const suffix of ["-wal", "-shm", "-journal"])
        if (exists(source + suffix)) {
          // SQLite can leave a stale SHM after a crash even after checkpoint and
          // conversion to DELETE mode. Preserve it with the base, never the new DB.
          if (suffix !== "-shm" && NodeFS.statSync(source + suffix).size !== 0)
            throw new Error(
              `Nonempty source sidecar after clean checkpoint: ${suffix}; do not swap.`,
            );
          if (exists(marker.archive + suffix))
            throw new Error(`Preserved sidecar already exists: ${suffix}`);
          NodeFS.renameSync(source + suffix, marker.archive + suffix);
        }
      syncFile(directory);
      // The callback can open the actual union reader: the preserved basename
      // exists now, and all SQLite handles are closed except the owner lock.
      options.validate?.(marker.output);
      input = new NodeSqlite.DatabaseSync(source);
      input.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;");
      if (marker.sourceIdentity !== identity(source))
        throw new Error("Source changed during server validation; do not swap.");
      NodeFS.renameSync(marker.output, source);
      swapped = true;
      syncFile(directory);
      // DELETE-mode source has no pending transaction or WAL; releasing this
      // handle only unlocks the archived inode, never checkpoints the new one.
      input.close();
      input = undefined;
      marker.phase = "swapped";
      markerWrite(markerPath, marker);
      progress("replacement installed atomically; checking final open");
      output = new NodeSqlite.DatabaseSync(source, { readOnly: true });
      if (baseArchive(output) !== NodePath.basename(marker.archive))
        throw new Error("Installed base pointer differs.");
      assertQuickCheck(output);
      output.close();
      output = undefined;
      options.validate?.(source);
    }
    marker.phase = "done";
    markerWrite(markerPath, marker);
    progress(
      `done; live=${NodeFS.statSync(source).size} bytes; preserved=${NodePath.basename(marker.archive)}`,
    );
    return {
      dryRun: false,
      alreadyDone: false,
      source,
      archive: NodePath.basename(marker.archive),
      outputBytes: NodeFS.statSync(source).size,
      elapsedSeconds: (Date.now() - started) / 1000,
    };
  } catch (error) {
    output?.close();
    output = undefined;
    if (swapped && marker) restoreOriginal(marker, markerPath, error);
    throw error;
  } finally {
    try {
      output?.close();
    } finally {
      try {
        input?.close();
      } finally {
        try {
          if (lockFd !== undefined) {
            NodeFS.closeSync(lockFd);
            NodeFS.unlinkSync(lockPath);
          }
        } finally {
          owner?.close();
        }
      }
    }
  }
}

export function main(args: string[] = process.argv.slice(2)): number {
  try {
    const { values } = NodeUtil.parseArgs({
      args,
      options: {
        source: { type: "string" },
        "acknowledge-stopped": { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        "idle-days": { type: "string", default: "7" },
        "batch-size": { type: "string", default: "2000" },
        help: { type: "boolean", default: false },
      },
    });
    if (values.help) {
      console.log(
        "Usage: offline-split.mjs --source /durable/userdata/statev2.sqlite --acknowledge-stopped [--dry-run] [--idle-days 7] [--batch-size 2000]\nStop Robob, supervisors and external database readers first. Copies only kept rows, preserves the original as a read-only base archive, and atomically replaces the live database. Rerun the identical command to resume. Exit 0: complete; 1: original kept/restored; 70: manual recovery required. No original is deleted.",
      );
      return 0;
    }
    if (!values.source) throw new Error("Explicit --source is required. See --help.");
    console.log(
      JSON.stringify(
        offlineSplit({
          source: values.source,
          acknowledgeStopped: values["acknowledge-stopped"],
          dryRun: values["dry-run"],
          idleDays: Number(values["idle-days"]),
          batchSize: Number(values["batch-size"]),
          progress: (line) => console.error(line),
          validate: validateOfflineArchive,
        }),
        null,
        2,
      ),
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return error instanceof OfflineSplitError ? error.exitCode : 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
)
  process.exitCode = main();
