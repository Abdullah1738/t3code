import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  validateReadyBudget, installCommandTimeout, installBackupTimeout,
  waitForInstallReadiness, readBootPhase,
} from "./install-readiness.mjs";
import { install, cloneBackup, createBackupRetention, getJson } from "./install-robob-fast.mjs";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../../..");
const readinessJs = path.join(import.meta.dirname, "install-readiness.mjs");

test("budget input classes: default, decimal integers, malformed and unsafe values", () => {
  for (const [input, expected] of [[undefined, 180], ["180", 180], ["780", 780], ["00780", 780], ["781", 781]])
    assert.equal(validateReadyBudget(input), expected);
  for (const input of ["", "179", "0", "-180", "+180", "180.0", "180.5", "1e3", "0xB4", " 780", "780 ", "780\n", "NaN", "Infinity", "abc", "--dmg", "9007199254740991"])
    assert.throws(() => validateReadyBudget(input), /integer >= 180/, JSON.stringify(input));
});

for (const budget of [180, 780, 781]) {
  test(`${budget}s reaches command, clone, listening and continuation waits without resetting the clock`, async () => {
    const quitAt = 1000;
    const deadline = quitAt + budget * 1000;
    assert.equal(installCommandTimeout(5000, quitAt, false, deadline - 2000, budget), 2000);
    assert.throws(() => installCommandTimeout(5000, quitAt, false, deadline, budget), /readiness budget/);
    assert.equal(installCommandTimeout(5000, undefined, false, deadline, budget), 5000);
    assert.equal(installCommandTimeout(1_840_000, quitAt, true, deadline + 1, budget), 1_840_000);
    assert.equal(installBackupTimeout(quitAt, deadline - 61_000, budget), 1000);
    assert.throws(() => installBackupTimeout(quitAt, deadline - 60_000, budget), /No time left/);
    assert.equal(installBackupTimeout(quitAt, quitAt, budget), 120_000);
    for (const pathName of ["listening", "continuations"]) {
      let now = deadline - 200;
      let calls = 0;
      await assert.rejects(waitForInstallReadiness(async () => { calls++; return false; }, {
        quitAt, readyBudgetS: budget, now: () => now, sleep: async (ms) => { now += ms; },
      }), /readiness budget/, pathName);
      assert.equal(calls, 1);
    }
  });
}

