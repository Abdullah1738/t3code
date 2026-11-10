// @effect-diagnostics nodeBuiltinImport:off globalDate:off - fixtures drive real worker threads and native SQLite.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeWorkerThreads from "node:worker_threads";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import { afterEach } from "vite-plus/test";

import {
  type ExportWorker,
  exportWorkerSource,
  superviseExportWorker,
  superviseReadonlyExport,
} from "./ReadonlyReplica.ts";
import { createReadonlyReplica } from "./readonlyExport.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup();
});

const fast = {
  stallTimeout: "300 millis",
  restartDelay: "20 millis",
  terminateTimeout: "2 seconds",
} as const;

const evalWorker = (code: string, workerData?: unknown) => {
  const worker = new NodeWorkerThreads.Worker(code, { eval: true, execArgv: [], workerData });
  const exited = new Promise<number>((resolve) => worker.once("exit", resolve));
  cleanups.push(() => void worker.terminate());
  return { worker: worker as unknown as ExportWorker, exited };
};

it.live("a failing worker reports its stage and error message", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      superviseExportWorker(
        () =>
          evalWorker(exportWorkerSource("() => { throw new Error('Readonly source changed') }"))
            .worker,
        fast,
      ),
    );
    assert.isTrue(Exit.isFailure(exit));
    const text = JSON.stringify(exit);
    assert.include(text, '"stage":"open"');
    assert.include(text, '"reason":"Readonly source changed"');
  }),
);

it.live("a silent (hung) worker is declared stalled and terminated", () =>
  Effect.gen(function* () {
    let exited: Promise<number> | undefined;
    const exit = yield* Effect.exit(
      superviseExportWorker(() => {
        const spawned = evalWorker("setInterval(() => {}, 1000)");
        exited = spawned.exited;
        return spawned.worker;
      }, fast),
    );
    assert.isTrue(Exit.isFailure(exit));
    assert.include(JSON.stringify(exit), "stalled");
    // The release terminated it; the thread is really gone.
    yield* Effect.promise(() => exited!);
  }),
);

it.live("heartbeats keep a slow but progressing worker alive", () =>
  Effect.gen(function* () {
    const result = yield* superviseExportWorker(
      () =>
        evalWorker(
          "const {parentPort}=require('node:worker_threads'); setInterval(() => parentPort.postMessage({type:'step'}), 50)",
        ).worker,
      fast,
    ).pipe(Effect.timeoutOption("1 second"));
    assert.isTrue(result._tag === "None");
  }),
);

it.live("every failure is logged with its reason and the worker is restarted", () => {
  const messages: string[] = [];
  const logger = Logger.make(({ message }) => {
    messages.push(String(message));
  });
  let spawned = 0;
  return superviseReadonlyExport(() => {
    spawned++;
    return evalWorker(exportWorkerSource("() => { throw new Error('disk I/O error') }")).worker;
  }, fast).pipe(
    Effect.timeoutOption("1500 millis"),
    Effect.andThen(
      Effect.sync(() => {
        assert.isAtLeast(spawned, 3);
        assert.isTrue(
          messages.some((m) => m.includes("Readonly export unavailable (open): disk I/O error")),
          messages.join("\n"),
        );
      }),
    ),
    Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
  );
});

const heldWorker = (notify: boolean) =>
  exportWorkerSource(
    `() => { throw Object.assign(new Error('Automatic rebuild held back: source event sequence regressed'), { code: 'READONLY_REBUILD_HELD', notify: ${notify} }) }`,
  );

it.live("a held-back rebuild is reported as its own stage, quiet between notices", () =>
  Effect.gen(function* () {
    const loud = JSON.stringify(
      yield* Effect.exit(superviseExportWorker(() => evalWorker(heldWorker(true)).worker, fast)),
    );
    assert.include(loud, '"stage":"rebuild-held"');
    assert.include(loud, '"quiet":false');
    const quiet = JSON.stringify(
      yield* Effect.exit(superviseExportWorker(() => evalWorker(heldWorker(false)).worker, fast)),
    );
    assert.include(quiet, '"quiet":true');
  }),
);

it.live("while a rebuild is held back the supervisor reopens rarely and stays quiet", () => {
  const warnings: string[] = [];
  const logger = Logger.make(({ message, logLevel }) => {
    if (logLevel === "Warn") warnings.push(String(message));
  });
  let spawned = 0;
  return superviseReadonlyExport(
    () => {
      spawned++;
      return evalWorker(heldWorker(false)).worker;
    },
    { ...fast, heldRestartDelay: "10 seconds" },
  ).pipe(
    Effect.timeoutOption("1 second"),
    Effect.andThen(
      Effect.sync(() => {
        // fast.restartDelay is 20 ms; a held rebuild waits heldRestartDelay.
        assert.strictEqual(spawned, 1);
        assert.deepStrictEqual(warnings, []);
      }),
    ),
    Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
  );
});

