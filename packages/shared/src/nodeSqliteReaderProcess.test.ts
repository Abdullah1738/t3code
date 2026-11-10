// @effect-diagnostics nodeBuiltinImport:off -- fake child-process lifecycle probes avoid signalling real processes.
import * as NodeEvents from "node:events";
import type * as NodeChildProcess from "node:child_process";
import { expect, it, vi } from "vite-plus/test";
import { startReaderProcess } from "./nodeSqliteReaderProcess.ts";

it("never signals a failed spawn before its asynchronous error arrives", async () => {
  const kill = vi.fn();
  const child = Object.assign(new NodeEvents.EventEmitter(), {
    pid: undefined,
    connected: false,
    send: () => true,
    kill,
    ref: () => {},
    unref: () => {},
  });
  const runtime = startReaderProcess(
    "",
    {},
    (() => child) as unknown as typeof NodeChildProcess.spawn,
  );
  const stopped = runtime.terminate();
  expect(kill).not.toHaveBeenCalled();
  child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
  expect(await stopped).toBe(1);
  expect(await runtime.completion).toBe(1);
  expect(kill).not.toHaveBeenCalled();
});

it("keeps a spawned process owned until exit even after an IPC error", async () => {
  const kill = vi.fn();
  const child = Object.assign(new NodeEvents.EventEmitter(), {
    pid: 42,
    connected: true,
    send: () => true,
    kill,
    ref: () => {},
    unref: () => {},
  });
  const runtime = startReaderProcess(
    "",
    {},
    (() => child) as unknown as typeof NodeChildProcess.spawn,
  );
  child.emit("error", new Error("IPC failed"));
  let done = false;
  void runtime.completion!.then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  const stopped = runtime.terminate();
  expect(kill).toHaveBeenCalledWith("SIGKILL");
  child.emit("exit", null);
  expect(await stopped).toBe(1);
  runtime.terminate();
  expect(kill).toHaveBeenCalledTimes(1);
});

// A stand-in worker for the guard: "block" spins like a long native SQLite call.
const guardWorker = `
const { parentPort, workerData } = require("node:worker_threads");
let db = { isTransaction: false };
parentPort.on("message", ({ id, op, ms }) => {
  if (op === "begin") db.isTransaction = true;
  if (op === "commit") db.isTransaction = false;
  if (op === "block") { const end = Date.now() + ms; while (Date.now() < end) {} }
  parentPort.postMessage({ id });
});`;

const runGuarded = (data: Record<string, unknown>, ops: ReadonlyArray<Record<string, unknown>>) =>
  new Promise<"answered" | "killed">((resolve) => {
    const runtime = startReaderProcess(guardWorker, data);
    let answered = 0;
    runtime.on("message", () => {
      if (++answered === ops.length) {
        resolve("answered");
        void runtime.terminate();
      }
    });
    runtime.on("exit", () => resolve("killed"));
    ops.forEach((op, id) => runtime.postMessage({ id, ...op }));
  });

it("the child's guard gives autocommit work the long limit and an open transaction its own", async () => {
  const limits = { statementLimitMs: 4_000, transactionLimitMs: 400 };
  // Past the transaction limit but outside a transaction: not killed.
  expect(await runGuarded(limits, [{ op: "block", ms: 1_200 }])).toBe("answered");
  // The same work inside a transaction is killed at the transaction limit.
  expect(
    await runGuarded(limits, [{ op: "begin" }, { op: "block", ms: 3_000 }, { op: "commit" }]),
  ).toBe("killed");
  // Without a transaction limit (the view reader) a transaction keeps the one limit.
  expect(
    await runGuarded({ statementLimitMs: 4_000 }, [
      { op: "begin" },
      { op: "block", ms: 1_200 },
      { op: "commit" },
    ]),
  ).toBe("answered");
}, 30_000);
