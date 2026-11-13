import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, openSync, closeSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalize, type State } from "../src/lib.ts";
import { CheckSlots, checkTimeout, isMounted } from "../src/host.ts";

const fixtures: ReturnType<typeof fixture>[] = [];
function fixture(options: Record<string, string> = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), "watch-load-"));
  const root = join(sandbox, "root"), calls = join(sandbox, "calls"), stub = join(sandbox, "bridge.ts");
  writeFileSync(stub, `import {appendFileSync} from "node:fs";
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n"); console.log('{"created":true}');`);
  const env: Record<string, string | undefined> = { ...process.env, BUN_INSPECT: undefined, ROBOB_WATCH_ROOT: root,
    ROBOB_WATCH_TELEGRAM_CLI: stub, ROBOB_WATCH_SPECTRUM_CLI: stub,
    ROBOB_WATCH_BRIDGE_DB: join(sandbox, "absent.sqlite"), WACLI_STORE_DIR: join(sandbox, "wacli"),
    ROBOB_WATCH_LOAD_OVERRIDE: "0.1", ROBOB_WATCH_CHECK_TIMEOUT_MS: "40", ...options };
  const path = (id: string, file: string) => join(root, "watchers", id, file);
  const state = (id: string): State => JSON.parse(readFileSync(path(id, "state.json"), "utf8"));
  const save = (id: string, s: State) => writeFileSync(path(id, "state.json"), JSON.stringify(s));
  const add = (id: string, extra: Record<string, unknown> = {}) => {
    mkdirSync(join(root, "watchers", id), { recursive: true });
    writeFileSync(path(id, "watcher.json"), JSON.stringify(normalize({ id, title: id, mode: "notify", context: "Test", interval_s: 600, max_fires: 0, check: "sleep 3", ...extra })));
    save(id, { status: "active", fires: 0, consecutive_failures: 0, failure_alerted: false });
  };
  const cli = (...args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], { env });
  const runners: ReturnType<typeof Bun.spawn>[] = [], logs = new Map<ReturnType<typeof Bun.spawn>, string>();
  const start = (preload?: string) => {
    const file = join(sandbox, `runner-${runners.length}.log`), fd = openSync(file, "w");
    const child = Bun.spawn([process.execPath, ...(preload ? ["--preload", preload] : []), join(import.meta.dir, "../src/runner.ts")], { env, stdout: fd, stderr: fd });
    closeSync(fd); logs.set(child, file); runners.push(child); return child;
  };
  const readLog = (child: ReturnType<typeof start>) => readFileSync(logs.get(child)!, "utf8");
  const stop = async (child: ReturnType<typeof start>) => { child.kill(); await child.exited; };
  const run = async (id: string, complete: (s: State) => boolean) => {
    save(id, { ...state(id), next_at: 0 }); const child = start();
    try { await until(() => complete(state(id))); } finally { await stop(child); }
  };
  const f = { sandbox, root, env, path, state, save, add, cli, start, readLog, stop, run, runners,
    calls: () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : [] };
  fixtures.push(f); return f;
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!check()) { if (Date.now() >= deadline) throw new Error("Runner did not reach expected state"); await Bun.sleep(20); }
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    for (const child of f.runners) if (child.exitCode === null) await f.stop(child);
    rmSync(f.sandbox, { recursive: true, force: true });
  }
});

test.each(["0.1", "9"])("timeout clears the previous source summary at load %s", async (load) => {
  const f = fixture({ ROBOB_WATCH_LOAD_OVERRIDE: load });
  f.add("stale-source");
  f.save("stale-source", { ...f.state("stale-source"), last_error: 'source failure: {"outlook":"timeout"}', last_error_sources: ["outlook"] });
  await f.run("stale-source", s => load === "9" ? s.load_timeouts === 1 : s.consecutive_failures === 1 && s.failure_alerted);
  expect(f.state("stale-source").last_error_sources).toBeUndefined();
  expect(f.state("stale-source").last_error).toContain("timed out");
});

