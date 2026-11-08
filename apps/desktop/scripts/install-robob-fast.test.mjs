import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { checkSignature, install } from "./install-robob-fast.mjs";

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
