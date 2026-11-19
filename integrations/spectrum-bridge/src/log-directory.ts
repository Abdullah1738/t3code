import { mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";

const LIVE_PACKAGE_ROOTS = [
  ".local/share/spectrum-bridge",
  // moni-box-runner/install.zsh installs the Store/Shares consumer on her box here.
  "person/agent/code/integrations/moni-box-runner",
];
let nonliveRoot: string | undefined;

function installedEntry(): boolean {
  try {
    const entry = realpathSync(process.argv[1] ?? "");
    return LIVE_PACKAGE_ROOTS.some(root => {
      try { return entry.startsWith(realpathSync(join(homedir(), root)) + sep); }
      catch { return false; }
    });
  } catch { return false; }
}

export function logDirectory(tool: "imessage" | "watchers"): string {
  if (process.env.TOOLLOG_DIR) return process.env.TOOLLOG_DIR;
  // Bun replaces argv's "test" subcommand with the first test file, even with NODE_ENV=production.
  const bunTest = process.versions.bun && /(?:\.(?:test|spec)|_(?:test|spec))\.[cm]?[jt]sx?$/.test(process.argv[1] ?? "");
  const test = process.env.NODE_ENV === "test" || process.env.ROBOB_TEST || bunTest;
  // Worktree scripts import production code; only installed live writers own the live day files.
  if (!test && installedEntry()) return join(homedir(), ".robob/logs/tools", tool);
  nonliveRoot ??= mkdtempSync(join(tmpdir(), test ? "bridge-test-logs-" : "bridge-nonlive-logs-"));
  // CLI subprocesses must inherit the isolation even when the package preload was bypassed.
  return process.env.TOOLLOG_DIR = join(nonliveRoot, tool);
}
