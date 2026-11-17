// @effect-diagnostics nodeBuiltinImport:off -- exercises the worker boundary with real children.
import { describe, expect, it } from "@effect/vitest";
import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { SpawnClient } from "./SpawnClient.ts";
import { spawnWorker } from "./spawnWorker.ts";
import { createCommandResolver } from "./commandResolver.ts";

describe("SpawnClient", () => {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Native POSIX fixtures are selected during test collection.
  const posixIt = it.skipIf(process.platform === "win32");
  posixIt.each(
    ["removed", "missing-interpreter", "no-match", "chmod", "parent-not-directory"].flatMap(
      (mode) => [false, true].map((race) => ({ mode, race })),
    ),
  )("selects the native binary after $mode (race=$race)", async ({ mode, race }) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "spawn-resolver-"));
    for (const dir of ["first", "second"]) {
      NodeFS.mkdirSync(NodePath.join(root, dir));
      NodeFS.symlinkSync(process.execPath, NodePath.join(root, dir, "git"));
    }
    const first = NodePath.join(root, "first", "git");
    const second = NodePath.join(root, "second", "git");
    const log = NodePath.join(root, "spawns.jsonl");
    const mutate = (
      fs: typeof NodeFS,
      path: typeof NodePath,
      first: string,
      second: string,
      mode: string,
    ) => {
      if (mode === "chmod") {
        fs.unlinkSync(first);
        fs.writeFileSync(first, "#!/bin/sh\n", { mode: 0o644 });
      } else {
        fs.unlinkSync(first);
        if (mode === "missing-interpreter") {
          fs.writeFileSync(first, "#!/missing-interpreter-1793\n", { mode: 0o755 });
        } else if (mode === "no-match") fs.unlinkSync(second);
        else if (mode === "parent-not-directory") {
          fs.rmdirSync(path.dirname(first));
          fs.writeFileSync(path.dirname(first), "file");
        }
      }
    };
    const client = new SpawnClient(
      () =>
        new NodeWorkerThreads.Worker(
          `
        const NodeFS = require('node:fs'), NodePath = require('node:path');
        const cp = require('node:child_process');
        const first = ${JSON.stringify(first)}, second = ${JSON.stringify(second)}, mode = ${JSON.stringify(mode)};
        const mutate = ${mutate.toString()}; let spawns = 0;
        const resolver = (${createCommandResolver.toString()})(NodeFS, NodePath);
        (${spawnWorker.toString()})({...cp, spawn(command,args,options) {
          NodeFS.appendFileSync(${JSON.stringify(log)}, JSON.stringify({command,argv0:options.argv0})+'\\n');
          if (${race} && ++spawns === 2) mutate(NodeFS, NodePath, first, second, mode);
          return cp.spawn(command,args,options);
        }},require('node:worker_threads').parentPort,resolver);
      `,
          { eval: true, execArgv: [] },
        ),
    );
    const env = { PATH: `${root}/first:${root}/second`, RESOLVER_TEST: "inherited" };
    const run = async () => {
      const child = client.spawn(
        "git",
        [
          "-e",
          "process.stdout.write(JSON.stringify([process.argv0,process.env.PATH,process.env.RESOLVER_TEST]))",
        ],
        { env, stdio: "pipe" },
      );
      try {
        await child.started;
        let text = "";
        for await (const chunk of child.stdout) text += chunk;
        expect(await child.exit).toEqual([0, null]);
        expect(JSON.parse(text)).toEqual(["git", env.PATH, "inherited"]);
      } finally {
        child.dispose();
      }
    };
    try {
      await run();
      if (!race) mutate(NodeFS, NodePath, first, second, mode);
      if (mode === "no-match") await expect(run()).rejects.toMatchObject({ code: "ENOENT" });
      else await run();
      expect(
        NodeFS.readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([
        { command: first, argv0: "git" },
        ...(race || mode === "missing-interpreter" ? [{ command: first, argv0: "git" }] : []),
        mode === "missing-interpreter" || mode === "no-match"
          ? { command: "git" }
          : { command: second, argv0: "git" },
      ]);
    } finally {
      await client.close();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["error-event", "throw", "stream-error"])(
    "preserves only diagnostic fields from a worker %s",
    async (mode) => {
      const client = new SpawnClient(
        () =>
          new NodeWorkerThreads.Worker(
            `
          const { parentPort } = require('node:worker_threads');
          const { EventEmitter } = require('node:events');
          const { PassThrough } = require('node:stream');
          const error = Object.assign(new Error('synthetic spawn failure'), {
            code: 'EAGAIN', errno: -11, syscall: 'spawn', path: '/fixture/gh',
            stdout: 'private-worker-token', stderr: 'private-worker-token',
            spawnargs: ['private-worker-token'], env: { GH_TOKEN: 'private-worker-token' },
          });
          (${spawnWorker.toString()})({ spawn() {
            if (${JSON.stringify(mode)} === 'throw') throw error;
            const child = new EventEmitter();
            child.stdout = new PassThrough(); child.stderr = new PassThrough();
            queueMicrotask(() => (${JSON.stringify(mode)} === 'stream-error' ? child.stdout : child).emit('error', error));
            return child;
          } }, parentPort);
          `,
            { eval: true, execArgv: [] },
          ),
      );
      try {
        const child = client.spawn("/fixture/gh", [], { stdio: "pipe" });
        const error: unknown = await child.started.catch((error: unknown) => error);
        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({
          message: "synthetic spawn failure",
          code: "EAGAIN",
          errno: -11,
          syscall: "spawn",
          path: "/fixture/gh",
        });
        for (const key of ["stdout", "stderr", "spawnargs", "env"])
          expect(error).not.toHaveProperty(key);
        expect(JSON.stringify(error)).not.toContain("private-worker-token");
      } finally {
        await client.close();
      }
    },
  );

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
      await expect(bad.started).rejects.toMatchObject({
        code: "ENOENT",
        errno: -2,
        syscall: "spawn /does/not/exist/robob",
        path: "/does/not/exist/robob",
      });
      const next = client.spawn(process.execPath, ["-e", ""], { detached: true, stdio: "ignore" });
      await next.started;
      expect(await next.exit).toEqual([0, null]);
      next.dispose();
    } finally {
      await client.close();
    }
  });
});
