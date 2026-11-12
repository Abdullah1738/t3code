import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalize, shouldPause, type State } from "../src/lib.ts";

const fixtures: ReturnType<typeof fixture>[] = [];
function fixture(options: Record<string, string> = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), "watch-failure-pause-"));
  const root = join(sandbox, "root"), calls = join(sandbox, "calls"), stub = join(sandbox, "bridge.ts");
  writeFileSync(stub, `import { appendFileSync, existsSync } from "node:fs";
const args = process.argv.slice(2), ok = !existsSync(${JSON.stringify(join(sandbox, "fail-send"))});
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args, ok}) + "\\n");
while (existsSync(${JSON.stringify(join(sandbox, "hold-send"))}) || existsSync(${JSON.stringify(join(sandbox, "hold-"))} + args[0])) await Bun.sleep(10);
if (!ok) process.exit(1);
console.log('{"created":true}');`);
  const db = join(sandbox, "bridge.sqlite");
  Bun.spawnSync(["/usr/bin/sqlite3", db, `create table kv (key text primary key, value text); create table inbound (id text primary key, payload text, state text); insert into kv values ('route', '{"id":"ses_test","generation":1}');`]);
  const env = { ...process.env, BUN_INSPECT: undefined, ROBOB_WATCH_ROOT: root,
    ROBOB_WATCH_SPECTRUM_CLI: stub, ROBOB_WATCH_TELEGRAM_CLI: stub, ROBOB_WATCH_BRIDGE_DB: db,
    ROBOB_WATCH_CHECK_TIMEOUT_MS: "500", WACLI_STORE_DIR: join(sandbox, "wacli"), ...options };
  const cli = (...args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], { env });
  const path = (id: string, file: string) => join(root, "watchers", id, file);
  const state = (id: string): State => JSON.parse(readFileSync(path(id, "state.json"), "utf8"));
  const save = (id: string, s: State) => writeFileSync(path(id, "state.json"), JSON.stringify(s));
  const add = (id: string, extra: Record<string, unknown> = {}) => {
    mkdirSync(join(root, "watchers", id), { recursive: true });
    writeFileSync(path(id, "watcher.json"), JSON.stringify(normalize({ id, title: id, mode: "notify", context: "Test context", interval_s: 5, max_fires: 0,
      check: 'echo run >> "$WATCH_DIR/runs"; echo broken >&2; exit 1', ...extra })));
    save(id, { status: "active", fires: 0, consecutive_failures: 0, failure_alerted: false });
  };
  const readCalls = () => (existsSync(calls) ? readFileSync(calls, "utf8") : "").split("\n").filter(Boolean)
    .map(line => JSON.parse(line) as { args: string[]; ok: boolean });
  const runners: ReturnType<typeof Bun.spawn>[] = [];
  const logs = new Map<ReturnType<typeof Bun.spawn>, string>();
  const start = () => {
    const file = join(sandbox, `runner-${runners.length}.log`);
    const fd = openSync(file, "w");
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/runner.ts")], { env, stdout: fd, stderr: "pipe" });
    closeSync(fd);
    logs.set(child, file);
    runners.push(child); return child;
  };
  const readLog = (child: ReturnType<typeof start>) => readFileSync(logs.get(child)!, "utf8");
  const stop = async (child: ReturnType<typeof start>) => { child.kill(); await child.exited; };
  const runs = (id: string) => existsSync(path(id, "runs")) ? readFileSync(path(id, "runs"), "utf8").trim().split("\n").length : 0;
  const run = async (id: string, complete: (s: State) => boolean) => {
    save(id, { ...state(id), next_at: 0 });
    const child = start();
    try { await until(() => complete(state(id))); } finally { await stop(child); }
  };
  const f = { sandbox, root, cli, path, state, save, add, readCalls, start, stop, runs, run, runners, readLog };
  fixtures.push(f); return f;
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 8_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Runner did not reach expected state");
    await Bun.sleep(20);
  }
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    for (const child of f.runners) if (child.exitCode === null) await f.stop(child);
    rmSync(f.sandbox, { recursive: true, force: true });
  }
});
const opt = (args: string[], key: string) => args[args.indexOf(key) + 1]!;

