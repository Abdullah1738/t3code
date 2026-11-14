// @effect-diagnostics nodeBuiltinImport:off - the CLI under test is plain Node.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";
import { test } from "@effect/vitest";

// @ts-expect-error plain ESM module without declarations
import { checkLive, ignoreMacosTypeOfServiceEinval } from "./t3ctl.mjs";

test("live bounds health even when it ignores abort", async () => {
  const start = performance.now();
  const guard = new AbortController();
  try {
    const result = await Promise.race([
      checkLive("HEAD", { health: () => new Promise(() => {}), timeoutMs: 25 }),
      NodeTimersPromises.setTimeout(500, undefined, { signal: guard.signal })
        .then(() => {
          throw new Error("live never returned");
        })
        .catch((error: unknown) => {
          if (guard.signal.aborted) return new Promise<never>(() => {});
          throw error;
        }),
    ]);
    NodeAssert.equal(result.live, null);
    NodeAssert.match(result.reason, /health.*timed out/);
    NodeAssert.equal(result.stages.health.status, "timeout");
    NodeAssert.ok(performance.now() - start < 400);
  } finally {
    guard.abort();
  }
});

test.each(["target", "build", "ancestry", "shallow"])(
  "live bounds an injected %s git stage",
  async (slowStage) => {
    const started: string[] = [];
    const start = performance.now();
    const result = await checkLive("HEAD", {
      timeoutMs: 40,
      health: async () => ({ ok: true, status: "healthy", buildCommit: "abcdef012345" }),
      onStage: (name: string) => started.push(name),
      git: async (args: string[]) => {
        if (started.at(-1) === slowStage) return new Promise(() => {});
        return {
          status: args[0] === "merge-base" ? 1 : 0,
          stdout: args[0] === "cat-file" ? "commit" : "abcdef012345",
        };
      },
    });
    NodeAssert.equal(result.live, null);
    NodeAssert.match(result.reason, new RegExp(`${slowStage}.*timed out`));
    NodeAssert.equal(result.stages[slowStage].status, "timeout");
    NodeAssert.ok(performance.now() - start < 400);
  },
);

test("live fast paths keep the answer fields and add stage timings", async () => {
  for (const live of [true, false]) {
    const result = await checkLive("HEAD", {
      health: async () => ({ ok: true, status: "healthy", buildCommit: "abcdef012345" }),
      git: async (args: string[]) => ({
        status: args[0] === "merge-base" && !live ? 1 : 0,
        stdout:
          args[0] === "cat-file"
            ? "commit"
            : args.includes("--is-shallow-repository")
              ? "false"
              : "abcdef012345",
      }),
    });
    NodeAssert.equal(result.commit, "HEAD");
    NodeAssert.equal(result.buildCommit, "abcdef012345");
    NodeAssert.equal(result.live, live);
    NodeAssert.equal(result.reason, live ? "ancestor of build" : "not ancestor of build");
    NodeAssert.ok(result.elapsedMs >= 0);
    NodeAssert.deepEqual(Object.keys(result.stages), [
      "health",
      "target",
      "build",
      "ancestry",
      ...(live ? [] : ["shallow"]),
    ]);
    for (const stage of Object.values(result.stages) as { status: string; ms: number }[]) {
      NodeAssert.equal(stage.status, "ok");
      NodeAssert.ok(stage.ms >= 0);
    }
  }
});

test("the macOS QoS guard swallows only Error EINVAL and preserves socket calls", () => {
  let error: unknown = Object.assign(new Error("setTypeOfService EINVAL"), { code: "EINVAL" });
  const socket = new NodeNet.Socket();
  const prototype = {
    setTypeOfService(this: NodeNet.Socket, typeOfService: number) {
      NodeAssert.equal(this, socket);
      NodeAssert.equal(typeOfService, 0);
      if (error !== undefined) throw error;
      return "success";
    },
  };
  ignoreMacosTypeOfServiceEinval("darwin", prototype);
  NodeAssert.equal(prototype.setTypeOfService.call(socket, 0), socket);

  error = Object.assign(new Error("setTypeOfService EPERM"), { code: "EPERM" });
  NodeAssert.throws(
    () => prototype.setTypeOfService.call(socket, 0),
    (thrown) => thrown === error,
  );
  error = { code: "EINVAL" };
  NodeAssert.throws(
    () => prototype.setTypeOfService.call(socket, 0),
    (thrown) => thrown === error,
  );
  error = undefined;
  NodeAssert.equal(prototype.setTypeOfService.call(socket, 0), "success");
});

