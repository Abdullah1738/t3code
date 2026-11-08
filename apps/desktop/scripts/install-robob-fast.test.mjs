import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { install } from "./install-robob-fast.mjs";

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
    assert.deepEqual(events.slice(0, 7), [
      "stage",
      "verify",
      "migrations",
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
    if (["stage", "verify", "migrations", "cancelWindow"].includes(failed))
      assert.ok(!calls.includes("quit"));
  });
}

test("rollback verifies the previous bundle and schema compatibility before quitting", async () => {
  const calls = [];
  const ops = Object.fromEntries(
    [
      "verifyPrevious",
      "migrations",
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