test("a: per-watcher timeout overrides the default and reports the actual timeout", async () => {
  const f = fixture(); f.add("short", { timeout_s: 1 }); f.add("long", { timeout_s: 5 });
  const child = f.start(); await until(() => f.state("short").consecutive_failures === 1 && existsSync(f.path("long", ".run-ok"))); await f.stop(child);
  expect(f.state("short").last_error).toBe("timed out after 1s"); expect(f.state("long").consecutive_failures).toBe(0);
}, 15_000);

test("b: repeated load timeouts never count, alert, escalate or pause", async () => {
  const f = fixture({ ROBOB_WATCH_LOAD_OVERRIDE: "9" }); f.add("loaded", { mode: "wake", max_consecutive_failures: 2 });
  for (let n = 1; n <= 6; n++) await f.run("loaded", s => s.load_timeouts === n);
  const s = f.state("loaded"); expect(s.consecutive_failures).toBe(0); expect(s.failing_since).toBeUndefined();
  expect(s.failure_paused_at).toBeUndefined(); expect(s.failure_escalated).toBeUndefined(); expect(f.calls()).toHaveLength(0);
  expect(s.load_timeout_since).toBeString(); expect(s.last_error).toBe("timed out after 0.12s under host load 9.0/core");
  expect(s.next_at! - Date.now()).toBeGreaterThan(115_000); expect(s.next_at! - Date.now()).toBeLessThanOrEqual(120_000);
  for (const args of [["list"], ["show", "loaded"]]) expect(f.cli(...args).stdout.toString()).toContain("load-timeouts 6");
  expect(f.cli("resume", "loaded").exitCode).toBe(0); expect(f.state("loaded").load_timeouts).toBeUndefined(); expect(f.state("loaded").load_timeout_since).toBeUndefined();
}, 15_000);

test("c: a 61-minute load timeout streak enters the normal failure path", async () => {
  const f = fixture({ ROBOB_WATCH_LOAD_OVERRIDE: "9" }); f.add("hung");
  f.save("hung", { ...f.state("hung"), load_timeouts: 10, load_timeout_since: new Date(Date.now() - 61 * 60_000).toISOString() });
  await f.run("hung", s => s.consecutive_failures === 1);
  expect(f.state("hung").last_error).toBe("timed out after 0.12s"); expect(f.state("hung").failing_since).toBeString();
});

test("grace safety valve still alerts, pauses and escalates a hung wake check", async () => {
  const f = fixture({ ROBOB_WATCH_LOAD_OVERRIDE: "9", ROBOB_WATCH_LOAD_GRACE_MS: "1" }); f.add("hung", { mode: "wake", max_consecutive_failures: 1 });
  f.save("hung", { ...f.state("hung"), consecutive_failures: 1, failing_since: new Date(Date.now() - 16 * 60_000).toISOString(), load_timeouts: 5, load_timeout_since: new Date(Date.now() - 1000).toISOString() });
  await f.run("hung", s => !!s.failure_paused_at && s.failure_alerted && !!s.failure_escalated);
  expect(f.state("hung").consecutive_failures).toBe(2); expect(f.calls()).toHaveLength(2);
});

test("d: low-load timeouts count as failures", async () => {
  const f = fixture(); f.add("low"); await f.run("low", s => s.consecutive_failures === 1);
  expect(f.state("low").last_error).toBe("timed out after 0.04s"); expect(f.state("low").load_timeouts).toBeUndefined();
});

test("e: high load triples a 1s timeout, allowing a 2s check to succeed", async () => {
  const f = fixture({ ROBOB_WATCH_LOAD_OVERRIDE: "9" }); f.add("slow", { timeout_s: 1, check: "sleep 2" });
  await f.run("slow", () => existsSync(f.path("slow", ".run-ok"))); expect(f.state("slow").consecutive_failures).toBe(0);
  expect(checkTimeout(normalize({ id: "cap", title: "cap", check: "true", mode: "notify", timeout_s: 600 }), 9)).toBe(300_000);
}, 15_000);

