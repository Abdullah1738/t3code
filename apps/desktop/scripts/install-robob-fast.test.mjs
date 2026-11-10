import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import {
  checkSignature,
  clearStaleStaging,
  hostPreflight,
  install,
  otherInstallerPids,
  pidsRunningFrom,
  probeDirectory,
  relaunchAfterFailure,
  uStateProcesses,
} from "./install-robob-fast.mjs";

test("preflights before downtime, swaps sandbox bundles and waits for a new server", async () => {
  const root = await mkdtemp(join(tmpdir(), "install-test-"));
  const events = [];
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end('{"ready":true}');
  });
  try {
    await mkdir(join(root, "current"));
    await writeFile(join(root, "current/version"), "old");
    await install({
      stage: async () => {
        events.push("stage");
        await mkdir(join(root, "next"));
        await writeFile(join(root, "next/version"), "new");
      },
      verify: async () => events.push("verify"),
      migrations: async () => events.push("migrations"),
      hostPreflight: async () => events.push("host"),
      cancelWindow: async () => events.push("cancel"),
      phase: async (p) => events.push(p),
      quit: async () => events.push("stop"),
      backup: async () => events.push("backup"),
      swap: async () => {
        await rename(join(root, "current"), join(root, "prev"));
        await rename(join(root, "next"), join(root, "current"));
      },
      launch: async () => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)),
      readReady: async () =>
        assert.deepEqual(await (await fetch(`http://127.0.0.1:${server.address().port}`)).json(), {
          ready: true,
        }),
      report: async () => events.push("report"),
    });
    assert.equal(await readFile(join(root, "current/version"), "utf8"), "new");
    assert.equal(await readFile(join(root, "prev/version"), "utf8"), "old");
    assert.deepEqual(events.slice(0, 8), [
      "stage",
      "verify",
      "migrations",
      "host",
      "cancel",
      "quit",
      "stop",
      "closed",
    ]);
    assert.equal(events.at(-1), "report");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

for (const failed of [
  "stage",
  "verify",
  "migrations",
  "hostPreflight",
  "cancelWindow",
  "quit",
  "backup",
  "swap",
  "launch",
  "readReady",
  "report",
]) {
  test(`failure at ${failed} stops before later actions`, async () => {
    const calls = [];
    const ops = Object.fromEntries(
      [
        "stage",
        "verify",
        "migrations",
        "hostPreflight",
        "cancelWindow",
        "quit",
        "backup",
        "swap",
        "launch",
        "readReady",
        "report",
      ].map((name) => [
        name,
        async () => {
          calls.push(name);
          if (name === failed) throw new Error(failed);
        },
      ]),
    );
    ops.phase = async () => {};
    await assert.rejects(install(ops), new RegExp(failed));
    assert.equal(calls.at(-1), failed);
    if (["stage", "verify", "migrations", "hostPreflight", "cancelWindow"].includes(failed))
      assert.ok(!calls.includes("quit"));
  });
}

test("rollback verifies the previous bundle and schema compatibility before quitting", async () => {
  const calls = [];
  const ops = Object.fromEntries(
    [
      "verifyPrevious",
      "migrations",
      "hostPreflight",
      "cancelWindow",
      "quit",
      "backup",
      "launch",
      "readReady",
      "report",
      "phase",
    ].map((name) => [name, async () => calls.push(name)]),
  );
  ops.swap = async (rollback) => assert.equal(rollback, true);
  await install(ops, { rollback: true });
  assert.equal(calls[0], "verifyPrevious");
});

const signed = (overrides = {}) => {
  const f = {
    Identifier: "com.ardud.robob",
    TeamIdentifier: "HVG39427R3",
    authorities: [
      "Developer ID Application: Abdullah Rangoonwala (HVG39427R3)",
      "Developer ID Certification Authority",
      "Apple Root CA",
    ],
    ...overrides,
  };
  return [
    "Executable=/Applications/Robob.app/Contents/MacOS/Robob",
    f.Identifier === undefined ? "" : `Identifier=${f.Identifier}`,
    "Format=app bundle with Mach-O thin (arm64)",
    ...f.authorities.map((a) => `Authority=${a}`),
    f.TeamIdentifier === undefined ? "" : `TeamIdentifier=${f.TeamIdentifier}`,
    "Runtime Version=26.5.0",
  ].join("\n");
};

test("accepts an un-notarized Developer ID build from the expected team", () => {
  checkSignature(signed());
});

for (const [name, overrides, message] of [
  ["another team", { TeamIdentifier: "AAAAAAAAAA" }, /team AAAAAAAAAA/],
  ["missing team", { TeamIdentifier: undefined }, /team missing/],
  ["another bundle", { Identifier: "com.example.app" }, /identifier com.example.app/],
  [
    "another signer",
    { authorities: ["Apple Development: Someone (X)", "Apple Root CA"] },
    /signer Apple Development/,
  ],
  ["ad-hoc", { authorities: [], TeamIdentifier: "not set" }, /signer missing/],
  [
    "a chain outside Apple",
    {
      authorities: [
        "Developer ID Application: Abdullah Rangoonwala (HVG39427R3)",
        "Some Other Root",
      ],
    },
    /Apple Root CA/,
  ],
])
  test(`rejects ${name}`, () => assert.throws(() => checkSignature(signed(overrides)), message));

