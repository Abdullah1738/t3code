import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import { acquireInstallHold } from "./robob-install-hold.mjs";
import { main } from "./install-robob-fast.mjs";

for (const [reason, code, args] of [
  ["another live installer owns the hold", "EBUSY", []],
  ["another live installer owns the hold", "EBUSY", ["--rollback"]],
  ["the hold helper cannot execute", "EACCES", []],
  ["the hold helper cannot execute", "EACCES", ["--rollback"]],
]) {
  NodeTest.test(`main logs one pre-quit skip when ${reason}${args.length ? " during rollback" : ""}`, async (t) => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "robob-hold-acquire-"));
    t.after(() => NodeFSP.rm(home, { recursive: true, force: true }));
    await NodeFSP.mkdir(NodePath.join(home, ".robob/userdata"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(home, ".robob/components"));
    const foreignHold = NodePath.join(home, ".robob/install-hold.json");
    const originalHold = JSON.stringify({ by: "other-installer", pid: 12345 });
    await NodeFSP.writeFile(foreignHold, originalHold);
    const routes = [];
    const server = NodeHttp.createServer((request, response) => {
      routes.push(request.url);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ bootId: "old-boot" }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    await NodeFSP.writeFile(NodePath.join(home, ".robob/components/t3ctl.json"), JSON.stringify({
      url: `http://127.0.0.1:${server.address().port}`, token: "test-token",
    }));
    const events = [];
    const calls = [];
    const failure = Object.assign(new Error(reason), { code });
    await NodeAssert.rejects(main(args, {
      home,
      env: { TMUX: "test-session" },
      phase: async (name, details) => events.push({ name, ...details }),
      acquireHold: (options) => acquireInstallHold({ ...options, run: async (helper, args) => {
        NodeAssert.equal(helper, NodePath.join(home, ".local/bin/robob-install-hold"));
        calls.push(args[0]);
        throw failure;
      } }),
    }), (error) => error === failure);
    NodeAssert.deepEqual(calls, ["start"]);
    NodeAssert.equal(await NodeFSP.readFile(foreignHold, "utf8"), originalHold);
    NodeAssert.deepEqual(routes, ["/api/ardud/control/install-report"]);
    NodeAssert.deepEqual(events, [
      { name: "install_started", readyBudgetS: 180 },
      { name: "failed", error: String(failure), swapped: false },
      { name: "prune_skipped", reason: "failed_before_quit" },
    ]);
    NodeAssert.equal(events.filter(({ name }) =>
      ["backups_pruned", "prune_failed", "prune_skipped"].includes(name)).length, 1);
  });
}