test("a throwaway probe app boots after 180s, continues at 540s, and survives budget overrun with its backup pinned", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "installer-budget-probe-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bootFile = path.join(dir, "boot.ndjson");
  const stamp = "2026-11-15T00-00-00.000Z";
  let elapsed;
  const server = http.createServer(async (_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ listening: elapsed >= 240_000, complete: elapsed >= 540_000 }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const probe = () => getJson(`http://127.0.0.1:${server.address().port}/probe`);
  for (const readyBudgetS of [180, 780]) {
    elapsed = 0;
    const events = [];
    const phase = async (name, details) => events.push({ name, ...details });
    const backupRoot = path.join(dir, String(readyBudgetS));
    const retention = createBackupRetention({ backupRoot, currentStamp: stamp, phase });
    let released = false;
    let quitStarted = false;
    let swapped = false;
    const poll = (field) => waitForInstallReadiness(async () => (await probe())[field], {
      quitAt: 0, readyBudgetS, now: () => elapsed, sleep: async () => { elapsed += 60_000; },
    });
    await fs.writeFile(bootFile, [
      { bootId: "probe", id: 0, phase: "boot", outcome: "start" },
      { bootId: "probe", id: 1, phase: "sqlite.shell-indexes", outcome: "start" },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");
    const ops = Object.fromEntries(["stage", "verify", "migrations", "hostPreflight", "cancelWindow"]
      .map((name) => [name, async () => {}]));
    Object.assign(ops, {
      phase, quit: async () => { quitStarted = true; },
      backup: () => cloneBackup({ backupRoot, stamp, clone: async (destination) => {
        assert.equal(installBackupTimeout(0, elapsed, readyBudgetS), 120_000);
        await fs.mkdir(destination);
        await fs.writeFile(path.join(destination, "probe.txt"), "probe backup, no SQLite");
        return ["probe.txt"];
      } }),
      swap: async () => { swapped = true; }, launch: async () => {},
      readReady: () => poll("listening"), report: () => poll("complete"),
      prune: () => retention.prune("ready"),
    });
    let failure;
    try { await install(ops); }
    catch (error) {
      failure = error;
      assert.equal(error.code, "READINESS_BUDGET_EXCEEDED");
      await retention.pin(error);
    } finally {
      await retention.finish({
        failure, swapped, quitStarted,
        release: async () => { released = true; await phase("hold_released"); },
        healthy: async () => (await probe()).complete,
        onWaiting: async () => {
          assert.equal(released, false);
          await fs.access(path.join(backupRoot, stamp, ".pinned"));
          const boot = await readBootPhase(bootFile);
          assert.equal(boot.phase, "sqlite.shell-indexes");
          await phase("recovery_waiting", { boot });
        },
        sleep: async () => { elapsed += 60_000; },
      });
    }
    assert.equal(Boolean(failure), readyBudgetS === 180);
    assert.equal(released, true);
    assert.equal(elapsed, 540_000);
    assert.deepEqual(events.filter(({ name }) => ["backup_pinned", "recovery_waiting", "hold_released", "backup_unpinned"].includes(name))
      .map(({ name }) => name), readyBudgetS === 180
        ? ["backup_pinned", "recovery_waiting", "hold_released", "backup_unpinned"] : ["hold_released"]);
    assert.equal(events.filter(({ name }) => name === "backups_pruned").length, 1);
  }
});

test("phase diagnostics handle nested phases, old boots, incomplete appends and missing logs", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "installer-phase-probe-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "boot.ndjson");
  assert.equal((await readBootPhase(file)).unavailable, "ENOENT");
  const records = [
    { bootId: "old", id: 0, phase: "ready.publish", outcome: "success" },
    { bootId: "new", id: 0, phase: "boot", outcome: "start" },
    { bootId: "new", id: 1, phase: "sqlite.setup", outcome: "start" },
    { bootId: "new", id: 2, phase: "sqlite.pragmas", outcome: "start" },
    { bootId: "new", id: 2, phase: "sqlite.pragmas", outcome: "success" },
  ];
  await fs.writeFile(file, records.map((r) => JSON.stringify(r)).join("\n") + '\n{"boot');
  assert.equal((await readBootPhase(file, "old")).phase, "sqlite.setup");
  assert.equal((await readBootPhase(file, "new")).unavailable, "no_new_boot");
  await fs.writeFile(file, "x".repeat(300_000) + "\n" + JSON.stringify(records[1]) + "\n");
  assert.equal((await readBootPhase(file)).phase, "boot");
});

test("multiple backup files share the clone deadline with both default and larger budgets", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "installer-multifile-probe-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const readyBudgetS of [180, 780, 781]) {
    let elapsed = 0;
    const backupDeadline = 120_000;
    const destination = path.join(dir, String(readyBudgetS));
    const allowances = [];
    await assert.rejects(cloneBackup({ backupRoot: dir, stamp: String(readyBudgetS), clone: async () => {
      await fs.mkdir(destination);
      for (const file of ["probe-main.txt", "probe-wal.txt", "probe-boards.txt"]) {
        const timeout = installBackupTimeout(0, elapsed, readyBudgetS, backupDeadline);
        allowances.push(timeout);
        await fs.writeFile(path.join(destination, file), "probe, no database");
        elapsed += Math.min(100_000, timeout);
        if (timeout < 100_000) throw new Error("probe copy reached its timeout");
      }
    } }), /probe copy reached its timeout/);
    assert.deepEqual(allowances, [120_000, 20_000]);
    assert.equal(elapsed, 120_000);
    await assert.rejects(fs.access(path.join(destination, ".complete")), { code: "ENOENT" });
    await fs.access(path.join(dir, `partial-${readyBudgetS}`));
  }
});

test("fast wrapper and generated release launcher carry the budget into the dry-run plan", async (t) => {
  const wrapper = path.join(import.meta.dirname, "install-robob-fast.zsh");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "release-launcher-probe-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const launcher = path.join(dir, "run-install.zsh");
  await fs.writeFile(launcher, '#!/bin/zsh -f\nexec zsh "$1" --ready-budget-s "$2" --dry-run\n');
  for (const budget of ["180", "780", "781"]) {
    const { stdout } = await exec("zsh", [launcher, wrapper, budget]);
    assert.equal(JSON.parse(stdout).readyBudgetS, Number(budget));
  }
  assert.equal(JSON.parse((await exec("zsh", [wrapper, "--dry-run"])).stdout).readyBudgetS, 180);
  for (const script of [wrapper, path.join(root, "tmp/memory/cutover/install-robob-resume.zsh"), path.join(root, "tmp/memory/cutover/robob-restart-unattended.zsh")]) {
    for (const args of [["179"], ["180.5"], ["1e3"], [""], [], ["780", "--ready-budget-s", "900"]])
      await assert.rejects(exec("zsh", [script, "--ready-budget-s", ...args, ...(script === wrapper ? ["--dry-run"] : [])]), /ready-budget-s/);
  }
});

