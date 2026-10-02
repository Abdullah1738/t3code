import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../src/lock.ts";

test("kernel lock rejects another open and is releasable without deleting the inode", () => {
  const dir = mkdtempSync(join(tmpdir(), "spectrum-lock-"));
  const path = join(dir, "lock");
  try {
    const release = acquireLock(path);
    expect(() => acquireLock(path)).toThrow("already running");
    release();
    release();
    acquireLock(path)();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lock refuses symlinks", () => {
  const dir = mkdtempSync(join(tmpdir(), "spectrum-lock-"));
  try {
    const path = join(dir, "link");
    symlinkSync(join(dir, "target"), path);
    expect(() => acquireLock(path)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
