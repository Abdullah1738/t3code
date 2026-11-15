// @effect-diagnostics nodeBuiltinImport:off -- native SQLite fixture creation and filesystem readback are the boundaries under test.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { afterEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as TestClock from "effect/testing/TestClock";
import * as BackupSnapshot from "./BackupSnapshot.ts";
import * as BoardsDatabase from "./BoardsDatabase.ts";
import * as ServerConfig from "../../config.ts";
import { ServerActivation } from "../../serverActivation.ts";

vi.mock("node:fs/promises", { spy: true });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});
const tables = [
  "projection_projects",
  "orchestration_v2_projection_provider_session_bindings",
  "ardud_thread_origin",
  "ardud_opencode_import_state",
  "effect_sql_migrations",
  "scheduled_tasks",
];
const fixture = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "robob-backup-test-"));
  dirs.push(dir);
  const boardsPath = NodePath.join(dir, "boards.sqlite");
  const statePath = NodePath.join(dir, "statev2.sqlite");
  const outputPath = NodePath.join(dir, "readonly", "backup.sqlite");
  const boards = new NodeSqlite.DatabaseSync(boardsPath);
  boards.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE ardud_kanban_cards(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT);
    CREATE TABLE ardud_kanban_boards(id TEXT PRIMARY KEY);
    CREATE TABLE ardud_mission_archive(id TEXT PRIMARY KEY);
    CREATE TABLE scheduled_tasks(id INTEGER PRIMARY KEY, value TEXT);
    CREATE INDEX cards_title ON ardud_kanban_cards(title);
    CREATE TRIGGER board_insert AFTER INSERT ON ardud_kanban_boards BEGIN INSERT INTO ardud_mission_archive VALUES (new.id); END;
    INSERT INTO ardud_kanban_cards(title) VALUES ('keep');
    INSERT INTO ardud_kanban_boards VALUES ('robob');
    INSERT INTO scheduled_tasks VALUES(10,'current');`);
  boards.close();
  const state = new NodeSqlite.DatabaseSync(statePath);
  state.exec("PRAGMA journal_mode=WAL");
  for (const table of tables) {
    state.exec(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY, value TEXT, payload BLOB)`);
    const insert = state.prepare(`INSERT INTO ${table} VALUES (?, ?, ?)`);
    for (let n = 0; n < 260; n++) insert.run(n, `${table}-${n}`, Buffer.from([0, 255, n % 256]));
  }
  state.close();
  const logs: string[] = [];
  const logger = Logger.make(({ message }) => {
    logs.push(JSON.stringify(message));
  });
  const run = <E, R>(
    test: (service: BackupSnapshot.BackupSnapshot["Service"]) => Effect.Effect<void, E, R>,
    options: Partial<Parameters<typeof BackupSnapshot.layerWithOptions>[0]> = {},
    transform?: Statement.Transformer,
    ready: Effect.Effect<void> = Effect.void,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const layer = BackupSnapshot.layerWithOptions({
          outputPath,
          serverVersion: "test",
          buildCommit: "abc123",
          ...options,
        }).pipe(
          Layer.provide(
            Layer.succeed(BoardsDatabase.BoardsDatabase, {
              path: boardsPath,
              sql,
              ready,
            }),
          ),
        );
        const context = yield* Layer.build(layer);
        const body = test(Context.get(context, BackupSnapshot.BackupSnapshot));
        yield* transform
          ? Effect.provideService(body, Statement.CurrentTransformer, transform)
          : body;
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeSqliteClient.layer({ filename: statePath, readerWorker: true }),
          Logger.layer([logger], { mergeWithExisting: false }),
          NodeServices.layer,
        ),
      ),
    );
  return { dir, outputPath, statePath, boardsPath, logs, run };
};