// ---------------------------------------------------------------------------
// Host preflight, failure relaunch and stale staging (install-20261110.1 issue 1)
// ---------------------------------------------------------------------------

const fakeProbe = (script) => {
  const calls = [];
  return {
    calls,
    probe: async (dir) => {
      calls.push(dir);
      const next = script.shift();
      return typeof next === "function" ? next(dir) : { dir, ...next };
    },
  };
};

test("host preflight passes a healthy mount without restarting ovnfs", async () => {
  const logs = [];
  const { probe, calls } = fakeProbe([{ state: "ok", stdout: ".\n..\n.hidden\nrobob-1\n" }, { state: "ok", stdout: "" }]);
  let restarted = false;
  const result = await hostPreflight({
    checkoutsDir: "/c",
    probe,
    restart: async () => (restarted = true),
    uState: async () => [{ pid: 7, stat: "U", command: "git" }],
    log: async (phase, extra) => logs.push([phase, extra]),
  });
  assert.equal(result.restarted, false);
  assert.equal(restarted, false);
  // Root first, then one checkout inside it (lookups inside hung on 10 Nov).
  assert.deepEqual(calls, ["/c", "/c/robob-1"]);
  const u = logs.find(([phase]) => phase === "host_preflight_u_state");
  assert.equal(u[1].count, 1);
  assert.equal(u[1].processes[0].pid, 7);
});

test("host preflight restarts ovnfs once for a hung checkout and continues when it answers", async () => {
  const logs = [];
  const { probe } = fakeProbe([
    { state: "ok", stdout: "a\n" },
    { state: "hang", timeoutMs: 10_000 },
    { state: "ok", stdout: "a\n" },
    { state: "ok", stdout: "" },
  ]);
  let restarts = 0;
  const result = await hostPreflight({
    checkoutsDir: "/c",
    probe,
    restart: async () => restarts++,
    uState: async () => [],
    log: async (phase) => logs.push(phase),
    sleep: async () => {},
  });
  assert.equal(restarts, 1);
  assert.equal(result.restarted, true);
  assert.ok(logs.includes("host_preflight_ovnfs_restart"));
});

test("host preflight aborts before the quit when the mount still hangs after the restart", async () => {
  const hang = { state: "hang", timeoutMs: 10_000 };
  const { probe } = fakeProbe([hang, hang, hang, hang]);
  let restarts = 0;
  await assert.rejects(
    hostPreflight({
      checkoutsDir: "/c",
      probe,
      restart: async () => restarts++,
      uState: async () => [],
      log: async () => {},
      sleep: async () => {},
      recheckAttempts: 3,
    }),
    /still hangs after ovnfs restart; not quitting Robob/,
  );
  assert.equal(restarts, 1);
});

test("host preflight refuses a hung mount when no ovnfs restart is available", async () => {
  const { probe } = fakeProbe([{ state: "hang", timeoutMs: 10 }]);
  await assert.rejects(
    hostPreflight({ checkoutsDir: "/c", probe, uState: async () => [], log: async () => {} }),
    /not quitting Robob/,
  );
});

test("host preflight tolerates a missing ~/checkouts", async () => {
  const { probe } = fakeProbe([{ state: "absent" }]);
  const result = await hostPreflight({ checkoutsDir: "/c", probe, uState: async () => [], log: async () => {} });
  assert.equal(result.result.state, "absent");
});

test("a failed host preflight stops the install before the cancel window and quit", async () => {
  const calls = [];
  const ops = Object.fromEntries(
    ["stage", "verify", "migrations", "cancelWindow", "quit", "backup", "swap", "launch", "readReady", "report", "phase"].map(
      (name) => [name, async () => calls.push(name)],
    ),
  );
  ops.hostPreflight = async () => {
    calls.push("hostPreflight");
    throw new Error("still hangs");
  };
  await assert.rejects(install(ops), /still hangs/);
  assert.deepEqual(calls, ["stage", "verify", "migrations", "hostPreflight"]);
});

