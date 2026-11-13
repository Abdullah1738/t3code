import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkSustainedReads,
  install,
  installCommandTimeout,
  reportInstall,
} from "./install-robob-fast.mjs";

const exec = promisify(execFile);
const moduleUrl = new URL("./install-robob-fast.mjs", import.meta.url).href;
const noThreads = { continued: 0, skipped: 0, pending: 0, threads: [] };

async function fixture(t, body) {
  const root = await mkdtemp(join(tmpdir(), "robob-reads-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = join(root, "fake watchdog");
  const calls = join(root, "calls");
  await writeFile(command, `#!/bin/zsh -f\nprint -r -- "$*" > "$ROBOB_TEST_CALLS"\n${body}\n`, {
    mode: 0o700,
  });
  const output = [];
  const env = { ...process.env, ROBOB_READ_CHECK: command, ROBOB_TEST_CALLS: calls };
  return { root, calls, output, env, check: () => checkSustainedReads({ env, output: (s) => output.push(s) }) };
}

const reportOptions = (extra = {}) => ({
  report: noThreads,
  phase: async () => {},
  stamp: "test-stamp",
  log: "/test/install.ndjson",
  elapsedSeconds: () => 350,
  ...extra,
});

test("watchdog uses the default executable, fixed sustain arguments and a separate bound", async () => {
  let called = false;
  await checkSustainedReads({
    env: {},
    run: async (command, args, options) => {
      called = true;
      assert.ok(command.endsWith("/.local/bin/robob-read-watchdog"));
      assert.deepEqual(args, ["--sustain", "300", "--every", "30", "--give-up", "1800"]);
      assert.equal(options.timeout, 1_840_000);
      assert.equal(options.killSignal, "SIGKILL");
      return { stdout: "", stderr: "" };
    },
  });
  assert.equal(called, true);
});

for (const [name, report, rollback] of [
  ["no pending or interrupted threads", noThreads, false],
  ["resumed and skipped threads", {
    continued: 1, skipped: 1, pending: 0,
    threads: [{ threadId: "a", continued: true }, { threadId: "b", continued: false, reason: "stopped" }],
  }, false],
  ["rollback with no threads", noThreads, true],
]) {
  test(`healthy reads gate success for ${name}`, async (t) => {
    const f = await fixture(t, "print 'reads healthy for 5 min'");
    const phases = [];
    const notices = [];
    const phase = async (name) => phases.push(name);
    const ops = Object.fromEntries([
      "stage", "verify", "verifyPrevious", "migrations", "hostPreflight", "cancelWindow",
      "quit", "backup", "swap", "launch", "readReady", "prune",
    ].map((name) => [name, async () => phases.push(name)]));
    ops.phase = phase;
    ops.report = () => reportInstall(reportOptions({
      report, phase, readCheck: f.check,
      notify: async (notice) => {
        assert.equal(phases.at(-1), "reads_healthy");
        assert.equal(await readFile(f.calls, "utf8"), "--sustain 300 --every 30 --give-up 1800\n");
        notices.push(notice);
      },
    }));
    await install(ops, { rollback });
    assert.equal(notices.length, 1);
    assert.equal(notices[0].key, "robob-install:test-stamp:report");
    assert.equal(notices[0].severity, "attention");
    assert.match(notices[0].text, /Robob installed: .*Reads healthy for 5 min\. 350s to report\./);
    assert.match(notices[0].text, new RegExp(`${report.continued} continuations queued`));
    if (report.skipped) assert.match(notices[0].text, /b:stopped/);
    assert.deepEqual(f.output, ["reads healthy for 5 min\n"]);
    assert.ok(phases.indexOf("continuations_queued") < phases.indexOf("read-check"));
    assert.equal(phases.at(-1), "prune");
  });
}

test("no success is sent while the read check is pending", async () => {
  const check = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const notices = [];
  const pending = reportInstall(reportOptions({
    readCheck: () => { entered.resolve(); return check.promise; },
    notify: async (n) => notices.push(n),
  }));
  await entered.promise;
  assert.equal(notices.length, 0);
  check.resolve();
  await pending;
  assert.equal(notices.length, 1);
});

test("failing reads exit 75 with a :reads error, even when no threads were pending", async (t) => {
  const f = await fixture(t, "print 'installed but reads still failing since 01:49 (timeout)'\nexit 1");
  const notices = join(f.root, "notices.jsonl");
  const runner = `
    import { appendFile } from 'node:fs/promises';
    import { install, reportInstall, runInstaller } from ${JSON.stringify(moduleUrl)};
    const noop = async () => {};
    const phase = async (phase, extra) => console.log(JSON.stringify({phase, ...extra}));
    await runInstaller([], () => install({
      stage: noop, verify: noop, migrations: noop, hostPreflight: noop, cancelWindow: noop,
      phase, quit: noop, backup: noop, swap: noop, launch: noop, readReady: noop,
      prune: async () => { throw new Error('must not prune'); },
      report: () => reportInstall({
        report: ${JSON.stringify(noThreads)}, phase, stamp: 'fake', log: '/test/install.ndjson',
        elapsedSeconds: () => 1850,
        notify: (notice) => appendFile(process.env.ROBOB_TEST_NOTICES, JSON.stringify(notice) + '\\n'),
      }),
    }));
  `;
  let failure;
  try {
    await exec(process.execPath, ["--input-type=module", "-e", runner], {
      env: { ...f.env, ROBOB_TEST_NOTICES: notices }, timeout: 10_000,
    });
  } catch (error) { failure = error; }
  assert.equal(failure?.code, 75);
  assert.match(failure.stdout, /installed but reads still failing since 01:49 \(timeout\)/);
  assert.match(failure.stdout, /"phase":"read-check"/);
  assert.match(failure.stdout, /"phase":"reads_failed"/);
  assert.doesNotMatch(failure.stdout, /reads_healthy|must not prune/);
  const sent = (await readFile(notices, "utf8")).trim().split("\n").map((s) => JSON.parse(s));
  assert.deepEqual(sent, [{
    severity: "error", key: "robob-install:fake:reads",
    text: "Robob installed, but reads are still failing since 01:49. Not saying it's back up. Log: /test/install.ndjson",
  }]);
  assert.equal(await readFile(f.calls, "utf8"), "--sustain 300 --every 30 --give-up 1800\n");
});

for (const [name, cause, expected] of [
  ["stdout", { stdout: "installed but reads still failing since 00:00 (timeout)\n" }, "00:00"],
  ["stderr", { stderr: "installed but reads still failing since 23:59 (timeout)\n" }, "23:59"],
  ["missing helper", { code: "ENOENT" }, "09:05"],
  ["killed helper", { signal: "SIGKILL", killed: true }, "09:05"],
  ["invalid time", { stdout: "installed but reads still failing since 29:59 (timeout)\n" }, "09:05"],
]) {
  test(`read-check failure from ${name} remains a read failure if notify fails`, async () => {
    const output = [];
    const phases = [];
    await assert.rejects(reportInstall(reportOptions({
      phase: async (p) => phases.push(p),
      readCheck: () => checkSustainedReads({
        now: () => new Date(2026, 10, 13, 9, 5), output: (s) => output.push(s),
        run: async () => { throw Object.assign(new Error(name), cause); },
      }),
      notify: async (n) => {
        assert.equal(n.key, "robob-install:test-stamp:reads");
        assert.match(n.text, new RegExp(`since ${expected}`));
        throw new Error("notify unavailable");
      },
    })), (error) => error.exitCode === 75 && error.since === expected);
    assert.ok(phases.includes("reads_notify_failed"));
    assert.ok(!phases.includes("reads_healthy"));
    assert.match(output.join(""), new RegExp(`installed but reads still failing since ${expected}`));
  });
}

test("observation, notify and detach can outlast the startup deadline", () => {
  assert.equal(installCommandTimeout(5000, 1000, false, 176_000), 5000);
  assert.throws(() => installCommandTimeout(5000, 1000, false, 181_000), /3 minute limit/);
  assert.equal(installCommandTimeout(1_840_000, 1000, true, 181_000), 1_840_000);
  assert.equal(installCommandTimeout(5000, 1000, true, 1_850_000), 5000);
  assert.equal(installCommandTimeout(20_000, 1000, true, 1_850_000), 20_000);
});
