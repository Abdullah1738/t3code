// @effect-diagnostics nodeBuiltinImport:off -- exercises the worker boundary with real children.
import { describe, expect, it } from "@effect/vitest";
import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeEvents from "node:events";
import { SpawnClient } from "./SpawnClient.ts";
import { spawnWorker } from "./spawnWorker.ts";

describe("SpawnClient", () => {
  it("leaves an unreferenced child alive when the client scope closes", async () => {
    const client = new SpawnClient();
    const child = client.spawn(
      process.execPath,
      ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
      { detached: true, stdio: "pipe" },
    );
    try {
      const ready = NodeEvents.EventEmitter.once(child.stdout, "data");
      await child.started;
      await ready;
      child.unref();
      await client.close();
      expect(child.signal(0)).toBe(true);
      child.ref();
      child.signal("SIGTERM");
      expect((await child.exit)[1]).toBe("SIGTERM");
    } finally {
      child.cancel();
      await client.close();
    }
  });
  it("cancels a queued spawn before the worker enters the syscall", async () => {
    const gate = new Int32Array(new SharedArrayBuffer(8));
    let worker: NodeWorkerThreads.Worker;
    const client = new SpawnClient(() => {
      worker = new NodeWorkerThreads.Worker(
        `
        const {parentPort,workerData}=require('node:worker_threads');
        const gate=new Int32Array(workerData); const cp=require('node:child_process');
        parentPort.postMessage('blocked'); Atomics.wait(gate,0,0);
        (${spawnWorker.toString()})({...cp,spawn(...args){Atomics.add(gate,1,1);return cp.spawn(...args)}},parentPort);
      `,
        { eval: true, execArgv: [], workerData: gate.buffer },
      );
      return worker;
    });
    try {
      const cancelled = client.spawn(process.execPath, ["-e", ""], {
        detached: true,
        stdio: "ignore",
      });
      const failed = expect(cancelled.started).rejects.toThrow("Spawn cancelled");
      await NodeEvents.EventEmitter.once(worker!, "message");
      cancelled.cancel();
      await failed;
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
      const next = client.spawn(process.execPath, ["-e", ""], { detached: true, stdio: "ignore" });
      await next.started;
      await next.exit;
      next.dispose();
      expect(Atomics.load(gate, 1)).toBe(1);
    } finally {
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
      await client.close();
    }
  });

  it("streams large output through a slow consumer without dropping bytes", async () => {
    const client = new SpawnClient();
    try {
      const child = client.spawn(
        process.execPath,
        ["-e", "process.stdout.write(Buffer.alloc(8*1024*1024,97))"],
        { detached: true, stdio: "pipe" },
      );
      await child.started;
      let bytes = 0;
      for await (const chunk of child.stdout) {
        bytes += chunk.length;
        expect(chunk.every((value: number) => value === 97)).toBe(true);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(await child.exit).toEqual([0, null]);
      child.dispose();
      expect(bytes).toBe(8 * 1024 * 1024);
    } finally {
      await client.close();
    }
  });
  it("streams stdin/stdout/stderr and preserves nonzero exits and per-call env", async () => {
    const client = new SpawnClient();
    try {
      const child = client.spawn(
        process.execPath,
        [
          "-e",
          `process.stdin.pipe(process.stdout); process.stderr.write(process.env.SPAWN_TEST); process.stdin.on('end',()=>process.exitCode=17)`,
        ],
        { env: { SPAWN_TEST: "stderr" }, detached: true, stdio: "pipe" },
      );
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (chunk) => out.push(chunk));
      child.stderr.on("data", (chunk) => err.push(chunk));
      const ended = Promise.all([
        NodeEvents.EventEmitter.once(child.stdout, "end"),
        NodeEvents.EventEmitter.once(child.stderr, "end"),
      ]);
      expect(await child.started).toBeGreaterThan(0);
      child.stdin.end("input");
      expect(await child.exit).toEqual([17, null]);
      await ended;
      expect(Buffer.concat(out).toString()).toBe("input");
      expect(Buffer.concat(err).toString()).toBe("stderr");
      child.dispose();
    } finally {
      await client.close();
    }
  });

  it("fails in-flight calls after worker loss, then starts a fresh worker", async () => {
    const workers: NodeWorkerThreads.Worker[] = [];
    const client = new SpawnClient(() => {
      const worker = new NodeWorkerThreads.Worker(
        `(${spawnWorker.toString()})(require('node:child_process'),require('node:worker_threads').parentPort)`,
        { eval: true, execArgv: [] },
      );
      workers.push(worker);
      return worker;
    });
    try {
      const child = client.spawn(
        process.execPath,
        ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
        { detached: true, stdio: "pipe" },
      );
      const ready = NodeEvents.EventEmitter.once(child.stdout, "data");
      await child.started;
      await ready;
      const failed = expect(child.exit).rejects.toThrow("Spawn worker exited");
      await workers[0]!.terminate();
      await failed;
      const next = client.spawn(process.execPath, ["-e", "process.exit(0)"], {
        detached: true,
        stdio: "ignore",
      });
      await next.started;
      expect(await next.exit).toEqual([0, null]);
      next.dispose();
      expect(workers).toHaveLength(2);
    } finally {
      await client.close();
    }
  });

  it("fails invalid commands without poisoning the next spawn", async () => {
    const client = new SpawnClient();
    try {
      const bad = client.spawn("/does/not/exist/robob", [], { detached: true, stdio: "pipe" });
      await expect(bad.started).rejects.toMatchObject({ code: "ENOENT" });
      const next = client.spawn(process.execPath, ["-e", ""], { detached: true, stdio: "ignore" });
      await next.started;
      expect(await next.exit).toEqual([0, null]);
      next.dispose();
    } finally {
      await client.close();
    }
  });
});