it.live("a slow refresh cycle is logged with its duration", () => {
  const warnings: string[] = [];
  const logger = Logger.make(({ message, logLevel }) => {
    if (logLevel === "Warn") warnings.push(String(message));
  });
  return superviseExportWorker(
    () =>
      evalWorker(
        "const {parentPort}=require('node:worker_threads'); parentPort.postMessage({type:'published',cycleMs:95000}); setInterval(() => parentPort.postMessage({type:'step'}), 50)",
      ).worker,
    fast,
  ).pipe(
    Effect.timeoutOption("500 millis"),
    Effect.andThen(
      Effect.sync(() => {
        assert.deepStrictEqual(warnings, [
          "Readonly export cycle took 95s; outside readers allow 45-120s",
        ]);
      }),
    ),
    Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
  );
});

function staleRemountedReplica() {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "readonly-supervisor-"));
  cleanups.push(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  const sourcePath = NodePath.join(dir, "source.sqlite");
  const replicaPath = NodePath.join(dir, "readonly/state.sqlite");
  const source = new NodeSqlite.DatabaseSync(sourcePath);
  cleanups.push(() => source.close());
  source.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT, stream_id TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY, thread_id TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_run_attempts (attempt_id TEXT PRIMARY KEY, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_turns (provider_turn_id TEXT PRIMARY KEY, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_subagents (subagent_id TEXT PRIMARY KEY, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_messages (message_id TEXT PRIMARY KEY, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_turn_items (turn_item_id TEXT PRIMARY KEY, type TEXT, payload_json TEXT, thread_id TEXT DEFAULT 'a', ordinal INTEGER DEFAULT 0);
    CREATE TABLE scheduled_tasks (task_id TEXT PRIMARY KEY, thread_id TEXT);
    CREATE TABLE ardud_opencode_import (native_session_id TEXT PRIMARY KEY, thread_id TEXT);
    CREATE TABLE ardud_kanban_cards (id TEXT PRIMARY KEY, active_thread_id TEXT, json TEXT);
    CREATE TABLE ardud_kanban_threads (thread_id TEXT PRIMARY KEY, ended INTEGER);
    INSERT INTO orchestration_events VALUES (1,'thread.created','a','{"id":"a"}');
    INSERT INTO orchestration_v2_projection_threads VALUES ('a','{"title":"before"}');`);
  const options = { sourcePath, replicaPath };
  const exporter = createReadonlyReplica(NodeSqlite, NodeFS, NodePath, options);
  while (exporter.step()) {
    // first generation
  }
  exporter.close();
  // The 9 Nov state: published long ago, identity recorded with the SSD's old
  // device number, which the remount changed.
  const real = NodeFS.realpathSync(sourcePath);
  const stat = NodeFS.statSync(sourcePath);
  const replica = new NodeSqlite.DatabaseSync(replicaPath);
  replica
    .prepare("UPDATE ardud_readonly_meta SET value=? WHERE key='source'")
    .run(`${real}:${stat.dev + 1}:${stat.ino}`);
  replica
    .prepare(
      "UPDATE ardud_readonly_meta SET value='2026-11-08T23:16:59.605Z' WHERE key='updated_at'",
    )
    .run();
  replica.close();
  source.exec(`UPDATE orchestration_v2_projection_threads SET payload_json='{"title":"after"}' WHERE thread_id='a';
    INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES ('thread.metadata-updated','a','{"id":"a"}');`);
  return { source, options };
}

it.live("the packaged worker advances a replica stranded by a volume remount", () =>
  Effect.gen(function* () {
    const { source, options } = staleRemountedReplica();
    const read = () => {
      const db = new NodeSqlite.DatabaseSync(options.replicaPath, {
        readOnly: true,
        timeout: 2000,
      });
      try {
        const meta = Object.fromEntries(
          db
            .prepare("SELECT key, value FROM ardud_readonly_meta")
            .all()
            .map((row) => [row.key, row.value]),
        );
        const title = db
          .prepare(
            "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='a'",
          )
          .get()?.payload_json;
        return { meta, title };
      } finally {
        db.close();
      }
    };
    const workerSource = exportWorkerSource(createReadonlyReplica.toString(), 50);
    const until = (check: () => boolean) =>
      Effect.gen(function* () {
        // A reader can briefly see SQLITE_BUSY while the worker initializes WAL.
        while (!(yield* Effect.try(check).pipe(Effect.orElseSucceed(() => false))))
          yield* Effect.sleep("25 millis");
      }).pipe(Effect.timeout("10 seconds"));
    yield* Effect.forkScoped(
      superviseReadonlyExport(() => evalWorker(workerSource, options).worker, {
        ...fast,
        stallTimeout: "10 seconds",
      }),
    );
    yield* until(() => read().title === '{"title":"after"}');
    const first = read().meta;
    assert.strictEqual(first.ready, "1");
    assert.isAbove(Date.parse(String(first.updated_at)), Date.parse("2026-11-09T00:00:00Z"));
    assert.isUndefined(first.last_rebuild_reason);
    // And it keeps going: a later change publishes a newer generation.
    source.exec(`UPDATE orchestration_v2_projection_threads SET payload_json='{"title":"later"}' WHERE thread_id='a';
      INSERT INTO orchestration_events(event_type,stream_id,payload_json) VALUES ('thread.metadata-updated','a','{"id":"a"}');`);
    yield* until(() => read().title === '{"title":"later"}');
    assert.isAbove(
      Date.parse(String(read().meta.updated_at)),
      Date.parse(String(first.updated_at)),
    );
  }).pipe(Effect.scoped),
);