test("a: five failures pause checks and send exactly one pause notice", async () => {
  const f = fixture(); f.add("broken");
  for (let n = 1; n <= 5; n++) await f.run("broken", s => s.consecutive_failures === n && (n < 5 || s.failure_alerted));
  expect(f.state("broken").failure_paused_at).toBeString(); expect(f.runs("broken")).toBe(5);
  f.save("broken", { ...f.state("broken"), next_at: 0 });
  const child = f.start(); await Bun.sleep(2_200); await f.stop(child);
  expect(f.runs("broken")).toBe(5); expect(f.readCalls()).toHaveLength(1);
  const text = opt(f.readCalls()[0]!.args, "--text");
  expect(text).toContain('Watcher "broken" paused after 5 failures'); expect(text).toContain("robob-watch resume broken"); expect(text).not.toContain("backing off");
  for (const args of [["list"], ["show", "broken"]]) expect(f.cli(...args).stdout.toString()).toContain("paused (failing since");
}, 20_000);

test("b: success after four failures resets the streak", async () => {
  const f = fixture(); f.add("recover", { check: 'echo run >> "$WATCH_DIR/runs"; [[ $(wc -l < "$WATCH_DIR/runs") -gt 4 ]]' });
  for (let n = 1; n <= 4; n++) await f.run("recover", s => s.consecutive_failures === n);
  await f.run("recover", s => s.consecutive_failures === 0);
  expect(f.runs("recover")).toBe(5); expect(f.state("recover").failure_paused_at).toBeUndefined(); expect(f.state("recover").failing_since).toBeUndefined(); expect(f.readCalls()).toHaveLength(0);
}, 20_000);

test("c: resume clears failure state and a new streak gets a new notice key", async () => {
  const f = fixture(); f.add("resume", { max_consecutive_failures: 1 });
  await f.run("resume", s => !!s.failure_paused_at && s.failure_alerted);
  f.save("resume", { ...f.state("resume"), failure_escalated: true });
  expect(f.cli("pause", "resume").exitCode).toBe(0); expect(f.cli("resume", "resume").exitCode).toBe(0);
  expect(f.state("resume")).toMatchObject({ consecutive_failures: 0, failure_alerted: false, next_at: 0 });
  for (const field of ["failure_paused_at", "failure_escalated", "failing_since", "last_error"] as const) expect(f.state("resume")[field]).toBeUndefined();
  await f.run("resume", s => !!s.failure_paused_at && s.failure_alerted);
  expect(f.runs("resume")).toBe(2);
  const keys = f.readCalls().map(c => opt(c.args, "--key")); expect(keys).toHaveLength(2); expect(keys[0]).not.toBe(keys[1]);
});

test("d: zero threshold keeps backoff and the original one-time alert", async () => {
  const f = fixture(); f.add("retry", { max_consecutive_failures: 0 });
  for (let n = 1; n <= 6; n++) await f.run("retry", s => s.consecutive_failures === n && (n < 5 || s.failure_alerted));
  expect(f.state("retry").failure_paused_at).toBeUndefined(); expect(f.readCalls()).toHaveLength(1);
  expect(opt(f.readCalls()[0]!.args, "--text")).toContain("has failed 5 times in a row (0 min) and is backing off.");
}, 20_000);