it.live(
  "copies all board schema and state tables, preserves collisions and publishes private metadata",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* f.run((service) => service.write);
      const db = new NodeSqlite.DatabaseSync(f.outputPath, { readOnly: true });
      try {
        expect(
          db
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name",
            )
            .all()
            .map((row) => row.name),
        ).toEqual(["board_insert", "cards_title"]);
        for (const name of [
          "ardud_kanban_cards",
          "ardud_kanban_boards",
          "ardud_mission_archive",
          "scheduled_tasks",
          "sqlite_sequence",
        ])
          expect(db.prepare(`SELECT count(*) AS n FROM ${name}`).get()!.n).toBe(1);
        for (const table of tables) {
          const target = table === "scheduled_tasks" ? "statev2_scheduled_tasks" : table;
          expect(db.prepare(`SELECT count(*) AS n FROM ${target}`).get()!.n).toBe(260);
          expect(db.prepare(`SELECT payload FROM ${target} WHERE id=259`).get()!.payload).toEqual(
            new Uint8Array([0, 255, 3]),
          );
        }
        const meta = db.prepare("SELECT * FROM backup_meta").get()!;
        expect(meta.server_version).toBe("test");
        expect(meta.build_commit).toBe("abc123");
        expect(Date.parse(String(meta.written_at))).toBeGreaterThan(0);
        expect(JSON.parse(String(meta.tables))).toMatchObject({
          ardud_kanban_cards: 1,
          projection_projects: 260,
          statev2_scheduled_tasks: 260,
        });
        expect(
          db
            .prepare("SELECT source_sql FROM backup_sources WHERE name='statev2_scheduled_tasks'")
            .get()!.source_sql,
        ).toContain("CREATE TABLE scheduled_tasks");
      } finally {
        db.close();
      }
      expect(NodeFS.statSync(f.outputPath).mode & 0o777).toBe(0o600);
      expect(f.logs.some((line) => line.includes("Backup snapshot done"))).toBe(true);
    }),
);

it.live(
  "keeps the previous generation readable until rename, and preserves it on a failed publication",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* f.run((service) => service.write);
      const before = NodeFS.readFileSync(f.outputPath);
      const reader = new NodeSqlite.DatabaseSync(f.outputPath, { readOnly: true });
      yield* f.run((service) => service.write, {
        beforePublish: Effect.sync(() => {
          expect(NodeFS.readFileSync(f.outputPath)).toEqual(before);
          throw new Error("injected write failure");
        }),
      });
      expect(NodeFS.readFileSync(f.outputPath)).toEqual(before);
      expect(NodeFS.readdirSync(NodePath.dirname(f.outputPath))).toEqual(["backup.sqlite"]);
      expect(f.logs.some((line) => line.includes("Backup snapshot error"))).toBe(true);
      yield* f.run((service) => service.write, { buildCommit: "new" });
      expect(reader.prepare("SELECT build_commit FROM backup_meta").get()!.build_commit).toBe(
        "abc123",
      );
      reader.close();
      const next = new NodeSqlite.DatabaseSync(f.outputPath, { readOnly: true });
      expect(next.prepare("SELECT build_commit FROM backup_meta").get()!.build_commit).toBe("new");
      next.close();
    }),
);

it.live("skips and logs a missing state table", () =>
  Effect.gen(function* () {
    const f = fixture();
    const state = new NodeSqlite.DatabaseSync(f.statePath);
    state.exec("DROP TABLE ardud_opencode_import_state");
    state.close();
    yield* f.run((service) => service.write);
    expect(
      f.logs.some(
        (line) =>
          line.includes("missing source table") && line.includes("ardud_opencode_import_state"),
      ),
    ).toBe(true);
    const out = new NodeSqlite.DatabaseSync(f.outputPath, { readOnly: true });
    expect(
      out.prepare("SELECT name FROM sqlite_schema WHERE name='projection_projects'").get(),
    ).toBeDefined();
    out.close();
  }),
);

it.live("rejects an oversized source table before copying or publishing it", () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* f.run((service) => service.write, { maxTableBytes: 1 });
    expect(NodeFS.existsSync(f.outputPath)).toBe(false);
    expect(
      f.logs.some(
        (line) => line.includes("Backup snapshot error") && line.includes("projection_projects"),
      ),
    ).toBe(true);
    expect(NodeFS.readdirSync(NodePath.dirname(f.outputPath))).toEqual([]);
  }),
);

it.live("pins all state pages to one read transaction while the writer can commit", () =>
  Effect.gen(function* () {
    const f = fixture();
    let changed = false;
    const observe: Statement.Transformer = (statement) =>
      Effect.sync(() => {
        const [text] = statement.compile();
        if (
          !changed &&
          text.includes('FROM "projection_projects"') &&
          text.includes("__backup_cursor")
        ) {
          changed = true;
          const writer = new NodeSqlite.DatabaseSync(f.statePath);
          try {
            writer.exec("UPDATE scheduled_tasks SET value='later'");
          } finally {
            writer.close();
          }
        }
        return statement;
      });
    yield* f.run((service) => service.write, {}, observe);
    expect(changed).toBe(true);
    const out = new NodeSqlite.DatabaseSync(f.outputPath, { readOnly: true });
    expect(out.prepare("SELECT value FROM statev2_scheduled_tasks WHERE id=0").get()!.value).toBe(
      "scheduled_tasks-0",
    );
    out.close();
  }),
);

