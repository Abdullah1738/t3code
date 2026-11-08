import {
  captureOwnedTree,
  cleanupOwnedTree,
  survivingOwned,
} from "../../../packages/shared/src/ownedProcessTree.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
export const INSTALL_PLAN = [
  "pre-stage",
  "signature",
  "migration-check",
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
  const get = async (route) => {
    const response = await fetch(`${origin}${route}`, {
      headers: { authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  let oldBootId;
  try {
    oldBootId = (await get("/api/ardud/control/install-report")).bootId;
  } catch {}
  let mount;
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
    // Before the swap no new binary has touched the data. Reopen the existing app.
    // After it, a rollback must pass the previous binary's migration preflight.
    if (quitAt !== undefined && !swapped) await launch().catch(() => {});
    throw e;
  } finally {
    if (ownsStaging && !swapped && quitAt === undefined)
      await fs.rm(next, { recursive: true, force: true });
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
