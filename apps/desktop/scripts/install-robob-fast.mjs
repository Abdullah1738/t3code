import {
  captureOwnedTree,
  cleanupOwnedTree,
  survivingOwned,
} from "../../../packages/shared/src/ownedProcessTree.ts";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
export const INSTALL_PLAN = [
  "pre-stage",
  "signature",
  "migration-check",
  "host-preflight (hung ~/checkouts mount, U-state processes)",
  "cancel-window (10s)",
  "quit (15s maximum)",
  "clone-backup",
  "swap",
  "launch",
  "read-ready",
  "continuation-report",
];

// Robob builds are Developer ID signed but not notarized, so `spctl --assess`
// rejects them. Pin the signer instead: bundle id, team and the full chain.
export const EXPECTED_SIGNATURE = {
  identifier: "com.ardud.robob",
  team: "HVG39427R3",
  authority: "Developer ID Application: Abdullah Rangoonwala (HVG39427R3)",
};

export function checkSignature(details, expected = EXPECTED_SIGNATURE) {
  const fields = new Map();
  const authorities = [];
  for (const line of details.split("\n")) {
    const at = line.indexOf("=");
    if (at < 0) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (key === "Authority") authorities.push(value);
    else if (!fields.has(key)) fields.set(key, value);
  }
  const problems = [];
  if (fields.get("Identifier") !== expected.identifier)
    problems.push(`identifier ${fields.get("Identifier") ?? "missing"}`);
  if (fields.get("TeamIdentifier") !== expected.team)
    problems.push(`team ${fields.get("TeamIdentifier") ?? "missing"}`);
  if (authorities[0] !== expected.authority) problems.push(`signer ${authorities[0] ?? "missing"}`);
  if (authorities.at(-1) !== "Apple Root CA") problems.push("chain does not end at Apple Root CA");
  if (problems.length) throw new Error(`Unexpected code signature: ${problems.join(", ")}`);
}

export async function install(ops, { rollback = false } = {}) {
  if (!rollback) {
    await ops.stage();
    await ops.verify();
    await ops.migrations();
  } else {
    await ops.verifyPrevious();
    await ops.migrations();
  }
  // A hung NFS mount (ovnfs ~/checkouts) blocks the old server's exit in
  // uv_thread_join, so the quit would time out into an outage (10 Nov 2026).
  await ops.hostPreflight();
  await ops.cancelWindow();
  await ops.phase("quit");
  await ops.quit();
  await ops.phase("closed");
  await ops.backup();
  await ops.phase("backup_done");
  await ops.swap(rollback);
  await ops.phase("swap_done");
  await ops.launch();
  await ops.phase("launched");
  await ops.readReady();
  await ops.phase("ready");
  await ops.report();
}

/** `ls -f DIR` in a child with a hard timeout: an NFS lookup that hangs puts
 * the child in U state, where even SIGKILL waits, so it is abandoned. */
/**
 * One JSON GET for the readiness polls, on node:http rather than global fetch. Under Node
 * 26.2 fetch (undici) threw `setTypeOfService EINVAL` from a socket callback while the new
 * server was not listening yet: outside any promise, so no try/catch saw it and the
 * installer died after `launched` (10 Nov 2026). Every failure here rejects instead.
 */
