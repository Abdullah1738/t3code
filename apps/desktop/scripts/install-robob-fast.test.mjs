import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import { acquireInstallHold, finishInstallHold } from "./robob-install-hold.mjs";
import {
  INSTALL_DATABASE_FILE,
  checkSignature,
  clearStaleStaging,
  cloneBackup,
  createBackupRetention,
  createDmgStage,
  getJson,
  hostPreflight,
  install,
  migrationCheckTimeoutMs,
  otherInstallerPids,
  pidsRunningFrom,
  probeDirectory,
  pruneBackups,
  relaunchAfterFailure,
  uStateProcesses,
} from "./install-robob-fast.mjs";

function dmgFixture({ detachFailures = 0, failAt, synchronous = false } = {}) {
  const calls = [];
  const phases = [];
  let attempts = 0;
  const dmg = createDmgStage({
    mkdtemp: async () => "/scratch/mount",
    rmdir: async (mount) => calls.push(["rmdir", mount]),
    phase: async (name, data) => phases.push({ name, ...data }),
    run: (cmd, args, options) => {
      calls.push([cmd, args, options]);
      const action = args[0];
      if (action === "detach") attempts++;
      if (action === failAt || (action === "detach" && attempts <= detachFailures)) {
        const error = new Error(`${action} failed ${attempts}`);
        if (synchronous) throw error;
        return Promise.reject(error);
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    },
  });
  const copy = async (mount) => {
    calls.push(["ditto", mount]);
    if (failAt === "copy") throw new Error("copy failed");
  };
  return { dmg, calls, phases, copy };
}

NodeTest.test("DMG staging detaches immediately after copy, before verification and quit", async () => {
  const { dmg, calls, phases, copy } = dmgFixture();
  const ops = Object.fromEntries(
    ["verify", "migrations", "hostPreflight", "cancelWindow", "quit", "backup", "swap",
      "launch", "readReady", "report", "phase"].map((name) => [name, async () => calls.push([name])]),
  );
  ops.stage = () => dmg.stage("/release.dmg", copy);
  try {
    await install(ops);
  } finally {
    await dmg.detach();
  }
  NodeAssert.deepEqual(calls.slice(0, 5).map(([cmd, args]) =>
    cmd === "/usr/bin/hdiutil" ? args[0] : cmd), ["attach", "ditto", "detach", "rmdir", "verify"]);
  const detaches = calls.filter(([cmd, args]) => cmd === "/usr/bin/hdiutil" && args[0] === "detach");
  NodeAssert.equal(detaches.length, 1);
  NodeAssert.deepEqual(detaches[0], ["/usr/bin/hdiutil", ["detach", "-quiet", "/scratch/mount"],
    { timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 2 ** 20 }]);
  NodeAssert.deepEqual(phases, []);
});

for (const synchronous of [false, true]) {
  NodeTest.test(`DMG detach retries once with force after a ${synchronous ? "synchronous throw" : "rejection"}`, async () => {
    const { dmg, calls, phases, copy } = dmgFixture({ detachFailures: 1, synchronous });
    await dmg.stage("/release.dmg", copy);
    await dmg.detach();
    const detaches = calls.filter(([cmd, args]) => cmd === "/usr/bin/hdiutil" && args[0] === "detach");
    NodeAssert.deepEqual(detaches.map(([, args]) => args), [
      ["detach", "-quiet", "/scratch/mount"],
      ["detach", "-quiet", "-force", "/scratch/mount"],
    ]);
    NodeAssert.ok(detaches.every(([, , options]) => options.timeout === 30_000));
    NodeAssert.equal(calls.at(-1)[0], "rmdir");
    NodeAssert.deepEqual(phases, []);
  });
}

for (const failure of [undefined, new Error("install failed")]) {
  NodeTest.test(`double detach failure logs both errors and preserves install ${failure ? "failure" : "success"}`, async () => {
    const { dmg, calls, phases, copy } = dmgFixture({ detachFailures: Infinity });
    const attempt = async () => {
      try {
        await dmg.stage("/release.dmg", copy);
        if (failure) throw failure;
        return "installed";
      } finally {
        await dmg.detach();
      }
    };
    if (failure) await NodeAssert.rejects(attempt, (error) => error === failure);
    else NodeAssert.equal(await attempt(), "installed");
    NodeAssert.deepEqual(phases, [
      { name: "dmg_detach_failed", mount: "/scratch/mount",
        error: "Error: detach failed 1; force retry: Error: detach failed 2" },
      { name: "dmg_detach_failed", mount: "/scratch/mount",
        error: "Error: detach failed 3; force retry: Error: detach failed 4" },
    ]);
    NodeAssert.equal(calls.some(([cmd]) => cmd === "rmdir"), false);
  });
}

for (const failAt of ["attach", "copy"]) {
  NodeTest.test(`finally backstop detaches after ${failAt} failure`, async () => {
    const { dmg, calls, copy } = dmgFixture({ failAt });
    await NodeAssert.rejects(async () => {
      try {
        await dmg.stage("/release.dmg", copy);
      } finally {
        await dmg.detach();
      }
    }, new RegExp(`${failAt} failed`));
    NodeAssert.deepEqual(calls.at(-2).slice(0, 2), ["/usr/bin/hdiutil", ["detach", "-quiet", "/scratch/mount"]]);
    NodeAssert.deepEqual(calls.at(-1), ["rmdir", "/scratch/mount"]);
  });
}

NodeTest.test("finally retries a mount left attached by failed early detach", async () => {
  const { dmg, calls, phases, copy } = dmgFixture({ detachFailures: 2 });
  await dmg.stage("/release.dmg", copy);
  NodeAssert.equal(phases.length, 1);
  await dmg.detach();
  await dmg.detach();
  NodeAssert.equal(calls.filter(([cmd, args]) => cmd === "/usr/bin/hdiutil" && args[0] === "detach").length, 3);
  NodeAssert.deepEqual(calls.at(-1), ["rmdir", "/scratch/mount"]);
});

NodeTest.test("DMG backstop does nothing when staging was skipped", async () => {
  const { dmg, calls, phases } = dmgFixture();
  await dmg.detach();
  NodeAssert.deepEqual(calls, []);
  NodeAssert.deepEqual(phases, []);
});

// Every post-quit failure must keep its owner alive through recovery, including rollback.
for (const rollback of [false, true]) {
  for (const failed of ["quit", "backup", "swap", "launch", "readReady", "report"]) {
    NodeTest.test(`${rollback ? "rollback" : "install"} ${failed} failure retains hold until healthy recovery`, async () => {
      const calls = [];
      let quitStarted = false;
      const ops = Object.fromEntries([
        "stage", "verify", "verifyPrevious", "migrations", "hostPreflight", "cancelWindow",
        "quit", "backup", "swap", "launch", "readReady", "report", "phase",
      ].map((name) => [name, async () => {
        if (name === "quit") quitStarted = true;
        if (name === failed) throw new Error(`failed ${name}`);
      }]));
      const { release } = await acquireInstallHold({ pid: 42, env: {}, run: async (_cmd, args) => calls.push(args[0]) });
      const waiting = Promise.withResolvers();
      const recovered = Promise.withResolvers();
      let probes = 0;
      const attempt = (async () => {
        try {
          await install(ops, { rollback });
        } finally {
          await finishInstallHold({
            release, quitStarted,
            healthy: async () => {
              calls.push("health");
              probes++;
              if (probes === 1) throw new Error("connection refused");
              if (probes === 2) return false;
              waiting.resolve();
              return recovered.promise;
            },
            onWaiting: async () => calls.push("attention"),
            sleep: async () => { NodeAssert.ok(!calls.includes("stop")); },
          });
        }
      })();
      const failure = NodeAssert.rejects(attempt, new RegExp(`failed ${failed}`));
      await waiting.promise;
      NodeAssert.equal(calls[0], "start");
      NodeAssert.equal(calls.includes("stop"), false);
      NodeAssert.equal(calls.filter((x) => x === "attention").length, 1);
      recovered.resolve(true);
      await failure;
      NodeAssert.equal(calls.at(-1), "stop");
    });
  }
}

NodeTest.test("preflights before downtime, swaps sandbox bundles and waits for a new server", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "install-test-"));
  const events = [];
  const server = NodeHttp.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end('{"ready":true}');
  });
  try {
    await NodeFSP.mkdir(NodePath.join(root, "current"));
    await NodeFSP.writeFile(NodePath.join(root, "current/version"), "old");
    await install({
      stage: async () => {
        events.push("stage");
        await NodeFSP.mkdir(NodePath.join(root, "next"));
        await NodeFSP.writeFile(NodePath.join(root, "next/version"), "new");
      },
      verify: async () => events.push("verify"),
      migrations: async () => events.push("migrations"),
      hostPreflight: async () => events.push("host"),
      cancelWindow: async () => events.push("cancel"),
      phase: async (p) => events.push(p),
      quit: async () => events.push("stop"),
      backup: async () => events.push("backup"),
      swap: async () => {
        await NodeFSP.rename(NodePath.join(root, "current"), NodePath.join(root, "prev"));
        await NodeFSP.rename(NodePath.join(root, "next"), NodePath.join(root, "current"));
      },
      launch: async () => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)),
      readReady: async () =>
        NodeAssert.deepEqual(await (await fetch(`http://127.0.0.1:${server.address().port}`)).json(), {
          ready: true,
        }),
      report: async () => events.push("report"),
    });
    NodeAssert.equal(await NodeFSP.readFile(NodePath.join(root, "current/version"), "utf8"), "new");
    NodeAssert.equal(await NodeFSP.readFile(NodePath.join(root, "prev/version"), "utf8"), "old");
    NodeAssert.deepEqual(events.slice(0, 8), [
      "stage",
      "verify",
      "migrations",
      "host",
      "cancel",
      "quit",
      "stop",
      "closed",
    ]);
    NodeAssert.equal(events.at(-1), "report");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await NodeFSP.rm(root, { recursive: true, force: true });
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
  NodeTest.test(`failure at ${failed} stops before later actions`, async () => {
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
    await NodeAssert.rejects(install(ops), new RegExp(failed));
    NodeAssert.equal(calls.at(-1), failed);
    if (["stage", "verify", "migrations", "hostPreflight", "cancelWindow"].includes(failed))
      NodeAssert.ok(!calls.includes("quit"));
  });
}

