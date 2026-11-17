import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

// Generic Linux test boxes lack zsh; exercise this macOS installer on the Mac
// with an isolated HOME rather than installing another shell just for the suite.
const hasZsh = spawnSync("zsh", ["--version"]).status === 0;
const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
const reloadDirectory = "integrations/local-helpers/libexec/opencode-reload";
const toollogDirectory = "integrations/local-helpers/libexec/toollog";
let root: string;
let repo: string;
let home: string;
let service: ReturnType<typeof spawn> | undefined;
function environment(overrides: NodeJS.ProcessEnv = {}) {
  return {
    ...process.env, HOME: home, ZDOTDIR: home, XDG_CONFIG_HOME: join(home, ".config"),
    PATH: join(root, "bin") + ":" + process.env.PATH, BUN_INSPECT: "",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", FIXTURE_GIT: realGit,
    FIXTURE_GIT_CALLS: join(root, "git-calls"), FIXTURE_FORBID_REMOTE: "",
    TOOLLOG_ROOT: join(home, "logs"), FIXTURE_PROBES: join(root, "probes"),
    OPENCODE_ALLOW_RELOAD: "", OPENCODE_RELOAD_WAIT: "0",
    OPENCODE_RELOAD_INSTANCES: '[{"name":"HOME","url":"http://127.0.0.1:1"},{"name":"BTSE","url":"http://127.0.0.1:1"}]',
    ...overrides,
  };
}
function run(args: string[], cwd = repo, overrides: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(args[0], args.slice(1), { cwd, env: environment(overrides), encoding: "utf8", timeout: 15_000 });
  return { status: result.status, stdout: result.stdout, output: result.stdout + result.stderr };
}
const install = (...args: string[]) => run(["zsh", "integrations/opencode-plugins/install.zsh", ...args]);
const installWithEnv = (env: NodeJS.ProcessEnv, ...args: string[]) => run(["zsh", "integrations/opencode-plugins/install.zsh", ...args], repo, env);
const push = () => expect(run(["git", "push", "origin", "main"]).status).toBe(0);
function records() {
  const directory = join(home, "logs/agent-tools");
  return existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith(".ndjson"))
    .flatMap(name => readFileSync(join(directory, name), "utf8").trim().split("\n").map(line => JSON.parse(line))) : [];
}
function managedFiles() {
  return ["lib", "plugin"].flatMap(directory => readdirSync(join(repo, "integrations/opencode-plugins", directory))
    .filter(name => /\.(ts|mjs)$/.test(name)).map(name => join(home, ".config/opencode", directory, name)));
}
function snapshot() {
  return managedFiles().map(file => {
    const { ino, mtimeNs } = statSync(file, { bigint: true });
    return { file, ino, mtimeNs, bytes: readFileSync(file) };
  });
}
async function busyService() {
  const script = `
    import { createServer } from 'node:http';
    import { appendFileSync } from 'node:fs';
    const server = createServer((request, response) => {
      appendFileSync(process.env.FIXTURE_PROBES, request.url + '\\n');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({data:{ses_busy:{type:'running'}}}));
    });
    server.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port));
  `;
  service = spawn(process.execPath, ["-e", script], { env: environment(), stdio: ["ignore", "pipe", "pipe"] });
  const url = await new Promise<string>((resolve, reject) => {
    service!.stdout!.once("data", data => resolve(String(data).trim()));
    service!.once("error", reject);
    service!.once("exit", code => reject(new Error(`fixture service exited ${code}`)));
  });
  return { OPENCODE_RELOAD_INSTANCES: JSON.stringify(["HOME", "BTSE"].map(name => ({ name, url }))) };
}

