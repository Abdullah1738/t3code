import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every fixture (including CLI subprocesses) writes away from the owner's day files.
const root = mkdtempSync(join(tmpdir(), "imessage-test-logs-"));
process.env.TOOLLOG_DIR = root;
process.env.NODE_ENV = "test";
afterAll(() => rmSync(root, { recursive: true, force: true }));