export function getJson(url, { headers = {}, timeoutMs = 1000 } = {}) {
  return new Promise((resolve, reject) => {
    let request;
    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      request?.destroy();
      settle(value);
    };
    const fail = (error) => finish(reject, error);
    // One deadline for the whole exchange, redirects included, as AbortSignal.timeout gave
    // fetch: a socket inactivity timeout never fires on a reply that trickles in.
    const deadline = setTimeout(() => fail(new Error("Request timed out")), timeoutMs);
    const origin = new URL(url).origin;
    const send = (target, redirectsLeft) => {
      // Node throws synchronously for a URL it cannot turn into a request (a redirect to
      // `http://bad%ZZ@host/`). In a response callback nothing else would catch that, and
      // the installer would exit.
      try {
        request = (target.protocol === "https:" ? NodeHttps : NodeHttp).get(
          target,
          // Credentials stay with the origin they were given for.
          { headers: target.origin === origin ? headers : {}, agent: false },
          (response) => {
            const status = response.statusCode ?? 0;
            const location = response.headers.location;
            if ([301, 302, 303, 307, 308].includes(status) && location !== undefined) {
              response.resume();
              if (redirectsLeft <= 0) return fail(new Error("Too many redirects"));
              let next;
              try {
                next = new URL(location, target);
              } catch (error) {
                return fail(error);
              }
              if (next.protocol !== "http:" && next.protocol !== "https:")
                return fail(new Error(`Unsupported redirect to ${next.protocol}`));
              request.destroy();
              return send(next, redirectsLeft - 1);
            }
            const chunks = [];
            let bytes = 0;
            response.on("data", (chunk) => {
              bytes += chunk.length;
              if (bytes > JSON_REPLY_LIMIT_BYTES) return fail(new Error("Reply too large"));
              chunks.push(chunk);
            });
            response.on("error", fail);
            response.on("end", () => {
              if (status < 200 || status > 299) return fail(new Error(`HTTP ${status}`));
              try {
                finish(resolve, JSON.parse(Buffer.concat(chunks).toString("utf8")));
              } catch (error) {
                fail(error);
              }
            });
          },
        );
        request.on("error", fail);
      } catch (error) {
        fail(error);
      }
    };
    send(new URL(url), JSON_REDIRECT_LIMIT);
  });
}
// The readiness replies are a few hundred bytes; fetch followed up to 20 redirects.
const JSON_REPLY_LIMIT_BYTES = 1024 * 1024;
const JSON_REDIRECT_LIMIT = 5;

export function probeDirectory(dir, timeoutMs = 10_000, command = ["/bin/ls", ["-f", dir]]) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(command[0], command[1], { stdio: ["ignore", "pipe", "pipe"] });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      finish({ state: "hang", dir, timeoutMs });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 1 << 20) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4096) stderr += chunk;
    });
    child.once("error", (error) => finish({ state: "error", dir, message: String(error) }));
    child.once("close", (code) =>
      finish(
        code === 0
          ? { state: "ok", dir, stdout }
          : {
              state: /No such file or directory/.test(stderr) ? "absent" : "error",
              dir,
              message: stderr.trim().slice(0, 500) || `ls exited ${code}`,
            },
      ),
    );
  });
}

/** Root listing, then one checkout inside it: on 10 Nov the root answered
 * while readdir/lookups inside hung. */
export async function probeCheckouts(checkoutsDir, probe = probeDirectory) {
  const root = await probe(checkoutsDir);
  if (root.state !== "ok") return root;
  const name = root.stdout
    .split("\n")
    .find((entry) => entry && entry !== "." && entry !== ".." && !entry.startsWith("."));
  if (name === undefined) return { state: "ok", dir: checkoutsDir, empty: true };
  const inner = await probe(path.join(checkoutsDir, name));
  return inner.state === "ok" ? { state: "ok", dir: inner.dir } : inner;
}

export async function uStateProcesses(
  runPs = () =>
    exec("/bin/ps", ["-axo", "pid=,stat=,comm="], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }),
) {
  const { stdout } = await runPs();
  return stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/))
    .filter((m) => m !== null && m[2].startsWith("U"))
    .map((m) => ({ pid: Number(m[1]), stat: m[2], command: m[3].slice(0, 200) }));
}

/**
 * Refuse to quit into a hang. A hung ~/checkouts gets one keep-mount
 * `ovnfs restart` and is probed again; if it still hangs the install stops
 * here, before anything is shut down.
 */
export async function hostPreflight({
  checkoutsDir,
  probe = probeDirectory,
  restart,
  uState = () => uStateProcesses(),
  log,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  recheckAttempts = 3,
  recheckDelayMs = 20_000,
}) {
  const listU = async (when) => {
    try {
      const processes = await uState();
      await log("host_preflight_u_state", {
        when,
        count: processes.length,
        processes: processes.slice(0, 50),
      });
      return processes;
    } catch (error) {
      await log("host_preflight_u_state", { when, error: String(error) });
      return [];
    }
  };
  await listU("before");
  const first = await probeCheckouts(checkoutsDir, probe);
  await log("host_preflight_mount", { when: "before", ...summarizeProbe(first) });
  if (first.state !== "hang") return { restarted: false, result: first };
  if (restart === undefined)
    throw new Error(`${first.dir} is hung and no ovnfs restart is available; not quitting Robob`);
  await log("host_preflight_ovnfs_restart", {
    reason: `${first.dir} did not answer in ${first.timeoutMs} ms`,
  });
  try {
    await restart();
  } catch (error) {
    await log("host_preflight_ovnfs_restart_failed", { error: String(error) });
  }
  let again = first;
  for (let attempt = 1; attempt <= recheckAttempts; attempt++) {
    again = await probeCheckouts(checkoutsDir, probe);
    await log("host_preflight_mount", {
      when: `after-restart-${attempt}`,
      ...summarizeProbe(again),
    });
    if (again.state !== "hang") break;
    if (attempt < recheckAttempts) await sleep(recheckDelayMs);
  }
  await listU("after-restart");
  if (again.state === "hang")
    throw new Error(
      `${again.dir} still hangs after ovnfs restart; not quitting Robob (a hung mount blocks the old server's exit). Fix the mount, then retry.`,
    );
  return { restarted: true, result: again };
}