it.live("skips overlapping writes without starting a second snapshot", () =>
  Effect.gen(function* () {
    const f = fixture();
    const entered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    yield* f.run(
      (service) =>
        Effect.gen(function* () {
          const first = yield* Effect.forkChild(service.write);
          // The publication hook coordinates overlap without time-based polling.
          yield* Deferred.await(entered);
          yield* service.write;
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(first);
        }),
      {
        beforePublish: Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }),
      },
    );
    expect(f.logs.filter((line) => line.includes("Backup snapshot start"))).toHaveLength(1);
    expect(f.logs.some((line) => line.includes("already_running"))).toBe(true);
  }),
);

it.live("rolls back a failed destination insert and removes all temporary sidecars", () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* f.run((service) => service.write);
    const before = NodeFS.readFileSync(f.outputPath);
    const source = new NodeSqlite.DatabaseSync(f.statePath);
    source.exec(`DROP TABLE projection_projects;
    CREATE TABLE projection_projects(id INTEGER PRIMARY KEY, value TEXT CHECK(value != 'invalid'), payload BLOB);
    PRAGMA ignore_check_constraints=ON;
    INSERT INTO projection_projects VALUES (1,'invalid',NULL)`);
    source.close();
    yield* f.run((service) => service.write);
    expect(NodeFS.readFileSync(f.outputPath)).toEqual(before);
    expect(NodeFS.readdirSync(NodePath.dirname(f.outputPath))).toEqual(["backup.sqlite"]);
    expect(
      f.logs.some(
        (line) => line.includes("Backup snapshot error") && line.includes("projection_projects"),
      ),
    ).toBe(true);
  }),
);

it.live("copies WITHOUT ROWID, STRICT and generated-column source schemas", () =>
  Effect.gen(function* () {
    const f = fixture();
    const source = new NodeSqlite.DatabaseSync(f.statePath);
    source.exec(`DROP TABLE projection_projects;
    CREATE TABLE projection_projects(id INTEGER PRIMARY KEY, value TEXT, computed TEXT GENERATED ALWAYS AS (upper(value)) STORED) STRICT, WITHOUT ROWID;
    INSERT INTO projection_projects(id,value) VALUES (1,'project')`);
    source.close();
    yield* f.run((service) => service.write);
    const output = new NodeSqlite.DatabaseSync(f.outputPath, { readOnly: true });
    try {
      expect(output.prepare("SELECT * FROM projection_projects").all()).toEqual([
        { id: 1, value: "project", computed: "PROJECT" },
      ]);
      expect(
        output.prepare("SELECT sql FROM sqlite_schema WHERE name='projection_projects'").get()!.sql,
      ).toContain("WITHOUT ROWID");
    } finally {
      output.close();
    }
  }),
);

it.effect("waits three minutes at startup and retries a failed cycle six hours later", () => {
  const f = fixture();
  return f.run(
    (service) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(service.run);
        yield* TestClock.adjust("179 seconds");
        expect(f.logs.filter((line) => line.includes("Backup snapshot start"))).toHaveLength(0);
        yield* TestClock.adjust("1 second");
        expect(f.logs.filter((line) => line.includes("Backup snapshot start"))).toHaveLength(1);
        expect(f.logs.some((line) => line.includes("Backup snapshot error"))).toBe(true);
        yield* TestClock.adjust("21599 seconds");
        expect(f.logs.filter((line) => line.includes("Backup snapshot start"))).toHaveLength(1);
        yield* TestClock.adjust("1 second");
        expect(f.logs.filter((line) => line.includes("Backup snapshot start"))).toHaveLength(2);
        yield* Fiber.interrupt(fiber);
      }),
    {},
    undefined,
    Effect.die(new Error("injected unavailable boards")),
  );
});

it.live("preserves selected tables whose foreign keys reference excluded projections", () =>
  Effect.gen(function* () {
    const f = fixture();
    const source = new NodeSqlite.DatabaseSync(f.statePath);
    source.exec(`DROP TABLE orchestration_v2_projection_provider_session_bindings;
    CREATE TABLE excluded_threads(id INTEGER PRIMARY KEY);
    INSERT INTO excluded_threads VALUES(1);
    CREATE TABLE orchestration_v2_projection_provider_session_bindings(id INTEGER PRIMARY KEY REFERENCES excluded_threads(id), value TEXT);
    INSERT INTO orchestration_v2_projection_provider_session_bindings VALUES(1,'binding')`);
    source.close();
    yield* f.run((service) => service.write);
    const output = new NodeSqlite.DatabaseSync(f.outputPath, { readOnly: true });
    try {
      expect(
        output.prepare("SELECT * FROM orchestration_v2_projection_provider_session_bindings").all(),
      ).toEqual([{ id: 1, value: "binding" }]);
      expect(
        output.prepare("SELECT name FROM sqlite_schema WHERE name='excluded_threads'").get(),
      ).toBeUndefined();
    } finally {
      output.close();
    }
  }),
);