test("e: failed sends leave a pause and retry the same notice after restart", async () => {
  const f = fixture(); f.add("silent", { max_consecutive_failures: 1, depends: ["ssd"] }); writeFileSync(join(f.sandbox, "fail-send"), "");
  await f.run("silent", s => !!s.failure_paused_at && f.readCalls().length >= 2);
  expect(f.state("silent").failure_alerted).toBe(false); rmSync(join(f.sandbox, "fail-send"));
  expect(f.cli("maintenance", "on", "--for", "1h").exitCode).toBe(0);
  expect(f.cli("pause", "silent").exitCode).toBe(0);
  const child = f.start(); await until(() => f.state("silent").failure_alerted); await Bun.sleep(1_100); await f.stop(child);
  expect(f.runs("silent")).toBe(1); const calls = f.readCalls(); expect(calls.filter(c => c.ok)).toHaveLength(1);
  expect(new Set(calls.map(c => opt(c.args, "--key"))).size).toBe(1);
  expect(new Set(calls.filter(c => c.args[0] === "notify").map(c => opt(c.args, "--text"))).size).toBe(1);
});

test("f/g: maintenance holds checks and pending deliveries, then expiry or off resumes", async () => {
  const f = fixture(); f.add("ssd", { depends: ["ssd"] }); f.add("plain", { check: 'echo run >> "$WATCH_DIR/runs"' }); f.add("pending", { depends: ["ssd"], check: "echo should-not-run" });
  f.save("ssd", { ...f.state("ssd"), consecutive_failures: 3 }); const held = f.state("ssd");
  f.save("pending", { ...f.state("pending"), pending: { key: "held-event", event: "held event", at: new Date().toISOString() } });
  const on = f.cli("maintenance", "on", "--depends", "ssd", "--for", "1h", "--reason", "SSD swap");
  expect(on.exitCode).toBe(0); expect(JSON.parse(on.stdout.toString()).held).toEqual(["pending", "ssd"]);
  const child = f.start(); await until(() => f.runs("plain") === 1); await Bun.sleep(1_100);
  expect(f.runs("ssd")).toBe(0); expect(f.state("ssd")).toEqual(held); expect(f.state("pending").pending?.key).toBe("held-event"); expect(f.readCalls()).toHaveLength(0);
  writeFileSync(join(f.root, "maintenance.json"), JSON.stringify({ until: new Date(0).toISOString(), reason: "past", depends: ["ssd"] }));
  await until(() => f.runs("ssd") === 1 && f.state("pending").fires === 1); await f.stop(child);
  const logs = f.readLog(child); expect(logs.match(/maintenance started/g)).toHaveLength(1); expect(logs.match(/maintenance ended/g)).toHaveLength(1);
  expect(f.readCalls()).toHaveLength(1); expect(opt(f.readCalls()[0]!.args, "--key")).toBe("held-event");
  expect(f.cli("maintenance", "on", "--for", "1h").exitCode).toBe(0); expect(f.cli("maintenance", "off").exitCode).toBe(0);
  await f.run("ssd", s => s.consecutive_failures === 5 && s.failure_alerted); expect(f.runs("ssd")).toBe(2);
}, 20_000);

test("h: normalize retains fields and validates dependencies and thresholds", () => {
  const base = { id: "valid", title: "Valid", check: "true", mode: "notify" as const };
  expect(normalize({ ...base, depends: ["ssd", "phone"], max_consecutive_failures: 0 })).toMatchObject({ depends: ["ssd", "phone"], max_consecutive_failures: 0 });
  for (const depends of [["usb"], "ssd", [null], ["ssd", "usb"]]) expect(() => normalize({ ...base, depends } as never)).toThrow("depends");
  for (const value of [-1, 1.5, "5", null, true]) expect(() => normalize({ ...base, max_consecutive_failures: value } as never)).toThrow("max_consecutive_failures");
  for (const depends of [[], ["ssd"], ["phone"], ["phone", "ssd"]]) expect(normalize({ ...base, depends } as never).depends).toEqual(depends);
  for (const value of [0, 1, 5, 10]) expect(normalize({ ...base, max_consecutive_failures: value }).max_consecutive_failures).toBe(value);
});

test("timeouts require both the count and ten minutes", () => {
  const w = normalize({ id: "timeout", title: "Timeout", check: "true", mode: "notify", max_consecutive_failures: 8 }); const t = Date.now();
  const s: State = { status: "active", fires: 0, consecutive_failures: 8, failure_alerted: false, failing_since: new Date(t - 599_999).toISOString() };
  expect(shouldPause(w, s, true, t)).toBe(false); expect(shouldPause(w, s, true, t + 1)).toBe(true); expect(shouldPause(w, { ...s, consecutive_failures: 7 }, false, t)).toBe(false);
});

