import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

let testRoot: string | undefined;

export function logDirectory(tool: "imessage" | "watchers"): string {
  if (process.env.TOOLLOG_DIR) return process.env.TOOLLOG_DIR;
  // Bun replaces argv's "test" subcommand with the first test file, even with NODE_ENV=production.
  const bunTest = process.versions.bun && /(?:\.(?:test|spec)|_(?:test|spec))\.[cm]?[jt]sx?$/.test(process.argv[1] ?? "");
  if (process.env.NODE_ENV === "test" || process.env.ROBOB_TEST || bunTest) {
    testRoot ??= mkdtempSync(join(tmpdir(), "bridge-test-logs-"));
    // CLI subprocesses must inherit the isolation even when the package preload was bypassed.
    return process.env.TOOLLOG_DIR = join(testRoot, tool);
  }
  return join(homedir(), ".robob/logs/tools", tool);
}
