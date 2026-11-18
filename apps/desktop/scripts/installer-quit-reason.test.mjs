import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { requestInstallerQuit } from "./install-robob-fast.mjs";

for (const rollback of [false, true]) {
  NodeTest.test(
    `installer writes a targeted reason before requesting quit (rollback=${rollback})`,
    async (t) => {
      const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "installer-quit-reason-"));
      t.after(() => NodeFSP.rm(home, { recursive: true, force: true }));
      const file = NodePath.join(home, ".robob/userdata/logs/desktop-quit-request.json");
      let called = false;
      await requestInstallerQuit({
        home,
        pid: 42,
        requesterPid: 12,
        now: 1000,
        rollback,
        run: async (command, args) => {
          NodeAssert.equal(command, "/usr/bin/osascript");
          NodeAssert.deepEqual(args, ["-e", 'tell application "Robob" to quit']);
          NodeAssert.deepEqual(JSON.parse(await NodeFSP.readFile(file, "utf8")), {
            at: 1000,
            targetPid: 42,
            requesterPid: 12,
            initiator: "installer",
            reason: rollback ? "release-rollback" : "release-install",
          });
          NodeAssert.equal((await NodeFSP.stat(file)).mode & 0o777, 0o600);
          called = true;
          throw new Error("AppleEvent failed; signal fallback still has the handoff");
        },
      });
      NodeAssert.equal(called, true);
      NodeAssert.equal(JSON.parse(await NodeFSP.readFile(file, "utf8")).targetPid, 42);
    },
  );
}

NodeTest.test("a failed reason write prevents the installer from sending a quit", async () => {
  let called = false;
  await NodeAssert.rejects(
    requestInstallerQuit({
      home: "/isolated",
      pid: 42,
      fs: {
        mkdir: async () => {},
        writeFile: async () => {
          throw new Error("disk full");
        },
      },
      run: async () => {
        called = true;
      },
    }),
    /disk full/,
  );
  NodeAssert.equal(called, false);
});