test("wake watchers escalate immediately at pause and only once", async () => {
  const f = fixture(); f.add("wake", { mode: "wake", max_consecutive_failures: 1 }); await f.run("wake", s => !!s.failure_escalated && s.failure_alerted);
  const child = f.start(); await Bun.sleep(1_100); await f.stop(child); const wakes = f.readCalls().filter(c => c.args[0] === "wake");
  expect(wakes).toHaveLength(1); expect(opt(wakes[0]!.args, "--text")).toContain("It is paused");
});

test("CLI validates maintenance and keeps dependencies across normalization and replacement", () => {
  const f = fixture(); f.add("config", { max_consecutive_failures: 9 });
  for (const args of [["--for", "0h"], ["--for", "25h"], ["--for", "1h", "--depends", "usb"], []]) expect(f.cli("maintenance", "on", ...args).exitCode).toBe(1);
  expect(f.cli("maintenance", "on", "--for", "24h").exitCode).toBe(0); expect(f.cli("depends", "config", "ssd,phone").exitCode).toBe(0);
  expect(f.cli("add", "--id", "config", "--title", "Config", "--check", "true", "--mode", "notify", "--replace", "--no-prime").exitCode).toBe(0);
  const definition = () => JSON.parse(readFileSync(f.path("config", "watcher.json"), "utf8")); expect(definition()).toMatchObject({ depends: ["ssd", "phone"], max_consecutive_failures: 9 });
  expect(f.cli("depends", "config", "none").exitCode).toBe(0); expect(definition().depends).toEqual([]);
  expect(f.cli("add", "--id", "config", "--title", "Config", "--check", "true", "--mode", "notify", "--replace", "--no-prime", "--depends", "phone").exitCode).toBe(0);
  expect(definition().depends).toEqual(["phone"]);
});


test("resume during a slow notice send cannot restore the old pause", async () => {
  const f = fixture(); f.add("race", { max_consecutive_failures: 1 });
  writeFileSync(join(f.sandbox, "hold-send"), "");
  const child = f.start();
  await until(() => f.readCalls().length > 0);
  expect(f.cli("resume", "race").exitCode).toBe(0);
  rmSync(join(f.sandbox, "hold-send"));
  await until(() => readFileSync(f.path("race", "log"), "utf8").includes("pause notice ok=true"));
  await f.stop(child);
  expect(f.state("race")).toMatchObject({ consecutive_failures: 0, failure_alerted: false, next_at: 0 });
  expect(f.state("race").failure_paused_at).toBeUndefined();
});

test("a higher threshold sends no backing-off alert before the pause", async () => {
  const f = fixture(); f.add("eight", { max_consecutive_failures: 8 });
  f.save("eight", { ...f.state("eight"), consecutive_failures: 4, failing_since: new Date().toISOString() });
  for (let n = 5; n <= 8; n++) {
    await f.run("eight", s => s.consecutive_failures === n && (n < 8 || s.failure_alerted));
    expect(f.readCalls()).toHaveLength(n === 8 ? 1 : 0);
  }
  expect(opt(f.readCalls()[0]!.args, "--text")).toContain("paused after 8 failures");
});


