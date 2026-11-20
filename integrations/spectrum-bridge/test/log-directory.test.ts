import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { logDirectory } from "../src/log-directory.ts";
import { createToolLog } from "../src/toollog.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "log-directory-test-")); dirs.push(dir); return dir; };
const entry = { component: "fixture", kind: "event", name: "bridge.start" } as const;

test("override directs writes, deferred singleton and rollups, while explicit roots take precedence", async () => {
  const previous = process.env.TOOLLOG_DIR;
  const root = temp();
  process.env.TOOLLOG_DIR = root;
  try {
    const log = createToolLog({ now: () => Date.parse("2026-11-13T12:00:00Z") });
    log.write(entry);
    expect(logDirectory("imessage")).toBe(root);
    expect(logDirectory("watchers")).toBe(root);
    expect(await log.rollup("2026-11-13")).toMatchObject({ total: 1 });
    expect(JSON.parse(readFileSync(join(root, "rollup-2026-11-13.json"), "utf8")).total).toBe(1);
    const explicit = temp();
    createToolLog({ root: explicit, now: () => Date.parse("2026-11-13T12:00:00Z") }).write(entry);
    expect(JSON.parse(readFileSync(join(explicit, "2026-11-13.ndjson"), "utf8")).name).toBe("bridge.start");
    const child = Bun.spawnSync([process.execPath, "-e", `import { toolLog } from ${JSON.stringify(resolve(import.meta.dir, "../src/toollog.ts"))}; toolLog.write(${JSON.stringify(entry)}); toolLog.flush();`], {
      cwd: root, env: { ...process.env, NODE_ENV: "production" }, stdout: "pipe", stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
    expect(readFileSync(join(root, `${new Date().toISOString().slice(0, 10)}.ndjson`), "utf8")).toContain('"bridge.start"');
  } finally {
    if (previous === undefined) delete process.env.TOOLLOG_DIR; else process.env.TOOLLOG_DIR = previous;
  }
});

test.each(["test", "production"])("bun test without package preload stays in tmp with NODE_ENV=%s", nodeEnv => {
  const cwd = temp();
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: nodeEnv };
  delete env.TOOLLOG_DIR;
  delete env.ROBOB_TEST;
  const fixture = join(cwd, "guard.test.ts");
  writeFileSync(fixture, `
    import { expect, test } from "bun:test";
    import { logDirectory } from ${JSON.stringify(resolve(import.meta.dir, "../src/log-directory.ts"))};
    import { createToolLog, toolLog } from ${JSON.stringify(resolve(import.meta.dir, "../src/toollog.ts"))};
    import { homedir, tmpdir } from "node:os";
    import { relative, resolve } from "node:path";
    import { readFileSync, realpathSync, rmSync } from "node:fs";
    test("guard default before any write", async () => {
      const dir = logDirectory("imessage");
      expect(relative(realpathSync(tmpdir()), realpathSync(resolve(dir, ".."))).startsWith("..")).toBe(false);
      expect(dir.startsWith(homedir() + "/.robob/")).toBe(false);
      expect(logDirectory("imessage")).toBe(dir);
      console.log("TEST_LOG_DIR=" + dir);
      try {
        const log = createToolLog();
        const day = new Date().toISOString().slice(0, 10);
        log.write(${JSON.stringify(entry)});
        toolLog.write(${JSON.stringify(entry)}); toolLog.flush();
        const child = Bun.spawnSync([process.execPath, "-e", ${JSON.stringify(`if (!process.env.TOOLLOG_DIR) throw new Error("Missing test log override"); import { toolLog } from ${JSON.stringify(resolve(import.meta.dir, "../src/toollog.ts"))}; toolLog.write(${JSON.stringify(entry)}); toolLog.flush();`)}], { env: process.env, stdout: "pipe", stderr: "pipe" });
        expect(child.exitCode).toBe(0);
        expect(await log.rollup(day)).toMatchObject({ total: 3 });
        expect(readFileSync(dir + "/" + day + ".ndjson", "utf8").trim().split("\\n").map(line => JSON.parse(line).name)).toEqual(["bridge.start", "bridge.start", "bridge.start"]);
      } finally { rmSync(resolve(dir, ".."), { recursive: true, force: true }); }
    });
  `);
  const child = Bun.spawnSync([process.execPath, "test", fixture], { cwd, env, stdout: "pipe", stderr: "pipe" });
  expect(child.stderr.toString()).toContain("0 fail");
  expect(child.exitCode).toBe(0);
  const dir = child.stdout.toString().match(/TEST_LOG_DIR=(.+)/)?.[1];
  expect(dir).toBeDefined();
  expect(dir!.startsWith(join(homedir(), ".robob"))).toBe(false);
});

test.each(["test", "production"])("non-test subprocesses use temp logs with NODE_ENV=%s", nodeEnv => {
  const cwd = temp();
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: nodeEnv };
  delete env.TOOLLOG_DIR;
  delete env.ROBOB_TEST;
  const script = `import { logDirectory } from ${JSON.stringify(resolve(import.meta.dir, "../src/log-directory.ts"))}; console.log(logDirectory("imessage"));`;
  const child = Bun.spawnSync([process.execPath, "-e", script], { cwd, env, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  const root = resolve(child.stdout.toString().trim(), "..");
  expect(relative(realpathSync(tmpdir()), realpathSync(root)).startsWith("..")).toBe(false);
  dirs.push(root);
});

function sandbox() {
  const cwd = realpathSync(temp());
  const home = join(cwd, "home"), tmp = join(cwd, "tmp");
  mkdirSync(home); mkdirSync(tmp);
  const installed = join(home, ".local/share/spectrum-bridge");
  const script = `
    import { logDirectory } from ${JSON.stringify(resolve(import.meta.dir, "../src/log-directory.ts"))};
    const imessage = logDirectory("imessage");
    const watchers = logDirectory("watchers");
    const child = Bun.spawnSync([process.execPath, "-e", "console.log(process.env.TOOLLOG_DIR ?? '')"], { env: process.env, stdout: "pipe", stderr: "pipe" });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    console.log(JSON.stringify({ imessage, watchers, inherited: child.stdout.toString().trim() }));
  `;
  const write = (path: string, source = script) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, source); return path; };
  const run = (args: string[], overrides: NodeJS.ProcessEnv = {}) => {
    const child = Bun.spawnSync([process.execPath, ...args], {
      cwd, env: { HOME: home, TMPDIR: tmp, ...overrides }, stdout: "pipe", stderr: "pipe",
    });
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
    return JSON.parse(child.stdout.toString()) as { imessage: string; watchers: string; inherited: string };
  };
  return { cwd, home, tmp, installed, script, write, run };
}