test("f: four high-load checks never overlap more than two at once", async () => {
  const f = fixture({ ROBOB_WATCH_LOAD_OVERRIDE: "9", ROBOB_WATCH_MAX_CONCURRENT_UNDER_LOAD: "2" }), ids = ["one", "two", "three", "four"];
  for (const id of ids) f.add(id, { timeout_s: 5, check: 'zmodload zsh/datetime; print "$EPOCHREALTIME start $WATCH_ID" >> "$WATCH_DIR/../../timeline"; sleep 0.3; print "$EPOCHREALTIME end $WATCH_ID" >> "$WATCH_DIR/../../timeline"' });
  const child = f.start(); await until(() => ids.every(id => existsSync(f.path(id, ".run-ok")))); await f.stop(child);
  const events = readFileSync(join(f.root, "timeline"), "utf8").trim().split("\n").map(line => line.split(" ")).sort((a, b) => Number(a[0]) - Number(b[0]));
  let active = 0, peak = 0; for (const event of events) { active += event[1] === "start" ? 1 : -1; peak = Math.max(peak, active); }
  expect(events).toHaveLength(8); expect(peak).toBe(2); expect(active).toBe(0);
});

test("slot cap changes live, preserving running checks and opening slots on recovery", async () => {
  let cap = 4; const slots = new CheckSlots(() => cap), active = new Set<number>(), releases: (() => void)[] = [];
  const jobs = Array.from({ length: 6 }, (_, i) => slots.run(async () => { active.add(i); await new Promise<void>(resolve => { releases[i] = resolve; }); active.delete(i); }));
  await Promise.resolve(); expect([...active]).toEqual([0, 1, 2, 3]); cap = 2;
  releases[0]!(); releases[1]!(); await Promise.resolve(); await Promise.resolve(); expect([...active]).toEqual([2, 3]);
  cap = 4; slots.drain(); await Promise.resolve(); expect([...active]).toEqual([2, 3, 4, 5]);
  for (const i of [2, 3, 4, 5]) releases[i]!(); await Promise.all(jobs);
});

test("g: an unmounted SSD holds checks, counts, schedule and pending deliveries until remounted", async () => {
  const f = fixture(), mount = join(f.sandbox, "ssd"); f.env.ROBOB_WATCH_SSD_PATH = mount;
  mkdirSync(mount); expect(isMounted(mount)).toBe(false); expect(isMounted("/dev")).toBe(true);
  f.add("ssd", { depends: ["ssd"], check: "true" }); f.add("pending", { depends: ["ssd"], check: "exit 99" }); f.add("plain", { check: "true" });
  f.save("ssd", { ...f.state("ssd"), consecutive_failures: 3, next_at: 0 });
  f.save("pending", { ...f.state("pending"), pending: { key: "held-key", event: "held-event", at: new Date().toISOString() } });
  const before = f.state("ssd"), pending = f.state("pending");
  const child = f.start(); await until(() => existsSync(f.path("plain", ".run-ok")));
  expect(f.state("ssd")).toEqual(before); expect(f.state("pending")).toEqual(pending); expect(f.calls()).toHaveLength(0);
  // /dev is a real mount on macOS/Linux. No production mount override is needed.
  rmSync(mount, { recursive: true }); symlinkSync("/dev", mount);
  await until(() => existsSync(f.path("ssd", ".run-ok")) && f.state("pending").fires === 1); await f.stop(child);
  expect(f.state("ssd").consecutive_failures).toBe(0); expect(f.calls()).toHaveLength(1); expect(f.calls()[0]).toContain("held-key");
  expect(f.readLog(child).match(/SSD missing/g)).toHaveLength(1); expect(f.readLog(child).match(/SSD mounted again/g)).toHaveLength(1);
}, 15_000);

