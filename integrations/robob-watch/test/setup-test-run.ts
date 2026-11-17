import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Card #14: the shared bun test setup. Marks the process as a test run so the send guards refuse real
// WhatsApp, email, iMessage and Telegram sends. Child processes spawned by a test inherit this env, so an
// ordinary fixture that forgets its send stub is refused instead of reaching the live app.
process.env.ROBOB_TEST = "1";

const logRoot = mkdtempSync(join(tmpdir(), "watchers-test-logs-"));
process.env.TOOLLOG_DIR = logRoot;
afterAll(() => rmSync(logRoot, { recursive: true, force: true }));
