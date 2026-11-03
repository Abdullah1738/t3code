// @effect-diagnostics nodeBuiltinImport:off - the CLI under test is plain Node.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { test } from "@effect/vitest";

// @ts-expect-error plain ESM module without declarations
import { checkLive } from "./t3ctl.mjs";

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

  NodeAssert.deepEqual(await checkLive(older, { repo, health: health(newer.slice(0, 12)) }), {
    commit: older,
    buildCommit: newer.slice(0, 12),
    live: true,
    reason: "ancestor of build",
  });
  NodeAssert.equal((await checkLive(newer, { repo, health: health(older) })).live, false);
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