test("maintenance is rechecked when a queued check gets a slot", async () => {
  const f = fixture({ ROBOB_WATCH_MAX_CONCURRENT: "1", ROBOB_WATCH_CHECK_TIMEOUT_MS: "5000" });
  f.add("a-blocker", { check: 'echo run >> "$WATCH_DIR/runs"; while [[ ! -f "$WATCH_DIR/release" ]]; do sleep 0.02; done' });
  f.add("z-ssd", { depends: ["ssd"] });
  const held = f.state("z-ssd");
  const child = f.start();
  await until(() => f.runs("a-blocker") === 1);
  expect(f.cli("maintenance", "on", "--depends", "ssd", "--for", "1h").exitCode).toBe(0);
  await until(() => f.readLog(child).includes("maintenance started"));
  writeFileSync(f.path("a-blocker", "release"), "");
  await until(() => existsSync(f.path("a-blocker", ".run-ok")));
  await Bun.sleep(100);
  expect(f.runs("z-ssd")).toBe(0);
  expect(f.state("z-ssd")).toEqual(held);
  expect(f.cli("maintenance", "off").exitCode).toBe(0);
  await until(() => f.state("z-ssd").consecutive_failures === 1);
  await f.stop(child);
  expect(f.runs("z-ssd")).toBe(1);
}, 20_000);

test("an in-flight event is held when maintenance begins before delivery", async () => {
  const f = fixture({ ROBOB_WATCH_CHECK_TIMEOUT_MS: "5000" });
  f.add("event", { depends: ["ssd"], check: 'echo run >> "$WATCH_DIR/runs"; while [[ ! -f "$WATCH_DIR/release" ]]; do sleep 0.02; done; echo held-event' });
  const child = f.start(); await until(() => f.runs("event") === 1);
  expect(f.cli("maintenance", "on", "--depends", "ssd", "--for", "1h").exitCode).toBe(0);
  await until(() => f.readLog(child).includes("maintenance started"));
  writeFileSync(f.path("event", "release"), "");
  await until(() => existsSync(f.path("event", ".run-ok")));
  expect(f.state("event").pending?.event).toBe("held-event");
  expect(f.readCalls()).toHaveLength(0);
  const held = f.state("event");
  await f.stop(child);
  expect(f.cli("maintenance", "off").exitCode).toBe(0);
  await f.run("event", s => s.fires === 1);
  expect(f.runs("event")).toBe(1);
  expect(opt(f.readCalls()[0]!.args, "--key")).toBe(held.pending!.key);
}, 20_000);

test.each(["alert", "escalation"])("legacy backoff %s cannot undo a concurrent resume", async phase => {
  const f = fixture();
  f.add("legacy", { max_consecutive_failures: 0, ...(phase === "escalation" ? { mode: "wake" } : {}) });
  f.save("legacy", { ...f.state("legacy"), consecutive_failures: 4, failure_alerted: phase === "escalation", failing_since: new Date(Date.now() - 16 * 60_000).toISOString() });
  writeFileSync(join(f.sandbox, "hold-send"), "");
  const child = f.start(); await until(() => f.readCalls().length > 0);
  expect(f.cli("resume", "legacy").exitCode).toBe(0);
  rmSync(join(f.sandbox, "hold-send"));
  await until(() => readFileSync(f.path("legacy", "log"), "utf8").includes("failure notice completed after resume/remove; state kept"));
  await f.stop(child);
  expect(f.state("legacy")).toMatchObject({ consecutive_failures: 0, failure_alerted: false, next_at: 0 });
  for (const field of ["failing_since", "last_error", "failure_escalated"] as const) expect(f.state("legacy")[field]).toBeUndefined();
});


test("pause escalation completion cannot undo a concurrent resume", async () => {
  const f = fixture(); f.add("paused-wake", { mode: "wake", max_consecutive_failures: 1 });
  writeFileSync(join(f.sandbox, "hold-wake"), "");
  const child = f.start();
  await until(() => f.readCalls().some(c => c.args[0] === "wake"));
  expect(f.cli("resume", "paused-wake").exitCode).toBe(0);
  rmSync(join(f.sandbox, "hold-wake"));
  await until(() => readFileSync(f.path("paused-wake", "log"), "utf8").includes("failure escalation ok=true"));
  await f.stop(child);
  expect(f.state("paused-wake")).toMatchObject({ consecutive_failures: 0, failure_alerted: false, next_at: 0 });
  expect(f.state("paused-wake").failure_paused_at).toBeUndefined();
  expect(f.state("paused-wake").failure_escalated).toBeUndefined();
});