const summarizeProbe = (result) => {
  const { stdout: _stdout, ...rest } = result;
  return rest;
};

/** Relaunch the old app after a failed quit only once every old process is
 * gone: a survivor still holds the server owner lock, and a relaunch beside it
 * leaves Robob with no server (10 Nov 2026, pid 5646). */
export async function relaunchAfterFailure({
  survivors,
  launch,
  log,
  notify = async () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  boundMs = 10 * 60_000,
  reportEveryMs = 30_000,
}) {
  const started = now();
  let reported = -Infinity;
  for (;;) {
    let alive;
    try {
      alive = await survivors();
    } catch (error) {
      alive = undefined;
      await log("relaunch_survivor_check_failed", { error: String(error) });
    }
    if (alive !== undefined && alive.length === 0) break;
    if (now() - started >= boundMs) {
      const pids = alive?.map((p) => p.pid ?? p) ?? "unknown";
      await log("relaunch_skipped", {
        reason: "old Robob processes did not exit",
        survivors: pids,
      });
      await notify(
        `Robob install failed and the old app was NOT relaunched: processes ${JSON.stringify(pids)} are still running after ${Math.round(boundMs / 1000)} s. Check for hung mounts (ovnfs restart), then open Robob.`,
      );
      return false;
    }
    if (now() - reported >= reportEveryMs) {
      reported = now();
      await log("relaunch_waiting", { survivors: alive?.map((p) => p.pid ?? p) ?? "unknown" });
    }
    await sleep(500);
  }
  await log("relaunch_old_app");
  await launch();
  return true;
}

const psRows = (stdout) =>
  stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m) => m !== null)
    .map((m) => ({ pid: Number(m[1]), rest: m[2] }));

/** Other real installer runs (`ps -axo pid=,command=`), never this one or a dry run. */
export const otherInstallerPids = (stdout, self = process.pid) =>
  psRows(stdout)
    .filter(
      ({ pid, rest }) =>
        pid !== self &&
        /(?:^|\/)node\s.*install-robob-fast\.mjs(?:\s|$)/.test(rest) &&
        !/\s--dry-run(?:\s|$)/.test(rest),
    )
    .map(({ pid }) => pid);

/** Processes whose executable lives inside BUNDLE (`ps -axo pid=,comm=`). */
export const pidsRunningFrom = (stdout, bundle) =>
  psRows(stdout)
    .filter(({ rest }) => rest.startsWith(`${bundle}/`))
    .map(({ pid }) => ({ pid }));

/**
 * A failed run can leave /Applications/.Robob.next.app behind. Replace it only
 * when it is provably a stale Robob staging copy: a Robob bundle (or a partial
 * copy holding only Contents/), no other installer running, and no process
 * running from it.
 */
export async function clearStaleStaging({
  next,
  stamp,
  log,
  exists,
  readBundleId,
  topLevel,
  otherInstallers,
  runningFrom,
  remove,
  rename,
  stat,
}) {
  if (!(await exists(next))) return "absent";
  const bundleId = await readBundleId(next).catch(() => undefined);
  const entries = await topLevel(next);
  const partial = bundleId === undefined && entries.every((name) => name === "Contents");
  if (bundleId !== EXPECTED_SIGNATURE.identifier && !partial)
    throw new Error(
      `Staging path ${next} holds ${bundleId ?? `unknown content (${entries.slice(0, 5).join(", ")})`}, not a Robob staging bundle; inspect it before retrying`,
    );
  const installers = await otherInstallers();
  if (installers.length)
    throw new Error(
      `Another installer is running (pid ${installers.join(", ")}); staging bundle ${next} may be in use`,
    );
  const users = await runningFrom(next);
  if (users.length)
    throw new Error(
      `Processes run from ${next} (pid ${users.map((p) => p.pid ?? p).join(", ")}); not replacing it`,
    );
  const info = await stat(next).catch(() => undefined);
  const aside = `${next}.stale-${stamp}`;
  await log("stale_staging_found", {
    path: next,
    bundleId: bundleId ?? null,
    partial,
    modifiedAt: info ? new Date(info.mtimeMs).toISOString() : null,
  });
  await rename(next, aside);
  await remove(aside);
  await log("stale_staging_removed", { path: next, movedTo: aside });
  return "removed";
}