test("the QoS guard changes nothing off macOS or without the socket method", () => {
  const error = Object.assign(new Error("setTypeOfService EINVAL"), { code: "EINVAL" });
  const prototype = {
    setTypeOfService() {
      throw error;
    },
  };
  const original = prototype.setTypeOfService;
  for (const platform of ["linux", "win32"]) {
    ignoreMacosTypeOfServiceEinval(platform, prototype);
    NodeAssert.equal(prototype.setTypeOfService, original);
    NodeAssert.throws(
      () => prototype.setTypeOfService(),
      (thrown) => thrown === error,
    );
  }
  const withoutMethod = {};
  ignoreMacosTypeOfServiceEinval("darwin", withoutMethod);
  NodeAssert.equal(Object.hasOwn(withoutMethod, "setTypeOfService"), false);
});

test("health reports a closed port without a stack trace", async () => {
  const server = NodeNet.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no test server address");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodeURL.fileURLToPath(new URL("./t3ctl.mjs", import.meta.url)),
      "health",
      "--request-timeout",
      "5",
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        T3_CONTROL_URL: `http://127.0.0.1:${address.port}`,
        T3_CONTROL_TOKEN: "test-secret-not-for-output",
      },
    },
  );
  NodeAssert.equal(result.error, undefined);
  NodeAssert.equal(result.status, 1);
  NodeAssert.equal(result.stdout, "");
  NodeAssert.equal(result.stderr, "fetch failed\n");
});

test("live checks the running build's ancestry and exits for each outcome", async ({
  onTestFinished,
}) => {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3ctl-live-"));
  onTestFinished(() => NodeFS.rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
    }).trim();
  git("init", "-q");
  git("commit", "--allow-empty", "-qm", "older");
  const older = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "-qm", "newer");
  const newer = git("rev-parse", "HEAD");
  const health = (buildCommit: string | null) => async () => ({
    ok: true,
    status: "healthy",
    buildCommit,
  });

  const { stages, elapsedMs, ...answer } = await checkLive(older, {
    repo,
    health: health(newer.slice(0, 12)),
  });
  NodeAssert.ok(stages.health.ms >= 0);
  NodeAssert.ok(elapsedMs >= 0);
  NodeAssert.deepEqual(answer, {
    commit: older,
    buildCommit: newer.slice(0, 12),
    live: true,
    reason: "ancestor of build",
  });
  NodeAssert.equal((await checkLive(newer, { repo, health: health(older) })).live, false);
  for (const status of ["degraded", "recovered-unverified"]) {
    NodeAssert.equal(
      (
        await checkLive(older, {
          repo,
          health: async () => ({ ...(await health(newer)()), status }),
        })
      ).live,
      true,
    );
  }

  NodeAssert.equal((await checkLive("HEAD", { repo, health: health(newer) })).live, true);
  NodeAssert.equal((await checkLive("garbage", { repo, health: health(newer) })).live, null);
  NodeAssert.equal((await checkLive(older, { repo, health: health(null) })).live, null);
  NodeAssert.equal((await checkLive(older, { repo, health: health("unknown") })).live, null);
  NodeAssert.equal((await checkLive(older, { repo, health: health("abcdef0\n") })).live, null);
  NodeAssert.equal((await checkLive(older, { repo, health: health("000000000000") })).live, null);
  git("branch", "000000000000", newer);
  NodeAssert.equal((await checkLive(older, { repo, health: health("000000000000") })).live, null);
  NodeAssert.equal((await checkLive("000000000000", { repo, health: health(newer) })).live, null);
  NodeAssert.equal(
    (await checkLive(older, { repo, health: async () => ({ buildCommit: newer }) })).live,
    null,
  );
  const previousGitDir = process.env.GIT_DIR;
  process.env.GIT_DIR = NodePath.join(repo, "does-not-exist");
  try {
    NodeAssert.equal((await checkLive(older, { repo, health: health(newer) })).live, true);
  } finally {
    if (previousGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousGitDir;
  }
  const shallow = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3ctl-shallow-"));
  onTestFinished(() => NodeFS.rmSync(shallow, { recursive: true, force: true }));
  NodeChildProcess.execFileSync("git", [
    "clone",
    "-q",
    "--depth=1",
    NodeURL.pathToFileURL(repo).href,
    shallow,
  ]);
  NodeChildProcess.execFileSync("git", ["fetch", "-q", "--depth=1", "origin", older], {
    cwd: shallow,
  });
  NodeAssert.equal((await checkLive(older, { repo: shallow, health: health(newer) })).live, null);
  NodeAssert.equal(
    (await checkLive(older, { repo: `${repo}/missing`, health: health(newer) })).live,
    null,
  );
  NodeAssert.equal(
    (
      await checkLive(older, {
        repo,
        health: async () => {
          throw new Error("secret");
        },
      })
    ).reason,
    "health unavailable",
  );

  const { createServer } = await import("node:http");
  let runningBuild: string | null = newer;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, status: "healthy", buildCommit: runningBuild }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const cli = NodeURL.fileURLToPath(new URL("./t3ctl.mjs", import.meta.url));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no test server address");
  const invoke = (commit: string, entry = cli) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = NodeChildProcess.spawn(
        process.execPath,
        [entry, "live", commit, "--repo", repo],
        {
          env: {
            ...process.env,
            T3_CONTROL_URL: `http://127.0.0.1:${address.port}`,
            T3_CONTROL_TOKEN: "test-secret-not-for-output",
          },
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  for (const [commit, build, code, live] of [
    [older, newer, 0, true],
    [newer, older, 3, false],
    ["garbage", newer, 2, null],
    [older, null, 2, null],
  ] as const) {
    runningBuild = build;
    const result = await invoke(commit);
    NodeAssert.equal(result.code, code);
    NodeAssert.equal(JSON.parse(result.stdout).live, live);
    NodeAssert.doesNotMatch(result.stdout + result.stderr, /test-secret-not-for-output/);
  }
  const link = NodePath.join(repo, "t3ctl");
  NodeFS.symlinkSync(cli, link);
  runningBuild = newer;
  NodeAssert.equal((await invoke(older, link)).code, 0);
  NodeAssert.equal((await invoke("--bad-ref")).code, 2);
  const imported = NodeChildProcess.spawnSync(
    process.execPath,
    ["-e", `import(${JSON.stringify(NodeURL.pathToFileURL(cli).href)})`, "nonexistent-entry"],
    { encoding: "utf8" },
  );
  NodeAssert.equal(imported.status, 0);
});