test("probeDirectory reports a real directory, a missing one, and a hang", async () => {
  const root = await mkdtemp(join(tmpdir(), "probe-test-"));
  try {
    await mkdir(join(root, "x"));
    const ok = await probeDirectory(root, 5000);
    assert.equal(ok.state, "ok");
    assert.match(ok.stdout, /\bx\b/);
    assert.equal((await probeDirectory(join(root, "missing"), 5000)).state, "absent");
    // A FIFO-free stand-in for a hung lookup: a timeout of 0 ms always expires first.
    assert.equal((await probeDirectory(root, 0)).state, "hang");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uStateProcesses keeps only U-state rows", async () => {
  const rows = await uStateProcesses(async () => ({
    stdout: "  1 Ss   /sbin/launchd\n5646 U    /Applications/Robob.app/Contents/MacOS/Robob\n 77 U+   git\n",
  }));
  assert.deepEqual(
    rows.map((r) => r.pid),
    [5646, 77],
  );
});

test("failure relaunch waits for the old server to exit before reopening the app", async () => {
  const logs = [];
  let checks = 0;
  let launched = 0;
  let clock = 0;
  const ok = await relaunchAfterFailure({
    survivors: async () => (++checks < 4 ? [{ pid: 5646 }] : []),
    launch: async () => {
      assert.equal(checks, 4, "launch only after the survivor is gone");
      launched++;
    },
    log: async (phase) => logs.push(phase),
    sleep: async (ms) => (clock += ms),
    now: () => clock,
  });
  assert.equal(ok, true);
  assert.equal(launched, 1);
  assert.ok(logs.includes("relaunch_waiting"));
});

test("failure relaunch never reopens beside a survivor and alerts instead", async () => {
  const notes = [];
  let clock = 0;
  let launched = false;
  const ok = await relaunchAfterFailure({
    survivors: async () => [{ pid: 5646 }],
    launch: async () => (launched = true),
    log: async () => {},
    notify: async (text) => notes.push(text),
    sleep: async (ms) => (clock += ms),
    now: () => clock,
    boundMs: 5000,
  });
  assert.equal(ok, false);
  assert.equal(launched, false);
  assert.match(notes[0], /NOT relaunched.*5646/);
});

test("failure relaunch treats an unreadable process table as still running", async () => {
  let clock = 0;
  let launched = false;
  const ok = await relaunchAfterFailure({
    survivors: async () => {
      throw new Error("ps timed out");
    },
    launch: async () => (launched = true),
    log: async () => {},
    sleep: async (ms) => (clock += ms),
    now: () => clock,
    boundMs: 2000,
  });
  assert.equal(ok, false);
  assert.equal(launched, false);
});

const stagingDeps = (overrides = {}) => {
  const calls = [];
  return {
    calls,
    deps: {
      next: "/A/.Robob.next.app",
      stamp: "s1",
      log: async (phase, extra) => calls.push([phase, extra]),
      exists: async () => true,
      readBundleId: async () => "com.ardud.robob",
      topLevel: async () => ["Contents"],
      otherInstallers: async () => [],
      runningFrom: async () => [],
      rename: async (from, to) => calls.push(["rename", from, to]),
      remove: async (target) => calls.push(["remove", target]),
      stat: async () => ({ mtimeMs: 0 }),
      ...overrides,
    },
  };
};

test("a stale Robob staging bundle is moved aside, removed and logged", async () => {
  const { deps, calls } = stagingDeps();
  assert.equal(await clearStaleStaging(deps), "removed");
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["stale_staging_found", "rename", "remove", "stale_staging_removed"],
  );
  assert.equal(calls[1][2], "/A/.Robob.next.app.stale-s1");
});

test("a partial staging copy (Contents only, no Info.plist) counts as stale", async () => {
  const { deps } = stagingDeps({
    readBundleId: async () => {
      throw new Error("no Info.plist");
    },
  });
  assert.equal(await clearStaleStaging(deps), "removed");
});

test("no staging bundle means nothing to do", async () => {
  const { deps, calls } = stagingDeps({ exists: async () => false });
  assert.equal(await clearStaleStaging(deps), "absent");
  assert.equal(calls.length, 0);
});

for (const [name, overrides, message] of [
  ["another app", { readBundleId: async () => "com.example.other" }, /not a Robob staging bundle/],
  [
    "unknown content",
    { readBundleId: async () => undefined, topLevel: async () => ["Contents", "evil"] },
    /not a Robob staging bundle/,
  ],
  ["a running installer", { otherInstallers: async () => [4242] }, /Another installer is running \(pid 4242\)/],
  ["a process running from it", { runningFrom: async () => [{ pid: 99 }] }, /Processes run from .* \(pid 99\)/],
])
  test(`staging bundle is kept when it has ${name}`, async () => {
    const { deps, calls } = stagingDeps(overrides);
    await assert.rejects(clearStaleStaging(deps), message);
    assert.ok(!calls.some((c) => c[0] === "rename" || c[0] === "remove"));
  });

test("installer and process-path parsers", () => {
  const ps = [
    "100 /usr/local/bin/node /x/apps/desktop/scripts/install-robob-fast.mjs --dmg /a.dmg",
    "101 node /x/install-robob-fast.mjs --dry-run",
    "102 tmux -L robob-install new-session -d -s install-1 zsh /x/install-robob-fast.zsh --dmg /a.dmg",
    "103 /usr/local/bin/node /x/install-robob-fast.mjs --dmg /b.dmg",
  ].join("\n");
  assert.deepEqual(otherInstallerPids(ps, 103), [100]);
  const comm = "5 /A/.Robob.next.app/Contents/MacOS/Robob\n6 /A/Robob.app/Contents/MacOS/Robob\n";
  assert.deepEqual(pidsRunningFrom(comm, "/A/.Robob.next.app"), [{ pid: 5 }]);
  assert.deepEqual(pidsRunningFrom(comm, "/A/Robob.app"), [{ pid: 6 }]);
});