beforeEach(() => {
  if (!hasZsh) return;
  root = mkdtempSync(join(tmpdir(), "codemode-install-"));
  repo = join(root, "repo");
  home = join(root, "home");
  mkdirSync(home);
  mkdirSync(repo);
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin/git"), `#!/bin/sh
for arg do
  if [ "$arg" = ls-remote ]; then
    echo remote >> "$FIXTURE_GIT_CALLS"
    [ "$FIXTURE_FORBID_REMOTE" != 1 ] || exit 82
  fi
done
exec "$FIXTURE_GIT" "$@"
`, { mode: 0o755 });
  cpSync(resolve(import.meta.dir, ".."), join(repo, "integrations/opencode-plugins"), { recursive: true });
  for (const directory of [reloadDirectory, toollogDirectory]) {
    cpSync(resolve(import.meta.dir, "../../..", directory), join(repo, directory), { recursive: true });
  }
  for (const args of [
    ["git", "init", "-b", "main"],
    ["git", "config", "user.name", "Test"], ["git", "config", "user.email", "test@example.invalid"],
    ["git", "config", "commit.gpgsign", "false"],
    ["git", "add", "."], ["git", "commit", "-m", "fixture"],
    ["git", "init", "--bare", join(root, "origin.git")],
    ["git", "remote", "add", "origin", join(root, "origin.git")],
  ]) expect(run(args).status).toBe(0);
});

afterEach(async () => {
  const child = service;
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise(resolve => child.once("exit", resolve));
    child.kill();
    await stopped;
  }
  service = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
});

test.skipIf(!hasZsh)("check and dry run have no writes, remote checks or service probes", async () => {
  const env = { ...await busyService(), FIXTURE_FORBID_REMOTE: "1" };
  const check = installWithEnv(env, "--check");
  expect(check.status).toBe(1);
  expect(check.output).toContain("plugin/codemode-guard.ts not installed");
  expect(check.output).not.toContain("drift");
  const preview = installWithEnv(env, "--dry-run");
  expect(preview.status).toBe(0);
  expect(preview.output).toContain("would write");
  expect(preview.output).not.toContain("opencode-reload:");
  expect(readdirSync(home)).toHaveLength(0);
  expect(existsSync(join(root, "git-calls"))).toBe(false);
  expect(existsSync(join(root, "probes"))).toBe(false);
  expect(run(["git", "status", "--porcelain"]).output).toBe("");
});

test.skipIf(!hasZsh)("installer rejects unpushed work and batches changes with backups outside plugin", () => {
  expect(install().status).toBe(1);
  expect(existsSync(join(home, ".config"))).toBe(false);
  push();
  const installed = install();
  expect(installed.status).toBe(0);
  expect(installed.stdout.match(/^opencode-reload:/gm)).toHaveLength(1);
  expect(installed.output).not.toContain("needs an OpenCode restart");
  expect(records()).toHaveLength(1);
  expect(records()[0]).toMatchObject({ kind: "opencode-reload", component: "installers", props: { installer: "opencode-plugins" } });
  expect(records()[0].props.files).toHaveLength(managedFiles().length);
  expect(install("--check").status).toBe(0);
  const plugin = join(home, ".config/opencode/plugin/codemode-guard.ts");
  expect(readFileSync(plugin, "utf8")).toBe(readFileSync(join(repo, "integrations/opencode-plugins/plugin/codemode-guard.ts"), "utf8"));
  expect(existsSync(join(home, ".config/opencode/lib/codemode-never-settles.mjs"))).toBe(true);
  const lib = join(home, ".config/opencode/lib/toollog.ts");
  writeFileSync(plugin, "old plugin");
  writeFileSync(lib, "old lib");
  expect(install("--check").output).toContain("drift:");
  const updated = install();
  expect(updated.status).toBe(0);
  expect(updated.stdout.match(/^opencode-reload:/gm)).toHaveLength(1);
  expect(records()).toHaveLength(2);
  expect(records()[1].props.files).toHaveLength(2);
  const backupDirectory = join(home, ".config/opencode/backups/opencode-plugins");
  const backups = readdirSync(backupDirectory, { recursive: true }).map(name => join(backupDirectory, String(name)))
    .filter(path => statSync(path).isFile());
  expect(backups.map(path => readFileSync(path, "utf8")).sort()).toEqual(["old lib", "old plugin"]);
  expect(backups.some(path => path.includes("/lib/toollog.ts"))).toBe(true);
  expect(backups.some(path => path.includes("/plugin/codemode-guard.ts"))).toBe(true);
  expect(readdirSync(join(home, ".config/opencode/plugin")).some(name => name.includes(".bak"))).toBe(false);
  const source = join(repo, "integrations/opencode-plugins/plugin/codemode-guard.ts");
  writeFileSync(source, readFileSync(source, "utf8") + "\n// changed\n");
  expect(install().output).toContain("uncommitted changes");
  expect(run(["git", "add", "integrations/opencode-plugins"]).status).toBe(0);
  expect(run(["git", "commit", "-m", "unpushed"]).status).toBe(0);
  expect(install().output).toContain("not on origin/main");
});

test.skipIf(!hasZsh)("unchanged install preserves every inode and mtime without probes or reload events", async () => {
  push();
  const env = await busyService();
  expect(installWithEnv(env, "--allow-reload").status).toBe(0);
  for (const path of managedFiles()) utimesSync(path, 1_700_000_000, 1_700_000_000);
  const before = snapshot();
  const probes = readFileSync(join(root, "probes"), "utf8");
  const result = installWithEnv({ ...env, FIXTURE_FORBID_REMOTE: "1" });
  expect(result.status).toBe(0);
  expect(result.output).not.toContain("opencode-reload:");
  expect(snapshot()).toEqual(before);
  expect(readFileSync(join(root, "probes"), "utf8")).toBe(probes);
  expect(records()).toHaveLength(1);
  expect(existsSync(join(home, ".config/opencode/backups"))).toBe(false);
});

for (const approval of ["flag", "env"]) {
  test.skipIf(!hasZsh)(`busy sessions block the whole batch until the ${approval} override`, async () => {
    push();
    const env = await busyService();
    const busy = installWithEnv(env);
    expect(busy.status).toBe(1);
    expect(busy.output).toContain("OpenCode sessions busy");
    expect(existsSync(join(home, ".config"))).toBe(false);
    expect(records()).toHaveLength(0);
    const permitted = approval === "flag" ? installWithEnv(env, "--allow-reload")
      : installWithEnv({ ...env, OPENCODE_ALLOW_RELOAD: "1" });
    expect(permitted.status).toBe(0);
    expect(permitted.stdout.match(/^opencode-reload:/gm)).toHaveLength(1);
    expect(records()).toHaveLength(1);
    expect(records()[0].props.allow_reload).toBe(true);
    expect(records()[0].props.busy).toEqual({ HOME: 1, BTSE: 1 });
    expect(readFileSync(join(root, "probes"), "utf8").trim().split("\n")).toHaveLength(4);
  });
}

test.skipIf(!hasZsh)("source preflight rejects a late invalid plugin before installing any file", () => {
  const invalid = join(repo, "integrations/opencode-plugins/plugin/zz-invalid.ts");
  mkdirSync(invalid);
  writeFileSync(join(invalid, ".keep"), "fixture");
  expect(run(["git", "add", "."]).status).toBe(0);
  expect(run(["git", "commit", "-m", "invalid source fixture"]).status).toBe(0);
  push();
  const result = install();
  expect(result.status).toBe(1);
  expect(result.output).toContain("missing or unreadable source");
  expect(readdirSync(home)).toHaveLength(0);
});

test.skipIf(!hasZsh)("push check covers the reload helper and toollog dependency", () => {
  push();
  for (const relative of [reloadDirectory + "/opencode_reload.py", toollogDirectory + "/toollog.py"]) {
    const path = join(repo, relative);
    const original = readFileSync(path, "utf8");
    writeFileSync(path, original + "\n# changed\n");
    const result = install();
    expect(result.status).toBe(1);
    expect(result.output).toContain("uncommitted changes");
    expect(readdirSync(home)).toHaveLength(0);
    writeFileSync(path, original);
  }
});

test.skipIf(!hasZsh)("installed plugin loads its helper, logs a denial and reloads its off switch by mtime", () => {
  push();
  expect(install().status).toBe(0);
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
  expect(records[0]).toMatchObject({ session: "ses_fixture" });
});
