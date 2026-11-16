// @effect-diagnostics nodeBuiltinImport:off -- Node stream/worker boundary, owned by the spawner layer.
import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeStream from "node:stream";
import type * as NodeChildProcess from "node:child_process";
import { spawnWorker, type SpawnEvent } from "./spawnWorker.ts";

export class SpawnClient {
  private worker: NodeWorkerThreads.Worker | undefined;
  private closed = false;
  private readonly pending = new Map<(error: Error) => void, () => boolean>();

  private readonly createWorker;
  constructor(
    createWorker = () =>
      new NodeWorkerThreads.Worker(
        `(${spawnWorker.toString()})(require('node:child_process'), require('node:worker_threads').parentPort)`,
        { eval: true, execArgv: [] },
      ),
  ) {
    this.createWorker = createWorker;
  }

  private getWorker() {
    if (this.closed) throw new Error("Spawn client closed");
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    this.worker = worker;
    const fail = (error: Error) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      for (const reject of this.pending.keys()) reject(error);
    };
    worker.on("error", fail);
    worker.on("exit", () => fail(new Error("Spawn worker exited")));
    worker.unref();
    return worker;
  }

  spawn(command: string, args: ReadonlyArray<string>, options: NodeChildProcess.SpawnOptions) {
    const worker = this.getWorker();
    const { port1: port, port2 } = new NodeWorkerThreads.MessageChannel();
    const state = new Int32Array(new SharedArrayBuffer(8));
    const stdout = new NodeStream.PassThrough();
    const stderr = new NodeStream.PassThrough();
    // Streams can fail before their Effect consumers attach.
    stdout.on("error", () => {});
    stderr.on("error", () => {});
    let writeDone: ((error?: Error | null) => void) | undefined;
    const stdin = new NodeStream.Writable({
      write(data, _encoding, callback) {
        writeDone = callback;
        port.postMessage({ type: "write", data });
      },
      final(callback) {
        writeDone = callback;
        port.postMessage({ type: "end" });
      },
    });
    stdin.on("error", () => {});
    let exited = false;
    let failedExit = false;
    let ends = 0;
    let referenced = true;
    let resolveExit: (value: readonly [number | null, NodeJS.Signals | null]) => void;
    let rejectExit: (error: Error) => void;
    const exit = new Promise<readonly [number | null, NodeJS.Signals | null]>((resolve, reject) => {
      resolveExit = resolve;
      rejectExit = reject;
    });
    void exit.catch(() => {});
    let rejectSpawn: (error: Error) => void;
    let resolveSpawn: (pid: number) => void;
    const started = new Promise<number>((resolve, reject) => {
      resolveSpawn = resolve;
      rejectSpawn = reject;
    });
    void started.catch(() => {});
    const signal = (signal: NodeJS.Signals | 0) => {
      const pid = Atomics.load(state, 0);
      if (pid) {
        try {
          process.kill(options.detached ? -pid : pid, signal);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      return false;
    };
    const dispose = () => {
      this.pending.delete(fail);
      port.close();
      if (this.closed && this.pending.size === 0) void this.worker?.terminate();
    };
    const fail = (error: Error) => {
      Atomics.store(state, 1, 1);
      try {
        signal("SIGKILL");
      } catch {
        /* Best effort after worker loss. */
      }
      exited = true;
      rejectSpawn(error);
      rejectExit(error);
      stdout.destroy(error);
      stderr.destroy(error);
      stdin.destroy(error);
      writeDone?.(error);
      writeDone = undefined;
      dispose();
    };
    this.pending.set(fail, () => referenced);
    port.on("message", (event: SpawnEvent) => {
      switch (event.type) {
        case "spawn":
          resolveSpawn(event.pid);
          break;
        case "error":
          fail(
            Object.assign(new Error(event.message), {
              code: event.code,
              errno: event.errno,
              syscall: event.syscall,
              path: event.path,
            }),
          );
          break;
        case "exit":
          exited = true;
          failedExit = event.code !== null && event.code !== 0;
          resolveExit([event.code, event.signal]);
          if (!referenced && ends === 2) dispose();
          break;
        case "data": {
          const output = event.stream === "stdout" ? stdout : stderr;
          output.write(event.data, () => {
            if (!output.destroyed) port.postMessage({ type: "read", stream: event.stream });
          });
          break;
        }
        case "end":
          (event.stream === "stdout" ? stdout : stderr).end();
          ends++;
          if (!referenced && exited && ends === 2) dispose();
          break;
        case "written": {
          const callback = writeDone;
          writeDone = undefined;
          callback?.(event.error ? new Error(event.error) : undefined);
          break;
        }
      }
    });
    try {
      worker.postMessage({ command, args: [...args], options, state: state.buffer, port: port2 }, [
        port2,
      ]);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
    return {
      started,
      exit,
      stdout,
      stderr,
      stdin,
      signal,
      dispose,
      hasStarted: () => Atomics.load(state, 0) !== 0,
      isRunning: () => !exited,
      hasFailed: () => failedExit,
      isReferenced: () => referenced,
      unref: () => {
        referenced = false;
        port.unref();
        if (exited && ends === 2) dispose();
      },
      ref: () => {
        referenced = true;
        port.ref();
      },
      cancel: () => fail(new Error("Spawn cancelled")),
    };
  }

  async close() {
    this.closed = true;
    for (const [fail, referenced] of this.pending)
      if (referenced()) fail(new Error("Spawn client closed"));
    // Unreferenced children outlive their scope just as Node's child.unref does.
    // Their unreferenced ports dispose the worker once output and exit arrive.
    if (this.pending.size === 0) await this.worker?.terminate();
  }
}
