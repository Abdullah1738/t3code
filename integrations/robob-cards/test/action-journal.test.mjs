import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("Swift widget action journal lifecycle and locking", { skip: process.platform !== "darwin" }, () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const source = ["../ios/Widgets/ActionJournal.swift", "./widget-client/ActionJournalTests.swift"]
    .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
    .join("\n");
  const directory = mkdtempSync(join(tmpdir(), "action-journal-tests-"));
  try {
    const workerSource = join(directory, "ActionJournalTests.swift");
    writeFileSync(workerSource, source);
    execFileSync("/usr/bin/swift", ["-"], {
      cwd: here,
      env: { ...process.env, ACTION_JOURNAL_TEST_SOURCE: workerSource },
      input: source,
      stdio: ["pipe", "inherit", "inherit"],
      timeout: 120_000,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
