// @effect-diagnostics nodeBuiltinImport:off - these use isolated file-backed SQLite stores.
import * as FS from "node:fs";
import * as Path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  DesktopLease,
  DesktopLeaseError,
  QUIET_MS,
  STALE_MS,
  type AcquireResult,
  type Caller,
} from "./DesktopLease.ts";

const dirs: string[] = [];
const stores: DesktopLease[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) FS.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = FS.mkdtempSync(Path.join(process.cwd(), ".desktop-lease-test-"));
  dirs.push(dir);
  const filename = Path.join(dir, "lease.sqlite");
  let now = 1_750_000_000_000;
  const open = () => {
    const store = new DesktopLease({ filename, now: () => now });
    stores.push(store);
    return store;
  };
  return { dir, filename, open, addTime: (ms: number) => { now += ms; } };
}

const caller = (id: string): Caller => ({
  rootThreadId: `root-${id}`,
  robobThreadId: `child-${id}`,
});
const request = (id: string) => ({
  taskId: `task-${id}`,
  scope: "fixture app / window 1",
  mode: "native" as const,
});
const conflict = (operation: () => unknown) => {
  let failure: unknown;
  try {
    operation();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(DesktopLeaseError);
  expect(failure).toMatchObject({ code: "conflict" });
};

describe("desktop lease", () => {
  it("serializes connections, preserves FIFO, and grants the head only on its retry", () => {
    const { open } = setup();
    const a = open();
    const b = open();
    const first = a.acquire(caller("1"), request("1"));
    const second = b.acquire(caller("2"), request("2"));
    const third = a.acquire(caller("3"), request("3"));
    expect(first.state).toBe("held");
    expect(first.position).toBeNull();
    expect(second).toMatchObject({ state: "queued", position: 1 });
    expect(third).toMatchObject({ state: "queued", position: 2 });
    expect(b.status().queue.map(({ taskId }) => taskId)).toEqual(["task-2", "task-3"]);
    expect(b.acquire(caller("2"), request("2"))).toMatchObject({ ticket: second.ticket, state: "queued", position: 1 });
    expect(a.release(caller("1"), first.ticket).lease).toBeNull();
    expect(a.acquire(caller("3"), request("3"))).toMatchObject({ state: "queued", position: 2 });
    expect(b.acquire(caller("2"), request("2"))).toMatchObject({ ticket: second.ticket, state: "held" });
    expect(b.status().lease).toMatchObject({ ticket: second.ticket, childThreadId: "child-2" });
  });

  it("keys idempotence to the exact caller and task without allowing changes or reviving a closed ticket", () => {
    const { open } = setup();
    const store = open();
    const first = store.acquire(caller("1"), request("same"));
    expect(store.acquire(caller("1"), request("same"))).toMatchObject({ ticket: first.ticket, state: "held" });
    conflict(() => store.acquire(caller("1"), { ...request("same"), scope: "other" }));
    conflict(() => store.acquire(caller("1"), { ...request("same"), mode: "cua-driver" }));
    const other = store.acquire(caller("2"), request("same"));
    expect(other).toMatchObject({ state: "queued", position: 1 });
    expect(other.ticket).not.toBe(first.ticket);
    const siblingTask = store.acquire(caller("1"), request("different"));
    expect(siblingTask).toMatchObject({ state: "queued", position: 2 });
    store.release(caller("1"), first.ticket);
    expect(store.acquire(caller("1"), request("same"))).toMatchObject({ ticket: first.ticket, state: "finished" });
    expect(store.status().queue.map(({ ticket }) => ticket)).toEqual([other.ticket, siblingTask.ticket]);
  });

  it("rejects heartbeat, release, and call-start by nonholders, including a different root", () => {
    const { open } = setup();
    const store = open();
    const held = store.acquire(caller("1"), request("1"));
    const queued = store.acquire(caller("2"), request("2"));
    const sameChildOtherRoot = { ...caller("1"), rootThreadId: "another-root" };
    for (const intruder of [caller("2"), sameChildOtherRoot]) {
      conflict(() => store.heartbeat(intruder, held.ticket));
      conflict(() => store.release(intruder, held.ticket));
      conflict(() => store.callStart(intruder, "unauthorized"));
    }
    conflict(() => store.heartbeat(caller("2"), queued.ticket));
    conflict(() => store.release(caller("2"), queued.ticket));
    expect(store.status().queue.map(({ ticket }) => ticket)).toEqual([queued.ticket]);
    expect(store.callStart(caller("1"), "unauthorized").lease?.ticket).toBe(held.ticket);
  });

  it("waits for the last recorded call after release, including across reopened connections", () => {
    const { open } = setup();
    const a = open();
    const first = a.acquire(caller("1"), request("1"));
    const next = a.acquire(caller("2"), request("2"));
    a.callStart(caller("1"), "call-1");
    a.callStart(caller("1"), "call-2");
    expect(a.release(caller("1"), first.ticket).lease?.state).toBe("stopping");
    conflict(() => a.callStart(caller("1"), "call-3"));
    conflict(() => a.heartbeat(caller("1"), first.ticket));
    expect(open().callEnd("call-1", "failed").lease?.state).toBe("stopping");
    expect(a.acquire(caller("2"), request("2")).state).toBe("queued");
    expect(open().callEnd("call-2", "completed").lease).toBeNull();
    expect(a.acquire(caller("2"), request("2"))).toMatchObject({ ticket: next.ticket, state: "held" });
  });

  it("commits stale stopping on rejection and waits a full ten minutes even after manual release", () => {
    const { open, addTime } = setup();
    const store = open();
    const first = store.acquire(caller("1"), request("1"));
    const second = store.acquire(caller("2"), request("2"));
    addTime(STALE_MS);
    conflict(() => store.heartbeat(caller("1"), first.ticket));
    addTime(-STALE_MS);
    expect(open().status().lease?.state).toBe("stopping");
    addTime(STALE_MS + 9 * 60_000);
    expect(store.release(caller("1"), first.ticket).lease?.state).toBe("stopping");
    expect(store.acquire(caller("2"), request("2"))).toMatchObject({ ticket: second.ticket, state: "queued" });
    addTime(60_000 - 1);
    expect(store.status().lease?.state).toBe("stopping");
    addTime(1);
    expect(store.status().lease).toBeNull();
    expect(store.acquire(caller("2"), request("2")).state).toBe("held");
  });

  it("does not let call-end or release bypass stale stopping's quiet period", () => {
    const { open, addTime } = setup();
    const store = open();
    const first = store.acquire(caller("1"), request("1"));
    store.callStart(caller("1"), "call-1");
    store.acquire(caller("2"), request("2"));
    addTime(STALE_MS);
    expect(store.status().lease?.state).toBe("stopping");
    expect(store.release(caller("1"), first.ticket).lease?.state).toBe("stopping");
    expect(store.callEnd("call-1", "completed").lease?.state).toBe("stopping");
    addTime(QUIET_MS - 1);
    expect(store.acquire(caller("2"), request("2")).state).toBe("queued");
    addTime(1);
    expect(store.acquire(caller("2"), request("2")).state).toBe("held");
  });

  it("quarantines a stalled explicit release instead of finishing after ten minutes", () => {
    const { open, addTime } = setup();
    const store = open();
    const first = store.acquire(caller("1"), request("1"));
    store.callStart(caller("1"), "hanging-after-release");
    expect(store.release(caller("1"), first.ticket).lease?.state).toBe("stopping");
    store.acquire(caller("2"), request("2"));
    addTime(QUIET_MS);
    expect(store.callEnd("hanging-after-release", "failed").lease?.state).toBe("quarantined");
    expect(store.acquire(caller("2"), request("2")).state).toBe("queued");
    store.reconcile(first.ticket, "operator checked");
    expect(store.acquire(caller("2"), request("2")).state).toBe("held");
  });

  it("quarantines an old open call despite healthy heartbeats; call-end cannot clear quarantine", () => {
    const { open, addTime } = setup();
    const store = open();
    const first = store.acquire(caller("1"), request("1"));
    store.callStart(caller("1"), "hung");
    const second = store.acquire(caller("2"), request("2"));
    for (let i = 0; i < 5; i++) {
      addTime(100_000);
      expect(store.heartbeat(caller("1"), first.ticket).lease?.state).toBe("held");
    }
    addTime(100_000);
    expect(open().status().lease?.state).toBe("quarantined");
    expect(store.acquire(caller("2"), request("2"))).toMatchObject({ ticket: second.ticket, state: "queued" });
    expect(store.callEnd("hung", "completed").lease?.state).toBe("quarantined");
    expect(store.release(caller("1"), first.ticket).lease?.state).toBe("quarantined");
    expect(store.acquire(caller("1"), request("1"))).toMatchObject({ ticket: first.ticket, state: "quarantined" });
    conflict(() => store.callStart(caller("1"), "after-quarantine"));
    expect(store.reconcile(first.ticket, "operator verified the desktop is idle").lease).toBeNull();
    expect(store.acquire(caller("2"), request("2")).state).toBe("held");
  });

  it("keeps a newer holder untouched by late call-end and forbids tool-use ID reuse", () => {
    const { open, addTime } = setup();
    const store = open();
    const first = store.acquire(caller("1"), request("1"));
    store.callStart(caller("1"), "old-call");
    addTime(QUIET_MS);
    expect(store.status().lease?.state).toBe("quarantined");
    store.reconcile(first.ticket, "operator checked");
    const second = store.acquire(caller("2"), request("2"));
    conflict(() => store.callStart(caller("2"), "old-call"));
    // Even an otherwise stale new holder must not be advanced by the old completion.
    addTime(STALE_MS);
    expect(store.callEnd("old-call", "failed").lease).toMatchObject({ ticket: second.ticket, state: "held" });
    expect(store.callEnd("old-call", "failed").lease).toMatchObject({ ticket: second.ticket, state: "held" });
    conflict(() => store.callEnd("old-call", "completed"));
    expect(store.status().lease?.state).toBe("stopping");
  });

  it("preserves completed call IDs across release, reacquisition, and a reopened database", () => {
    const { open } = setup();
    const firstStore = open();
    const first = firstStore.acquire(caller("1"), request("1"));
    firstStore.callStart(caller("1"), "completed-id");
    firstStore.callEnd("completed-id", "completed");
    firstStore.release(caller("1"), first.ticket);
    const reopened = open();
    const second = reopened.acquire(caller("2"), request("2"));
    conflict(() => reopened.callStart(caller("2"), "completed-id"));
    expect(reopened.callEnd("completed-id", "completed").lease).toMatchObject({ ticket: second.ticket, state: "held" });
    expect(reopened.callStart(caller("2"), "unused-id").lease?.ticket).toBe(second.ticket);
  });

  it("does not resurrect a cancelled request or let it block the next queue entry", () => {
    const { open, filename } = setup();
    const store = open();
    const first = store.acquire(caller("1"), request("1"));
    const obsolete = store.acquire(caller("2"), request("2"));
    const next = store.acquire(caller("3"), request("3"));
    const db = new DatabaseSync(filename);
    try {
      db.prepare("UPDATE ardud_desktop_requests SET request_state = 'cancelled' WHERE ticket = ?").run(obsolete.ticket);
    } finally {
      db.close();
    }
    expect(store.acquire(caller("2"), request("2"))).toMatchObject({ ticket: obsolete.ticket, state: "cancelled" });
    expect(store.status().queue.map(({ ticket }) => ticket)).toEqual([next.ticket]);
    store.release(caller("1"), first.ticket);
    expect(store.acquire(caller("2"), request("2")).state).toBe("cancelled");
    expect(store.acquire(caller("3"), request("3")).state).toBe("held");
  });

  it("requires quarantine and evidence for reconcile; reports unknown and invalid calls", () => {
    const { open } = setup();
    const store = open();
    const first = store.acquire(caller("1"), request("1"));
    conflict(() => store.reconcile(first.ticket, "premature"));
    expect(() => store.reconcile(first.ticket, "")).toThrow(/evidence/);
    expect(() => store.callEnd("unknown", "completed")).toThrow(/Unknown desktop call/);
    expect(() => store.callEnd("unknown", "uncertain" as "completed")).toThrow(/Invalid call outcome/);
  });

  it("keeps the SQLite singleton index and fails closed under writer contention", () => {
    const { open, filename } = setup();
    const store = open();
    const first = store.acquire(caller("1"), request("1"));
    const writer = new DatabaseSync(filename);
    try {
      expect(() => writer.prepare(`INSERT INTO ardud_desktop_requests
        (ticket, root_thread_id, child_thread_id, task_id, scope, mode, request_state, lease_state, enqueued_at)
        VALUES ('other', 'r', 'c', 't', 's', 'native', 'held', 'held', 1)`).run()).toThrow();
      writer.exec("BEGIN IMMEDIATE");
      expect(() => store.acquire(caller("2"), request("2"))).toThrow(/locked|busy/i);
      writer.exec("ROLLBACK");
    } finally {
      writer.close();
    }
    expect(store.status().lease?.ticket).toBe(first.ticket);
    expect(store.status().queue).toEqual([]);
  });

  it("serializes genuinely concurrent acquisitions in independent worker threads", async () => {
    const { open, filename } = setup();
    const store = open();
    const moduleUrl = new URL("./DesktopLease.ts", import.meta.url).href;
    const signal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const workerCode = `const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { DesktopLease } = await import(workerData.moduleUrl);
        const store = new DesktopLease({ filename: workerData.filename });
        parentPort.postMessage({ ready: true });
        Atomics.wait(new Int32Array(workerData.signal), 0, 0);
        try {
          const id = workerData.id;
          parentPort.postMessage({ result: store.acquire(
            { robobThreadId: 'child-' + id, rootThreadId: 'root-' + id },
            { taskId: 'task-' + id, scope: 'fixture', mode: 'native' }) });
        } finally { store.close(); }
      })().catch((error) => { throw error; });`;
    const workers = ["1", "2"].map((id) => {
      const worker = new Worker(workerCode, { eval: true, workerData: { id, filename, moduleUrl, signal } });
      let readyResolve: () => void;
      let readyReject: (reason: unknown) => void;
      const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      const done = new Promise<AcquireResult>((resolve, reject) => {
        worker.on("message", (message: { ready?: boolean; result?: AcquireResult }) => {
          if (message.ready) readyResolve();
          if (message.result) resolve(message.result);
        });
        worker.once("error", (error) => { readyReject(error); reject(error); });
        worker.once("exit", (code) => {
          if (code !== 0) {
            const error = new Error(`worker exited with ${code}`);
            readyReject(error);
            reject(error);
          }
        });
      });
      return { worker, ready, done };
    });
    try {
      const results = Promise.all(workers.map(({ done }) => done));
      await Promise.all(workers.map(({ ready }) => ready));
      Atomics.store(new Int32Array(signal), 0, 1);
      Atomics.notify(new Int32Array(signal), 0, workers.length);
      expect((await results).map(({ state }) => state).sort()).toEqual(["held", "queued"]);
      expect(store.status().queue).toHaveLength(1);
      expect(store.status().lease?.childThreadId).not.toBe(store.status().queue[0]?.childThreadId);
    } finally {
      await Promise.all(workers.map(({ worker }) => worker.terminate()));
    }
  });

  it("creates a private directory, corrects the file mode, and never chmods a shared injected parent", () => {
    const { dir } = setup();
    const privateDir = Path.join(dir, "private");
    const filename = Path.join(privateDir, "lease.sqlite");
    const first = new DesktopLease({ filename });
    expect(FS.statSync(privateDir).mode & 0o777).toBe(0o700);
    expect(FS.statSync(filename).mode & 0o777).toBe(0o600);
    for (const suffix of ["-wal", "-shm"]) {
      expect(FS.statSync(filename + suffix).mode & 0o777).toBe(0o600);
    }
    first.close();
    FS.chmodSync(filename, 0o666);
    const second = new DesktopLease({ filename });
    second.close();
    expect(FS.statSync(filename).mode & 0o777).toBe(0o600);
    const sharedDir = Path.join(dir, "shared");
    FS.mkdirSync(sharedDir, { mode: 0o755 });
    FS.chmodSync(sharedDir, 0o755);
    expect(() => new DesktopLease({ filename: Path.join(sharedDir, "lease.sqlite") }))
      .toThrow(/directory must be private/);
    expect(FS.statSync(sharedDir).mode & 0o777).toBe(0o755);
  });

  it("migrates the prototype without reviving old stops or reusing old call IDs", () => {
    const { filename, open, addTime } = setup();
    const db = new DatabaseSync(filename);
    try {
      db.exec(`CREATE TABLE ardud_desktop_requests (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, ticket TEXT NOT NULL UNIQUE,
        root_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL,
        task_id TEXT NOT NULL UNIQUE, scope TEXT NOT NULL, mode TEXT NOT NULL,
        request_state TEXT NOT NULL, lease_state TEXT, enqueued_at INTEGER NOT NULL,
        acquired_at INTEGER, heartbeat_at INTEGER, stopping_at INTEGER,
        quiescent INTEGER NOT NULL DEFAULT 0, evidence TEXT);
        CREATE UNIQUE INDEX ardud_desktop_one_holder ON ardud_desktop_requests(request_state)
          WHERE request_state = 'held';
        CREATE UNIQUE INDEX ardud_desktop_one_child ON ardud_desktop_requests(child_thread_id)
          WHERE request_state IN ('queued', 'held');
        CREATE TABLE ardud_desktop_calls (call_id TEXT PRIMARY KEY, ticket TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('started', 'completed', 'uncertain')),
          started_at INTEGER NOT NULL, ended_at INTEGER);
        INSERT INTO ardud_desktop_requests VALUES (1, 'old', 'root-1', 'child-1', 'task-1',
          'fixture app / window 1', 'native', 'held', 'stopping', 1750000000000,
          1750000000000, 1750000000000, 1750000000000, 1, 'old evidence');
        INSERT INTO ardud_desktop_calls VALUES ('old-call', 'old', 'uncertain',
          1750000000000, 1750000000000);`);
    } finally {
      db.close();
    }
    const store = open();
    expect(store.status().lease).toMatchObject({ ticket: "old", state: "stopping" });
    const next = store.acquire(caller("2"), request("1"));
    expect(next.state).toBe("queued");
    expect(store.release(caller("1"), "old").lease?.state).toBe("stopping");
    expect(store.callEnd("old-call", "failed").lease?.state).toBe("stopping");
    conflict(() => store.reconcile("old", "premature"));
    addTime(QUIET_MS);
    expect(store.acquire(caller("2"), request("1"))).toMatchObject({ ticket: next.ticket, state: "held" });
    conflict(() => store.callStart(caller("2"), "old-call"));
  });
});
