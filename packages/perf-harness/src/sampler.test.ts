// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Tests the lifetime of the native sampler control channel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
test("sampler IPC does not keep a stopped server alive", async () => {
  const child = spawn(
    process.execPath,
    ["--import", fileURLToPath(new URL("./sampler.ts", import.meta.url)), "-e", ""],
    {
      env: { ...process.env, ROBOB_PERF_SAMPLE_FILE: "/tmp/robob-perf-sampler-probe.json" },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Sampler kept process alive")), 3000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error(`exit ${code}`));
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    assert.equal(child.exitCode, 0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test("WAL counters accumulate commits across checkpoints and generations", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const directory = mkdtempSync(tmpdir() + "/wal-probe-");
  const file = directory + "/sample.json";
  const child = spawn(
    process.execPath,
    [
      "--import",
      fileURLToPath(new URL("./sampler.ts", import.meta.url)),
      "--input-type=module",
      "-e",
      `
    import {DatabaseSync} from 'node:sqlite';
    setInterval(()=>{},1000);
    const db=new DatabaseSync(process.env.TEST_DB);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(x)');
    db.exec("ATTACH DATABASE '"+process.env.TEST_DB+".archive' AS attached; PRAGMA attached.journal_mode=WAL; CREATE TABLE attached.t(x)");
    process.on('message',m=>{
      if(m.type!=='work') return;
      let expected=0;
      const pos=()=>Number(db.prepare('PRAGMA wal_checkpoint(NOOP)').get().log);
      for(let generation=0;generation<3;generation++) {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        let previous=pos();
        for(let i=0;i<10;i++) {
          db.exec('BEGIN');
          db.prepare('INSERT INTO t VALUES (?)').run(i);
          db.exec('COMMIT');
          const next=pos();expected+=next-previous;previous=next;
        }
      }
      db.exec('PRAGMA attached.wal_checkpoint(TRUNCATE)');
    for(let i=0;i<7;i++) db.prepare('INSERT INTO attached.t VALUES (?)').run(i);
    expected+=Number(db.prepare('PRAGMA attached.wal_checkpoint(NOOP)').get().log);
    process.send({type:'worked',expected});
    });
    process.send({type:'ready'});
  `,
    ],
    {
      env: { ...process.env, TEST_DB: directory + "/test.sqlite", ROBOB_PERF_SAMPLE_FILE: file },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const next = (type: string) =>
    new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("IPC timeout " + type)), 5000);
      const listener = (m: any) => {
        if (m.type === type) {
          clearTimeout(timer);
          child.off("message", listener);
          resolve(m);
        }
      };
      child.on("message", listener);
    });
  try {
    await next("ready");
    let ready = next("perf-started");
    child.send({ type: "perf-start" });
    await ready;
    const worked = next("worked");
    child.send({ type: "work" });
    const { expected } = await worked;
    ready = next("perf-stopped");
    child.send({ type: "perf-stop" });
    await ready;
    const samples = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(samples.walError, undefined);
    assert.equal(samples.walWriteFrames, expected);
    assert.ok(expected >= 30);
    assert.equal(samples.walWriteBytes, expected * (4096 + 24));
  } finally {
    child.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});