test("h: normalize keeps only integer timeout_s values in 1–600", () => {
  const base = { id: "valid", title: "valid", check: "true", mode: "notify" as const };
  expect(normalize(base).timeout_s).toBeUndefined();
  for (const timeout_s of [1, 60, 600]) expect(normalize({ ...base, timeout_s }).timeout_s).toBe(timeout_s);
  for (const timeout_s of [0, 601, "60", null, true, 1.5, -1, NaN, Infinity]) expect(() => normalize({ ...base, timeout_s } as never)).toThrow("timeout_s");
});

test.each(["true", "exit 7"])("success/non-timeout exit clears load streak: %s", async check => {
  const f = fixture({ ROBOB_WATCH_LOAD_OVERRIDE: "9" }); f.add("clear", { check, max_consecutive_failures: 1 });
  f.save("clear", { ...f.state("clear"), load_timeouts: 3, load_timeout_since: new Date().toISOString() });
  await f.run("clear", s => check === "true" ? existsSync(f.path("clear", ".run-ok")) : s.failure_alerted);
  const s = f.state("clear"); expect(s.load_timeouts).toBeUndefined(); expect(s.load_timeout_since).toBeUndefined();
  if (check !== "true") { expect(s.consecutive_failures).toBe(1); expect(s.last_error).toContain("exit 7"); expect(s.failure_paused_at).toBeString(); expect(f.calls()).toHaveLength(1); }
});

test.each(["0.1", "9"])("load at either endpoint grants timeout immunity: starts at %s", async initial => {
  const f = fixture({ ROBOB_WATCH_LOAD_OVERRIDE: initial, ROBOB_WATCH_CHECK_TIMEOUT_MS: "2000" });
  const control = join(f.sandbox, "load"), preload = join(f.sandbox, "load.ts"); writeFileSync(control, initial);
  writeFileSync(preload, `import {readFileSync} from "node:fs"; setInterval(() => { process.env.ROBOB_WATCH_LOAD_OVERRIDE = readFileSync(${JSON.stringify(control)}, "utf8"); }, 20);`);
  f.add("edge", { check: 'echo started > "$WATCH_DIR/started"; sleep 10' });
  const child = f.start(preload); await until(() => existsSync(f.path("edge", "started"))); writeFileSync(control, initial === "9" ? "0.1" : "9");
  await until(() => f.state("edge").load_timeouts === 1); await f.stop(child);
  expect(f.state("edge").consecutive_failures).toBe(0); expect(f.state("edge").last_error).toContain("9.0/core"); expect(f.calls()).toHaveLength(0);
  expect(f.readLog(child).match(/host load mode started/g)).toHaveLength(1);
  if (initial === "9") expect(f.readLog(child).match(/host load mode ended/g)).toHaveLength(1);
}, 15_000);

test("CLI preserves timeout_s on flag replacement and uses it for scratch tests", async () => {
  const f = fixture(); f.add("config", { timeout_s: 1, check: "sleep 2" });
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "test", "config"], { env: f.env, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(1); expect(JSON.parse(await new Response(child.stdout).text()).timedOut).toBe(true);
  expect(f.cli("add", "--id", "config", "--title", "config", "--check", "true", "--mode", "notify", "--replace").exitCode).toBe(0);
  expect(JSON.parse(readFileSync(f.path("config", "watcher.json"), "utf8")).timeout_s).toBe(1);
});