test("legacy waits consume the same budget with probe-only shell commands", async (t) => {
  const source = await fs.readFile(path.join(root, "tmp/memory/cutover/install-robob-resume.zsh"), "utf8");
  const shutdown = source.slice(source.indexOf("wait_until_closed() {"), source.indexOf('\nsource "', source.indexOf("wait_until_closed() {")));
  const opencode = source.slice(source.indexOf("  for (( i=0; i<READY_BUDGET_S; i+=2 ))"), source.indexOf('\n  curl -fsS', source.indexOf("  for (( i=0; i<READY_BUDGET_S; i+=2 ))")));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "legacy-budget-probe-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, "probe.zsh");
  await fs.writeFile(script, `set -eu\nREADY_BUDGET_S=$(node "$1" validate "$2")\nUNATTENDED=1\nPW=probe\ncalls=$3\nsleep() { :; }\nkill() { print FORBIDDEN_KILL; return 1; }\n${shutdown}\nprobe_pids() {\n local n=$(cat "$calls")\n print $((n+1)) > "$calls"\n (( n < READY_BUDGET_S-1 )) && print 999999\n return 0\n}\nprint 0 > "$calls"\nwait_until_closed probe_pids 0 Probe\nprint "shutdown_calls=$(cat "$calls")"\ncurl() { print x >> "$calls"; return 1; }\nprint -n '' > "$calls"\n${opencode}\nprint "opencode_calls=$(wc -l < "$calls" | tr -d ' ')"\n`);
  for (const budget of [180, 780, 781]) {
    const { stdout } = await exec("zsh", [script, readinessJs, String(budget), path.join(dir, "calls")]);
    assert.match(stdout, new RegExp(`shutdown_calls=${budget}`));
    assert.match(stdout, new RegExp(`opencode_calls=${Math.ceil(budget / 2)}`));
    assert.doesNotMatch(stdout, /FORBIDDEN_KILL/);
  }
});

test("legacy argument validation initializes Node from NVM on a restricted PATH", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "installer-nvm-probe-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cutover = path.join(dir, "tmp/memory/cutover");
  const scripts = path.join(dir, "apps/desktop/scripts");
  const bin = path.join(dir, "empty-path");
  const nvm = path.join(dir, "nvm");
  for (const p of [cutover, scripts, bin, nvm]) await fs.mkdir(p, { recursive: true });
  await fs.copyFile(readinessJs, path.join(scripts, "install-readiness.mjs"));
  await fs.writeFile(path.join(nvm, "nvm.sh"), `export PATH=${JSON.stringify(path.dirname(process.execPath))}:$PATH\n`);
  for (const name of ["install-robob-resume", "robob-restart-unattended"]) {
    const source = await fs.readFile(path.join(root, `tmp/memory/cutover/${name}.zsh`), "utf8");
    const end = source.indexOf(name === "install-robob-resume" ? "OPEN_CLEAN=" : "# The test mode only exercises");
    assert.ok(end > 0);
    const probe = path.join(cutover, `${name}.zsh`);
    await fs.writeFile(probe, source.slice(0, end) + '\nprint -r -- "budget=$READY_BUDGET_S"\n');
    for (const [args, expected] of [[[], 180], [["--ready-budget-s", "780"], 780]]) {
      const { stdout } = await exec("/bin/zsh", [probe, ...args], {
        env: { ...process.env, PATH: bin, NVM_DIR: nvm },
      });
      assert.match(stdout, new RegExp(`budget=${expected}`));
    }
    await assert.rejects(exec("/bin/zsh", [probe], {
      env: { ...process.env, PATH: bin, NVM_DIR: path.join(dir, "missing-nvm") },
    }), /node not found/);
  }
});

test("legacy recovery keeps waiting through diagnostic command and log write failures", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "installer-log-failure-probe-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = await fs.readFile(path.join(root, "tmp/memory/cutover/install-robob-resume.zsh"), "utf8");
  const start = source.indexOf("WAIT_START=$SECONDS\nBUDGET_REPORTED=0");
  const end = source.indexOf('\nprint "Server up after', start);
  assert.ok(start > 0 && end > start);
  const probe = path.join(dir, "probe.zsh");
  await fs.writeFile(probe, `set -euo pipefail\nREADY_BUDGET_S=180\nSTAMP=probe\nOLD_BOOT_ID=old\nREADINESS_JS=probe\nROBOB_INSTALL_LOG=$1\nhealth_calls=0\nt3ctl() { (( health_calls+=1 )); (( health_calls >= 3 )); }\nsleep() { SECONDS=$((SECONDS+180)); }\nnode() { print '{"phase":"sqlite.shell-indexes"}'; return $2; }\n${source.slice(start, end)}\nprint "RECOVERED:$health_calls"\n`);
  // The shell function's own argv differs from the probe's: use a fixed function body.
  for (const nodeExit of [0, 1]) {
    const text = (await fs.readFile(probe, "utf8")).replace("return $2;", `return ${nodeExit};`);
    const run = path.join(dir, `probe-${nodeExit}.zsh`);
    await fs.writeFile(run, text);
    for (const log of [dir, path.join(dir, "install.ndjson")]) {
      const { stdout, stderr } = await exec("/bin/zsh", [run, log]);
      assert.match(stdout, /RECOVERED:3/);
      if (log === dir) assert.match(stderr, /keeping the install heartbeat/);
      if (nodeExit) assert.match(stdout, /diagnostic_failed/);
    }
  }
});
