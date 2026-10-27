import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Drives the real runner and CLI against a sandbox root with stub bridge CLIs; nothing is sent anywhere.
const sandbox = mkdtempSync(join(tmpdir(), "robob-watch-test-"));
const calls = join(sandbox, "calls.log");
const stub = (name: string, failOn: string) => {
  const path = join(sandbox, `${name}.ts`);
  writeFileSync(path, `import { appendFileSync, existsSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ cli: ${JSON.stringify(name)}, args }) + "\\n");
if (existsSync(${JSON.stringify(join(sandbox, "fail-"))} + args[0])) { console.error("stub failure"); process.exit(1); }
console.log(JSON.stringify({ id: "x", created: true }));
void ${JSON.stringify(failOn)};`);
  return path;
};
const db = join(sandbox, "bridge.sqlite");
Bun.spawnSync(["/usr/bin/sqlite3", db, `create table kv (key text primary key, value text); create table inbound (id text primary key, payload text, state text); insert into kv values ('route', '{"id":"ses_live123","generation":1}');`]);
const env = { ...process.env, ROBOB_WATCH_ROOT: join(sandbox, "root"), ROBOB_WATCH_SPECTRUM_CLI: stub("spectrum", ""),
  ROBOB_WATCH_TELEGRAM_CLI: stub("telegram", ""), ROBOB_WATCH_BRIDGE_DB: db,
  ROBOB_WATCH_HEADSUP_MS: "1000", WACLI_STORE_DIR: join(sandbox, "wacli") };