async function main(args) {
  const rollback = args.includes("--rollback");
  const dmgIndex = args.indexOf("--dmg");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dmg" && args[i + 1]) {
      i++;
      continue;
    }
    if (!["--rollback", "--dry-run"].includes(args[i]))
      throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (args.includes("--dry-run")) {
    console.log(JSON.stringify({ rollback, steps: INSTALL_PLAN }));
    return;
  }
  if (!process.env.TMUX) throw new Error("Use the zsh wrapper: installs must run in tmux");
  const app = "/Applications/Robob.app";
  const next = "/Applications/.Robob.next.app";
  const prev = "/Applications/.Robob.prev.app";
  const data = await fs.realpath(path.join(os.homedir(), ".robob/userdata"));
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const backupRoot = path.join(path.dirname(data), "fast-install-backups");
  const phase = async (phase, extra = {}) =>
    console.log(JSON.stringify({ phase, at: new Date().toISOString(), ...extra }));
  let quitAt;
  const run = (cmd, args, timeout = 20_000, env = process.env) => {
    const remaining =
      quitAt === undefined ? timeout : Math.min(timeout, 180_000 - (Date.now() - quitAt));
    if (remaining <= 0) throw new Error("Install exceeded the 3 minute limit");
    return exec(cmd, args, { timeout: remaining, maxBuffer: 2 ** 20, env });
  };
  const exists = async (p) =>
    fs.access(p).then(
      () => true,
      () => false,
    );
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const inputs = async () =>
    (await fs.readdir(data)).filter((name) => /^(statev2|boards).*\.sqlite(?:-wal)?$/.test(name));
  const clone = async (destination) => {
    await fs.mkdir(destination, { recursive: true, mode: 0o700 });
    const names = await inputs();
    if (!names.includes("statev2.sqlite")) throw new Error("Missing state database");
    for (const name of names)
      await run("/bin/cp", ["-c", path.join(data, name), path.join(destination, name)], 3000);
  };
  const cfg = JSON.parse(
    await fs.readFile(
      process.env.T3_CONTROL_TOKEN_FILE || path.join(os.homedir(), ".robob/components/t3ctl.json"),
      "utf8",
    ),
  );
  const origin = (cfg.url || "http://127.0.0.1:3773").replace(/\/$/, "");
  const get = (route) =>
    getJson(`${origin}${route}`, { headers: { authorization: `Bearer ${cfg.token}` } });
  let oldBootId;
  try {
    oldBootId = (await get("/api/ardud/control/install-report")).bootId;
  } catch {}
  let mount;
  let quitTree;
  let ownsStaging = false;
  let swapped = false;
  const poll = async (fn) => {
    for (;;) {
      if (Date.now() - quitAt >= 180_000) throw new Error("Install exceeded the 3 minute limit");
      try {
        if (await fn()) return;
      } catch {}
      await sleep(200);
    }
  };
  const launch = () =>
    run(
      "/bin/zsh",
      [path.join(path.dirname(fileURLToPath(import.meta.url)), "open-robob-clean.zsh"), app],
      35_000,
    );
  const verifyBundle = async (bundle) => {
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], 60_000);
    // codesign -dv prints its details on stderr.
    const { stderr } = await run("/usr/bin/codesign", ["-dv", "--verbose=2", bundle]);
    checkSignature(stderr);
  };
  const ops = {
    phase,
    stage: async () => {
      const dmg = args[dmgIndex + 1];
      if (dmgIndex < 0 || !path.isAbsolute(dmg)) throw new Error("--dmg requires an absolute path");
      // A failed run can leave its staging copy; replace it only when provably stale.
      await clearStaleStaging({
        next,
        stamp,
        log: phase,
        exists,
        readBundleId: async (bundle) =>
          (
            await run("/usr/bin/plutil", [
              "-extract",
              "CFBundleIdentifier",
              "raw",
              path.join(bundle, "Contents/Info.plist"),
            ])
          ).stdout.trim(),
        topLevel: (bundle) => fs.readdir(bundle),
        otherInstallers: async () =>
          otherInstallerPids((await run("/bin/ps", ["-axo", "pid=,command="], 5000)).stdout),
        runningFrom: async (bundle) =>
          pidsRunningFrom((await run("/bin/ps", ["-axo", "pid=,comm="], 5000)).stdout, bundle),
        rename: fs.rename,
        remove: (target) => fs.rm(target, { recursive: true, force: true }),
        stat: fs.stat,
      });
      mount = await fs.mkdtemp(path.join(os.tmpdir(), "robob-fast-dmg-"));
      await run(
        "/usr/bin/hdiutil",
        ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, dmg],
        60_000,
      );
      if (await exists(next))
        throw new Error(`Staging bundle already exists: ${next}; inspect it before retrying`);
      ownsStaging = true;
      await run("/usr/bin/ditto", [path.join(mount, "Robob.app"), next], 120_000);
    },
    verify: () => verifyBundle(next),
    migrations: async () => {
      const sandbox = await fs.mkdtemp(path.join(path.dirname(data), ".install-clone-"));
      try {
        const fingerprint = async () =>
          JSON.stringify(
            await Promise.all(
              (await inputs()).sort().map(async (n) => {
                const s = await fs.stat(path.join(data, n));
                return [n, s.size, s.mtimeMs, s.ino];
              }),
            ),
          );
        const before = await fingerprint();
        await clone(sandbox);
        if (before !== (await fingerprint()))
          throw new Error("Database changed during preflight clone; retry before quitting");
        await fs.writeFile(path.join(sandbox, ".install-clone"), "", { mode: 0o600 });
        const candidate = rollback ? prev : next;
        const entry = path.join(candidate, "Contents/Resources/app.asar/apps/server/dist/bin.mjs");
        const result = await run(
          path.join(candidate, "Contents/MacOS/Robob"),
          [entry, "__install-migration-check", sandbox],
          120_000,
          { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        );
        if (!result.stdout.includes('"migrationCheck":"passed"'))
          throw new Error("Candidate did not confirm migration compatibility");
        console.log(result.stdout);
      } finally {
        await fs.rm(sandbox, { recursive: true, force: true });
      }
    },
    verifyPrevious: () => verifyBundle(prev),
    hostPreflight: async () => {
      const ovnfs = path.join(os.homedir(), ".local/bin/ovnfs");
      await hostPreflight({
        checkoutsDir: path.join(os.homedir(), "checkouts"),
        log: phase,
        // Keep-mount restart (ovnfs >= 0.3.0). Never `ovnfs stop`: it unmounts
        // and can wedge the kernel mount point while processes still use it.
        restart: (await exists(ovnfs)) ? () => run(ovnfs, ["restart"], 6 * 60_000) : undefined,
      });
    },
    cancelWindow: () => sleep(10_000),
    quit: async () => {
      quitAt = Date.now();
      const quitAbort = AbortSignal.timeout(15_000);
      const { stdout } = await run(
        "/usr/bin/lsappinfo",
        ["info", "-only", "pid", "-app", "com.ardud.robob"],
        2000,
      );
      const pid = Number(stdout.match(/pid[^0-9]*(\d+)/i)?.[1]);
      if (!Number.isSafeInteger(pid) || pid < 2) throw new Error("Cannot identify Robob PID");
      const tree = await captureOwnedTree(
        pid,
        new Set(),
        quitAbort,
        path.join(app, "Contents/MacOS/Robob"),
      );
      quitTree = tree;
      try {
        await run("/usr/bin/osascript", ["-e", 'tell application "Robob" to quit'], 2000);
      } catch {}
      while ((await survivingOwned(tree, true, quitAbort)).length && Date.now() - quitAt < 12_000)
        await sleep(100);
      await cleanupOwnedTree(tree, 250, true, Math.max(1, 15_000 - (Date.now() - quitAt)));
      for (let i = 0; i < 10 && (await survivingOwned(tree, true, quitAbort)).length; i++)
        await sleep(100);
      if ((await survivingOwned(tree, true, quitAbort)).length)
        throw new Error("Robob processes survived the shutdown bound");
    },
    backup: async () => {
      await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
      await clone(path.join(backupRoot, stamp));
      const old = (await fs.readdir(backupRoot))
        .filter((n) => /^\d{4}-/.test(n))
        .sort()
        .reverse()
        .slice(2);
      for (const name of old) await fs.rm(path.join(backupRoot, name), { recursive: true });
    },
    swap: async (rollback) => {
      if (rollback) {
        await fs.rename(app, next);
        try {
          await fs.rename(prev, app);
        } catch (e) {
          await fs.rename(next, app);
          throw e;
        }
        await fs.rename(next, prev);
      } else {
        await fs.rm(prev, { recursive: true, force: true });
        await fs.rename(app, prev);
        try {
          await fs.rename(next, app);
        } catch (e) {
          await fs.rename(prev, app);
          throw e;
        }
      }
      swapped = true;
    },
    launch,
    readReady: async () => {
      await poll(async () => {
        const report = await get("/api/ardud/control/install-report");
        return report.bootId && report.bootId !== oldBootId;
      });
      await phase("listening");
    },
    report: async () => {
      let report;
      await poll(async () => {
        report = await get("/api/ardud/control/install-report");
        return (
          report.bootId !== oldBootId &&
          report.completedAt &&
          report.pending === 0 &&
          report.commandReadyAt &&
          (report.continued === 0 || report.firstResumedProviderRequestAt)
        );
      });
      await phase("listening", { at: report.listeningAt });
      await phase("command_ready", { at: report.commandReadyAt });
      await phase("continuations_queued", { at: report.completedAt, report });
      if (report.firstResumedProviderRequestAt)
        await phase("first_resumed_provider_request", { at: report.firstResumedProviderRequestAt });
      const skipped = report.threads
        .filter((t) => !t.continued)
        .map((t) => `${t.threadId}:${t.reason}`)
        .join(", ");
      const text = `Robob installed: ${report.continued} continuations queued, ${report.skipped} skipped${skipped ? ` (${skipped})` : ""}. ${Math.round((Date.now() - quitAt) / 1000)}s to report.`;
      await run(
        "/Users/ardud/.bun/bin/bun",
        [
          "/Users/ardud/.local/share/telegram-bridge/src/cli.ts",
          "notify",
          "--source",
          "Robob install",
          "--severity",
          "attention",
          "--key",
          `robob-install:${stamp}:report`,
          "--text",
          text,
        ],
        5000,
      );
    },
  };
  try {
    await install(ops, { rollback });
  } catch (e) {
    await phase("failed", { error: String(e), swapped });
    // Before the swap no new binary has touched the data. Reopen the existing app,
    // but only once every old process is gone (its server holds the owner lock).
    // After the swap, a rollback must pass the previous binary's migration preflight.
    if (quitAt !== undefined && !swapped) {
      await relaunchAfterFailure({
        survivors: async () =>
          quitTree !== undefined
            ? survivingOwned(quitTree, true, AbortSignal.timeout(10_000))
            : // The quit failed before the tree was captured: any process from the bundle.
              pidsRunningFrom(
                (
                  await exec("/bin/ps", ["-axo", "pid=,comm="], {
                    timeout: 5000,
                    maxBuffer: 8 * 1024 * 1024,
                  })
                ).stdout,
                app,
              ),
        // Not bounded by the 3 minute install clock: waiting for the old tree can outlast it.
        launch: () =>
          exec(
            "/bin/zsh",
            [path.join(path.dirname(fileURLToPath(import.meta.url)), "open-robob-clean.zsh"), app],
            { timeout: 35_000, maxBuffer: 2 ** 20 },
          ),
        log: phase,
        notify: (text) =>
          exec(
            "/Users/ardud/.bun/bin/bun",
            [
              "/Users/ardud/.local/share/telegram-bridge/src/cli.ts",
              "notify",
              "--source",
              "Robob install",
              "--severity",
              "attention",
              "--key",
              `robob-install:${stamp}:no-relaunch`,
              "--text",
              text,
            ],
            { timeout: 5000 },
          ).catch(() => {}),
      }).catch((error) => phase("relaunch_failed", { error: String(error) }));
    }
    throw e;
  } finally {
    // Our own unswapped staging copy is useless after a failure; drop it so the
    // next run does not trip on it, but only while the live app is in place.
    if (ownsStaging && !swapped && (quitAt === undefined || (await exists(app)))) {
      await fs.rm(next, { recursive: true, force: true });
      if (quitAt !== undefined) await phase("staging_removed", { path: next });
    }
    if (mount) {
      await run("/usr/bin/hdiutil", ["detach", "-quiet", mount]).catch(() => {});
      await fs.rmdir(mount).catch(() => {});
    }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
