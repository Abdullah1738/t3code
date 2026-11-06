import { beforeAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Generic Linux test boxes lack zsh; exercise this macOS installer on the Mac
// with an isolated HOME rather than installing another shell just for the suite.
const hasZsh = spawnSync("zsh", ["--version"]).status === 0;
let root: string;
let repo: string;
let home: string;
function run(args: string[], cwd = repo) {
  const result = spawnSync(args[0], args.slice(1), { cwd, env: { ...process.env, HOME: home, BUN_INSPECT: "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8" });
  return { status: result.status, output: result.stdout + result.stderr };
}
const install = (...args: string[]) => run(["zsh", "integrations/opencode-plugins/install.zsh", ...args]);

beforeAll(() => {
  if (!hasZsh) return;
  root = mkdtempSync(join(tmpdir(), "codemode-install-"));
  repo = join(root, "repo");
  home = join(root, "home");
  mkdirSync(home);
  mkdirSync(repo);
  cpSync(resolve(import.meta.dir, ".."), join(repo, "integrations/opencode-plugins"), { recursive: true });
  for (const args of [
    ["git", "init", "-b", "main"],
    ["git", "config", "user.name", "Test"], ["git", "config", "user.email", "test@example.invalid"],
    ["git", "config", "commit.gpgsign", "false"],
    ["git", "add", "integrations/opencode-plugins"], ["git", "commit", "-m", "fixture"],
    ["git", "init", "--bare", join(root, "origin.git")],
    ["git", "remote", "add", "origin", join(root, "origin.git")],
  ]) expect(run(args).status).toBe(0);
});

test.skipIf(!hasZsh)("installer distinguishes missing files, unpushed work, drift and backups", () => {
  const check = install("--check");
  expect(check.status).toBe(1);
  expect(check.output).toContain("plugin/codemode-guard.ts not installed");
  expect(check.output).not.toContain("drift");
  expect(install("--dry-run").status).toBe(0);
  expect(existsSync(join(home, ".config"))).toBe(false);
  expect(install().status).toBe(1);
  expect(existsSync(join(home, ".config"))).toBe(false);
  expect(run(["git", "push", "origin", "main"]).status).toBe(0);
  const installed = install();
  expect(installed.status).toBe(0);
  expect(installed.output).toContain("needs an OpenCode restart");
  expect(install("--check").status).toBe(0);
  const plugin = join(home, ".config/opencode/plugin/codemode-guard.ts");
  expect(readFileSync(plugin, "utf8")).toBe(readFileSync(join(repo, "integrations/opencode-plugins/plugin/codemode-guard.ts"), "utf8"));
  expect(existsSync(join(home, ".config/opencode/lib/codemode-never-settles.mjs"))).toBe(true);
  writeFileSync(plugin, "old plugin");
  expect(install("--check").output).toContain("drift:");
  expect(install().status).toBe(0);
  const backups = readdirSync(join(home, ".config/opencode/plugin")).filter(name => name.startsWith("codemode-guard.ts.bak-"));
  expect(backups).toHaveLength(1);
  expect(readFileSync(join(home, ".config/opencode/plugin", backups[0]), "utf8")).toBe("old plugin");
  const source = join(repo, "integrations/opencode-plugins/plugin/codemode-guard.ts");
  writeFileSync(source, readFileSync(source, "utf8") + "\n// changed\n");
  expect(install().output).toContain("uncommitted changes");
  expect(run(["git", "add", "integrations/opencode-plugins"]).status).toBe(0);
  expect(run(["git", "commit", "-m", "unpushed"]).status).toBe(0);
  expect(install().output).toContain("not on origin/main");
});

test.skipIf(!hasZsh)("installed plugin loads its helper, logs a denial and reloads its off switch by mtime", () => {
  const script = `
    import { readFileSync, writeFileSync, utimesSync, unlinkSync } from 'node:fs';
    import { pathToFileURL } from 'node:url';
    const { default: plugin } = await import(pathToFileURL(process.env.HOME + '/.config/opencode/plugin/codemode-guard.ts'));
    let hook;
    await plugin.setup({tool:{hook:async (_, fn) => {hook = fn;}}});
    const cfg = process.env.HOME + '/.config/opencode/codemode-guard.json';
    const event = () => ({tool:'execute', sessionID:'ses_fixture', input:{code:'await new Promise(r=>r)'}});
    const denied = event(); await hook(denied);
    if (!denied.input.code.startsWith('throw new Error(')) throw Error('not denied');
    writeFileSync(cfg, JSON.stringify({mode:'off'}));
    utimesSync(cfg, 2000000000, 2000000000);
    const off = event(); await hook(off);
    if (off.input.code !== event().input.code) throw Error('off switch ignored');
    writeFileSync(cfg, JSON.stringify({mode:'enforce'}));
    utimesSync(cfg, 2000000001, 2000000001);
    const on = event(); await hook(on);
    if (on.input.code === event().input.code) throw Error('mtime reload missed');
    writeFileSync(cfg, '{bad json');
    utimesSync(cfg, 2000000002, 2000000002);
    const broken = event(); await hook(broken);
    if (broken.input.code !== event().input.code) throw Error('did not fail open');
    unlinkSync(cfg);
    const reset = event(); await hook(reset);
    if (reset.input.code === event().input.code) throw Error('config removal missed');
    console.log(readFileSync(process.env.HOME + '/.local/share/opencode-plugins/codemode-guard.jsonl','utf8'));
  `;
  const result = run([process.execPath, "-e", script]);
  expect(result.status).toBe(0);
  const records = result.output.trim().split("\n").map(line => JSON.parse(line));
  expect(records.filter(row => row.event === "deny")).toHaveLength(3);
  expect(records.filter(row => row.event === "hook-error")).toHaveLength(1);
  expect(records[0]).toMatchObject({ session: "ses_fixture", code: "await new Promise(r=>r)" });
});
