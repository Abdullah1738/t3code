// @effect-diagnostics nodeBuiltinImport:off -- exercises the bundled SQLite worker on disposable databases.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeWorkerThreads from "node:worker_threads";
import { assert, it } from "@effect/vitest";
import { archiveCheckpointWorkerSource } from "./archiveCheckpointWorker.ts";

type Reply = {
  id: number;
  ok: boolean;
  walBytes: number;
  checkpoint: { log: number; checkpointed: number };
  truncate?: { busy: number };
};

const fixture = async (
  body: (fixture: {
    db: NodeSqlite.DatabaseSync;
    main: NodeSqlite.DatabaseSync;
    archivePath: string;
    request: (operation: string) => Promise<Reply>;
  }) => Promise<void>,
) => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "archive-wal-"));
  const filename = NodePath.join(dir, "statev2.sqlite");
  const archivePath = NodePath.join(dir, "archive.sqlite");
  const main = new NodeSqlite.DatabaseSync(filename);
  main.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  const db = new NodeSqlite.DatabaseSync(archivePath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE entries(value BLOB)");
  main.prepare("ATTACH DATABASE ? AS ardud_archive").run(archivePath);
  const worker = new NodeWorkerThreads.Worker(archiveCheckpointWorkerSource, {
    eval: true,
    workerData: { filename, archiveFilename: archivePath },
  });
  let id = 0;
  const request = (operation: string) =>
    new Promise<Reply>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers have no target origin.
      worker.postMessage({ id: ++id, operation });
    });
  try {
    await body({ db, main, archivePath, request });
  } finally {
    await worker.terminate();
    db.close();
    main.close();
    await NodeFSP.rm(dir, { recursive: true });
  }
};

it("defers truncation for the attached statev2 writer, then resets after five durable passes", async () => {
  await fixture(async ({ db, main, request, archivePath }) => {
    for (let pass = 0; pass < 5; pass++) {
      db.exec("INSERT INTO entries VALUES(randomblob(8192))");
      const barrier = await request("checkpoint");
      assert.isTrue(barrier.ok);
      assert.equal(barrier.checkpoint.log, barrier.checkpoint.checkpointed);
      assert.isAbove(barrier.walBytes, 0, "PASSIVE alone retains the high-water file");
    }
    main.exec("CREATE TABLE hot(value); BEGIN IMMEDIATE; INSERT INTO hot VALUES(1)");
    const maintained = await request("maintenance");
    assert.isTrue(maintained.ok);
    assert.equal(maintained.truncate?.busy, 1);
    assert.isAbove(maintained.walBytes, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM entries").get()?.n, 5);
    main.exec("COMMIT");
    assert.equal((await request("maintenance")).truncate?.busy, 0);
    assert.equal((await NodeFSP.stat(archivePath + "-wal")).size, 0);
    assert.equal(main.prepare("SELECT value FROM hot").get()?.value, 1);
    db.exec("INSERT INTO entries VALUES(x'01')");
    assert.isTrue((await request("checkpoint")).ok);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM entries").get()?.n, 6);
  });
});

it("does not treat a pinned archive reader as durable or force its truncation", async () => {
  await fixture(async ({ db, request, archivePath }) => {
    db.exec("INSERT INTO entries VALUES(x'01')");
    const reader = new NodeSqlite.DatabaseSync(archivePath, { readOnly: true });
    try {
      reader.exec("BEGIN; SELECT * FROM entries");
      db.exec("INSERT INTO entries VALUES(randomblob(8192))");
      const pinned = await request("maintenance");
      assert.isFalse(pinned.ok);
      assert.isBelow(pinned.checkpoint.checkpointed, pinned.checkpoint.log);
      assert.isUndefined(pinned.truncate);
      assert.isAbove(pinned.walBytes, 0);
      reader.exec("ROLLBACK");
      const barrier = await request("checkpoint");
      assert.isTrue(barrier.ok);
      // Start the tip snapshot before backfill so it reads WAL, not read-mark zero.
      db.exec("INSERT INTO entries VALUES(x'02')");
      reader.exec("BEGIN; SELECT * FROM entries");
      const busy = await request("maintenance");
      assert.isTrue(busy.ok);
      assert.equal(busy.truncate?.busy, 1);
      assert.isAbove(busy.walBytes, 0);
      reader.exec("ROLLBACK");
      assert.equal((await request("maintenance")).walBytes, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM entries").get()?.n, 3);
    } finally {
      reader.close();
    }
  });
});
