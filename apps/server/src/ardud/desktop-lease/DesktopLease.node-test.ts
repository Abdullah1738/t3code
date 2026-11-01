// @effect-diagnostics nodeBuiltinImport:off - isolated file-backed concurrency tests.
import * as FS from "node:fs";
import * as Path from "node:path";
import * as Assert from "node:assert/strict";
import * as ChildProcess from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";

import { DesktopLease, QUIET_MS, STALE_MS } from "./DesktopLease.ts";

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
  return { filename, open, addTime: (ms: number) => { now += ms; } };
}

const request = (id: string) => ({
  rootThreadId: `root-${id}`,
  childThreadId: `child-${id}`,
  taskId: `task-${id}`,
  scope: "fixture app / window 1",
  mode: "native" as const,
});

describe("desktop lease", () => {
  it("serializes independent connections and resumes the FIFO only after a safe release", () => {
    const { open, addTime } = setup();
    const a = open();
    const b = open();
    const first = a.acquire(request("1"));
    const second = b.acquire(request("2"));
    const third = a.acquire(request("3"));
    Assert.equal(first.state, "held");
    Assert.equal(second.state, "queued");
    Assert.equal(third.state, "queued");
    Assert.deepEqual(b.status().queue.map((item) => item.taskId), ["task-2", "task-3"]);
    Assert.equal(b.acquire(request("2")).ticket, second.ticket);
    Assert.throws(() => b.acquire({ ...request("2"), scope: "other" }));
    Assert.throws(() => b.acquire({ ...request("4"), childThreadId: "child-2" }));
    Assert.equal(a.release(first.ticket).lease?.state, "stopping");
    Assert.equal(b.status().queue.length, 2);
    a.recordVerifiedQuiescence(first.ticket, "supervisor stopped controller and checked native service");
    Assert.equal(a.release(first.ticket).lease?.state, "stopping");
    addTime(QUIET_MS);
    Assert.equal(a.status().lease, null);
    Assert.equal(a.acquire(request("3")).state, "queued");
    Assert.equal(b.acquire(request("2")).state, "held");
    Assert.equal(b.status().lease?.state, "held");
    Assert.deepEqual(b.stop(third.ticket).queue, []);
    Assert.throws(() => b.acquire(request("3")));
  });

  it("does not allow a stale or hung call to be replaced by the quiet timer, even after restart", () => {
    const { open, addTime } = setup();
    const a = open();
    const first = a.acquire(request("1"));
    a.startCall(first.ticket, "call-1");
    a.acquire(request("2"));
    addTime(STALE_MS);
    Assert.equal(a.status().lease?.state, "stopping");
    Assert.throws(() => a.startCall(first.ticket, "call-2"));
    Assert.throws(() => a.heartbeat(first.ticket));
    addTime(QUIET_MS);
    Assert.equal(open().status().lease?.state, "quarantined");
    addTime(QUIET_MS * 20);
    Assert.equal(open().status().lease?.taskId, "task-1");
    Assert.equal(a.release(first.ticket).lease?.state, "quarantined");
    Assert.equal(a.endCall(first.ticket, "call-1", "completed").lease?.state, "quarantined");
    Assert.equal(a.reconcile(first.ticket, "manually verified controller stopped and service is idle").lease, null);
    Assert.equal(a.acquire(request("2")).state, "held");
  });

  it("quarantines uncertain outcomes, rejects replay, and persists in-flight calls", () => {
    const { open } = setup();
    const a = open();
    const first = a.acquire(request("1"));
    a.startCall(first.ticket, "call-1");
    Assert.throws(() => open().startCall(first.ticket, "call-2"));
    Assert.equal(a.endCall(first.ticket, "call-1", "uncertain").lease?.state, "quarantined");
    Assert.equal(a.endCall(first.ticket, "call-1", "uncertain").lease?.state, "quarantined");
    Assert.throws(() => a.endCall(first.ticket, "call-1", "completed"));
    Assert.throws(() => a.startCall(first.ticket, "call-1"));
    Assert.equal(a.acquire(request("2")).state, "queued");
  });

  it("does not release if a late uncertain report invalidates an earlier quiet proof", () => {
    const { open, addTime } = setup();
    const a = open();
    const first = a.acquire(request("1"));
    a.startCall(first.ticket, "call-1");
    a.acquire(request("2"));
    a.stop(first.ticket);
    a.recordVerifiedQuiescence(first.ticket, "supervisor checked the stopped controller");
    a.endCall(first.ticket, "call-1", "uncertain");
    addTime(QUIET_MS * 2);
    Assert.equal(a.release(first.ticket).lease?.state, "quarantined");
    Assert.equal(a.acquire(request("2")).state, "queued");
  });

  it("persists the stale transition even when the operation that discovers it is rejected", () => {
    const { open, addTime } = setup();
    const a = open();
    const first = a.acquire(request("1"));
    addTime(STALE_MS);
    Assert.throws(() => a.heartbeat(first.ticket));
    // Turn the test clock back to demonstrate that the stop did commit, rather
    // than a later status call independently discovering the same expiration.
    addTime(-STALE_MS);
    Assert.equal(open().status().lease?.state, "stopping");
  });

  it("fails closed for a second process while the database writer is locked", () => {
    const { open, filename } = setup();
    const a = open();
    const b = open();
    const writer = new DatabaseSync(filename);
    try {
      writer.exec("BEGIN IMMEDIATE");
      Assert.throws(() => b.acquire(request("2")), /locked|busy/i);
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
    Assert.equal(a.status().lease, null);
    Assert.equal(a.acquire(request("1")).state, "held");
  });

  it("auto-releases only after independent proof and the full stopping quiet period", () => {
    const { open, addTime } = setup();
    const a = open();
    const first = a.acquire(request("1"));
    a.acquire(request("2"));
    Assert.throws(() => a.recordVerifiedQuiescence(first.ticket, "premature"));
    a.stop(first.ticket);
    a.recordVerifiedQuiescence(first.ticket, "supervisor stopped process and checked service");
    addTime(QUIET_MS - 1);
    Assert.equal(a.status().lease?.taskId, "task-1");
    addTime(1);
    Assert.equal(a.status().lease, null);
    Assert.equal(a.acquire(request("2")).state, "held");
  });

  it("cancels a waiting task and stops a running task via the delegation lifecycle", () => {
    const { open } = setup();
    const a = open();
    a.acquire(request("1"));
    a.acquire(request("2"));
    Assert.deepEqual(a.stopTask("task-2").queue, []);
    Assert.equal(a.stopTask("task-1").lease?.state, "stopping");
    Assert.throws(() => a.acquire(request("2")));
  });

  it("uses a database-enforced singleton even against a second independent writer", () => {
    const { open, filename } = setup();
    const a = open();
    a.acquire(request("1"));
    const other = new DatabaseSync(filename);
    try {
      Assert.throws(() => other.prepare(`INSERT INTO ardud_desktop_requests
        (ticket, root_thread_id, child_thread_id, task_id, scope, mode, request_state, lease_state, enqueued_at)
        VALUES ('other', 'r', 'c', 't', 's', 'native', 'held', 'held', 1)`).run());
    } finally {
      other.close();
    }
    Assert.equal(a.status().lease?.taskId, "task-1");
  });

  it("serializes real simultaneous requests in independent processes", async () => {
    const { open, filename } = setup();
    const a = open();
    const moduleUrl = new URL("./DesktopLease.ts", import.meta.url).href;
    const code = `import { DesktopLease } from ${JSON.stringify(moduleUrl)};
      const lease = new DesktopLease({ filename: process.argv[1] });
      process.stdout.write(JSON.stringify(lease.acquire({ rootThreadId:'r', childThreadId:process.argv[2],
        taskId:process.argv[2], scope:'fixture', mode:'native' })));
      lease.close();`;
    const spawn = (id: string) => new Promise<{ state: string }>((resolve, reject) => {
      const child = ChildProcess.spawn(process.execPath, ["--input-type=module", "-e", code, filename, id]);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (exit) => {
        if (exit !== 0) reject(new Error(stderr));
        else resolve(JSON.parse(stdout) as { state: string });
      });
    });
    const results = await Promise.all([spawn("child-1"), spawn("child-2")]);
    Assert.deepEqual(results.map((result) => result.state).sort(), ["held", "queued"]);
    const status = a.status();
    Assert.equal(status.queue.length, 1);
    Assert.notEqual(status.lease?.childThreadId, status.queue[0]?.childThreadId);
  });
});