test.each(["main.ts", "cli.ts"])("installed %s keeps both live log directories", name => {
  const s = sandbox();
  const result = s.run([s.write(join(s.installed, "src", name))]);
  expect(result).toEqual({ imessage: join(s.home, ".robob/logs/tools/imessage"), watchers: join(s.home, ".robob/logs/tools/watchers"), inherited: "" });
});

test("installed Moni box runner is an explicit live writer", () => {
  const s = sandbox();
  const result = s.run([s.write(join(s.home, "person/agent/code/integrations/moni-box-runner/src/main.ts"))]);
  expect(result.imessage).toBe(join(s.home, ".robob/logs/tools/imessage"));
  expect(result.inherited).toBe("");
});

function expectTemp(s: ReturnType<typeof sandbox>, result: { imessage: string; watchers: string; inherited: string }) {
  expect(dirname(dirname(result.imessage))).toBe(s.tmp);
  expect(dirname(result.imessage).startsWith(join(s.tmp, "bridge-nonlive-logs-"))).toBe(true);
  expect(result.watchers).toBe(result.imessage);
  expect(result.inherited).toBe(result.imessage);
  expect(existsSync(join(s.home, ".robob"))).toBe(false);
}

test.each(["worktree/src/cli.ts", "board-artifacts/after.ts", "home/.local/share/spectrum-bridge-copy/src/main.ts"])("%s defaults to inherited temp logs", path => {
  const s = sandbox();
  expectTemp(s, s.run([s.write(join(s.cwd, path))]));
});

test("bun -e without an entry file defaults to inherited temp logs", () => {
  const s = sandbox();
  expectTemp(s, s.run(["-e", s.script]));
});

test.each([undefined, "missing.ts"])("unresolvable entry %s defaults to temp logs", entryPath => {
  const s = sandbox();
  expectTemp(s, s.run(["-e", `${entryPath === undefined ? "process.argv.length = 1;" : `process.argv[1] = ${JSON.stringify(join(s.installed, entryPath))};`} ${s.script}`]));
});

test("symlink to an installed entry stays live", () => {
  const s = sandbox();
  const entryPath = s.write(join(s.installed, "src/main.ts"));
  const link = join(s.cwd, "bridge.ts");
  symlinkSync(entryPath, link);
  expect(s.run([link]).imessage).toBe(join(s.home, ".robob/logs/tools/imessage"));
});

test("symlink escaping an installed root uses temp logs", () => {
  const s = sandbox();
  const entryPath = s.write(join(s.cwd, "worktree/main.ts"));
  mkdirSync(s.installed, { recursive: true });
  const link = join(s.installed, "main.ts");
  symlinkSync(entryPath, link);
  expectTemp(s, s.run([link]));
});

test("installed root itself can be a symlink", () => {
  const s = sandbox();
  const actual = join(s.cwd, "installed-package");
  s.write(join(actual, "src/main.ts"));
  mkdirSync(dirname(s.installed), { recursive: true });
  symlinkSync(actual, s.installed);
  expect(s.run([join(s.installed, "src/main.ts")]).imessage).toBe(join(s.home, ".robob/logs/tools/imessage"));
});

test.each([{ NODE_ENV: "test" }, { ROBOB_TEST: "1" }])("test environment %j isolates installed entries", env => {
  const s = sandbox();
  const result = s.run([s.write(join(s.installed, "src/main.ts"))], env);
  expect(dirname(result.imessage).startsWith(join(s.tmp, "bridge-test-logs-"))).toBe(true);
  expect(result.inherited).toBe(result.imessage);
});

test.each(["installed", "worktree"])("TOOLLOG_DIR wins for %s scripts even in test mode", location => {
  const s = sandbox();
  const entryPath = s.write(join(location === "installed" ? s.installed : s.cwd, "src/main.ts"));
  const override = "relative-log-override";
  expect(s.run([entryPath], { TOOLLOG_DIR: override, NODE_ENV: "test", ROBOB_TEST: "1" })).toEqual({ imessage: override, watchers: override, inherited: override });
});
