// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { assert, describe, it } from "vite-plus/test";
import {
  classifyQuit,
  guardLaunchContext,
  previousQuit,
  readSmallJson,
} from "./desktopQuitContext.ts";

const now = Date.parse("2026-11-17T00:00:00Z");
const request = {
  at: now - 1000,
  targetPid: 42,
  requesterPid: 12,
  initiator: "watchdog",
  reason: "overload-restart",
};
const base = {
  pid: 42,
  processStartedAt: now - 60_000,
  now,
  trigger: "before-quit",
  native: { osShutdownInProgress: false },
};

describe("quit attribution", () => {
  it.each([
    ["unattributed AppleEvent", {}, "unknown"],
    ["menu", { trigger: "menu" }, "menu/user"],
    ["menu during a tool request", { trigger: "menu", toolRequest: request }, "menu/user"],
    [
      "Dock",
      {
        native: {
          osShutdownInProgress: false,
          appleEventSenderBundleId: "com.apple.dock",
          appleEventSenderPid: 9,
        },
      },
      "menu/user",
    ],
    [
      "osascript without handoff",
      {
        native: {
          osShutdownInProgress: false,
          appleEventSenderBundleId: "com.apple.osascript",
          appleEventSenderPid: 9,
        },
      },
      "unknown",
    ],
    ["shutdown", { native: { osShutdownInProgress: true }, toolRequest: request }, "os-shutdown"],
    [
      "loginwindow",
      {
        native: { osShutdownInProgress: false, appleEventSenderBundleId: "com.apple.loginwindow" },
      },
      "os-shutdown",
    ],
    ["updater", { trigger: "quitAndInstall" }, "installer"],
    [
      "updater during a tool request",
      { trigger: "quitAndInstall", toolRequest: request },
      "installer",
    ],
    [
      "Dock during a tool request",
      {
        toolRequest: request,
        native: { osShutdownInProgress: false, appleEventSenderBundleId: "com.apple.dock" },
      },
      "menu/user",
    ],
    ["IPC", { trigger: "ipc-relaunch" }, "unknown"],
    ["signal", { trigger: "signal", signalParent: { pid: 1, name: "launchd" } }, "signal"],
    ["watchdog", { toolRequest: request }, "watchdog"],
    ["watchdog signal fallback", { toolRequest: request, trigger: "signal" }, "watchdog"],
    ["installer", { toolRequest: { ...request, initiator: "installer" } }, "installer"],
    ["guard", { toolRequest: { ...request, initiator: "guard" } }, "guard"],
    ["wrong PID", { toolRequest: { ...request, targetPid: 43 } }, "unknown"],
    ["reused PID", { toolRequest: { ...request, at: base.processStartedAt - 1 } }, "unknown"],
    [
      "expired",
      { toolRequest: { ...request, at: now - 90_001 }, processStartedAt: now - 100_000 },
      "unknown",
    ],
    ["future", { toolRequest: { ...request, at: now + 1 } }, "unknown"],
    ["unknown tool", { toolRequest: { ...request, initiator: "shell" } }, "unknown"],
    ["missing reason", { toolRequest: { ...request, reason: "" } }, "unknown"],
    ["bad requester", { toolRequest: { ...request, requesterPid: -1 } }, "unknown"],
    ["non-object", { toolRequest: [] }, "unknown"],
  ] as const)("%s", (_name, input, expected) => {
    assert.equal(classifyQuit({ ...base, ...input }).initiator, expected);
  });

  it("retains sender, restart reason and signal parent as separate evidence", () => {
    const native = {
      osShutdownInProgress: false,
      appleEventSenderPid: 19,
      appleEventSenderBundleId: "com.apple.osascript",
    };
    const signalParent = { pid: 1, name: "launchd" };
    assert.deepEqual(
      classifyQuit({ ...base, trigger: "signal", native, signalParent, toolRequest: request }),
      {
        ...native,
        signalParent,
        initiator: "watchdog",
        restartReason: "overload-restart",
        requesterPid: 12,
      },
    );
  });

  it("reads the real Python tool handoff and rejects it for another process", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quit-handoff-"));
    try {
      const script = NodeURL.fileURLToPath(
        new URL("../../../integrations/robob-guard/quit_reason.py", import.meta.url),
      );
      NodeChildProcess.execFileSync("python3", [
        "-I",
        "-c",
        "import sys; from pathlib import Path; sys.path.insert(0, sys.argv[1]); from quit_reason import write_reason; write_reason(Path(sys.argv[2]), 'installer', 'release .13', 12, 42)",
        NodePath.dirname(script),
        home,
      ]);
      const toolRequest = readSmallJson(
        NodePath.join(home, ".robob/userdata/logs/desktop-quit-request.json"),
      );
      const current = Date.now();
      assert.equal(
        classifyQuit({ ...base, now: current, processStartedAt: current - 60_000, toolRequest })
          .initiator,
        "installer",
      );
      assert.equal(
        classifyQuit({ ...base, pid: 43, now: current, toolRequest }).initiator,
        "unknown",
      );
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("carries only a quit since the previous boot, with bounded whitelisted fields", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "previous-quit-"));
    const file = NodePath.join(dir, "desktop-last-quit.json");
    try {
      NodeFS.writeFileSync(
        file,
        JSON.stringify({
          at: new Date(now - 1000).toISOString(),
          pid: 42,
          trigger: "signal",
          initiator: "watchdog",
          restartReason: "overload-restart",
          signalParent: { pid: 1, secret: "no" },
          secret: "no",
        }),
      );
      const quit = previousQuit(dir, now - 2000, now);
      assert.equal(quit?.initiator, "watchdog");
      assert.notInclude(JSON.stringify(quit), "secret");
      assert.isNull(previousQuit(dir, now, now + 1000));
      assert.isNull(previousQuit(dir, 0, now - 2000));
      NodeFS.writeFileSync(file, " ".repeat(16385));
      assert.isNull(previousQuit(dir, 0, now));
      NodeFS.writeFileSync(file, "{truncated");
      assert.isNull(previousQuit(dir, 0, now));
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not carry the guard's environment into a later restart", () => {
    assert.deepEqual(guardLaunchContext(`guard:${now - 1000}`, now - 2000, now), {
      initiator: "guard",
      requestedAt: new Date(now - 1000).toISOString(),
    });
    for (const value of [undefined, "guard", `guard:${now + 1}`, `guard:${now - 90_001}`])
      assert.isNull(guardLaunchContext(value, 0, now));
    assert.isNull(guardLaunchContext(`guard:${now - 1000}`, now, now + 1000));
  });
});