// Checks put the sandbox helpers first on PATH: a logging-only wa there keeps any check that drafts away from the real one.
const waCalls = join(sandbox, "wa-calls.log");
mkdirSync(join(sandbox, "root/helpers"), { recursive: true });
writeFileSync(join(sandbox, "root/helpers/wa"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(waCalls)}\n`, { mode: 0o755 });
const cli = (...args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], { env });
const readCalls = () => (existsSync(calls) ? readFileSync(calls, "utf8") : "").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { cli: string; args: string[] });
const optIn = (id: string) => { const f = join(sandbox, "root/watchers", id, "watcher.json"); writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), headsup: true })); };
const state = (id: string) => JSON.parse(readFileSync(join(sandbox, "root/watchers", id, "state.json"), "utf8"));

async function runnerFor(ms: number) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/runner.ts")], { env, stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(ms);
  child.kill();
  await child.exited;
}

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

test("a wake watcher fires once with its context, falling back to send when wake is unavailable, then disables", async () => {
  const flag = join(sandbox, "event");
  const add = cli("add", "--id", "demo", "--title", "Demo event", "--check", `[[ -f ${flag} ]] && cat ${flag}; true`,
    "--interval", "10", "--context", "Owner wants to know when demo happens. Tell him; do nothing else.", "--expires", "1d");
  expect(add.exitCode).toBe(0);
  expect(JSON.parse(add.stdout.toString()).prime).toContain("nothing new");
  writeFileSync(join(sandbox, "fail-wake"), "");
  writeFileSync(flag, "demo happened");
  await runnerFor(2_500);
  const all = readCalls();
  const wake = all.find(call => call.args[0] === "wake")!;
  expect(wake.args).toContain("robob-watch demo");
  const text = wake.args[wake.args.indexOf("--text") + 1]!;
  expect(text).toContain("Demo event");
  expect(text).toContain("demo happened");
  expect(text).toContain("Owner wants to know when demo happens");
  const send = all.find(call => call.args[0] === "send")!;
  expect(send.args).toContain("ses_live123");
  expect(send.args[send.args.indexOf("--key") + 1]).toBe(wake.args[wake.args.indexOf("--key") + 1]);
  expect(all.some(call => call.cli === "telegram")).toBe(false);
  expect(state("demo")).toMatchObject({ status: "done", fires: 1, last_delivery: "imessage-send" });
  expect(state("demo").pending).toBeUndefined();
}, 20_000);

test("an undelivered event is kept and retried under the same key before the check runs again", async () => {
  writeFileSync(calls, "");
  for (const name of ["wake", "send", "notify"]) writeFileSync(join(sandbox, `fail-${name}`), "");
  const add = cli("add", "--id", "retry", "--title", "Retry", "--check", "echo event-1", "--interval", "10", "--mode", "notify", "--no-prime");
  expect(add.exitCode).toBe(0);
  await runnerFor(2_500);
  const pending = state("retry").pending;
  expect(pending.event).toBe("event-1");
  expect(state("retry").fires).toBe(0);
  rmSync(join(sandbox, "fail-notify"));
  const s = state("retry");
  s.next_at = 0;
  writeFileSync(join(sandbox, "root/watchers/retry/state.json"), JSON.stringify(s));
  await runnerFor(2_500);
  const tg = readCalls().filter(call => call.cli === "telegram");
  expect(tg.at(-1)!.args[tg.at(-1)!.args.indexOf("--key") + 1]).toBe(pending.key);
  expect(state("retry")).toMatchObject({ status: "done", fires: 1, last_delivery: "telegram" });
}, 20_000);

test("quiet hours hold an event, new or retried, under its key and deliver it once they end", async () => {
  writeFileSync(calls, "");
  for (const name of ["wake", "send", "notify"]) rmSync(join(sandbox, `fail-${name}`), { force: true });
  const hour = new Date().getUTCHours();
  const window = (from: number) => ({ start: (hour + from + 24) % 24, end: (hour + from + 2 + 24) % 24, time_zone: "UTC" });
  const def = { id: "hush", title: "Hush", check: "echo quiet-event", interval_s: 10, mode: "notify", context: "x",
    expires_at: "1d", max_fires: 1, quiet: window(0) };
  const add = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), "add", "--json", "-", "--no-prime"],
    { env, stdin: new TextEncoder().encode(JSON.stringify(def)) });
  expect(add.exitCode).toBe(0);
  await runnerFor(2_500);
  const held = state("hush");
  expect(held.pending.event).toBe("quiet-event");
  expect(held.fires).toBe(0);
  expect(readCalls().some(call => call.args.join(" ").includes("quiet-event"))).toBe(false);
  const file = join(sandbox, "root/watchers/hush/watcher.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), quiet: window(3) }));
  writeFileSync(join(sandbox, "root/watchers/hush/state.json"), JSON.stringify({ ...state("hush"), next_at: 0 }));
  await runnerFor(2_500);
  const sent = readCalls().filter(call => call.args.join(" ").includes("quiet-event"));
  expect(sent).toHaveLength(1);
  expect(sent[0]!.args[sent[0]!.args.indexOf("--key") + 1]).toBe(held.pending.key);
  expect(state("hush")).toMatchObject({ status: "done", fires: 1 });
}, 20_000);

test("failing checks back off and alert once; expired watchers switch off with a notice", async () => {
  writeFileSync(calls, "");
  for (const name of ["wake", "send", "notify"]) rmSync(join(sandbox, `fail-${name}`), { force: true });
  expect(cli("add", "--id", "broken", "--title", "Broken", "--check", "exit 3", "--mode", "notify", "--no-prime").exitCode).toBe(0);
  const dir = join(sandbox, "root/watchers/broken");
  writeFileSync(join(dir, "state.json"), JSON.stringify({ status: "active", fires: 0, consecutive_failures: 4, failure_alerted: false }));
  await runnerFor(2_000);
  expect(state("broken")).toMatchObject({ consecutive_failures: 5, failure_alerted: true });
  expect(state("broken").next_at - Date.now()).toBeGreaterThan(200_000);
  expect(readCalls().filter(call => call.cli === "telegram")).toHaveLength(1);

  mkdirSync(join(sandbox, "root/watchers/old"), { recursive: true });
  expect(cli("add", "--id", "old", "--title", "Old", "--check", "true", "--mode", "notify", "--no-prime", "--replace").exitCode).toBe(0);
  const def = JSON.parse(readFileSync(join(sandbox, "root/watchers/old/watcher.json"), "utf8"));
  writeFileSync(join(sandbox, "root/watchers/old/watcher.json"), JSON.stringify({ ...def, expires_at: new Date(Date.now() - 1000).toISOString() }));
  await runnerFor(2_000);
  expect(state("old").status).toBe("expired");
  expect(readCalls().some(call => call.cli === "telegram" && call.args.join(" ").includes("expired"))).toBe(true);
}, 20_000);

test("a wake watcher failing 15+ min wakes the agent once per failure run, caps its backoff at 5 min, and resets on recovery", async () => {
  writeFileSync(calls, "");
  for (const name of ["wake", "send", "notify"]) rmSync(join(sandbox, `fail-${name}`), { force: true });
  const flag = join(sandbox, "esc-ok");
  expect(cli("add", "--id", "esc", "--title", "Esc", "--check", `[[ -f ${flag} ]] || { echo "wacli sync daemon is not running" >&2; exit 1; }`,
    "--interval", "30", "--context", "Owner waits for a reply.", "--no-prime").exitCode).toBe(0);
  const file = join(sandbox, "root/watchers/esc/state.json");
  // Failing 5 min: no escalation yet.
  writeFileSync(file, JSON.stringify({ status: "active", fires: 0, consecutive_failures: 7, failure_alerted: true,
    failing_since: new Date(Date.now() - 5 * 60_000).toISOString() }));
  await runnerFor(2_000);
  expect(readCalls().filter(call => call.args[0] === "wake")).toHaveLength(0);
  expect(state("esc").next_at - Date.now()).toBeLessThanOrEqual(300_000);
  // Failing 16 min: one wake with the error and repair instructions.
  writeFileSync(file, JSON.stringify({ ...state("esc"), next_at: 0, failing_since: new Date(Date.now() - 16 * 60_000).toISOString() }));
  await runnerFor(2_000);
  const wakes = readCalls().filter(call => call.args[0] === "wake");
  expect(wakes).toHaveLength(1);
  const text = wakes[0]!.args[wakes[0]!.args.indexOf("--text") + 1]!;
  expect(text).toContain("FAILING for 16 min");
  expect(text).toContain("wacli sync daemon is not running");
  expect(text).toContain("robob-watch resume esc");
  expect(state("esc").failure_escalated).toBe(true);
  // Still failing: not woken again.
  writeFileSync(file, JSON.stringify({ ...state("esc"), next_at: 0 }));
  await runnerFor(2_000);
  expect(readCalls().filter(call => call.args[0] === "wake")).toHaveLength(1);
  // Recovery clears the flag.
  writeFileSync(flag, "");
  writeFileSync(file, JSON.stringify({ ...state("esc"), next_at: 0 }));
  await runnerFor(2_000);
  expect(state("esc").failure_escalated).toBeUndefined();
  expect(state("esc").consecutive_failures).toBe(0);
  // Notify watchers never escalate.
  expect(cli("add", "--id", "escn", "--title", "EscN", "--check", "exit 1", "--mode", "notify", "--no-prime").exitCode).toBe(0);
  writeFileSync(join(sandbox, "root/watchers/escn/state.json"), JSON.stringify({ status: "active", fires: 0, consecutive_failures: 9,
    failure_alerted: true, failing_since: new Date(Date.now() - 60 * 60_000).toISOString() }));
  await runnerFor(2_000);
  expect(readCalls().filter(call => call.args[0] === "wake")).toHaveLength(1);
}, 30_000);

test("validation: wake watchers need context, interval has a floor, ids are strict", () => {
  expect(cli("add", "--id", "x", "--title", "t", "--check", "true").stderr.toString()).toContain("wake watchers need context");
  expect(cli("add", "--id", "x", "--title", "t", "--check", "true", "--mode", "notify", "--interval", "4").stderr.toString()).toContain("interval_s");
  expect(cli("add", "--id", "Bad_Id", "--title", "t", "--check", "true", "--mode", "notify").stderr.toString()).toContain("id must be");
  const test = cli("test", "demo");
  expect(JSON.parse(test.stdout.toString())).toMatchObject({ exit: 0 });
});

test("a wake still queued after the heads-up delay gets exactly one plain text; a consumed one gets nothing", async () => {
  writeFileSync(calls, "");
  for (const name of ["wake", "send", "notify"]) rmSync(join(sandbox, `fail-${name}`), { force: true });
  for (const id of ["busy", "idle"]) {
    expect(cli("add", "--id", id, "--title", `Title ${id}`, "--check", `echo ${id} happened`, "--interval", "10",
      "--context", "Tell the owner.", "--no-prime").exitCode).toBe(0);
    optIn(id);
  }
  await runnerFor(2_500);
  const busy = state("busy").wakes;
  const idle = state("idle").wakes;
  expect(busy).toHaveLength(1);
  expect(state("busy")).toMatchObject({ status: "done", last_delivery: "wake" });
  const wakeKey = readCalls().find(call => call.args[0] === "wake" && call.args.includes("robob-watch busy"))!;
  expect(busy[0].inbound).toBe(`wake:${new Bun.CryptoHasher("sha256").update(wakeKey.args[wakeKey.args.indexOf("--key") + 1]!).digest("hex")}`);
  Bun.spawnSync(["/usr/bin/sqlite3", db, `insert into inbound values ('${busy[0].inbound}', '{}', 'pending'); insert into inbound values ('${idle[0].inbound}', '{}', 'done');`]);
  await Bun.sleep(1_100);
  writeFileSync(calls, "");
  await runnerFor(2_500);
  const sends = readCalls().filter(call => call.args[0] === "send");
  expect(sends).toHaveLength(1);
  const text = sends[0]!.args[sends[0]!.args.indexOf("--text") + 1]!;
  expect(text).toBe("Heads-up from watcher Title busy: busy happened. I'll follow up properly when I'm free.");
  expect(sends[0]!.args).toContain("ses_live123");
  expect(state("busy").wakes).toBeUndefined();
  expect(state("idle").wakes).toBeUndefined();
  expect(readFileSync(join(sandbox, "root/watchers/idle/log"), "utf8")).toContain("consumed (done)");
  // Still pending, but never sent twice.
  await runnerFor(2_000);
  expect(readCalls().filter(call => call.args[0] === "send")).toHaveLength(1);
}, 20_000);

test("a heads-up whose iMessage send fails falls back to telegram", async () => {
  writeFileSync(calls, "");
  expect(cli("add", "--id", "fallback", "--title", "Fallback", "--check", "echo fb", "--interval", "10",
    "--context", "Tell the owner.", "--no-prime").exitCode).toBe(0);
  optIn("fallback");
  await runnerFor(2_500);
  const tracked = state("fallback").wakes[0];
  Bun.spawnSync(["/usr/bin/sqlite3", db, `insert into inbound values ('${tracked.inbound}', '{}', 'pending');`]);
  writeFileSync(join(sandbox, "fail-send"), "");
  await Bun.sleep(1_100);
  await runnerFor(2_500);
  rmSync(join(sandbox, "fail-send"));
  const tg = readCalls().filter(call => call.cli === "telegram");
  expect(tg).toHaveLength(1);
  expect(tg[0]!.args.join(" ")).toContain("Heads-up from watcher Fallback");
  expect(state("fallback").wakes).toBeUndefined();
}, 20_000);

test("the runner gives each check a WATCH_RUN id and acks it in .run-ok only after recording the output", async () => {
  expect(cli("add", "--id", "runid", "--title", "Run id", "--check", `print -r -- "$WATCH_RUN" >> runs; true`, "--mode", "notify",
    "--interval", "600", "--context", "x", "--expires", "1d").exitCode).toBe(0);
  const dir = join(sandbox, "root/watchers/runid");
  const prime = readFileSync(join(dir, "runs"), "utf8").trim();
  expect(prime).toStartWith("prime-");
  await runnerFor(2_000);
  const runs = readFileSync(join(dir, "runs"), "utf8").trim().split("\n");
  expect(runs).toHaveLength(2);
  expect(readFileSync(join(dir, ".run-ok"), "utf8").trim()).toBe(runs[1]!);
}, 20_000);

test("a trigger file runs the check within a couple of seconds, long before its interval", async () => {
  const trig = join(sandbox, "trigger-file");
  const flag = join(sandbox, "trig-event");
  writeFileSync(trig, "0");
  const add = cli("add", "--id", "trig", "--title", "Triggered", "--check", `[[ -f ${flag} ]] && cat ${flag} && rm ${flag}; true`,
    "--interval", "600", "--trigger", trig, "--max-fires", "0", "--context", "Test trigger watcher.", "--expires", "1d");
  expect(add.exitCode).toBe(0);
  const runner = Bun.spawn([process.execPath, join(import.meta.dir, "../src/runner.ts")], { env, stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(2_500); // first run consumes next_at=0 and records the trigger signature
  expect(state("trig").fires).toBe(0);
  writeFileSync(flag, "triggered event");
  writeFileSync(trig, "12");
  await Bun.sleep(3_000);
  runner.kill();
  await runner.exited;
  expect(state("trig").fires).toBe(1);
  expect(readCalls().some(call => call.args.includes("robob-watch trig"))).toBe(true);
}, 20_000);

test("timeouts are transient: no alert before 10 min of failing, fast retry; a real error still alerts after 5", async () => {
  writeFileSync(calls, "");
  for (const name of ["wake", "send", "notify"]) rmSync(join(sandbox, `fail-${name}`), { force: true });
  const slowEnv = { ...env, ROBOB_WATCH_CHECK_TIMEOUT_MS: "300" };
  const runSlow = async (ms: number) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/runner.ts")], { env: slowEnv, stdout: "ignore", stderr: "ignore" });
    await Bun.sleep(ms);
    child.kill();
    await child.exited;
  };
  expect(cli("add", "--id", "slow", "--title", "Slow", "--check", "sleep 5", "--mode", "notify", "--interval", "30", "--no-prime").exitCode).toBe(0);
  const file = join(sandbox, "root/watchers/slow/state.json");
  // Failing x4 for 2 minutes: the 5th timeout must not alert yet, and must retry within 2 min, not 30s x 8 = 4 min.
  writeFileSync(file, JSON.stringify({ status: "active", fires: 0, consecutive_failures: 4, failure_alerted: false,
    failing_since: new Date(Date.now() - 120_000).toISOString() }));
  await runSlow(2_000);
  expect(state("slow")).toMatchObject({ consecutive_failures: 5, failure_alerted: false });
  expect(state("slow").next_at - Date.now()).toBeLessThanOrEqual(120_000);
  expect(readCalls().filter(call => call.cli === "telegram")).toHaveLength(0);
  // The same run of timeouts, 11 minutes long: now it alerts once.
  writeFileSync(file, JSON.stringify({ ...state("slow"), next_at: 0, failing_since: new Date(Date.now() - 11 * 60_000).toISOString() }));
  await runSlow(2_000);
  expect(state("slow")).toMatchObject({ consecutive_failures: 6, failure_alerted: true });
  expect(readCalls().filter(call => call.cli === "telegram")).toHaveLength(1);
}, 20_000);

test("checks run with bounded concurrency; queue time does not count against the timeout; runs are timed", async () => {
  const capEnv = { ...env, ROBOB_WATCH_MAX_CONCURRENT: "2", ROBOB_WATCH_CHECK_TIMEOUT_MS: "1500" };
  const marks = join(sandbox, "conc");
  writeFileSync(marks, "");
  for (const i of [1, 2, 3, 4]) {
    expect(cli("add", "--id", `conc${i}`, "--title", `C${i}`, "--mode", "notify", "--interval", "600", "--no-prime",
      "--check", `print start >> ${marks}; sleep 1; print end >> ${marks}`).exitCode).toBe(0);
  }
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/runner.ts")], { env: capEnv, stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(4_500);
  child.kill();
  await child.exited;
  // Never more than 2 overlapping, and the queued ones (waiting ~1s) still finish without timing out.
  let live = 0, peak = 0;
  for (const line of readFileSync(marks, "utf8").trim().split("\n")) { live += line === "start" ? 1 : -1; peak = Math.max(peak, live); }
  expect(peak).toBe(2);
  for (const i of [1, 2, 3, 4]) {
    expect(state(`conc${i}`).consecutive_failures).toBe(0);
    expect(state(`conc${i}`).last_run_ms).toBeGreaterThanOrEqual(900);
  }
}, 20_000);

test("relays: one stop reaches every watcher of the trip, and ETA updates to a person are throttled", () => {
  const pam = { to: "120363@g.us", name: "Pam group", quote: "Keep Pam's group posted", at: "2026-10-19T04:00:00Z" };
  const cars = { to: "971501234567@s.whatsapp.net", name: "ComfortCars", quote: "Send the driver the landing time", at: "2026-10-19T04:00:00Z" };
  const add = (id: string, relays: unknown[], ...extra: string[]) => {
    const file = join(sandbox, `${id}.json`);
    writeFileSync(file, JSON.stringify({ id, title: id, check: "true", mode: "wake", context: "On a change, wa draft then wa send --approved.",
      trip: "dus-oct", relays }));
    return cli("add", "--json", file, "--no-prime", ...extra);
  };
  expect(add("ek57", [pam, cars]).exitCode).toBe(0);
  expect(add("ek58", [pam]).exitCode).toBe(0);
  const ok = (id: string, to: string, eta?: string) => {
    const run = cli("relay-ok", id, "--to", to, ...(eta ? ["--eta", eta] : []));
    return { code: run.exitCode, out: run.stdout.toString() };
  };
  expect(ok("ek57", "+971 50 123 4567", "2026-10-23T19:03:00Z")).toMatchObject({ code: 0, out: expect.stringContaining("ok: send to ComfortCars") });
  // 23 Oct: 19:03, 19:12, 19:36 went out one after another.
  expect(ok("ek57", "971501234567", "2026-10-23T19:12:00Z")).toMatchObject({ code: 3, out: expect.stringContaining("moved 9 min") });
  expect(ok("ek57", "971501234567", "2026-10-23T19:36:00Z")).toMatchObject({ code: 3, out: expect.stringContaining("at most one an hour") });
  expect(ok("ek57", "971501234567", "2026-10-23T20:10:00Z").code).toBe(0);
  expect(ok("ek57", "120363999@g.us")).toMatchObject({ code: 3, out: expect.stringContaining("not one of this watcher's relays") });
  expect(ok("ek58", "120363@g.us").code).toBe(0);

  const off = cli("relays-off", "ek57", "--quote", "You can stop updating groups and people btw");
  expect(JSON.parse(off.stdout.toString())).toEqual({ stopped: "everyone", trip: "dus-oct", watchers: ["ek57", "ek58"] });
  expect(ok("ek58", "120363@g.us")).toMatchObject({ code: 3, out: expect.stringContaining("stopped updates to Pam group") });
  expect(cli("fire-test", "ek58").exitCode).toBe(0);
  const fired = readCalls().filter(call => call.args.includes("robob-watch ek58")).at(-1)!;
  expect(fired.args[fired.args.indexOf("--text") + 1]).toContain(`- Pam group (120363@g.us): the owner stopped these on ${new Date().toISOString().slice(0, 10)} ("You can stop updating groups and people btw")`);
  const shown = (id: string) => JSON.parse(cli("show", id).stdout.toString().split("\n--- log")[0]!).watcher;
  // A flag --replace keeps who the owner allowed, and nothing that rewrites watcher.json lifts a stop.
  expect(cli("add", "--id", "ek58", "--title", "EK58 again", "--check", "true", "--context", "Tell the owner; no wa send.", "--replace").exitCode).toBe(0);
  expect(shown("ek58")).toMatchObject({ trip: "dus-oct", relays: [{ name: "Pam group" }] });
  expect(cli("pause", "ek58").exitCode).toBe(0);
  expect(cli("resume", "ek58").exitCode).toBe(0);
  expect(ok("ek58", "120363@g.us").code).toBe(3);
  // 24 Oct review: a sibling rewritten without its trip tag kept the old grant and slipped out of the trip's stop.
  const untagged = join(sandbox, "ek58-untagged.json");
  writeFileSync(untagged, JSON.stringify({ id: "ek58", title: "ek58", check: "true", mode: "wake", context: "wa send --approved.", relays: [pam] }));
  expect(cli("add", "--json", untagged, "--no-prime", "--replace").exitCode).toBe(0);
  expect(ok("ek58", "120363@g.us").code).toBe(3);
  expect(add("ek58", [pam], "--replace").exitCode).toBe(0);
  // Nor does replaying the JSON it was set up with, even after an owner-only version in between.
  expect(add("ek57", [pam, cars], "--replace").exitCode).toBe(0);
  expect(ok("ek57", "120363@g.us")).toMatchObject({ code: 3, out: expect.stringContaining("stopped updates to Pam group") });
  expect(add("ek57", [pam, cars], "--replace", "--owner-only").exitCode).toBe(0);
  expect(shown("ek57").relays).toEqual([]);
  expect(add("ek57", [pam, cars], "--replace").exitCode).toBe(0);
  expect(ok("ek57", "120363@g.us").code).toBe(3);
  // Only a grant he gave after the stop lifts it, and a later stop covers that grant again.
  expect(add("ek57", [{ ...pam, at: new Date(Date.now() + 3_600_000).toISOString() }, cars], "--replace").stderr.toString()).toContain("not in the future");
  expect(add("ek57", [{ ...pam, at: new Date().toISOString(), quote: "Update Pam again" }, cars], "--replace").exitCode).toBe(0);
  expect(ok("ek57", "120363@g.us").code).toBe(0);
  expect(ok("ek58", "120363@g.us").code).toBe(3);
  const again = cli("relays-off", "ek58", "--to", "120363@g.us", "--quote", "Stop Pam's group again");
  expect(JSON.parse(again.stdout.toString()).watchers).toEqual(["ek58", "ek57"]);
  expect(ok("ek57", "120363@g.us").code).toBe(3);
  const flags = ["--title", "Gate change", "--check", "true", "--context", "Tell the owner. Never wa send to anyone.", "--no-prime"];
  // Nothing is refused: a watcher that mentions a send without relays is added, with a note on stderr.
  const gate = cli("add", "--id", "gate", ...flags);
  expect(gate.exitCode).toBe(0);
  expect(gate.stderr.toString()).toContain("Note for gate: its text mentions WhatsApp sends");
  expect(cli("add", "--id", "gate", ...flags, "--owner-only", "--replace").exitCode).toBe(0);
});

test("watchers from before relays that mention wa sends are listed and fire owner-only, with a log line", async () => {
  // EK58 (24 Oct) was set up before 11c84e10d9: its context still had the relay rules the owner had stopped.
  const dir = join(sandbox, "root/watchers/old-ek");
  mkdirSync(dir, { recursive: true });
  const flag = join(sandbox, "old-ek-event");
  writeFileSync(join(dir, "watcher.json"), JSON.stringify({ id: "old-ek", title: "Old EK ETA", check: `[[ -f ${flag} ]] && cat ${flag}; true`,
    interval_s: 10, mode: "wake", context: "Pre-authorised: on a new ETA, wa draft 120363@g.us then wa send --approved <id>.",
    expires_at: null, max_fires: 1, serial: false, created_at: "2026-10-19T08:00:00.000Z", created_by_session: null }));
  const fine = join(sandbox, "root/watchers/old-plain");
  mkdirSync(fine, { recursive: true });
  writeFileSync(join(fine, "watcher.json"), JSON.stringify({ id: "old-plain", title: "Old plain", check: "true", interval_s: 60, mode: "wake",
    context: "Tell the owner.", expires_at: null, max_fires: 1, serial: false, created_at: "2026-10-19T08:00:00.000Z", created_by_session: null }));
  const listed = cli("unscoped").stdout.toString();
  expect(listed).toContain("old-ek");
  expect(listed).toContain("Old EK ETA");
  expect(listed).not.toContain("old-plain");
  expect(listed).toContain("tell only the owner");
  writeFileSync(flag, "ETA 21:40");
  await runnerFor(2_500);
  const wake = readCalls().filter(call => call.args[0] === "wake" && call.args.includes("robob-watch old-ek")).at(-1)!;
  const text = wake.args[wake.args.indexOf("--text") + 1]!;
  expect(text).not.toContain("No third-party relays");
  expect(text).not.toContain("tell only the owner");
  expect(text).not.toContain("no longer applies");
  expect(cli("logs", "old-ek").stdout.toString()).not.toContain("told the agent owner-only");
  // Once it names its relays (here: nobody), it drops off the list.
  writeFileSync(join(dir, "watcher.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, "watcher.json"), "utf8")), relays: [] }));
  expect(cli("unscoped").stdout.toString()).toContain("No watchers mention");
  for (const id of ["old-ek", "old-plain"]) cli("remove", id);
}, 20_000);

test("an old watcher whose check runs wa draft runs as before: no hold, no held notice", async () => {
  // 27 Oct: nothing is held any more. The check runs; an agent reads what it drafts.
  const dir = join(sandbox, "root/watchers/old-sender");
  mkdirSync(dir, { recursive: true });
  const ran = join(sandbox, "old-sender-ran");
  const old = { id: "old-sender", title: "Old sender", check: `print -r -- ran >> ${ran}; wa draft 120363@g.us "New ETA"; print ETA`,
    interval_s: 1, mode: "wake", context: "Tell the owner.", expires_at: null, max_fires: 0, serial: false,
    created_at: "2026-10-19T08:00:00.000Z", created_by_session: null };
  writeFileSync(join(dir, "watcher.json"), JSON.stringify(old));
  expect(cli("unscoped").stdout.toString()).not.toContain("held");
  const test = cli("test", "old-sender");
  expect(test.exitCode).toBe(0);
  expect(test.stderr.toString()).not.toContain("is held");
  const before = readCalls().length;
  await runnerFor(3_500);
  expect(existsSync(ran)).toBe(true);
  const notices = readCalls().slice(before).filter(call => call.args.some(arg => arg.includes("robob-watch:old-sender:held")));
  expect(notices).toHaveLength(0);
  expect(state("old-sender").held_alerted).toBeUndefined();
  cli("remove", "old-sender");
}, 25_000);

test("relays: a person's @lid and phone jid are one contact, and concurrent checks take one ETA slot", async () => {
  mkdirSync(join(sandbox, "wacli"), { recursive: true });
  Bun.spawnSync(["/usr/bin/sqlite3", join(sandbox, "wacli/session.db"),
    "create table whatsmeow_lid_map (lid text primary key, pn text); insert into whatsmeow_lid_map values ('111222333', '971509876543');"]);
  const driver = (to: string) => ({ to, name: "Driver", quote: "Keep the driver posted", at: "2026-10-19T04:00:00Z" });
  const add = (id: string, to: string) => {
    const file = join(sandbox, `${id}.json`);
    writeFileSync(file, JSON.stringify({ id, title: id, check: "true", mode: "wake", context: "wa send the driver the ETA.", trip: "ride", relays: [driver(to)] }));
    return cli("add", "--json", file, "--no-prime");
  };
  expect(add("r1", "971509876543@s.whatsapp.net").exitCode).toBe(0);
  expect(add("r2", "+971 50 987 6543").exitCode).toBe(0);
  expect(add("r3", "111222333@lid").stderr.toString()).toContain("not an @lid");
  const ok = (id: string, to: string, eta: string) => cli("relay-ok", id, "--to", to, "--eta", eta).exitCode;
  expect(ok("r2", "111222333@lid", "2026-10-24T10:00:00Z")).toBe(0);
  // The same person under the other id, on a sibling: the ETA barely moved.
  expect(ok("r1", "971509876543@s.whatsapp.net", "2026-10-24T10:05:00Z")).toBe(3);
  const racers = await Promise.all(Array.from({ length: 5 }, () => Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"),
    "relay-ok", "r1", "--to", "111222333@lid", "--eta", "2026-10-24T13:00:00Z"], { env, stdout: "ignore", stderr: "ignore" }).exited));
  expect(racers.filter(code => code === 0)).toHaveLength(1);
  const off = cli("relays-off", "r1", "--to", "111222333@lid", "--quote", "Stop texting the driver");
  expect(JSON.parse(off.stdout.toString()).watchers).toEqual(["r1", "r2"]);
  expect(ok("r2", "+971509876543", "2026-10-24T18:00:00Z")).toBe(3);
  // A stop by an @lid wacli can't map would stop nobody, so it fails instead of claiming it worked.
  const unknown = cli("relays-off", "r1", "--to", "999888777@lid", "--quote", "Stop texting him");
  expect(unknown.exitCode).toBe(1);
  expect(unknown.stderr.toString()).toContain("can't find the phone number behind 999888777@lid");
}, 30_000);

test("relays: each watcher's ETA moves on its own, while one person still gets at most one an hour", () => {
  const host = { to: "971501112222@s.whatsapp.net", name: "Host", quote: "Tell the host when each of us lands", at: "2026-10-19T04:00:00Z" };
  for (const id of ["fa", "fb"]) {
    const file = join(sandbox, `${id}.json`);
    writeFileSync(file, JSON.stringify({ id, title: id, check: "true", mode: "wake", context: "wa send the host the ETA.", trip: "two-flights", relays: [host] }));
    expect(cli("add", "--json", file, "--no-prime").exitCode).toBe(0);
  }
  const ok = (id: string, eta: string) => cli("relay-ok", id, "--to", host.to, "--eta", eta).exitCode;
  expect(ok("fa", "2026-10-24T18:00:00Z")).toBe(0);
  expect(ok("fb", "2026-10-24T21:00:00Z")).toBe(0);
  // 24 Oct review: each compared with the other flight's ETA, so a one-minute change looked like three hours.
  expect(ok("fa", "2026-10-24T18:01:00Z")).toBe(3);
  expect(ok("fb", "2026-10-24T21:01:00Z")).toBe(3);
  expect(ok("fa", "2026-10-24T18:30:00Z")).toBe(3);
  expect(ok("fa", "2026-10-24T19:30:00Z")).toBe(0);
  // A third watcher on flight A starts from A's last ETA: 20 min later within the hour is still too soon.
  const file = join(sandbox, "fc.json");
  writeFileSync(file, JSON.stringify({ id: "fc", title: "fc", check: "true", mode: "wake", context: "wa send the host the ETA.", trip: "two-flights", relays: [host] }));
  expect(cli("add", "--json", file, "--no-prime").exitCode).toBe(0);
  expect(ok("fc", "2026-10-24T19:50:00Z")).toBe(3);
  // 24 Oct review: archiving the watcher that sent 19:30 must not wipe what the host was already told.
  expect(cli("remove", "fa").exitCode).toBe(0);
  expect(ok("fc", "2026-10-24T19:50:00Z")).toBe(3);
});