NodeTest.test("rollback verifies the previous bundle and schema compatibility before quitting", async () => {
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
  ops.swap = async (rollback) => NodeAssert.equal(rollback, true);
  await install(ops, { rollback: true });
  NodeAssert.equal(calls[0], "verifyPrevious");
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

NodeTest.test("accepts an un-notarized Developer ID build from the expected team", () => {
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
  NodeTest.test(`rejects ${name}`, () => NodeAssert.throws(() => checkSignature(signed(overrides)), message));

// Host preflight, failure relaunch and stale staging (install-20261110.1 issue 1).

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

NodeTest.test("host preflight passes a healthy mount without restarting ovnfs", async () => {
  const logs = [];
  const { probe, calls } = fakeProbe([
    { state: "ok", stdout: ".\n..\n.hidden\nrobob-1\n" },
    { state: "ok", stdout: "" },
  ]);
  let restarted = false;
  const result = await hostPreflight({
    checkoutsDir: "/c",
    probe,
    restart: async () => (restarted = true),
    uState: async () => [{ pid: 7, stat: "U", command: "git" }],
    log: async (phase, extra) => logs.push([phase, extra]),
  });
  NodeAssert.equal(result.restarted, false);
  NodeAssert.equal(restarted, false);
  // Root first, then one checkout inside it (lookups inside hung on 10 Nov).
  NodeAssert.deepEqual(calls, ["/c", "/c/robob-1"]);
  const u = logs.find(([phase]) => phase === "host_preflight_u_state");
  NodeAssert.equal(u[1].count, 1);
  NodeAssert.equal(u[1].processes[0].pid, 7);
});

NodeTest.test("host preflight restarts ovnfs once for a hung checkout and continues when it answers", async () => {
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
  NodeAssert.equal(restarts, 1);
  NodeAssert.equal(result.restarted, true);
  NodeAssert.ok(logs.includes("host_preflight_ovnfs_restart"));
});

NodeTest.test("host preflight aborts before the quit when the mount still hangs after the restart", async () => {
  const hang = { state: "hang", timeoutMs: 10_000 };
  const { probe } = fakeProbe([hang, hang, hang, hang]);
  let restarts = 0;
  await NodeAssert.rejects(
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
  NodeAssert.equal(restarts, 1);
});

NodeTest.test("host preflight refuses a hung mount when no ovnfs restart is available", async () => {
  const { probe } = fakeProbe([{ state: "hang", timeoutMs: 10 }]);
  await NodeAssert.rejects(
    hostPreflight({ checkoutsDir: "/c", probe, uState: async () => [], log: async () => {} }),
    /not quitting Robob/,
  );
});

NodeTest.test("host preflight tolerates a missing ~/checkouts", async () => {
  const { probe } = fakeProbe([{ state: "absent" }]);
  const result = await hostPreflight({
    checkoutsDir: "/c",
    probe,
    uState: async () => [],
    log: async () => {},
  });
  NodeAssert.equal(result.result.state, "absent");
});

NodeTest.test("a failed host preflight stops the install before the cancel window and quit", async () => {
  const calls = [];
  const ops = Object.fromEntries(
    [
      "stage",
      "verify",
      "migrations",
      "cancelWindow",
      "quit",
      "backup",
      "swap",
      "launch",
      "readReady",
      "report",
      "phase",
    ].map((name) => [name, async () => calls.push(name)]),
  );
  ops.hostPreflight = async () => {
    calls.push("hostPreflight");
    throw new Error("still hangs");
  };
  await NodeAssert.rejects(install(ops), /still hangs/);
  NodeAssert.deepEqual(calls, ["stage", "verify", "migrations", "hostPreflight"]);
});

NodeTest.test("probeDirectory reports a real directory, a missing one, and a hang", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "probe-test-"));
  try {
    await NodeFSP.mkdir(NodePath.join(root, "x"));
    const ok = await probeDirectory(root, 5000);
    NodeAssert.equal(ok.state, "ok");
    NodeAssert.match(ok.stdout, /\bx\b/);
    NodeAssert.equal((await probeDirectory(NodePath.join(root, "missing"), 5000)).state, "absent");
    // A stand-in for a lookup stuck on a hung mount: a command that outlives the timeout.
    const hung = await probeDirectory(root, 200, ["/bin/sleep", ["30"]]);
    NodeAssert.equal(hung.state, "hang");
    NodeAssert.equal(hung.timeoutMs, 200);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

NodeTest.test("uStateProcesses keeps only U-state rows", async () => {
  const rows = await uStateProcesses(async () => ({
    stdout:
      "  1 Ss   /sbin/launchd\n5646 U    /Applications/Robob.app/Contents/MacOS/Robob\n 77 U+   git\n",
  }));
  NodeAssert.deepEqual(
    rows.map((r) => r.pid),
    [5646, 77],
  );
});

NodeTest.test("failure relaunch waits for the old server to exit before reopening the app", async () => {
  const logs = [];
  let checks = 0;
  let launched = 0;
  let clock = 0;
  const ok = await relaunchAfterFailure({
    survivors: async () => (++checks < 4 ? [{ pid: 5646 }] : []),
    launch: async () => {
      NodeAssert.equal(checks, 4, "launch only after the survivor is gone");
      launched++;
    },
    log: async (phase) => logs.push(phase),
    sleep: async (ms) => (clock += ms),
    now: () => clock,
  });
  NodeAssert.equal(ok, true);
  NodeAssert.equal(launched, 1);
  NodeAssert.ok(logs.includes("relaunch_waiting"));
});

NodeTest.test("failure relaunch never reopens beside a survivor and alerts instead", async () => {
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
  NodeAssert.equal(ok, false);
  NodeAssert.equal(launched, false);
  NodeAssert.match(notes[0], /NOT relaunched.*5646/);
});

NodeTest.test("failure relaunch treats an unreadable process table as still running", async () => {
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
  NodeAssert.equal(ok, false);
  NodeAssert.equal(launched, false);
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

NodeTest.test("a stale Robob staging bundle is moved aside, removed and logged", async () => {
  const { deps, calls } = stagingDeps();
  NodeAssert.equal(await clearStaleStaging(deps), "removed");
  NodeAssert.deepEqual(
    calls.map((c) => c[0]),
    ["stale_staging_found", "rename", "remove", "stale_staging_removed"],
  );
  NodeAssert.equal(calls[1][2], "/A/.Robob.next.app.stale-s1");
});

NodeTest.test("a partial staging copy (Contents only, no Info.plist) counts as stale", async () => {
  const { deps } = stagingDeps({
    readBundleId: async () => {
      throw new Error("no Info.plist");
    },
  });
  NodeAssert.equal(await clearStaleStaging(deps), "removed");
});

NodeTest.test("no staging bundle means nothing to do", async () => {
  const { deps, calls } = stagingDeps({ exists: async () => false });
  NodeAssert.equal(await clearStaleStaging(deps), "absent");
  NodeAssert.equal(calls.length, 0);
});

for (const [name, overrides, message] of [
  ["another app", { readBundleId: async () => "com.example.other" }, /not a Robob staging bundle/],
  [
    "unknown content",
    { readBundleId: async () => undefined, topLevel: async () => ["Contents", "evil"] },
    /not a Robob staging bundle/,
  ],
  [
    "a running installer",
    { otherInstallers: async () => [4242] },
    /Another installer is running \(pid 4242\)/,
  ],
  [
    "a process running from it",
    { runningFrom: async () => [{ pid: 99 }] },
    /Processes run from .* \(pid 99\)/,
  ],
])
  NodeTest.test(`staging bundle is kept when it has ${name}`, async () => {
    const { deps, calls } = stagingDeps(overrides);
    await NodeAssert.rejects(clearStaleStaging(deps), message);
    NodeAssert.ok(!calls.some((c) => c[0] === "rename" || c[0] === "remove"));
  });

NodeTest.test("installer and process-path parsers", () => {
  const ps = [
    "100 /usr/local/bin/node /x/apps/desktop/scripts/install-robob-fast.mjs --dmg /a.dmg",
    "101 node /x/install-robob-fast.mjs --dry-run",
    "102 tmux -L robob-install new-session -d -s install-1 zsh /x/install-robob-fast.zsh --dmg /a.dmg",
    "103 /usr/local/bin/node /x/install-robob-fast.mjs --dmg /b.dmg",
  ].join("\n");
  NodeAssert.deepEqual(otherInstallerPids(ps, 103), [100]);
  const comm = "5 /A/.Robob.next.app/Contents/MacOS/Robob\n6 /A/Robob.app/Contents/MacOS/Robob\n";
  NodeAssert.deepEqual(pidsRunningFrom(comm, "/A/.Robob.next.app"), [{ pid: 5 }]);
  NodeAssert.deepEqual(pidsRunningFrom(comm, "/A/Robob.app"), [{ pid: 6 }]);
});

NodeTest.test("readiness polls reject on every failure and never use global fetch", async () => {
  const hits = [];
  const server = NodeHttp.createServer((req, res) => {
    hits.push(req.headers.authorization);
    if (req.url === "/ok") {
      res.setHeader("content-type", "application/json");
      return res.end('{"bootId":"b1"}');
    }
    if (req.url === "/bad") {
      res.statusCode = 503;
      return res.end("starting");
    }
    if (req.url === "/text") return res.end("not json");
    if (req.url === "/moved") {
      res.statusCode = 302;
      res.setHeader("location", "/ok");
      return res.end();
    }
    if (req.url === "/loop") {
      res.statusCode = 307;
      res.setHeader("location", "/loop");
      return res.end();
    }
    if (req.url === "/elsewhere") {
      res.statusCode = 302;
      res.setHeader("location", `http://127.0.0.1:${other.address().port}/ok`);
      return res.end();
    }
    if (req.url === "/malformed") {
      // A URL that parses but that node:http refuses to request.
      res.statusCode = 302;
      res.setHeader("location", `http://bad%ZZ@127.0.0.1:${server.address().port}/ok`);
      return res.end();
    }
    if (req.url === "/trickle") {
      // Bytes arrive faster than any inactivity timeout, and the reply never ends.
      res.setHeader("content-type", "application/json");
      const timer = setInterval(() => res.write(" "), 10);
      res.on("close", () => {
        clearInterval(timer);
        trickleClosed = true;
      });
      return;
    }
    if (req.url === "/huge") {
      res.setHeader("content-type", "application/json");
      return res.end(`"${"x".repeat(1024 * 1024 + 1)}"`);
    }
    // "/slow" never answers.
  });
  let trickleClosed = false;
  // Another origin (same host, other port) that the first one redirects to.
  const otherHits = [];
  const other = NodeHttp.createServer((req, res) => {
    otherHits.push(req.headers.authorization);
    res.setHeader("content-type", "application/json");
    res.end('{"bootId":"b2"}');
  });
  await new Promise((resolve) => other.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  try {
    NodeAssert.deepEqual(await getJson(`${origin}/ok`, { headers: { authorization: "Bearer t" } }), {
      bootId: "b1",
    });
    NodeAssert.deepEqual(hits, ["Bearer t"]);
    await NodeAssert.rejects(getJson(`${origin}/bad`), /HTTP 503/);
    await NodeAssert.rejects(getJson(`${origin}/text`), SyntaxError);
    await NodeAssert.rejects(getJson(`${origin}/slow`, { timeoutMs: 50 }), /timed out/);
    // The deadline bounds the whole exchange: a reply that keeps trickling still ends,
    // and its connection is closed.
    const trickleStarted = Date.now();
    await NodeAssert.rejects(getJson(`${origin}/trickle`, { timeoutMs: 80 }), /timed out/);
    NodeAssert.ok(Date.now() - trickleStarted < 1000);
    for (let i = 0; i < 50 && !trickleClosed; i++) await new Promise((ok) => setTimeout(ok, 10));
    NodeAssert.equal(trickleClosed, true);
    await NodeAssert.rejects(getJson(`${origin}/huge`), /too large/);
    // Redirects are followed as fetch followed them, within a bound; the credential goes
    // only to the origin it was given for.
    hits.length = 0;
    NodeAssert.deepEqual(await getJson(`${origin}/moved`, { headers: { authorization: "Bearer t" } }), {
      bootId: "b1",
    });
    NodeAssert.deepEqual(hits, ["Bearer t", "Bearer t"]);
    hits.length = 0;
    NodeAssert.deepEqual(
      await getJson(`${origin}/elsewhere`, { headers: { authorization: "Bearer t" } }),
      { bootId: "b2" },
    );
    NodeAssert.deepEqual([hits, otherHits], [["Bearer t"], [undefined]]);
    await NodeAssert.rejects(getJson(`${origin}/loop`), /Too many redirects/);
    // A redirect node:http cannot request rejects the poll; it used to throw from the
    // response callback and end the process.
    await NodeAssert.rejects(getJson(`${origin}/malformed`), URIError);
  } finally {
    server.closeAllConnections();
    other.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => other.close(resolve));
  }
  // The server is gone: what the installer polls right after launching the new app.
  for (let i = 0; i < 20; i++) await NodeAssert.rejects(getJson(`${origin}/ok`), /ECONNREFUSED/);
  // Node 26.2's fetch crashed the installer from a socket callback; keep it out.
  const source = await NodeFSP.readFile(new URL("./install-robob-fast.mjs", import.meta.url), "utf8");
  NodeAssert.doesNotMatch(source.replace(/^\s*(\*|\/\/).*$/gm, ""), /\bfetch\(/);
});

NodeTest.test("the pre-quit migration check waits 10 minutes by default and takes an env override", () => {
  NodeAssert.equal(migrationCheckTimeoutMs({}), 600_000);
  NodeAssert.equal(
    migrationCheckTimeoutMs({ ROBOB_INSTALL_MIGRATION_CHECK_TIMEOUT_MS: "900000" }),
    900_000,
  );
  NodeAssert.equal(migrationCheckTimeoutMs({ ROBOB_INSTALL_MIGRATION_CHECK_TIMEOUT_MS: "5" }), 600_000);
  NodeAssert.equal(
    migrationCheckTimeoutMs({ ROBOB_INSTALL_MIGRATION_CHECK_TIMEOUT_MS: "nope" }),
    600_000,
  );
});

NodeTest.test("clones only the live databases, never the pre-shrink copy", () => {
  const names = [
    "statev2.sqlite",
    "statev2.sqlite-wal",
    "statev2.sqlite-shm",
    "statev2.pre-shrink-20261105234934246.sqlite",
    "boards.sqlite",
    "boards.sqlite-wal",
    "boards.sqlite.pre-ledger14",
    "archive.sqlite",
  ];
  NodeAssert.deepEqual(
    names.filter((n) => INSTALL_DATABASE_FILE.test(n)),
    ["statev2.sqlite", "statev2.sqlite-wal", "boards.sqlite", "boards.sqlite-wal"],
  );
});

NodeTest.test("prunes old backups only after the report, and a prune failure does not fail the install", async () => {
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
    ].map((name) => [name, async () => calls.push(name)]),
  );
  ops.phase = async (p, extra) => calls.push(extra?.error ? `${p}:${extra.error}` : p);
  ops.prune = async () => {
    calls.push("prune");
    throw new Error("rm failed");
  };
  await install(ops);
  NodeAssert.deepEqual(calls.slice(-4), ["ready", "report", "prune", "prune_failed:Error: rm failed"]);
  NodeAssert.ok(calls.indexOf("backup") < calls.indexOf("swap"));
});

const backupStamp = (day) => `2026-11-${String(day).padStart(2, "0")}T12-00-00.000Z`;
const pruneOutcomes = (events) => events.filter(({ name }) =>
  ["backups_pruned", "prune_failed", "prune_skipped"].includes(name));

async function backupFixture(t) {
  const backupRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "robob-backup-retention-"));
  t.after(() => NodeFSP.rm(backupRoot, { recursive: true, force: true }));
  const events = [];
  const phase = async (name, details = {}) => events.push({ name, ...details });
  const put = async (name, { marked = true, pinned = false, database = "backup" } = {}) => {
    const directory = NodePath.join(backupRoot, name);
    await NodeFSP.mkdir(directory);
    if (database !== null) await NodeFSP.writeFile(NodePath.join(directory, "statev2.sqlite"), database);
    if (marked) await NodeFSP.writeFile(NodePath.join(directory, ".complete"), "{}");
    if (pinned) await NodeFSP.writeFile(NodePath.join(directory, ".pinned"), "{}");
  };
  return { backupRoot, events, phase, put, names: async () => (await NodeFSP.readdir(backupRoot)).sort() };
}

NodeTest.test("clone completion marker is synced only after the clone succeeds", async (t) => {
  const { backupRoot } = await backupFixture(t);
  const stamp = backupStamp(1);
  const order = [];
  const io = {
    ...NodeFSP,
    open: async (...args) => {
      order.push("open marker");
      const handle = await NodeFSP.open(...args);
      return {
        writeFile: (value) => handle.writeFile(value),
        sync: async () => { order.push("sync"); await handle.sync(); },
        close: async () => { order.push("close"); await handle.close(); },
      };
    },
  };
  await cloneBackup({ backupRoot, stamp, fs: io, clone: async (destination) => {
    await NodeFSP.mkdir(destination);
    await NodeFSP.writeFile(NodePath.join(destination, "statev2.sqlite"), "backup");
    order.push("cloned");
    return ["statev2.sqlite"];
  } });
  const marker = JSON.parse(await NodeFSP.readFile(NodePath.join(backupRoot, stamp, ".complete"), "utf8"));
  NodeAssert.deepEqual(order, ["cloned", "open marker", "sync", "close"]);
  NodeAssert.equal(marker.stamp, stamp);
  NodeAssert.deepEqual(marker.files, ["statev2.sqlite"]);
  NodeAssert.ok(Number.isFinite(Date.parse(marker.completedAt)));
});

for (const failedAt of ["clone", "sync"]) {
  NodeTest.test(`a ${failedAt} failure leaves a partial clone, never a completed timestamp dir`, async (t) => {
    const { backupRoot, names } = await backupFixture(t);
    const stamp = backupStamp(1);
    const failure = new Error(`${failedAt} failed`);
    let closed = false;
    const io = { ...NodeFSP, open: async (...args) => {
      const handle = await NodeFSP.open(...args);
      return {
        writeFile: (value) => handle.writeFile(value),
        sync: async () => { throw failure; },
        close: async () => { closed = true; await handle.close(); },
      };
    } };
    await NodeAssert.rejects(cloneBackup({ backupRoot, stamp, fs: io, clone: async (destination) => {
      await NodeFSP.mkdir(destination);
      await NodeFSP.writeFile(NodePath.join(destination, "statev2.sqlite"), "half cloned");
      if (failedAt === "clone") throw failure;
      return ["statev2.sqlite"];
    } }), (error) => error === failure);
    NodeAssert.deepEqual(await names(), [`partial-${stamp}`]);
    NodeAssert.equal(closed, failedAt === "sync");
  });
}

NodeTest.test("prune keeps two marked backups and removes older, partial and interrupted clones", async (t) => {
  const f = await backupFixture(t);
  for (let i = 1; i <= 5; i++) await f.put(backupStamp(i));
  await f.put(backupStamp(6), { marked: false });
  const partial = `partial-${backupStamp(7)}`;
  await f.put(partial, { marked: false });
  await pruneBackups({ ...f, currentStamp: backupStamp(6), trigger: "ready" });
  NodeAssert.deepEqual(await f.names(), [backupStamp(4), backupStamp(5)]);
  NodeAssert.deepEqual(f.events, [
    { name: "prune_started", trigger: "ready" },
    { name: "backups_pruned", trigger: "ready",
      removed: [partial, backupStamp(6), backupStamp(3), backupStamp(2), backupStamp(1)],
      kept: [backupStamp(5), backupStamp(4)], pinned: [], incomplete: [partial, backupStamp(6)] },
  ]);
});

for (const markedBoundary of [false, true]) {
  NodeTest.test(`legacy backups need a nonempty database${markedBoundary ? " and must precede the oldest marker" : " before any markers exist"}`, async (t) => {
    const f = await backupFixture(t);
    await f.put(backupStamp(1), { marked: false });
    await f.put(backupStamp(2), { marked: false });
    await f.put(backupStamp(3), { marked: false });
    await f.put(backupStamp(4), { marked: false, database: "" });
    await f.put(backupStamp(5), { marked: false, database: null });
    if (markedBoundary) {
      await f.put(backupStamp(6));
      await f.put(backupStamp(7), { marked: false });
    }
    await pruneBackups({ ...f, trigger: "ready" });
    NodeAssert.deepEqual(await f.names(), markedBoundary
      ? [backupStamp(3), backupStamp(6)] : [backupStamp(2), backupStamp(3)]);
    NodeAssert.deepEqual(f.events.at(-1).incomplete,
      (markedBoundary ? [7, 5, 4] : [5, 4]).map(backupStamp));
  });
}

for (const pinnedDay of [1, 5]) {
  NodeTest.test(`pinned backup ${pinnedDay} survives without using either retention slot`, async (t) => {
    const f = await backupFixture(t);
    for (let i = 1; i <= 5; i++) await f.put(backupStamp(i), { pinned: i === pinnedDay });
    await pruneBackups({ ...f, trigger: "ready" });
    NodeAssert.deepEqual(await f.names(), (pinnedDay === 1 ? [1, 4, 5] : [3, 4, 5]).map(backupStamp));
    NodeAssert.deepEqual(f.events.at(-1).pinned, [backupStamp(pinnedDay)]);
  });
}

NodeTest.test("current usable backup survives even when older than the two retention slots", async (t) => {
  const f = await backupFixture(t);
  for (let i = 1; i <= 4; i++) await f.put(backupStamp(i));
  await pruneBackups({ ...f, currentStamp: backupStamp(1), trigger: "ready" });
  NodeAssert.deepEqual(await f.names(), [1, 3, 4].map(backupStamp));
});

NodeTest.test("zero usable backups preserves timestamps and pins, removing only unpinned partials", async (t) => {
  const f = await backupFixture(t);
  await f.put(backupStamp(1), { marked: false, database: "" });
  await f.put(backupStamp(2), { marked: false, database: null });
  const partial = `partial-${backupStamp(3)}`;
  const pinned = `partial-${backupStamp(4)}`;
  await f.put(partial, { marked: false });
  await f.put(pinned, { marked: false, pinned: true });
  await pruneBackups({ ...f, trigger: "relaunched" });
  NodeAssert.deepEqual(await f.names(), [backupStamp(1), backupStamp(2), pinned]);
  NodeAssert.equal(f.events.at(-1).reason, "no_usable_backup");
  NodeAssert.deepEqual(f.events.at(-1).removed, [partial]);
  NodeAssert.deepEqual(f.events.at(-1).pinned, [pinned]);
  NodeAssert.equal(pruneOutcomes(f.events).length, 1);
});

NodeTest.test("missing backup root skips retention after a pre-backup relaunch", async (t) => {
  const f = await backupFixture(t);
  await pruneBackups({ ...f, backupRoot: NodePath.join(f.backupRoot, "missing"), trigger: "relaunched" });
  NodeAssert.equal(f.events.at(-1).reason, "no_usable_backup");
});

async function recoveryFixture(t, { failAt, holdFails = false, releaseFails = false, pruneFails = false } = {}) {
  const f = await backupFixture(t);
  for (let i = 1; i <= 3; i++) await f.put(backupStamp(i));
  const currentStamp = backupStamp(4);
  const failure = new Error("Install exceeded the 3 minute limit");
  const io = { ...NodeFSP, rm: async (...args) => {
    if (pruneFails && args[1]?.recursive) throw new Error("rm failed");
    return NodeFSP.rm(...args);
  } };
  const retention = createBackupRetention({ ...f, currentStamp, fs: io });
  let quitStarted = false;
  let backupDone = false;
  let swapped = false;
  let healthCalls = 0;
  const ops = Object.fromEntries(["stage", "verify", "migrations", "hostPreflight", "cancelWindow",
    "launch", "readReady", "report"].map((name) => [name, async () => {
      if (failAt === name) throw failure;
    }]));
  Object.assign(ops, {
    phase: f.phase,
    quit: async () => { quitStarted = true; },
    backup: async () => {
      await cloneBackup({ ...f, stamp: currentStamp, clone: async (destination) => {
        await NodeFSP.mkdir(destination);
        await NodeFSP.writeFile(NodePath.join(destination, "statev2.sqlite"), "backup");
        return ["statev2.sqlite"];
      } });
      backupDone = true;
    },
    swap: async () => {
      if (failAt === "swap") throw failure;
      swapped = true;
    },
    prune: () => retention.prune("ready"),
  });
  const run = async () => {
    let installFailure;
    try {
      await install(ops);
    } catch (error) {
      installFailure = error;
      if (backupDone || swapped) await retention.pin(error);
      throw error;
    } finally {
      await retention.finish({
        failure: installFailure, swapped, quitStarted,
        release: async () => {
          if (releaseFails) throw new Error("hold release failed");
          await f.phase("hold_released");
        },
        healthy: async () => ++healthCalls > 1,
        onWaiting: () => f.phase("recovery_waiting"),
        sleep: async () => { if (holdFails) throw new Error("recovery interrupted"); },
      });
    }
  };
  return { ...f, run, failure, currentStamp, retention };
}

for (const failAt of ["launch", "report", "swap"]) {
  NodeTest.test(`recovery after ${failAt} pins, releases, unpins then prunes once and preserves the install error`, async (t) => {
    const f = await recoveryFixture(t, { failAt });
    await NodeAssert.rejects(f.run(), (error) => error === f.failure);
    NodeAssert.deepEqual(f.events.filter(({ name }) => ["backup_pinned", "recovery_waiting", "hold_released",
      "backup_unpinned", "prune_started", "backups_pruned"].includes(name)).map(({ name }) => name),
    ["backup_pinned", "recovery_waiting", "hold_released", "backup_unpinned", "prune_started", "backups_pruned"]);
    NodeAssert.equal(f.events.at(-1).trigger, failAt === "swap" ? "relaunched" : "recovered");
    NodeAssert.deepEqual(await f.names(), [backupStamp(3), f.currentStamp]);
    NodeAssert.equal(pruneOutcomes(f.events).length, 1);
    await NodeAssert.rejects(NodeFSP.readFile(NodePath.join(f.backupRoot, f.currentStamp, ".pinned")), { code: "ENOENT" });
  });
}

NodeTest.test("an interrupted failed install leaves its rollback pinned through a later run's prune", async (t) => {
  const f = await recoveryFixture(t, { failAt: "launch", holdFails: true });
  await NodeAssert.rejects(f.run(), (error) => error === f.failure);
  NodeAssert.equal(f.events.at(-1).reason, "not_healthy");
  NodeAssert.equal(pruneOutcomes(f.events).length, 1);
  const pin = JSON.parse(await NodeFSP.readFile(NodePath.join(f.backupRoot, f.currentStamp, ".pinned"), "utf8"));
  NodeAssert.equal(pin.reason, "install_failed");
  NodeAssert.equal(pin.error, String(f.failure));
  for (let i = 5; i <= 8; i++) await f.put(backupStamp(i));
  await pruneBackups({ ...f, currentStamp: backupStamp(8), trigger: "ready" });
  NodeAssert.deepEqual(await f.names(), [4, 7, 8].map(backupStamp));
  NodeAssert.deepEqual(f.events.at(-1).pinned, [f.currentStamp]);
});

NodeTest.test("failure before quit releases the hold and logs one reasoned skip", async (t) => {
  const f = await recoveryFixture(t, { failAt: "verify" });
  await NodeAssert.rejects(f.run(), (error) => error === f.failure);
  NodeAssert.deepEqual(f.events, [
    { name: "hold_released" }, { name: "prune_skipped", reason: "failed_before_quit" },
  ]);
  NodeAssert.deepEqual(await f.names(), [1, 2, 3].map(backupStamp));
});

NodeTest.test("a failed hold release preserves the rollback pin and original install error", async (t) => {
  const f = await recoveryFixture(t, { failAt: "launch", releaseFails: true });
  await NodeAssert.rejects(f.run(), (error) => error === f.failure);
  NodeAssert.deepEqual(pruneOutcomes(f.events), [
    { name: "prune_skipped", reason: "not_healthy", error: "Error: hold release failed" },
  ]);
  NodeAssert.equal(f.events.some(({ name }) => name === "backup_unpinned"), false);
  NodeAssert.equal(f.events.some(({ name }) => name === "prune_started"), false);
  NodeAssert.equal(JSON.parse(await NodeFSP.readFile(NodePath.join(f.backupRoot, f.currentStamp, ".pinned"), "utf8")).reason,
    "install_failed");
});

for (const failAt of [undefined, "launch"]) {
  NodeTest.test(`a prune failure logs once and preserves ${failAt ? "the install error" : "success"}`, async (t) => {
    const f = await recoveryFixture(t, { failAt, pruneFails: true });
    if (failAt) await NodeAssert.rejects(f.run(), (error) => error === f.failure);
    else await f.run();
    NodeAssert.deepEqual(pruneOutcomes(f.events), [
      { name: "prune_failed", trigger: failAt ? "recovered" : "ready", error: "Error: rm failed" },
    ]);
    NodeAssert.equal(f.events.filter(({ name }) => name === "prune_started").length, 1);
  });
}

NodeTest.test("normal install still prunes once after report with the ready trigger", async (t) => {
  const f = await recoveryFixture(t);
  await f.run();
  NodeAssert.deepEqual(pruneOutcomes(f.events).map(({ name, trigger }) => ({ name, trigger })),
    [{ name: "backups_pruned", trigger: "ready" }]);
  NodeAssert.deepEqual(await f.names(), [backupStamp(3), f.currentStamp]);
  NodeAssert.equal(f.events.filter(({ name }) => name === "prune_started").length, 1);
});