test("threads forwards the opaque cursor and prints the next cursor", async ({
  onTestFinished,
}) => {
  const { createServer } = await import("node:http");
  let requested: string | undefined;
  const server = createServer((request, response) => {
    requested = request.url;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, threads: [], total: 510, nextCursor: "next-page" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no test server address");
  const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        NodeURL.fileURLToPath(new URL("./t3ctl.mjs", import.meta.url)),
        "threads",
        "--limit",
        "500",
        "--cursor",
        "opaque-cursor",
      ],
      {
        env: {
          ...process.env,
          T3_CONTROL_URL: `http://127.0.0.1:${address.port}`,
          T3_CONTROL_TOKEN: "test",
        },
      },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
  });
  NodeAssert.equal(result.code, 0);
  NodeAssert.equal(requested, "/api/ardud/control/threads?cursor=opaque-cursor&limit=500");
  NodeAssert.equal(JSON.parse(result.stdout).nextCursor, "next-page");
});

test("live shares one budget across health and every git invocation", async () => {
  const timeouts: number[] = [];
  const killSignals: string[] = [];
  const signals: AbortSignal[] = [];
  const result = await checkLive("abcdef012345", {
    timeoutMs: 100,
    health: async (options: { timeoutMs: number; signal: AbortSignal }) => {
      NodeAssert.ok(options.timeoutMs <= 100);
      signals.push(options.signal);
      await NodeTimersPromises.setTimeout(20);
      return { ok: true, status: "healthy", buildCommit: "abcdef012345" };
    },
    git: async (
      args: string[],
      options: { timeout: number; killSignal: string; signal: AbortSignal },
    ) => {
      killSignals.push(options.killSignal);
      timeouts.push(options.timeout);
      signals.push(options.signal);
      if (timeouts.length === 3) return new Promise(() => {});
      await NodeTimersPromises.setTimeout(10);
      return { status: 0, stdout: args[0] === "cat-file" ? "commit" : "abcdef012345" };
    },
  });
  NodeAssert.equal(result.live, null);
  NodeAssert.match(result.reason, /build.*timed out/);
  NodeAssert.ok(timeouts[0]! <= 85);
  for (let i = 1; i < timeouts.length; i++) NodeAssert.ok(timeouts[i]! < timeouts[i - 1]!);
  NodeAssert.ok(killSignals.every((signal) => signal === "SIGKILL"));
  NodeAssert.ok(signals.every((signal) => signal.aborted));
  NodeAssert.ok(result.elapsedMs < 500);
});

