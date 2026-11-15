import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logMarker, toolLog } from "../src/toollog.ts";
const before = process.env.TOOLLOG_DIR;
const dirs: string[] = [];
const props = { service: "robob-watch", sha: "abcdef1234567890", step: "restart.complete" };
function fixture() { const dir = mkdtempSync(join(tmpdir(), "log-marker-")); dirs.push(dir); process.env.TOOLLOG_DIR = dir; return dir; }
function cli(dir: string, args: string[]) {
  return Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), "log-marker", ...args], {
    env: { ...process.env, TOOLLOG_DIR: dir, ROBOB_WATCH_ROOT: join(dir, "blocked-root") },
  });
}
afterEach(() => {
  if (before === undefined) delete process.env.TOOLLOG_DIR; else process.env.TOOLLOG_DIR = before;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
test("marker CLI writes shared private format, without touching watcher state", () => {
  const dir = fixture(); writeFileSync(join(dir, "blocked-root"), "blocked");
  const child = cli(dir, ["--service", props.service, "--sha", props.sha, "--step", props.step]);
  expect(child.exitCode).toBe(0); expect(child.stderr.toString()).toBe(""); expect(child.stdout.toString()).toBe("");
  const file = join(dir, new Date().toISOString().slice(0, 10) + ".ndjson");
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ts: expect.any(String), tool: "watchers", component: "deploy", kind: "event", name: "deploy.marker", props });
  expect(statSync(file).mode & 0o777).toBe(0o600);
});
test.each([
  [], ["--service"], ["--unknown", "password=private"],
  ["--service", "robob-watch", "--sha", "not-a-sha", "--step", "done"],
  ["--service", "private subject OTP 123456", "--sha", props.sha, "--step", "done"],
  ["--service", "robob-watch", "--sha", props.sha, "--step", "/Users/private/release.sh"],
])("marker CLI never raises for invalid args %j", (...args) => {
  const dir = fixture(), child = cli(dir, args);
  expect(child.exitCode).toBe(0); expect(child.stderr.toString()).toBe(""); expect(readdirSync(dir)).toEqual([]);
});
test("marker never raises on IO/getters and allowlists props/IDs", () => {
  const dir = fixture(), blocked = join(dir, "blocked"); writeFileSync(blocked, "file");
  expect(cli(blocked, ["--service", props.service, "--sha", props.sha, "--step", props.step]).exitCode).toBe(0);
  process.env.TOOLLOG_DIR = blocked;
  expect(() => logMarker(props)).not.toThrow();
  expect(() => logMarker({ get service() { throw Error("private"); } })).not.toThrow();
  process.env.TOOLLOG_DIR = dir;
  toolLog({ component: "deploy", name: "deploy.marker", kind: "event", ids: { watcher: "private-id" }, props: { ...props, message: "password=private" } });
  const file = join(dir, new Date().toISOString().slice(0, 10) + ".ndjson");
  const row = JSON.parse(readFileSync(file, "utf8"));
  expect(row.ids).toBeUndefined(); expect(row.props).toEqual(props);
});
test("markers survive the non-error daily cap", () => {
  const dir = fixture();
  const file = join(dir, new Date().toISOString().slice(0, 10) + ".ndjson");
  writeFileSync(file, ""); const cap = 50 * 1024 * 1024 + 1; truncateSync(file, cap);
  logMarker(props);
  expect(readFileSync(file).subarray(cap).toString()).toContain('"name":"deploy.marker"');
});
