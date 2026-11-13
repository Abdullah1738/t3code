import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
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

test("NODE_ENV=test protects non-test subprocesses; ordinary production keeps the home default", () => {
  const cwd = temp();
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test" };
  delete env.TOOLLOG_DIR;
  delete env.ROBOB_TEST;
  const script = `import { logDirectory } from ${JSON.stringify(resolve(import.meta.dir, "../src/log-directory.ts"))}; console.log(logDirectory("imessage"));`;
  const child = Bun.spawnSync([process.execPath, "-e", script], { cwd, env, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  const root = resolve(child.stdout.toString().trim(), "..");
  expect(relative(realpathSync(tmpdir()), realpathSync(root)).startsWith("..")).toBe(false);
  dirs.push(root);
  const production = Bun.spawnSync([process.execPath, "-e", script], { cwd, env: { ...env, NODE_ENV: "production" }, stdout: "pipe", stderr: "pipe" });
  expect(production.exitCode).toBe(0);
  expect(production.stdout.toString().trim()).toBe(join(homedir(), ".robob/logs/tools/imessage"));
});
