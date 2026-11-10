// @effect-diagnostics nodeBuiltinImport:off globalDate:off - serialized worker has no Effect runtime; these are its native boundary types and clock.
import type * as NodeSqlite from "node:sqlite";
import type * as NodeFS from "node:fs";
import type * as NodePath from "node:path";

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
}

/** Self-contained for the packaged server's eval worker. No live write handle. */
export function createReadonlyReplica(
  sqlite: typeof NodeSqlite,
  fs: typeof NodeFS,
  path: typeof NodePath,
  options: ReadonlyReplicaOptions,
) {
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
  ];
  const selectedItems = new Set(["user_message", "error", "run_interrupt_request"]);
  const source = new sqlite.DatabaseSync(options.sourcePath, { readOnly: true });
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
    const baseFilename = () => {
      if (
        !source.prepare("SELECT 1 FROM sqlite_schema WHERE name='ardud_history_base_archive'").get()
      )
        return undefined;
      const rows = source.prepare("SELECT filename FROM ardud_history_base_archive LIMIT 2").all();
      if (rows.length === 0) return undefined;
      const filename = rows[0]!.filename;
      if (
        rows.length !== 1 ||
        typeof filename !== "string" ||
        !/^statev2\.pre-shrink-[^/\\]+\.sqlite$/.test(filename) ||
        path.basename(filename) !== filename
      )
        throw new Error("Invalid readonly history base filename");
      return filename;
    };
    const baseName = baseFilename();
    const basePath = baseName ? path.join(path.dirname(options.sourcePath), baseName) : undefined;
    if (basePath) {
      if (!fs.existsSync(basePath)) throw new Error("Readonly history base unavailable");
      baseArchive = new sqlite.DatabaseSync(basePath, { readOnly: true });
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
      archive = new sqlite.DatabaseSync(options.archivePath, { readOnly: true });
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
      boards = new sqlite.DatabaseSync(options.boardPath, { readOnly: true });
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
    target = new sqlite.DatabaseSync(options.replicaPath);
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
      ${bookkeeping}`);
    const out = target;
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
    const nextGeneration = () => {
      const n = Number(getMeta("generation") ?? 0) + 1;
      meta("generation", String(n));
      return n;
    };
    const sequence = () =>
      Math.max(
        Number(source.prepare("SELECT max(sequence) AS n FROM orchestration_events").get()?.n ?? 0),
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
    // After bootstrap, a routine cycle runs in one replica write transaction.
    // WAL readers keep the previous completed generation (ready=1, old
    // updated_at) until it commits, so readiness is not cleared per cycle.
    let cycleTransaction = false;
    let invalidated: string | undefined;
    const transaction = <A>(body: () => A) => {
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
          throw error;
        }
      }
      out.exec("BEGIN IMMEDIATE");
      try {
        const result = body();
        out.exec("COMMIT");
        return result;
      } catch (error) {
        out.exec("ROLLBACK");
        throw error;
      }
    };
    const abortCycle = () => {
      if (!cycleTransaction) return false;
      cycleTransaction = false;
      try {
        out.exec("ROLLBACK");
      } catch {
        // SQLite may already have rolled the transaction back after an I/O error.
      }
      return true;
    };
    /** Structural changes: drop any open cycle and refuse readers until rebuilt. */
    const invalidate = (message: string) => {
      invalidated = message;
      abortCycle();
      meta("ready", "0");
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
    const normalizeSchema = (value: string) =>
      value
        .replace(/\s+/g, "")
        .replace(/IFNOTEXISTS/gi, "")
        .toLowerCase();
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
    // A replaced source, a changed table or a regressed event history cannot be
    // caught up incrementally. Rebuild in place instead of refusing every open
    // until someone deletes the file: readers see ready=0 until the fresh
    // generation publishes, exactly as on a first bootstrap.
    const storedSource = getMeta("source");
    const storedSequence = getMeta("sequence");
    const changedTable = sourceTables.find(({ name, schema }) => {
      const previous = getMeta(`schema:${name}`);
      return previous !== undefined && normalizeSchema(previous) !== normalizeSchema(schema);
    });
    const rebuildReason =
      storedSource !== undefined && !sameSource(storedSource)
        ? "source database was replaced"
        : changedTable
          ? `source schema changed: ${changedTable.name}`
          : storedSequence !== undefined && sequence() < Number(storedSequence)
            ? "source event sequence regressed"
            : undefined;
    if (rebuildReason) {
      // A rebuild re-bootstraps the whole export (4.5 GB in production) by
      // paging the live source. Never loop: the same reason may rebuild again
      // only after the backoff window; until then stay unready and say why.
      // The window lives in meta, so worker and server restarts keep it.
      const lastReason = getMeta("last_rebuild_reason");
      const lastAt = Date.parse(getMeta("last_rebuild_at") ?? "");
      const now = Date.now();
      if (
        lastReason === rebuildReason &&
        Number.isFinite(lastAt) &&
        now - lastAt < rebuildBackoffMs
      ) {
        const lastNotice = Date.parse(getMeta("rebuild_held_notice_at") ?? "");
        const notify = !(Number.isFinite(lastNotice) && now - lastNotice < rebuildNoticeMs);
        const until = new Date(lastAt + rebuildBackoffMs).toISOString();
        meta("ready", "0");
        meta("rebuild_held_until", until);
        if (notify) meta("rebuild_held_notice_at", new Date(now).toISOString());
        throw Object.assign(
          new Error(
            `Automatic rebuild held back: ${rebuildReason} again within ${Math.round(rebuildBackoffMs / 60_000)} min of the last rebuild (${new Date(lastAt).toISOString()}); next allowed after ${until}`,
          ),
          { code: "READONLY_REBUILD_HELD", notify },
        );
      }
      const exported = [...projections, ...auxiliary].filter((name) =>
        out.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name),
      );
      transaction(() => {
        for (const name of [
          ...exported,
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
            "DELETE FROM ardud_readonly_meta WHERE key LIKE 'schema:%' OR key IN ('archive_deletion_sequence','resetting_events')",
          )
          .run();
        meta("ready", "0");
        meta("source", identity);
        meta("sequence", String(sequence()));
        meta("schema_version", "1");
        meta("last_rebuild_reason", rebuildReason);
        meta("last_rebuild_at", new Date(now).toISOString());
        out
          .prepare(
            "DELETE FROM ardud_readonly_meta WHERE key IN ('rebuild_held_until','rebuild_held_notice_at')",
          )
          .run();
      });
    } else if (storedSource !== undefined && storedSource !== identity) {
      meta("source", identity);
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
    if (!published()) meta("ready", "0");

    const tables = new Map<
      string,
      {
        db: NodeSqlite.DatabaseSync;
        columns: string[];
        primary: string;
        upsert: NodeSqlite.StatementSync;
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
    for (const { name, db, schema } of sourceTables) {
      // Any stored schema that differed was rebuilt above.
      meta(`schema:${name}`, schema);
      sourceSchemas.set(name, schema);
      out.exec(
        schema.replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?/i, "CREATE TABLE IF NOT EXISTS "),
      );
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
        // Identical rows are left alone: each cycle re-reads the small tables
        // (75 MB of kanban card JSON on 10 Nov), and rewriting every unchanged
        // row turned that into 75 MB of replica WAL per cycle.
        upsert: out.prepare(
          `INSERT INTO ${q(name)} (${columns.map(q).join(",")}) VALUES (${columns.map(() => "?").join(",")}) ON CONFLICT(${q(primary)}) DO UPDATE SET ${values
            .map((c) => `${q(c)}=excluded.${q(c)}`)
            .join(",")} WHERE ${values.map((c) => `${q(c)} IS NOT excluded.${q(c)}`).join(" OR ")}`,
        ),
      });
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
    }
    out.exec(
      "CREATE INDEX IF NOT EXISTS ardud_readonly_items_thread ON orchestration_v2_projection_turn_items(thread_id)",
    );
    const copyRow = (name: string, row: Record<string, NodeSqlite.SQLOutputValue>) => {
      const table = tables.get(name)!;
      if (name.endsWith("_turn_items") && !selectedItems.has(String(row.type))) {
        out.prepare(`DELETE FROM ${q(name)} WHERE ${q(table.primary)}=?`).run(row[table.primary]!);
      } else {
        table.upsert.run(...table.columns.map((c) => row[c]!));
        if (name.endsWith("_turn_items"))
          out
            .prepare(
              "INSERT INTO ardud_readonly_item_fences VALUES (?,?) ON CONFLICT(item_id) DO UPDATE SET sequence=excluded.sequence",
            )
            .run(row[table.primary]!, threadSequence(row.thread_id!));
      }
    };
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
      if (row) copyRow(name, row);
      else out.prepare(`DELETE FROM ${q(name)} WHERE ${q(table.primary)}=?`).run(id);
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
    let auxiliaryGeneration = nextGeneration();
    let auxiliaryIndex = 0,
      auxiliaryCursor = 0,
      pruning = false,
      reconcileIndex = 0,
      closed = false;
    const sourceSchemaVersion = Number(
      source.prepare("PRAGMA schema_version").get()?.schema_version,
    );
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
    let auxiliaryPruneCursor = 0;
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
    const stepOnce = (): boolean => {
      if (closed) throw new Error("Readonly exporter is closed");
      if (invalidated) throw new Error(invalidated);
      if (baseFilename() !== baseName)
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
      if (
        Number(source.prepare("PRAGMA schema_version").get()?.schema_version) !==
        sourceSchemaVersion
      ) {
        for (const [name, schema] of sourceSchemas) {
          if (
            tables.get(name)!.db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name)
              ?.sql !== schema
          )
            throw invalidate("Readonly source schema changed; restart export");
        }
      }
      // Routine refresh of a published replica: one write transaction for the
      // whole cycle. Bootstrap and event resets commit page by page instead,
      // so they stay resumable while ready=0.
      if (!cycleTransaction && published()) {
        out.exec("BEGIN IMMEDIATE");
        cycleTransaction = true;
      }
      if (resettingEvents) {
        const result = out
          .prepare(
            "DELETE FROM orchestration_events WHERE sequence IN (SELECT sequence FROM orchestration_events LIMIT ?)",
          )
          .run(batchSize);
        resettingEvents = Number(result.changes) >= batchSize;
        if (!resettingEvents) meta("resetting_events", "0");
        return true;
      }
      if (sequence() < Number(getMeta("sequence")))
        throw invalidate("Readonly event sequence regressed");
      for (const name of projections) {
        const saved = progress(name);
        if (saved.done) continue;
        const generation = saved.generation ?? nextGeneration();
        if (saved.pruning) {
          transaction(() =>
            checkpoint(name, { ...saved, ...prune(name, saved.pruneCursor ?? 0, generation) }),
          );
          return true;
        }
        source.exec("BEGIN");
        try {
          const rows = page(name, saved.cursor);
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
      }
      if (cycleTarget === undefined) cycleTarget = sequence();
      if (catchUpWork()) return true;
      if (auxiliaryIndex < auxiliary.length) {
        auxiliaryCapturedAt ??= Date.now();
        const name = auxiliary[auxiliaryIndex]!,
          table = tables.get(name)!;
        if (!pruning) {
          const rows = page(name, auxiliaryCursor);
          transaction(() => {
            for (const row of rows) {
              copyRow(name, row);
              markSeen(name, row[table.primary]!, auxiliaryGeneration);
            }
          });
          auxiliaryCursor = Number(rows.at(-1)?.__rowid ?? auxiliaryCursor);
          pruning = rows.length < batchSize;
        } else {
          const result = transaction(() => prune(name, auxiliaryPruneCursor, auxiliaryGeneration));
          auxiliaryPruneCursor = result.pruneCursor;
          if (result.done) {
            auxiliaryIndex++;
            auxiliaryCursor = 0;
            pruning = false;
            auxiliaryPruneCursor = 0;
          }
        }
        return true;
      }
      return publishStep();
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
          const rows = [...merged.values()]
            .sort((a, b) => Number(a.sequence) - Number(b.sequence))
            .slice(0, batchSize);
          // Compaction may have removed changes while bootstrap was in flight.
          // Revisit the paged projections at a fresh watermark, failing closed.
          if (
            !rows.length ||
            rows.some(
              (row, i) => Number(row.sequence) !== (i ? Number(rows[i - 1]!.sequence) : cursor) + 1,
            )
          ) {
            transaction(() => {
              meta("ready", "0");
              meta("sequence", String(sequence()));
              out.prepare("DELETE FROM ardud_readonly_progress").run();
              meta("resetting_events", "1");
            });
            // Publish the reset: readers must not keep using this replica
            // while projections are rebuilt and events are cleared.
            if (cycleTransaction) {
              cycleTransaction = false;
              out.exec("COMMIT");
            }
            resettingEvents = true;
            cycleTarget = undefined;
            auxiliaryIndex = 0;
            auxiliaryCursor = 0;
            pruning = false;
            auxiliaryPruneCursor = 0;
            auxiliaryCapturedAt = undefined;
            auxiliaryGeneration = nextGeneration();
            return;
          }
          transaction(() => {
            for (const row of rows) {
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
          for (const row of rows) refresh(name, row.id!);
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
          // Recall invalidates its lineage cache at each completed generation;
          // it does not need an unbounded copy of the event history.
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
          meta("ready", "1");
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
        cycleTransaction = false;
        out.exec("COMMIT");
      }
      cycleTarget = undefined;
      auxiliaryIndex = 0;
      auxiliaryCursor = 0;
      auxiliaryCapturedAt = undefined;
      auxiliaryGeneration = nextGeneration();
      return false;
    };
    return {
      /** One bounded page; false means caught up, ready for the next interval. */
      step(): boolean {
        try {
          return stepOnce();
        } catch (error) {
          // Discarding a routine cycle leaves the in-memory cursors ahead of
          // the replica; this exporter must be reopened. Readers keep the last
          // published generation, which goes stale if the failure persists.
          if (abortCycle()) invalidated ??= "Readonly refresh cycle aborted; reopen exporter";
          recordFailure(error);
          throw error;
        }
      },
      close() {
        if (!closed) {
          closed = true;
          // An unfinished cycle is discarded; readers keep the last generation.
          abortCycle();
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
