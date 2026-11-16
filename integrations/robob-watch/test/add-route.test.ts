import { expect, test, setDefaultTimeout } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogEntry } from "../src/toollog.ts";

setDefaultTimeout(15_000);
const cli = join(import.meta.dir, "../src/cli.ts");
const lib = join(import.meta.dir, "../src/lib.ts");
const thread = "ardud-control:thread:offbox-home%3A20261112T190236Z%3Athread%3A1";
const owner = "ardud-control:thread:owner%3Alive";
const title = 'Offbox "home" monitor';
type Probe = { error?: string; output?: string; timeout?: boolean };

async function fixture(body: (f: {
  root: string; env: Record<string, string | undefined>;
  config: (p: { status?: Probe; native?: Probe; archived?: boolean; origin?: string; projectId?: string }) => void;
  add: (args?: string[]) => Promise<{ code: number; out: string; err: string }>;
  invoke: (args: string[]) => Promise<{ code: number; out: string; err: string }>;
  calls: () => string[][]; logs: () => LogEntry[];
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "watch-add-route-"));
  try {
    const configPath = join(root, "config.json"), callsPath = join(root, "calls.jsonl"), stub = join(root, "t3ctl.ts");
    writeFileSync(stub, `#!${process.execPath}
import {appendFileSync,readFileSync} from 'node:fs';
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)},JSON.stringify(args)+'\\n');
const config=JSON.parse(readFileSync(${JSON.stringify(configPath)},'utf8'));
const probe=config[args[0]] ?? {};
if(probe.timeout) { console.error('probe waiting'); await Bun.sleep(10000); }
if(probe.error) { console.error(probe.error); process.exit(1); }
console.log(probe.output ?? JSON.stringify({ok:true,thread:{threadId:args[0] === 'status' ? args[1] : ${JSON.stringify(thread)},title:${JSON.stringify(title)},archived:config.archived ?? false,origin:config.origin,projectId:config.projectId}}));
`, { mode: 0o755 });
    const config = (p: object) => writeFileSync(configPath, JSON.stringify(p));
    config({});
    const db = new Database(join(root, "bridge.sqlite"));
    db.exec("create table kv(key text primary key,value text)");
    db.query("insert into kv values('route',?)").run(JSON.stringify({ id: owner }));
    db.close();
    const env = { ...process.env, BUN_INSPECT: undefined, ROBOB_TEST: "1", ROBOB_WATCH_ROOT: join(root, "watch"),
      ROBOB_WATCH_T3CTL: stub, ROBOB_WATCH_BRIDGE_DB: join(root, "bridge.sqlite"), TOOLLOG_DIR: join(root, "logs"),
      ROBOB_WATCH_TEST_CREATOR_TIMEOUT_MS: "1000" };
    const invoke = async (args: string[]) => {
      const child = Bun.spawn([process.execPath, cli, ...args], { env, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (process.env.ROUTE_SAMPLES) console.log(JSON.stringify({ args, code, out, err }));
      return { code, out, err };
    };
    const add = (args: string[] = []) => invoke(["add", "--id", "route-test", "--title", "Route test", "--check", "true", "--context", "Handle the event", "--no-prime", ...args]);
    await body({ root, env, config, add, invoke,
      calls: () => existsSync(callsPath) ? readFileSync(callsPath, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [],
      logs: () => existsSync(join(root, "logs")) ? readdirSync(join(root, "logs")).filter(f => f.endsWith(".ndjson"))
        .flatMap(f => readFileSync(join(root, "logs", f), "utf8").trim().split("\n").map(line => JSON.parse(line))) : [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const routeLogs = (logs: LogEntry[]) => logs.filter(l => l.name === "watch.route_checked");

test("encoded id is accepted unchanged, with its title and one route check in add and show", () => fixture(async f => {
  const result = await f.add(["--session", thread]);
  expect(result.code, result.err).toBe(0);
  expect(result.err).toContain(`Note for route-test: wakes go to thread ${thread} (${JSON.stringify(title)})`);
  expect(JSON.parse(result.out)).toMatchObject({ added: "route-test", mode: "wake", prime: "", wake_route: { route: "thread", thread, title } });
  expect(f.calls()).toEqual([["status", thread]]);
  expect(routeLogs(f.logs())).toMatchObject([{ props: { route: "thread", reason: "live thread", durationMs: expect.any(Number) } }]);
  const shown = await f.invoke(["show", "route-test"]);
  expect(shown.code).toBe(0);
  expect(shown.err).toBe(result.err);
  expect(shown.out).toContain('"wake_route"');
  expect(f.calls()).toEqual([["status", thread], ["status", thread]]);
}));

test.each([
  { name: "not_found", status: { error: "not_found: thread is missing" }, reason: "not_found", session: thread },
  { name: "archived", archived: true, reason: "archived", session: thread },
  { name: "invalid id", status: { error: "invalid id" }, reason: "invalid_id", session: "bogus session" },
  { name: "missing native", native: { error: "not_found: native session is missing" }, reason: "not_found", session: "ses_missing" },
  { name: "invalid native", native: { error: "invalid session" }, reason: "invalid_session", session: "ses_invalid" },
])("$name refuses before writing a watcher", ({ session, reason, ...config }) => fixture(async f => {
  f.config(config);
  const result = await f.add(["--session", session]);
  expect(result.code).toBe(1);
  expect(result.out).toBe("");
  expect(result.err).toContain(`--session ${session} is not a live thread (${reason}); wakes would go to the owner chat.`);
  expect(result.err).toContain("Pass the thread id from t3ctl, or omit --session for owner wakes.");
  expect(existsSync(join(f.root, "watch/watchers/route-test"))).toBe(false);
  expect(routeLogs(f.logs())).toMatchObject([{ props: { route: "refused", reason } }]);
  expect(f.logs()).toContainEqual(expect.objectContaining({ error: { tag: "watch.invalid_definition", message: "watch.invalid_definition" }, props: { stderrClass: "usage_error" } }));
}));

test.each([
  { name: "timeout", status: { timeout: true } },
  { name: "empty exit", status: { error: " " } },
  { name: "service exit", status: { error: "service unavailable" } },
  { name: "malformed success", status: { output: "not json" } },
  { name: "mismatched thread", status: { output: JSON.stringify({ thread: { threadId: "other", archived: false } }) } },
  { name: "native exit", native: { error: "service unavailable" }, session: "ses_pending" },
  { name: "native timeout", native: { timeout: true }, session: "ses_pending" },
  { name: "malformed native", native: { output: "{}" }, session: "ses_pending" },
])("$name warns and adds; transient answers never refuse", ({ session = thread, ...config }) => fixture(async f => {
  f.config(config);
  const result = await f.add(["--session", session]);
  expect(result.code, result.err).toBe(0);
  expect(result.err).toContain("Note for route-test: could not check thread");
  expect(result.err).toContain("wakes will try it first and fall back to the owner chat");
  expect(result.err).toContain("10 minutes without confirmation");
  expect(JSON.parse(result.out).wake_route.route).toBe("unverified");
  expect(existsSync(join(f.root, "watch/watchers/route-test/watcher.json"))).toBe(true);
  expect(routeLogs(f.logs())).toMatchObject([{ props: { route: "unverified", reason: "lookup unavailable" } }]);
  expect(f.logs().filter(l => l.name === "wake.creator_fallback")).toHaveLength(0);
}));

test.each([
  { name: "no session", args: [], reason: "no --session" },
  { name: "live owner", args: ["--session", owner], reason: "live owner session" },
  { name: "iMessage origin", args: ["--session", thread], origin: "imessage", reason: "iMessage thread" },
  { name: "iMessage project", args: ["--session", thread], projectId: "project:/Users/ardud/.robob/imessage", reason: "iMessage thread" },
])("$name names owner chat", ({ args, reason, ...config }) => fixture(async f => {
  f.config(config);
  const result = await f.add(args);
  expect(result.code, result.err).toBe(0);
  expect(result.err).toContain(`Note for route-test: wakes go to the owner chat (${reason})`);
  expect(JSON.parse(result.out).wake_route).toMatchObject({ route: "owner", reason });
  if (reason !== "iMessage thread") expect(f.calls()).toEqual([]);
}));

test("JSON input and native resolution use the same check; refused replace preserves bytes", () => fixture(async f => {
  const json = join(f.root, "input.json");
  writeFileSync(json, JSON.stringify({ id: "route-test", title: "JSON watcher", check: "true", context: "Handle it", created_by_session: "ses_valid" }));
  const result = await f.invoke(["add", "--json", json, "--no-prime"]);
  expect(result.code, result.err).toBe(0);
  expect(result.err).toContain(`wakes go to thread ${thread}`);
  expect(f.calls()).toEqual([["native", "ses_valid"], ["status", thread]]);
  f.config({ archived: true });
  const previous = readFileSync(join(f.root, "watch/watchers/route-test/watcher.json"), "utf8");
  const state = readFileSync(join(f.root, "watch/watchers/route-test/state.json"), "utf8");
  const replaced = await f.invoke(["add", "--json", json, "--replace"]);
  expect(replaced.code).toBe(1);
  expect(readFileSync(join(f.root, "watch/watchers/route-test/watcher.json"), "utf8")).toBe(previous);
  expect(readFileSync(join(f.root, "watch/watchers/route-test/state.json"), "utf8")).toBe(state);
}));

test.each([["--mode", "notify"], ["--chat", "moni"]])("non-creator delivery skips route checks (%j)", (...args) => fixture(async f => {
  const result = await f.add([...args, "--session", "bogus"]);
  expect(result.code, result.err).toBe(0);
  expect(result.err).toBe("");
  expect(JSON.parse(result.out).wake_route).toBeUndefined();
  expect(f.calls()).toEqual([]);
  expect(routeLogs(f.logs())).toEqual([]);
}));

test("an add-time check cannot seed the runner creator cache", () => fixture(async f => {
  const code = `import {checkWakeRoute,normalize,deliver,loadState} from ${JSON.stringify(lib)};
const watcher=normalize({id:'route-test',title:'Route test',check:'true',context:'Handle it',created_by_session:${JSON.stringify(thread)}});
await checkWakeRoute(watcher);
await checkWakeRoute(watcher);
await deliver(watcher,'event','test-key',loadState(watcher.id));`;
  const child = Bun.spawn([process.execPath, "-e", code], { env: f.env, stdout: "pipe", stderr: "pipe" });
  const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit, err + out).toBe(0);
  expect(f.calls().filter(c => c[0] === "status")).toHaveLength(3);
}));


test.each([
  "thread:project:work:abcd1234-5678-4000-8000-123456789abc",
  "ardud-control:thread:abcd1234-5678-4000-8000-123456789abc",
  "ardud-control:thread:work%3a20261112%3athread%3a1",
  "custom-thread-accepted-by-t3ctl",
])("t3ctl-accepted id %s is not rejected by a local id pattern", session => fixture(async f => {
  const result = await f.add(["--session", session]);
  expect(result.code, result.err).toBe(0);
  expect(JSON.parse(result.out).wake_route).toMatchObject({ route: "thread", thread: session });
  expect(f.calls()).toEqual([["status", session]]);
}));

test("a legacy live owner session bypasses native lookup", () => fixture(async f => {
  const db = new Database(join(f.root, "bridge.sqlite"));
  db.query("update kv set value=? where key='route'").run(JSON.stringify({ id: "ses_live_owner" }));
  db.close();
  f.config({ native: { error: "not_found" } });
  const result = await f.add(["--session", "ses_live_owner"]);
  expect(result.code, result.err).toBe(0);
  expect(result.err).toContain("wakes go to the owner chat (live owner session)");
  expect(f.calls()).toEqual([]);
}));

test("flag replace refusal leaves the old definition and state intact; show names its current owner fallback", () => fixture(async f => {
  expect((await f.add(["--session", thread])).code).toBe(0);
  const file = join(f.root, "watch/watchers/route-test/watcher.json");
  const state = join(f.root, "watch/watchers/route-test/state.json");
  const previous = readFileSync(file, "utf8"), previousState = readFileSync(state, "utf8");
  f.config({ status: { error: "not_found" } });
  const result = await f.add(["--session", thread, "--replace", "--title", "Replacement"]);
  expect(result.code).toBe(1);
  expect(readFileSync(file, "utf8")).toBe(previous);
  expect(readFileSync(state, "utf8")).toBe(previousState);
  const shown = await f.invoke(["show", "route-test"]);
  expect(shown.code).toBe(0);
  expect(shown.err).toContain("wakes go to the owner chat (not_found; creator is not a live thread)");
}));