test.each(["exit 7", "sleep 10", "echo event"])("SSD removal during a check uses the maintenance hold path: %s", async end => {
  const f = fixture({ ROBOB_WATCH_CHECK_TIMEOUT_MS: "3000" }), mount = join(f.sandbox, "ssd");
  symlinkSync("/dev", mount); f.env.ROBOB_WATCH_SSD_PATH = mount;
  f.add("inflight", { depends: ["ssd"], check: 'echo started > "$WATCH_DIR/started"; while [[ ! -f "$WATCH_DIR/release" ]]; do sleep 0.02; done; ' + end });
  f.save("inflight", { ...f.state("inflight"), consecutive_failures: 4, failing_since: new Date(Date.now() - 16 * 60_000).toISOString(), load_timeouts: 3, load_timeout_since: new Date().toISOString() });
  const child = f.start(); await until(() => existsSync(f.path("inflight", "started")));
  rmSync(mount); mkdirSync(mount);
  await until(() => f.readLog(child).includes("SSD missing")); writeFileSync(f.path("inflight", "release"), "");
  await until(() => existsSync(f.path("inflight", "log")) && readFileSync(f.path("inflight", "log"), "utf8").includes(end === "echo event" ? "event: event" : "check failure ignored while SSD is unmounted"));
  await f.stop(child);
  expect(f.calls()).toHaveLength(0); expect(f.state("inflight").failure_paused_at).toBeUndefined();
  if (end === "echo event") expect(f.state("inflight").pending?.event).toBe("event");
  else { expect(f.state("inflight").consecutive_failures).toBe(4); expect(f.state("inflight").load_timeouts).toBe(3); expect(f.state("inflight").next_at).toBe(0); }
}, 15_000);

const pipeExitCases = [0, 7, 127].flatMap(code => ["stdout", "stderr"].map(pipe => [code, pipe] as const));
test.each(pipeExitCases)("known exit %s with a descendant holding %s past timeout", async (code, pipe) => {
  const f = fixture({ ROBOB_WATCH_LOAD_OVERRIDE: "9" });
  f.add("pipe", { max_consecutive_failures: 1, check: `/bin/sleep 2 ${pipe === "stdout" ? "2>/dev/null" : ">/dev/null"} & exit ${code}` });
  f.save("pipe", { ...f.state("pipe"), load_timeouts: 3, load_timeout_since: new Date().toISOString() });
  await f.run("pipe", s => code ? s.failure_alerted : s.load_timeouts === 4);
  const s = f.state("pipe");
  if (code) {
    expect(s.consecutive_failures).toBe(1); expect(s.last_error).toContain(`exit ${code}:`);
    expect(s.load_timeouts).toBeUndefined(); expect(s.load_timeout_since).toBeUndefined();
    expect(s.failure_paused_at).toBeString(); expect(f.calls()).toHaveLength(1);
  } else {
    expect(s.consecutive_failures).toBe(0); expect(s.last_error).toContain("under host load"); expect(f.calls()).toHaveLength(0);
  }
});

test.each(pipeExitCases)("known exit %s survives kill grace with detached descendant holding %s", async (code, pipe) => {
  const f = fixture({ ROBOB_WATCH_LOAD_OVERRIDE: "9" });
  const detached = `/usr/bin/perl -e 'setpgrp; open my $f, ">", $ENV{WATCH_DIR}."/detached" or die $!; print $f $$; close $f; sleep 30' ${pipe === "stdout" ? "2>/dev/null" : ">/dev/null"} &`;
  f.add("grace", { max_consecutive_failures: 1, check: detached + ' while [[ ! -f "$WATCH_DIR/detached" ]]; do sleep 0.01; done; exit ' + code });
  f.save("grace", { ...f.state("grace"), load_timeouts: 3, load_timeout_since: new Date().toISOString() });
  try {
    await f.run("grace", s => code ? s.failure_alerted : s.load_timeouts === 4);
    const s = f.state("grace"); expect(s.last_run_ms!).toBeGreaterThanOrEqual(5000);
    if (code) {
      expect(s.consecutive_failures).toBe(1); expect(s.last_error).toContain(`exit ${code}:`);
      expect(s.load_timeouts).toBeUndefined(); expect(s.load_timeout_since).toBeUndefined(); expect(s.failure_paused_at).toBeString(); expect(f.calls()).toHaveLength(1);
    } else { expect(s.consecutive_failures).toBe(0); expect(s.last_error).toContain("under host load"); expect(f.calls()).toHaveLength(0); }
  } finally {
    // This is the PID captured from this fixture's own escaped child, which group cleanup cannot reach.
    if (existsSync(f.path("grace", "detached"))) {
      const pid = Number(readFileSync(f.path("grace", "detached"), "utf8"));
      try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
    }
  }
}, 15_000);
