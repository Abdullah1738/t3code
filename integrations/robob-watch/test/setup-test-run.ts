import { afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Card #14: the shared bun test setup. Marks the process as a test run so the send guards refuse real
// WhatsApp, email, iMessage and Telegram sends. Child processes spawned by a test inherit this env, so an
// ordinary fixture that forgets its send stub is refused instead of reaching the live app.
process.env.ROBOB_TEST = "1";

const logRoot = mkdtempSync(join(tmpdir(), "watchers-test-logs-"));
process.env.TOOLLOG_DIR = logRoot;
// Destination guard tests provide their own config; ordinary fixtures must not read live chat routing.
if (!process.env.SPECTRUM_BRIDGE_CONFIG) {
  process.env.SPECTRUM_BRIDGE_CONFIG = join(logRoot, "bridge-config.json");
  writeFileSync(process.env.SPECTRUM_BRIDGE_CONFIG, JSON.stringify({ chatBackends: {} }));
}
afterAll(() => rmSync(logRoot, { recursive: true, force: true }));
