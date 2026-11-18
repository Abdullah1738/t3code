// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- A real worker OOM is isolated from the test runner; stdout carries its proof.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

// This child imports the production client and uses real SQLite and Worker threads.
// Only heap inspection is injected; no error, reply, or termination is simulated.
const fixture = `
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(new URL('./packages/shared/package.json', import.meta.url));
const threads = require('node:worker_threads');
const NativeWorker = threads.Worker;
const readers = [];
threads.Worker = class extends NativeWorker {
  constructor(source, options) {
    const reader = options?.workerData?.claims !== undefined;
    if (reader) source = source.replace('const statements = new Map();',
      'db.function("test_heap_limit", () => require("node:v8").getHeapStatistics().heap_size_limit); const statements = new Map();');
    // The subprocess uses ESM eval, while production workers use CommonJS eval.
    super(source, { ...options, execArgv: [] });
    if (reader) readers.push(this);
  }
};
syncBuiltinESMExports();
const Effect = await import(pathToFileURL(require.resolve('effect/Effect')));
const SqlClient = await import(pathToFileURL(require.resolve('effect/sql/SqlClient')));
const Sqlite = await import('./packages/shared/src/nodeSqliteClient.ts');
const { DatabaseSync } = await import('node:sqlite');
const dir = mkdtempSync(join(tmpdir(), 'sqlite-oom-'));
const filename = join(dir, 'fixture.sqlite');
const db = new DatabaseSync(filename);
db.exec('PRAGMA journal_mode=WAL; CREATE TABLE seed(n INTEGER); INSERT INTO seed VALUES(1)');
db.close();
try {
  const stats = Sqlite.makeStatementStats();
  const result = await Effect.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const heap = yield* sql.unsafe('SELECT test_heap_limit() AS bytes').pipe(Sqlite.requireReader);
    assert.ok(heap[0].bytes >= 32 * 1024 * 1024 && heap[0].bytes <= 64 * 1024 * 1024, JSON.stringify(heap));
    const first = readers.at(-1);
    const firstId = first.threadId;
    const oomRead = sql.unsafe("WITH RECURSIVE numbers(n) AS (SELECT n FROM seed UNION ALL SELECT n+1 FROM numbers WHERE n<60000) SELECT printf('%08000d', n) AS payload FROM numbers");
    const failure = yield* oomRead.pipe(Sqlite.requireReader, Effect.flip);
    assert.equal(failure._tag, 'SqlError');
    const oom = failure.reason.cause;
    assert.ok(oom instanceof Sqlite.ReaderOutOfMemory);
    assert.equal(oom.code, 'ERR_WORKER_OUT_OF_MEMORY');
    assert.equal(oom.cause.code, 'ERR_WORKER_OUT_OF_MEMORY');
    assert.equal(oom.progress.workerId, firstId);
    assert.ok(oom.progress.rows > 0);
    assert.ok(oom.progress.resultBytes > 0);
    const next = yield* sql.unsafe('SELECT n FROM seed').pipe(Sqlite.requireReader);
    assert.equal(next[0].n, 1);
    assert.notEqual(readers.at(-1), first);
    assert.equal(readers.length, 2);
    const replacementId = readers.at(-1).threadId;
    yield* sql.withTransaction(Effect.gen(function* () {
      const failure = yield* oomRead.pipe(Effect.flip);
      assert.ok(failure.reason.cause instanceof Sqlite.ReaderOutOfMemory);
      const pinned = yield* sql.unsafe('SELECT n FROM seed').pipe(Effect.flip);
      assert.ok(pinned.reason.cause instanceof Sqlite.ReaderOutOfMemory);
      assert.equal(readers.length, 2, 'a failed transaction must not start another worker');
    })).pipe(Sqlite.requireReader);
    const afterTransaction = yield* sql.unsafe('SELECT n FROM seed').pipe(Sqlite.requireReader);
    assert.equal(afterTransaction[0].n, 1);
    assert.equal(readers.length, 3);
    return { heapLimit: heap[0].bytes, oom: oom.progress, replacementId, next: next[0].n, pinnedTransaction: true };
  }).pipe(Effect.provide(Sqlite.layer({ filename, readerWorker: true, readerMaxOldGenerationSizeMb: 32 })), Effect.provideService(Sqlite.StatementStats, stats.record), Effect.scoped));
  assert.ok(stats.drain().some(s => s.failures === 2 && s.maxResultBytes >= result.oom.resultBytes));
  const normal = await Effect.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const heap = yield* sql.unsafe('SELECT test_heap_limit() AS bytes').pipe(Sqlite.requireReader);
    assert.ok(heap[0].bytes >= 96 * 1024 * 1024 && heap[0].bytes <= 112 * 1024 * 1024);
    const rows = yield* sql.unsafe("WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<2048) SELECT printf('%08000d', n) AS payload FROM numbers").pipe(Sqlite.requireReader);
    assert.equal(rows.length, 2048);
    assert.equal(rows[2047].payload.length, 8000);
    return { heapLimit: heap[0].bytes, rows: rows.length, stringBytes: rows.length * 8000 };
  }).pipe(Effect.provide(Sqlite.layer({ filename, readerWorker: true })), Effect.scoped));
  console.log('SQLITE_OOM_PROOF ' + JSON.stringify({ ...result, normal, versions: process.versions }));
} finally { rmSync(dir, { recursive: true, force: true }); }
`;

it("contains a real SQLite reader OOM and replaces it for the next pool read", async () => {
  const { stdout, stderr } = await execFile(
    process.env.SQLITE_MEMORY_TEST_RUNTIME ?? process.execPath,
    ["--input-type=module", "-e", fixture],
    {
      cwd: new URL("../../../", import.meta.url),
      env: { ...process.env, NODE_OPTIONS: "", ELECTRON_RUN_AS_NODE: "1" },
      timeout: 45_000,
      maxBuffer: 1024 * 1024,
    },
  );
  const proof = stdout.split("\n").find((line) => line.startsWith("SQLITE_OOM_PROOF "));
  expect(proof).toBeDefined();
  const large = stderr
    .split("\n")
    .filter((line) => line.startsWith('{"event":"sqlite.large-worker-result"'));
  expect(large.length).toBeGreaterThan(0);
  expect(large.map((line) => JSON.parse(line))).toContainEqual(
    expect.objectContaining({
      operation: "execute",
      family: "WITH:numbers",
      rows: 2048,
      resultBytes: expect.any(Number),
    }),
  );
  console.log(proof);
}, 50_000);
