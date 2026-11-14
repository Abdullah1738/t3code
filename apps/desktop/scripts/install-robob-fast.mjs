import {
  captureOwnedTree,
  cleanupOwnedTree,
  survivingOwned,
} from "../../../packages/shared/src/ownedProcessTree.ts";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeURL from "node:url";

import { acquireInstallHold, finishInstallHold } from "./robob-install-hold.mjs";

// Exit 75: the bundle is installed, but sustained reads did not pass. Do not reinstall.
export const READ_CHECK_FAILED = 75;
const exec = NodeUtil.promisify(NodeChildProcess.execFile);
export const INSTALL_DATABASE_FILE = /^(statev2|boards)\.sqlite(?:-wal)?$/;

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
  "read-check (5 healthy minutes, up to 30 minutes)",
  "continuation-report",
  "prune-old-backups (also after verified recovery)",
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
  if (ops.prune)
    await ops.prune().catch((error) => ops.phase("prune_failed", { error: String(error) }));
}

async function writeBackupMarker(file, value, io) {
  const handle = await io.open(file, "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function cloneBackup({ backupRoot, stamp, clone, fs: io = NodeFSP }) {
  await io.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const destination = NodePath.join(backupRoot, stamp);
  try {
    const files = await clone(destination);
    await writeBackupMarker(NodePath.join(destination, ".complete"), {
      stamp, completedAt: new Date().toISOString(), files,
    }, io);
  } catch (error) {
    // Rename rather than delete large clones inside the outage window.
    await io.rename(destination, NodePath.join(backupRoot, `partial-${stamp}`)).catch(() => {});
    throw error;
  }
}

async function backupInventory(backupRoot, io) {
  const stat = (file) => io.stat(file).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const entries = await io.readdir(backupRoot, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const backups = [];
  for (const entry of entries) {
    const partial = entry.name.startsWith("partial-");
    if (!entry.isDirectory() || (!partial && !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/.test(entry.name)))
      continue;
    const directory = NodePath.join(backupRoot, entry.name);
    backups.push({
      name: entry.name,
      partial,
      marked: !partial && Boolean((await stat(NodePath.join(directory, ".complete")))?.isFile()),
      pinned: Boolean(await stat(NodePath.join(directory, ".pinned"))),
    });
  }
  backups.sort((a, b) => a.name < b.name ? 1 : a.name > b.name ? -1 : 0);
  const oldestMarked = backups.findLast((backup) => backup.marked)?.name;
  for (const backup of backups) {
    backup.usable = backup.marked;
    if (!backup.partial && !backup.marked && (!oldestMarked || backup.name < oldestMarked)) {
      const database = await stat(NodePath.join(backupRoot, backup.name, "statev2.sqlite"));
      backup.usable = Boolean(database?.isFile() && database.size > 0);
    }
  }
  return backups;
}

export async function pruneBackups({ backupRoot, currentStamp, trigger, phase, fs: io = NodeFSP }) {
  await phase("prune_started", { trigger });
  const backups = await backupInventory(backupRoot, io);
  const usable = backups.filter((backup) => backup.usable);
  const pinned = backups.filter((backup) => backup.pinned).map((backup) => backup.name);
  const incomplete = backups.filter((backup) => !backup.usable).map((backup) => backup.name);
  const keep = new Set([
    ...usable.filter((backup) => !backup.pinned).slice(0, 2).map((backup) => backup.name),
    ...pinned,
    ...usable.filter((backup) => backup.name === currentStamp).map((backup) => backup.name),
  ]);
  const removed = [];
  for (const backup of backups) {
    // With no proven rollback, preserve timestamp directories for manual inspection.
    if (keep.has(backup.name) || (!usable.length && !backup.partial)) continue;
    await io.rm(NodePath.join(backupRoot, backup.name), { recursive: true });
    removed.push(backup.name);
  }
  const details = {
    trigger, removed, kept: backups.filter((backup) => !removed.includes(backup.name)).map((backup) => backup.name),
    pinned, incomplete,
  };
  if (!usable.length) await phase("prune_skipped", { ...details, reason: "no_usable_backup" });
  else await phase("backups_pruned", details);
}

export function createBackupRetention({ backupRoot, currentStamp, phase, fs: io = NodeFSP }) {
  let pruned = false;
  let pinnedByRun = false;
  const pin = async (error) => {
    try {
      const backups = await backupInventory(backupRoot, io);
      const current = backups.find((backup) => backup.name === currentStamp);
      if (!current?.usable || current.pinned) return;
      await writeBackupMarker(NodePath.join(backupRoot, currentStamp, ".pinned"), {
        stamp: currentStamp, reason: "install_failed", error: String(error), at: new Date().toISOString(),
      }, io);
      pinnedByRun = true;
      await phase("backup_pinned", { stamp: currentStamp });
    } catch (error) {
      await phase("backup_pin_failed", { stamp: currentStamp, error: String(error) });
    }
  };
  const prune = async (trigger = "ready") => {
    if (pruned) return;
    pruned = true;
    try {
      if (pinnedByRun) {
        await io.rm(NodePath.join(backupRoot, currentStamp, ".pinned"));
        pinnedByRun = false;
        await phase("backup_unpinned", { stamp: currentStamp });
      }
      await pruneBackups({ backupRoot, currentStamp, trigger, phase, fs: io });
    } catch (error) {
      await phase("prune_failed", { trigger, error: String(error) });
    }
  };
  return {
    pin,
    prune,
    finish: async ({ swapped, failure, ...hold }) => {
      try {
        await finishInstallHold(hold);
      } catch (error) {
        if (!pruned) {
          pruned = true;
          await phase("prune_skipped", { reason: "not_healthy", error: String(error) });
        }
        // Recovery bookkeeping must not replace the original install error.
        if (!failure) throw error;
        return;
      }
      if (pruned) return;
      if (!hold.quitStarted) {
        pruned = true;
        await phase("prune_skipped", { reason: "failed_before_quit" });
        return;
      }
      await prune(swapped ? "recovered" : "relaunched");
    },
  };
}

export function installCommandTimeout(timeout, quitAt, startupComplete, now = Date.now()) {
  const remaining =
    quitAt === undefined || startupComplete ? timeout : Math.min(timeout, 180_000 - (now - quitAt));
  if (remaining <= 0) throw new Error("Install exceeded the 3 minute limit");
  return remaining;
}

export function createDmgStage({
  run = exec,
  phase,
  mkdtemp = NodeFSP.mkdtemp,
  rmdir = NodeFSP.rmdir,
}) {
  let mount;
  const detach = async () => {
    if (!mount) return;
    // Cleanup must still run after the install's three-minute startup deadline.
    const options = { timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 2 ** 20 };
    try {
      await run("/usr/bin/hdiutil", ["detach", "-quiet", mount], options);
    } catch (first) {
      try {
        await run("/usr/bin/hdiutil", ["detach", "-quiet", "-force", mount], options);
      } catch (error) {
        await phase("dmg_detach_failed", {
          mount,
          error: `${String(first)}; force retry: ${String(error)}`,
        });
        return;
      }
    }
    const detached = mount;
    mount = undefined;
    await rmdir(detached).catch(() => {});
  };
  return {
    stage: async (dmg, copy) => {
      mount = await mkdtemp(NodePath.join(NodeOS.tmpdir(), "robob-fast-dmg-"));
      await run(
        "/usr/bin/hdiutil",
        ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, dmg],
        { timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 2 ** 20 },
      );
      await copy(mount);
      await detach();
    },
    detach,
  };
}

export async function checkSustainedReads({
  env = process.env,
  run = exec,
  output = (text) => process.stdout.write(text),
  now = () => new Date(),
} = {}) {
  const started = now();
  try {
    const result = await run(
      env.ROBOB_READ_CHECK || NodePath.join(NodeOS.homedir(), ".local/bin/robob-read-watchdog"),
      ["--sustain", "300", "--every", "30", "--give-up", "1800"],
      // Allow the final in-flight probe to finish after the watchdog's 30 minute bound.
      { timeout: 1_840_000, killSignal: "SIGKILL", maxBuffer: 2 ** 20, env },
    );
    if (result.stdout) output(result.stdout);
    if (result.stderr) output(result.stderr);
  } catch (cause) {
    const diagnostic = `${cause.stdout ?? ""}${cause.stderr ?? ""}`;
    if (diagnostic) output(diagnostic);
    const match = diagnostic.match(
      /^installed but reads still failing since ((?:[01]\d|2[0-3]):[0-5]\d) .+$/m,
    );
    const since = match?.[1] ?? started.toTimeString().slice(0, 5);
    const line = match?.[0] ?? `installed but reads still failing since ${since} (read check could not complete)`;
    if (!match) output(`${line}\n${cause.message}\n`);
    throw Object.assign(new Error(line, { cause }), { exitCode: READ_CHECK_FAILED, since });
  }
}

export async function reportInstall({
  report,
  phase,
  readCheck = checkSustainedReads,
  notify,
  stamp,
  log = process.env.ROBOB_INSTALL_LOG || "installer stdout",
  elapsedSeconds,
}) {
  await phase("listening", { at: report.listeningAt });
  await phase("command_ready", { at: report.commandReadyAt });
  await phase("continuations_queued", { at: report.completedAt, report });
  if (report.firstResumedProviderRequestAt)
    await phase("first_resumed_provider_request", { at: report.firstResumedProviderRequestAt });
  await phase("read-check");
  try {
    await readCheck();
  } catch (error) {
    if (error.exitCode !== READ_CHECK_FAILED) throw error;
    await phase("reads_failed", { since: error.since, error: error.message });
    await notify({
      severity: "error",
      key: `robob-install:${stamp}:reads`,
      text: `Robob installed, but reads are still failing since ${error.since}. Not saying it's back up. Log: ${log}`,
    }).catch((notifyError) => phase("reads_notify_failed", { error: String(notifyError) }));
    throw error;
  }
  await phase("reads_healthy");
  const skipped = report.threads
    .filter((t) => !t.continued)
    .map((t) => `${t.threadId}:${t.reason}`)
    .join(", ");
  await notify({
    severity: "attention",
    key: `robob-install:${stamp}:report`,
    text: `Robob installed: ${report.continued} continuations queued, ${report.skipped} skipped${skipped ? ` (${skipped})` : ""}. Reads healthy for 5 min. ${elapsedSeconds()}s to report.`,
  });
}

/** `ls -f DIR` in a child with a hard timeout: an NFS lookup that hangs puts
 * the child in U state, where even SIGKILL waits, so it is abandoned. */
/**
 * One JSON GET for the readiness polls, on node:http rather than global fetch. Under Node
 * 26.2 fetch (undici) threw `setTypeOfService EINVAL` from a socket callback while the new
 * server was not listening yet: outside any promise, so no try/catch saw it and the
 * installer died after `launched` (10 Nov 2026). Every failure here rejects instead.
 */
/** Pre-quit migration check limit. It runs before the quit, so a longer wait costs no outage.
 * Closing the check's sandbox checkpoints its WAL into an APFS clone of a ~160 GB database, and
 * copy-on-write of shared extents made that exceed 120 s on 11 Nov 2026 under disk load. */
export function migrationCheckTimeoutMs(env = process.env) {
  const value = Number(env.ROBOB_INSTALL_MIGRATION_CHECK_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 30_000 ? value : 600_000;
}

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
    const child = NodeChildProcess.spawn(command[0], command[1], { stdio: ["ignore", "pipe", "pipe"] });
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
  const inner = await probe(NodePath.join(checkoutsDir, name));
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
  const skipIndex = args.indexOf("--skip-migration-check");
  // The pre-quit check clones the live database, and that clone stalls the running server's
  // writes for as long as it takes (5.3 min on 11 Nov 2026). Skip it, with a stated reason,
  // when the release changes no migration or schema files.
  const skipMigrationCheck = skipIndex < 0 ? undefined : args[skipIndex + 1]?.trim();
  if (skipIndex >= 0 && (!skipMigrationCheck || skipMigrationCheck.startsWith("--")))
    throw new Error("--skip-migration-check requires a reason");
  // A rollback must always prove the previous binary still opens the migrated database.
  if (rollback && skipMigrationCheck !== undefined)
    throw new Error("--skip-migration-check cannot be used with --rollback");
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--dmg" || args[i] === "--skip-migration-check") && args[i + 1]) {
      i++;
      continue;
    }
    if (!["--rollback", "--dry-run"].includes(args[i]))
      throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (args.includes("--dry-run")) {
    console.log(
      JSON.stringify({
        rollback,
        skipMigrationCheck: skipMigrationCheck ?? null,
        steps: INSTALL_PLAN,
      }),
    );
    return;
  }
  if (!process.env.TMUX) throw new Error("Use the zsh wrapper: installs must run in tmux");
  const app = "/Applications/Robob.app";
  const next = "/Applications/.Robob.next.app";
  const prev = "/Applications/.Robob.prev.app";
  const data = await NodeFSP.realpath(NodePath.join(NodeOS.homedir(), ".robob/userdata"));
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const backupRoot = NodePath.join(NodePath.dirname(data), "fast-install-backups");
  const phase = async (phase, extra = {}) =>
    console.log(JSON.stringify({ phase, at: new Date().toISOString(), ...extra }));
  const retention = createBackupRetention({ backupRoot, currentStamp: stamp, phase });
  let backupDone = false;
  let installFailure;
  let cleanupFailure;
  let quitAt;
  let startupComplete = false;
  const run = (cmd, args, timeout = 20_000, env = process.env) => {
    const remaining = installCommandTimeout(timeout, quitAt, startupComplete);
    return exec(cmd, args, { timeout: remaining, maxBuffer: 2 ** 20, env });
  };
  const exists = async (p) =>
    NodeFSP.access(p).then(
      () => true,
      () => false,
    );
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const inputs = async () =>
    // Exact names only: the 226 GB statev2.pre-shrink-*.sqlite copy matched the old prefix pattern
    // and was cloned on every install (11 Nov 2026).
    (await NodeFSP.readdir(data)).filter((name) => INSTALL_DATABASE_FILE.test(name));
  const clone = async (destination, timeoutMs) => {
    await NodeFSP.mkdir(destination, { recursive: true, mode: 0o700 });
    const names = await inputs();
    if (!names.includes("statev2.sqlite")) throw new Error("Missing state database");
    for (const name of names)
      await run(
        "/bin/cp",
        ["-c", NodePath.join(data, name), NodePath.join(destination, name)],
        timeoutMs(),
      );
    return names;
  };
  const cfg = JSON.parse(
    await NodeFSP.readFile(
      process.env.T3_CONTROL_TOKEN_FILE || NodePath.join(NodeOS.homedir(), ".robob/components/t3ctl.json"),
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
  const dmgStage = createDmgStage({ phase });
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
      [NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "open-robob-clean.zsh"), app],
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
      if (dmgIndex < 0 || !NodePath.isAbsolute(dmg)) throw new Error("--dmg requires an absolute path");
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
              NodePath.join(bundle, "Contents/Info.plist"),
            ])
          ).stdout.trim(),
        topLevel: (bundle) => NodeFSP.readdir(bundle),
        otherInstallers: async () =>
          otherInstallerPids((await run("/bin/ps", ["-axo", "pid=,command="], 5000)).stdout),
        runningFrom: async (bundle) =>
          pidsRunningFrom((await run("/bin/ps", ["-axo", "pid=,comm="], 5000)).stdout, bundle),
        rename: NodeFSP.rename,
        remove: (target) => NodeFSP.rm(target, { recursive: true, force: true }),
        stat: NodeFSP.stat,
      });
      await dmgStage.stage(dmg, async (mount) => {
        if (await exists(next))
          throw new Error(`Staging bundle already exists: ${next}; inspect it before retrying`);
        ownsStaging = true;
        await run("/usr/bin/ditto", [NodePath.join(mount, "Robob.app"), next], 120_000);
      });
    },
    verify: () => verifyBundle(next),
    migrations: async () => {
      if (skipMigrationCheck !== undefined) {
        await phase("migration_check_skipped", { reason: skipMigrationCheck });
        return;
      }
      const sandbox = await NodeFSP.mkdtemp(NodePath.join(NodePath.dirname(data), ".install-clone-"));
      try {
        const fingerprint = async () =>
          JSON.stringify(
            await Promise.all(
              (await inputs()).sort().map(async (n) => {
                const s = await NodeFSP.stat(NodePath.join(data, n));
                return [n, s.size, s.mtimeMs, s.ino];
              }),
            ),
          );
        const before = await fingerprint();
        await clone(sandbox, () => 3000);
        if (before !== (await fingerprint()))
          throw new Error("Database changed during preflight clone; retry before quitting");
        await NodeFSP.writeFile(NodePath.join(sandbox, ".install-clone"), "", { mode: 0o600 });
        const candidate = rollback ? prev : next;
        const entry = NodePath.join(candidate, "Contents/Resources/app.asar/apps/server/dist/bin.mjs");
        const result = await run(
          NodePath.join(candidate, "Contents/MacOS/Robob"),
          [entry, "__install-migration-check", sandbox],
          migrationCheckTimeoutMs(),
          { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        );
        if (!result.stdout.includes('"migrationCheck":"passed"'))
          throw new Error("Candidate did not confirm migration compatibility");
        console.log(result.stdout);
      } finally {
        await NodeFSP.rm(sandbox, { recursive: true, force: true });
      }
    },
    verifyPrevious: () => verifyBundle(prev),
    hostPreflight: async () => {
      const ovnfs = NodePath.join(NodeOS.homedir(), ".local/bin/ovnfs");
      await hostPreflight({
        checkoutsDir: NodePath.join(NodeOS.homedir(), "checkouts"),
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
        NodePath.join(app, "Contents/MacOS/Robob"),
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
      // No writer is left after the quit, so the clone only waits on APFS, not on the server.
      // Leave at least 60 s of the 3 minute window for swap, launch and readiness: a backup that
      // ate the window would fail the launch after the swap, where nothing relaunches either app.
      const budget = () => {
        const ms = Math.min(120_000, 180_000 - (Date.now() - quitAt) - 60_000);
        if (ms <= 0) throw new Error("No time left for the backup before the swap");
        return ms;
      };
      await cloneBackup({ backupRoot, stamp, clone: (destination) => clone(destination, budget) });
      backupDone = true;
    },
    // Deleting old clones of a fragmented 160 GB file takes tens of seconds; it runs after
    // the new server is ready instead of inside the outage window.
    prune: () => retention.prune("ready"),
    swap: async (rollback) => {
      if (rollback) {
        await NodeFSP.rename(app, next);
        try {
          await NodeFSP.rename(prev, app);
        } catch (e) {
          await NodeFSP.rename(next, app);
          throw e;
        }
        await NodeFSP.rename(next, prev);
      } else {
        await NodeFSP.rm(prev, { recursive: true, force: true });
        await NodeFSP.rename(app, prev);
        try {
          await NodeFSP.rename(next, app);
        } catch (e) {
          await NodeFSP.rename(prev, app);
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
      // Continuations still start inside the startup bound. Healthy-read observation,
      // and its notification must be allowed to outlast that bound.
      startupComplete = true;
      await reportInstall({
        report,
        phase,
        stamp,
        elapsedSeconds: () => Math.round((Date.now() - quitAt) / 1000),
        notify: ({ severity, key, text }) =>
          run(
            "/Users/ardud/.bun/bin/bun",
            [
              "/Users/ardud/.local/share/telegram-bridge/src/cli.ts",
              "notify",
              "--source",
              "Robob install",
              "--severity",
              severity,
              "--key",
              key,
              "--text",
              text,
            ],
            5000,
          ),
      });
    },
  };
  const hold = await acquireInstallHold();
  try {
    await install(ops, { rollback });
  } catch (e) {
    installFailure = e;
    await phase("failed", { error: String(e), swapped });
    if (swapped || backupDone) await retention.pin(e);
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
            [NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "open-robob-clean.zsh"), app],
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
    try {
      await dmgStage.detach();
      // Our own unswapped staging copy is useless after a failure; drop it so the
      // next run does not trip on it, but only while the live app is in place.
      if (ownsStaging && !swapped && (quitAt === undefined || (await exists(app)))) {
        await NodeFSP.rm(next, { recursive: true, force: true });
        if (quitAt !== undefined) await phase("staging_removed", { path: next });
      }
    } catch (error) {
      await phase("cleanup_failed", { error: String(error) });
      cleanupFailure = error;
    } finally {
      await retention.finish({
        swapped,
        failure: installFailure ?? cleanupFailure,
        release: hold.release,
        quitStarted: quitAt !== undefined,
        healthy: async () => {
          const health = await get("/api/ardud/control/health");
          if (health.ok !== true || health.status !== "healthy") return false;
          if (!swapped) return true;
          const report = await get("/api/ardud/control/install-report");
          return Boolean(report.bootId && report.bootId !== oldBootId);
        },
        onWaiting: async () => {
          await phase("recovery_waiting", {
            swapped,
            message: "Keeping install heartbeat until Robob is healthy. Repair or complete a compatible rollback from another Terminal; keep this installer running.",
            holdBy: hold.by,
            holdPid: hold.pid,
          });
          await exec(
            "/Users/ardud/.bun/bin/bun",
            [
              "/Users/ardud/.local/share/telegram-bridge/src/cli.ts",
              "notify", "--source", "Robob install", "--severity", "attention",
              "--key", `robob-install:${stamp}:recovery`,
              "--text", "Robob install needs recovery. Its heartbeat is still held. Keep the installer running while repairing or completing a compatible rollback, then reopen Robob. Check the install log for the hold PID.",
            ],
            { timeout: 5000 },
          ).catch(() => {});
        },
      });
    }
  }
  if (cleanupFailure) throw cleanupFailure;
}
export async function runInstaller(args, run = main) {
  try {
    await run(args);
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode === READ_CHECK_FAILED ? READ_CHECK_FAILED : 1;
  }
}
if (process.argv[1] && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)) {
  await runInstaller(process.argv.slice(2));
}
