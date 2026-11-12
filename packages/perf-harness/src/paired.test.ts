// @effect-diagnostics nodeBuiltinImport:off - Exercises the CLI output ownership boundary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
test("paired controller refuses an existing ledger before appending or measuring", () => {
  const directory = mkdtempSync(tmpdir() + "/paired-ledger-");
  const ledger = directory + "/base.jsonl";
  writeFileSync(ledger, "retained evidence\n");
  try {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./paired.ts", import.meta.url)),
        "missing-fixture",
        "base",
        "missing-base",
        "candidate",
        "missing-candidate",
        directory,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Output already contains a paired experiment/);
    assert.equal(readFileSync(ledger, "utf8"), "retained evidence\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