const maintenanceFailureCases = (["ssd", "phone"] as const).flatMap(resource =>
  (["exit", "timeout"] as const).flatMap(failure =>
    (["off", "expiry"] as const).map(end => [resource, failure, end] as const)));

test.each(maintenanceFailureCases)("in-flight maintenance failure: %s %s %s", async (resource, failure, end) => {
  const f = fixture({ ROBOB_WATCH_CHECK_TIMEOUT_MS: "3000" });
  f.add("inflight", {
    mode: "wake", depends: [resource],
    ...(end === "expiry" ? { max_consecutive_failures: 0 } : {}),
    check: 'echo run >> "$WATCH_DIR/runs"; [[ -f "$WATCH_DIR/healthy" ]] && exit 0; while [[ ! -f "$WATCH_DIR/release" ]]; do sleep 0.02; done; '
      + (failure === "exit" ? 'echo resource missing >&2; exit 1' : 'sleep 30'),
  });
  const streak = { ...f.state("inflight"), consecutive_failures: 4, next_at: 0,
    failing_since: new Date(Date.now() - 16 * 60_000).toISOString(), last_error: "previous failure" };
  f.save("inflight", streak);
  const child = f.start();
  await until(() => f.runs("inflight") === 1);
  expect(f.cli("maintenance", "on", "--depends", resource, "--for", "1h").exitCode).toBe(0);
  await until(() => f.readLog(child).includes("maintenance started"));
  writeFileSync(f.path("inflight", "release"), "");
  await until(() => f.state("inflight").consecutive_failures !== 4
    || (existsSync(f.path("inflight", "log"))
      && readFileSync(f.path("inflight", "log"), "utf8").includes("check failure ignored during maintenance")));
  expect(f.state("inflight")).toMatchObject(streak);
  expect(f.state("inflight").failure_paused_at).toBeUndefined();
  expect(f.state("inflight").failure_escalated).toBeUndefined();
  expect(f.readCalls()).toHaveLength(0);
  expect(existsSync(f.path("inflight", ".run-ok"))).toBe(false);

  writeFileSync(f.path("inflight", "healthy"), "");
  if (end === "off") expect(f.cli("maintenance", "off").exitCode).toBe(0);
  else writeFileSync(join(f.root, "maintenance.json"), JSON.stringify({ until: new Date(0).toISOString(), reason: "expired", depends: [resource] }));
  await until(() => f.runs("inflight") === 2 && f.state("inflight").consecutive_failures === 0);
  await f.stop(child);
  expect(f.state("inflight").failure_paused_at).toBeUndefined();
  expect(f.state("inflight").failing_since).toBeUndefined();
  expect(f.readCalls()).toHaveLength(0);
}, 20_000);

test.each(["other resource", "no dependency"])("maintenance still counts unrelated in-flight failures: %s", async dependency => {
  const f = fixture({ ROBOB_WATCH_CHECK_TIMEOUT_MS: "5000" });
  f.add("unrelated", {
    ...(dependency === "other resource" ? { depends: ["phone"] } : {}),
    check: 'echo run >> "$WATCH_DIR/runs"; while [[ ! -f "$WATCH_DIR/release" ]]; do sleep 0.02; done; exit 1',
  });
  f.save("unrelated", { ...f.state("unrelated"), consecutive_failures: 4, failing_since: new Date().toISOString() });
  const child = f.start(); await until(() => f.runs("unrelated") === 1);
  expect(f.cli("maintenance", "on", "--depends", "ssd", "--for", "1h").exitCode).toBe(0);
  await until(() => f.readLog(child).includes("maintenance started"));
  writeFileSync(f.path("unrelated", "release"), "");
  await until(() => f.state("unrelated").failure_alerted);
  await f.stop(child);
  expect(f.state("unrelated").consecutive_failures).toBe(5);
  expect(f.state("unrelated").failure_paused_at).toBeString();
  expect(f.readCalls()).toHaveLength(1);
});