test("live caps health at ten seconds of its default budget", async () => {
  let healthTimeout = 0;
  const result = await checkLive("HEAD", {
    health: async (options: { timeoutMs: number }) => {
      healthTimeout = options.timeoutMs;
      throw new Error("secret in server error");
    },
  });
  NodeAssert.equal(healthTimeout, 10_000);
  NodeAssert.equal(result.reason, "health unavailable");
  NodeAssert.equal(result.stages.health.status, "error");
  NodeAssert.doesNotMatch(JSON.stringify(result), /secret/);
});

test("live CLI bounds a blackhole health request and validates --timeout", async ({
  onTestFinished,
}) => {
  const sockets = new Set<NodeNet.Socket>();
  const server = NodeNet.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no test server address");
  const cli = NodeURL.fileURLToPath(new URL("./t3ctl.mjs", import.meta.url));
  const invoke = (timeout: string) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      NodeChildProcess.execFile(
        process.execPath,
        [cli, "live", "HEAD", `--timeout=${timeout}`],
        {
          timeout: 3000,
          killSignal: "SIGKILL",
          env: {
            ...process.env,
            T3_CONTROL_URL: `http://127.0.0.1:${address.port}`,
            T3_CONTROL_TOKEN: "test-secret-not-for-output",
          },
        },
        (error, stdout, stderr) =>
          resolve({ code: error ? Number(error.code) : 0, stdout, stderr }),
      ).on("error", reject);
    });
  const start = performance.now();
  const result = await invoke("0.5");
  NodeAssert.equal(result.code, 2);
  NodeAssert.match(JSON.parse(result.stdout).reason, /health.*timed out/);
  NodeAssert.equal(JSON.parse(result.stdout).stages.health.status, "timeout");
  NodeAssert.ok(performance.now() - start < 2000);
  NodeAssert.doesNotMatch(result.stdout + result.stderr, /test-secret-not-for-output/);
  for (const timeout of ["0", "-1", "NaN", "Infinity", "", "2147484"]) {
    const invalid = await invoke(timeout);
    NodeAssert.equal(invalid.code, 2);
    NodeAssert.match(invalid.stderr, /--timeout must be a positive number/);
  }
});

test("live kills a real git process that ignores SIGTERM", async ({ onTestFinished }) => {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone Node CLI test uses a POSIX executable fixture.
  if (NodeOS.platform() === "win32") return;
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3ctl-slow-git-"));
  const marker = NodePath.join(dir, "pid");
  NodeFS.writeFileSync(
    NodePath.join(dir, "git"),
    `#!/bin/sh\ntrap '' TERM\necho $$ > '${marker}'\nexec /bin/sleep 60\n`,
    { mode: 0o755 },
  );
  onTestFinished(() => {
    if (NodeFS.existsSync(marker)) {
      const pid = Number(NodeFS.readFileSync(marker, "utf8").trim());
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}:${previousPath}`;
  try {
    const start = performance.now();
    const result = await checkLive("HEAD", {
      repo: dir,
      timeoutMs: 200,
      health: async () => ({ ok: true, status: "healthy", buildCommit: "abcdef012345" }),
    });
    NodeAssert.equal(result.live, null);
    NodeAssert.match(result.reason, /target.*timed out/);
    NodeAssert.equal(result.stages.target.status, "timeout");
    NodeAssert.ok(performance.now() - start < 1500);
    const pid = Number(NodeFS.readFileSync(marker, "utf8").trim());
    const state = await new Promise<string>((resolve, reject) => {
      NodeChildProcess.execFile(
        "ps",
        ["-p", String(pid), "-o", "stat="],
        { timeout: 1000 },
        (error, stdout) => {
          if (error && error.code !== 1) reject(error);
          else resolve(stdout.trim());
        },
      );
    });
    // A zombie is already dead and only awaits the parent's close notification.
    NodeAssert.match(state, /^(Z.*)?$/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});
