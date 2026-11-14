import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Delivery, State, Watcher } from "../src/lib.ts";
import type { LogEntry } from "../src/toollog.ts";

const projectThread = "thread:project:work:abcd1234-5678-4000-8000-123456789abc";
const ownerThread = "ardud-control:thread:11111111-2222-4000-8000-123456789abc";
const libPath = join(import.meta.dir, "../src/lib.ts");
const runnerPath = join(import.meta.dir, "../src/runner.ts");
type Call = { cli: string; args: string[] };
type Fixture = {
  watcher?: Partial<Watcher>;
  status?: Record<string, unknown>;
  statusError?: boolean;
  nativeError?: boolean;
  sendError?: boolean;
  wakeError?: boolean;
  imessageError?: boolean;
  telegramError?: boolean;
  noOverride?: boolean;
  missingCli?: boolean;
  nativeOutput?: string;
  statusOutput?: string;
  nativeSleep?: boolean;
  statusSleep?: boolean;
};

// Each delivery runs in a fresh process: caches, bridge rows, logs and every CLI stay inside its fixture.
async function fixture(options: Fixture = {}, body = "await deliver(watcher, 'event happened', key, state)") {
  const dir = mkdtempSync(join(tmpdir(), "watch-wake-route-"));
  try {
    const callsFile = join(dir, "calls.jsonl");
    const config = join(dir, "config.json");
    const status = { threadId: projectThread, projectId: "project:work", origin: null, archived: false, ...options.status };
    writeFileSync(config, JSON.stringify({ ...options, status }));
    const stub = (cli: string) => {
      const file = join(dir, `${cli}.ts`);
      writeFileSync(file, `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ cli: ${JSON.stringify(cli)}, args }) + '\\n');
const config = JSON.parse(readFileSync(${JSON.stringify(config)}, 'utf8'));
if (${JSON.stringify(cli)} === 't3ctl') {
  if (config[args[0] + 'Sleep']) await Bun.sleep(10_000);
  if (config[args[0] + 'Error']) { console.error(args[0] + ' stub failure'); process.exit(1); }
  console.log(config[args[0] + 'Output'] ?? JSON.stringify(args[0] === 'send' ? { ok: true, duplicate: false } : { ok: true, thread: config.status }));
} else {
  if (args[0] === 'wake' && config.wakeError || args[0] === 'send' && config.imessageError
    || ${JSON.stringify(cli)} === 'telegram' && config.telegramError) process.exit(1);
  console.log(JSON.stringify({ ok: true }));
}
`, { mode: 0o755 });
      return file;
    };
    const t3ctl = stub("t3ctl");
    const spectrum = stub("spectrum");
    const telegram = stub("telegram");
    const dbPath = join(dir, "bridge.sqlite");
    const db = new Database(dbPath);
    db.exec("create table kv(key text primary key, value text); create table inbound(id text primary key, state text);");
    db.query("insert into kv values('route', ?)").run(JSON.stringify({ id: ownerThread }));
    db.close();
    const watcherDir = join(dir, "root/watchers/route-test");
    mkdirSync(watcherDir, { recursive: true });
    const code = `
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliver, normalize, loadState, saveState, sameDestination, queueEvent, sealBatch, testEnv } from ${JSON.stringify(libPath)};
const watcher = normalize({ id: 'route-test', title: 'Routing event', check: 'true', mode: 'wake',
  context: 'Handle this event in its work thread.', max_fires: 0, created_by_session: ${JSON.stringify(projectThread)},
  ...${JSON.stringify(options.watcher ?? {})} });
writeFileSync(${JSON.stringify(join(watcherDir, "watcher.json"))}, JSON.stringify(watcher));
const state = loadState(watcher.id);
const key = 'robob-watch:route-test:1:stable-event';
const configPath = ${JSON.stringify(config)};
console.log(JSON.stringify(await (async () => (${body}))()));`;
    const env = { ...process.env, ROBOB_TEST: "1", ROBOB_WATCH_ROOT: join(dir, "root"),
      ROBOB_WATCH_BRIDGE_DB: dbPath, ROBOB_WATCH_SPECTRUM_CLI: spectrum, ROBOB_WATCH_TELEGRAM_CLI: telegram,
      ROBOB_WATCH_T3CTL: options.noOverride ? undefined : options.missingCli ? join(dir, "missing-cli") : t3ctl,
      ROBOB_WATCH_TEST_CREATOR_TIMEOUT_MS: "2000",
      ROBOB_WATCH_LOAD_OVERRIDE: "0.1", TOOLLOG_DIR: join(dir, "logs") };
    const child = Bun.spawn([process.execPath, "-e", code], { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exitCode, stderr).toBe(0);
    const lines = stdout.trim().split("\n");
    const logsDir = join(dir, "logs");
    return { result: JSON.parse(lines.pop()!) as Delivery & { state: State; held: State; same: boolean; env: string; deliveries: Delivery[] },
      sentLogs: existsSync(logsDir) ? readdirSync(logsDir).filter(file => file.endsWith(".ndjson"))
        .flatMap(file => readFileSync(join(logsDir, file), "utf8").trim().split("\n").map(line => JSON.parse(line) as LogEntry))
        .filter(row => row.name === "wake.sent") : [],
      runnerLog: lines.join("\n"),
      fallbacks: existsSync(logsDir) ? readdirSync(logsDir).filter(file => file.endsWith(".ndjson"))
        .flatMap(file => readFileSync(join(logsDir, file), "utf8").trim().split("\n").map(line => JSON.parse(line) as LogEntry))
        .filter(row => row.name === "wake.creator_fallback") : [],
      calls: existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n").map(line => JSON.parse(line) as Call) : [],
      log: existsSync(join(watcherDir, "log")) ? readFileSync(join(watcherDir, "log"), "utf8") : "" };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const wakeText = (calls: Call[]) => calls.find(c => c.cli === "spectrum" && c.args[0] === "wake")!.args.find(a => a.startsWith("--text="))!.slice(7);

test("a project creator gets one queued send with its event key, context and provenance, without a bridge wake", async () => {
  const { result, calls } = await fixture({ status: { recentRuns: [{ data: "x".repeat(2000) }] } });
  expect(result).toMatchObject({ ok: true, via: "thread:abcd1234" });
  expect(calls.map(c => c.cli)).toEqual(["t3ctl", "t3ctl"]);
  expect(calls[0]!.args).toEqual(["status", projectThread]);
  const [send] = calls.filter(c => c.args[0] === "send");
  expect(send!.args).toEqual(["send", projectThread, expect.any(String), "--request-id", "robob-watch:route-test:1:stable-event", "--mode", "queue"]);
  expect(send!.args[2]).toStartWith("[Watcher event from robob-watch route-test, not typed by anyone in this thread.]\n");
  expect(send!.args[2]).toContain("event happened");
  expect(send!.args[2]).toContain("Handle this event in its work thread.");
});

test.each([
  { name: "rotated owner", origin: "imessage", projectId: "unrelated", archived: false },
  { name: "archived rotated owner", origin: "imessage", projectId: "unrelated", archived: true },
  { name: "old project", origin: null, projectId: "ardud-opencode-import:project:/Users/ardud/.config/openchamber/imessage", archived: true },
  { name: "current project (Moni shares this root)", origin: null, projectId: "ardud-opencode-import:project:/Users/ardud/.robob/imessage", archived: false },
  { name: "project name", origin: null, projectId: "iMessage", archived: false },
])("$name keeps the existing owner wake text and key", async ({ name, ...status }) => {
  const { result, calls } = await fixture({ status });
  expect(result.via).toBe("wake");
  expect(calls.filter(c => c.cli === "t3ctl").map(c => c.args[0])).toEqual(["status"]);
  const bridge = calls.find(c => c.cli === "spectrum")!;
  expect(bridge.args).toEqual(["wake", "--source=robob-watch route-test", expect.any(String), "--key=robob-watch:route-test:1:stable-event"]);
  expect(wakeText(calls)).toStartWith("Routing event\n");
  expect(wakeText(calls)).not.toContain("meant for thread");
});

test("a creator matching the live route keeps the owner path even without readable status", async () => {
  const { result, calls } = await fixture({ watcher: { created_by_session: ownerThread }, statusError: true });
  expect(result.via).toBe("wake");
  expect(calls.filter(c => c.cli === "t3ctl")).toHaveLength(0);
  expect(wakeText(calls)).not.toContain("meant for thread");
});

test.each([null, "", "   "])("no creator (%j) keeps the owner path without t3ctl", async created_by_session => {
  const { result, calls } = await fixture({ watcher: { created_by_session }, noOverride: true });
  expect(result.via).toBe("wake");
  expect(calls.filter(c => c.cli === "t3ctl")).toHaveLength(0);
  expect(wakeText(calls)).not.toContain("meant for thread");
});

test.each([
  { name: "archived", status: { archived: true }, reason: "thread is archived" },
  { name: "missing", statusError: true, reason: "status stub failure" },
  { name: "invalid status", status: { archived: null }, reason: "invalid thread status" },
  { name: "send failure", sendError: true, reason: "send stub failure" },
  { name: "spawn failure", missingCli: true, reason: "status:" },
])("$name falls back to the owner wake with the intended thread and a logged reason", async ({ name, reason, ...options }) => {
  const { result, calls, log } = await fixture(options);
  expect(result).toMatchObject({ ok: true, via: "wake" });
  expect(wakeText(calls)).toStartWith("(meant for thread abcd1234, which could not be reached)\n");
  expect(log).toContain(`creator wake fallback thread=${projectThread}`);
  expect(log).toContain(reason);
});

test("a resolved ses_ creator goes to its Robob thread", async () => {
  const { result, calls } = await fixture({ watcher: { created_by_session: "ses_old" } });
  expect(result.via).toBe("thread:abcd1234");
  expect(calls[0]!.args).toEqual(["native", "ses_old"]);
  expect(calls[1]!.args).toEqual(["status", projectThread]);
  expect(calls[2]!.args.slice(0, 2)).toEqual(["send", projectThread]);
});

test.each([
  { name: "timeout", nativeSleep: true, reason: "timeout" },
  { name: "exit", nativeError: true, reason: "exit:1" },
  { name: "spawn", missingCli: true, reason: "exit:127" },
  ...["not json", "null", "[]", "{}", '{"thread":null}', '{"thread":[]}',
    '{"thread":{"threadId":12}}', '{"thread":{"threadId":""}}', '{"thread":{"threadId":"   "}}']
    .map(nativeOutput => ({ name: `invalid ${nativeOutput}`, nativeOutput, reason: "invalid" })),
])("native $name logs one fallback and delivers once to the owner", async ({ name, reason, ...options }) => {
  const session = "ses_gone_123456789";
  const { result, calls, fallbacks, runnerLog } = await fixture({ watcher: { created_by_session: session }, ...options });
  expect(result).toMatchObject({ ok: true, via: "wake" });
  expect(calls.filter(c => c.cli === "spectrum")).toHaveLength(1);
  expect(calls.filter(c => c.cli === "t3ctl").map(c => c.args)).toEqual(options.missingCli ? [] : [["native", session]]);
  expect(wakeText(calls)).not.toContain("meant for thread");
  expect(runnerLog.split("\n")).toHaveLength(1);
  expect(runnerLog).toEndWith(`creator lookup failed watcher=route-test session=${session.slice(0, 12)} reason=${reason}`);
  expect(fallbacks).toHaveLength(1);
  expect(fallbacks[0]!.props!.durationMs).toBeGreaterThanOrEqual(0);
  expect(fallbacks[0]).toMatchObject({ component: "wakes", ok: false, ids: { watcher: "route-test" },
    props: { step: "native", reason } });
  if (options.nativeSleep) expect(fallbacks[0]!.durationMs).toBeLessThan(5_000);
});

test.each([
  { name: "timeout", statusSleep: true, reason: "timeout" },
  { name: "exit", statusError: true, reason: "exit:1" },
  { name: "spawn", missingCli: true, reason: "exit:127" },
  { name: "invalid JSON", statusOutput: "not json", reason: "invalid" },
  { name: "invalid shape", status: { archived: null }, reason: "invalid" },
  { name: "archived", status: { archived: true }, reason: "archived" },
])("status $name logs one fallback and keeps the intended-thread prefix", async ({ name, reason, ...options }) => {
  const { result, calls, fallbacks, runnerLog } = await fixture(options);
  expect(result).toMatchObject({ ok: true, via: "wake" });
  expect(calls.filter(c => c.cli === "spectrum")).toHaveLength(1);
  expect(wakeText(calls)).toStartWith("(meant for thread abcd1234, which could not be reached)\n");
  expect(runnerLog.split("\n")).toHaveLength(1);
  expect(runnerLog).toEndWith(`creator lookup failed watcher=route-test session=${projectThread.slice(0, 12)} reason=${reason}`);
  expect(fallbacks).toHaveLength(1);
  expect(fallbacks[0]!.props!.durationMs).toBeGreaterThanOrEqual(0);
  expect(fallbacks[0]).toMatchObject({ component: "wakes", ok: false, ids: { watcher: "route-test" },
    props: { step: "status", reason } });
});

test.each([
  { name: "native timeout", nativeSleep: true, watcher: { created_by_session: "ses_old" } },
  { name: "native invalid", nativeOutput: "not json", watcher: { created_by_session: "ses_old" } },
  { name: "status unreachable", statusError: true },
])("$name is cached once, then looked up again after 30 seconds", async ({ name, ...options }) => {
  const { result, calls, fallbacks } = await fixture(options, `(async () => {
    const originalNow = Date.now;
    let at = originalNow();
    Date.now = () => at;
    const deliveries = [await deliver(watcher, 'first', key, state)];
    at += 29_000;
    deliveries.push(await deliver(watcher, 'cached', key + ':2', state));
    writeFileSync(configPath, JSON.stringify({ status: ${JSON.stringify({ threadId: projectThread, projectId: "work", origin: null, archived: false })} }));
    at += 2_000;
    deliveries.push(await deliver(watcher, 'recovered', key + ':3', state));
    return { deliveries };
  })()`);
  expect(result.deliveries.map(d => d.via)).toEqual(["wake", "wake", "thread:abcd1234"]);
  expect(calls.filter(c => c.cli === "spectrum")).toHaveLength(2);
  expect(calls.filter(c => c.args[0] === (options.watcher ? "native" : "status"))).toHaveLength(2);
  expect(fallbacks).toHaveLength(1);
});

test("successful native resolution is cached for three minutes", async () => {
  const { result, calls, fallbacks } = await fixture({ watcher: { created_by_session: "ses_old" } }, `(async () => {
    const originalNow = Date.now;
    let at = originalNow();
    Date.now = () => at;
    const deliveries = [await deliver(watcher, 'first', key, state)];
    at += 179_000;
    deliveries.push(await deliver(watcher, 'cached', key + ':2', state));
    at += 2_000;
    deliveries.push(await deliver(watcher, 'refreshed', key + ':3', state));
    return { deliveries };
  })()`);
  expect(result.deliveries.every(d => d.via === "thread:abcd1234")).toBe(true);
  expect(calls.filter(c => c.args[0] === "native")).toHaveLength(2);
  expect(calls.filter(c => c.args[0] === "status")).toHaveLength(2);
  expect(calls.filter(c => c.cli === "spectrum")).toHaveLength(0);
  expect(calls.map(c => c.args[0])).toEqual(["native", "status", "send", "send", "native", "status", "send"]);
  expect(fallbacks).toHaveLength(0);
});

test("a retried pending event reuses its request ID and cached creator resolution", async () => {
  const { result, calls } = await fixture({ sendError: true, wakeError: true, imessageError: true, telegramError: true }, `(async () => {
    state.pending = { key, event: 'event happened', at: new Date().toISOString(), watcher };
    saveState(watcher.id, state);
    const { tickOne } = await import(${JSON.stringify(runnerPath)});
    await tickOne(watcher.id);
    const held = loadState(watcher.id);
    writeFileSync(configPath, JSON.stringify({ status: ${JSON.stringify({ threadId: projectThread, projectId: "work", origin: null, archived: false })} }));
    held.next_at = 0;
    saveState(watcher.id, held);
    await tickOne(watcher.id);
    return { held, state: loadState(watcher.id) };
  })()`);
  expect(result.held.pending?.key).toBe("robob-watch:route-test:1:stable-event");
  expect(result.state.last_delivery).toBe("thread:abcd1234");
  expect(result.state.pending).toBeUndefined();
  const sends = calls.filter(c => c.cli === "t3ctl" && c.args[0] === "send");
  expect(sends).toHaveLength(2);
  expect(sends[0]!.args).toEqual(sends[1]!.args);
  expect(calls.filter(c => c.args[0] === "status")).toHaveLength(1);
});

test("creator status is refreshed after the cache expires", async () => {
  const { result, calls } = await fixture({}, `(async () => {
    await deliver(watcher, 'first', key, state);
    writeFileSync(configPath, JSON.stringify({ status: { threadId: watcher.created_by_session, projectId: 'work', origin: null, archived: true } }));
    const originalNow = Date.now;
    Date.now = () => originalNow() + 4 * 60_000;
    return await deliver(watcher, 'second', key + ':2', state);
  })()`);
  expect(result.via).toBe("wake");
  expect(calls.filter(c => c.args[0] === "status")).toHaveLength(2);
  expect(calls.filter(c => c.cli === "t3ctl" && c.args[0] === "send")).toHaveLength(1);
});

test.each([false, true])("explicit chat routing is unchanged (wake failure: %j)", async wakeError => {
  const { result, calls } = await fixture({ watcher: { chat: "moni" }, noOverride: true, wakeError });
  expect(result).toMatchObject({ ok: !wakeError, via: wakeError ? "none" : "wake:moni" });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.cli).toBe("spectrum");
  expect(calls[0]!.args).toContain("--chat=moni");
  expect(calls[0]!.args).toContain(`--session=${ownerThread}`);
});

test("a test run with no t3ctl override refuses before touching the real app", async () => {
  const { result, calls } = await fixture({ noOverride: true });
  expect(result).toMatchObject({ ok: false, via: "none" });
  expect(result.detail).toContain("refused: test run; t3ctl");
  expect(calls).toHaveLength(0);
});

test("creator changes invalidate the cache and keep pending batches on their accepted destination", async () => {
  const { calls, result } = await fixture({}, `(async () => {
    await deliver(watcher, 'first', key, state);
    const next = { ...watcher, created_by_session: 'thread:project:work:ffff0000' };
    writeFileSync(configPath, JSON.stringify({ status: { threadId: next.created_by_session, projectId: 'work', origin: null, archived: false } }));
    queueEvent(watcher, state, 'held', false);
    if (state.batch) sealBatch(next, state);
    const same = sameDestination(watcher, next);
    const delivery = await deliver(next, 'second', key + ':2', state);
    return { ...delivery, same, state };
  })()`);
  expect(result.via).toBe("thread:ffff0000");
  expect(result.same).toBe(false);
  expect(result.state.pending!.watcher!.created_by_session).toBe(projectThread);
  expect(calls.filter(c => c.args[0] === "status")).toHaveLength(2);
});

test("the runner records thread delivery without adding a spectrum heads-up row", async () => {
  const { result, calls } = await fixture({ watcher: { headsup: true } }, `(async () => {
    state.pending = { key, event: 'event happened', at: new Date().toISOString(), watcher };
    saveState(watcher.id, state);
    const { tickOne } = await import(${JSON.stringify(runnerPath)});
    await tickOne(watcher.id);
    return { state: loadState(watcher.id) };
  })()`);
  expect(result.state.last_delivery).toBe("thread:abcd1234");
  expect(result.state.fires).toBe(1);
  expect(result.state.pending).toBeUndefined();
  expect(result.state.wakes).toBeUndefined();
  expect(calls.filter(c => c.cli === "spectrum")).toHaveLength(0);
});

test("the t3ctl stub override is forwarded to child helpers", async () => {
  const { result } = await fixture({}, "({ env: testEnv().ROBOB_WATCH_T3CTL })");
  expect(result.env).toEndWith("/t3ctl.ts");
});


test("direct creator and owner fallback deliveries log one attempt each", async () => {
  for (const sendError of [false, true]) {
    const { result, sentLogs } = await fixture({ sendError });
    expect(result.route).toBe(sendError ? "owner" : "creator");
    expect(sentLogs).toHaveLength(1);
    expect(sentLogs[0]).toMatchObject({ component: "wakes", kind: "perf", ok: true,
      ids: { watcher: "route-test" }, props: { via: sendError ? "wake" : "thread", events: 1 } });
    expect(sentLogs[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(sentLogs)).not.toContain("event happened");
    expect(JSON.stringify(sentLogs)).not.toContain("Handle this event");
  }
});