it.live("cancels an in-progress write without publishing or leaving temporary files", () =>
  Effect.gen(function* () {
    const f = fixture();
    const entered = yield* Deferred.make<void>();
    yield* f.run(
      (service) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(service.write);
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(fiber);
        }),
      { beforePublish: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) },
    );
    expect(NodeFS.existsSync(f.outputPath)).toBe(false);
    expect(NodeFS.readdirSync(NodePath.dirname(f.outputPath))).toEqual([]);
    expect(f.logs.some((line) => line.includes("Backup snapshot error"))).toBe(false);
  }),
);

it.live.each(["temp-open", "rename", "directory-open", "directory-sync"] as const)(
  "cancellation during %s finishes native I/O and closes handles",
  (phase) =>
    Effect.gen(function* () {
      const f = fixture();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const nativeFs = yield* Effect.promise(() =>
        vi.importActual<typeof NodeFSP>("node:fs/promises"),
      );
      const open = nativeFs.open;
      const rename = nativeFs.rename;
      let synced = 0;
      let closed = 0;
      const openSpy = vi.spyOn(NodeFSP, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        const isDirectory = args[0] === NodePath.dirname(f.outputPath);
        const close = handle.close.bind(handle);
        handle.close = async () => {
          closed++;
          return close();
        };
        if (isDirectory) {
          const sync = handle.sync.bind(handle);
          handle.sync = async () => {
            if (phase === "directory-sync") {
              entered.resolve();
              await release.promise;
            }
            await sync();
            synced++;
          };
        }
        if (
          (phase === "temp-open" && !isDirectory) ||
          (phase === "directory-open" && isDirectory)
        ) {
          entered.resolve();
          await release.promise;
        }
        return handle;
      });
      const renameSpy = vi.spyOn(NodeFSP, "rename").mockImplementation(async (...args) => {
        await rename(...args);
        if (phase === "rename") {
          entered.resolve();
          await release.promise;
        }
      });
      try {
        yield* f.run((service) =>
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(service.write);
            yield* Effect.promise(() => entered.promise);
            const stopping = yield* Effect.forkChild(Fiber.interrupt(fiber));
            yield* Effect.yieldNow;
            release.resolve();
            yield* Fiber.join(stopping);
          }),
        );
        expect(closed).toBe(phase === "temp-open" ? 1 : 2);
        expect(synced).toBe(phase === "temp-open" ? 0 : 1);
        expect(NodeFS.readdirSync(NodePath.dirname(f.outputPath))).toEqual(
          phase === "temp-open" ? [] : ["backup.sqlite"],
        );
        if (phase !== "temp-open") {
          const out = new NodeSqlite.DatabaseSync(f.outputPath, { readOnly: true });
          try {
            expect(out.prepare("SELECT build_commit FROM backup_meta").get()!.build_commit).toBe(
              "abc123",
            );
          } finally {
            out.close();
          }
        }
      } finally {
        release.resolve();
        openSpy.mockRestore();
        renameSpy.mockRestore();
      }
    }),
);

it.live("configured backup records the build commit preserved by server startup", () =>
  Effect.gen(function* () {
    const f = fixture();
    const config = yield* ServerConfig.ServerConfig;
    const sql = yield* SqlClient.SqlClient;
    const services = yield* Layer.build(BackupSnapshot.layer).pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        ...config,
        dbPath: f.statePath,
        robobBuildCommit: "fedcba123456",
      }),
      Effect.provideService(BoardsDatabase.BoardsDatabase, {
        path: f.boardsPath,
        sql,
        ready: Effect.void,
      }),
      Effect.provideService(ServerActivation, Effect.never),
    );
    yield* Context.get(services, BackupSnapshot.BackupSnapshot).write;
    const output = new NodeSqlite.DatabaseSync(f.outputPath, { readOnly: true });
    try {
      expect(output.prepare("SELECT build_commit FROM backup_meta").get()!.build_commit).toBe(
        "fedcba123456",
      );
    } finally {
      output.close();
    }
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.merge(
        ServerConfig.layerTest(process.cwd(), { prefix: "backup-build-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
        NodeSqliteClient.layer({ filename: ":memory:" }),
      ),
    ),
  ),
);
