// @effect-diagnostics nodeBuiltinImport:off -- fake child-process lifecycle probes avoid signalling real processes.
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { expect, it, vi } from "vite-plus/test";
import { startReaderProcess } from "./nodeSqliteReaderProcess.ts";

it("never signals a failed spawn before its asynchronous error arrives", async () => {
  const kill = vi.fn();
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    connected: false,
    send: () => true,
    kill,
    ref: () => {},
    unref: () => {},
  });
  const runtime = startReaderProcess("", {}, (() => child) as unknown as typeof spawn);
  const stopped = runtime.terminate();
  expect(kill).not.toHaveBeenCalled();
  child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
  expect(await stopped).toBe(1);
  expect(await runtime.completion).toBe(1);
  expect(kill).not.toHaveBeenCalled();
});

it("keeps a spawned process owned until exit even after an IPC error", async () => {
  const kill = vi.fn();
  const child = Object.assign(new EventEmitter(), {
    pid: 42,
    connected: true,
    send: () => true,
    kill,
    ref: () => {},
    unref: () => {},
  });
  const runtime = startReaderProcess("", {}, (() => child) as unknown as typeof spawn);
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
