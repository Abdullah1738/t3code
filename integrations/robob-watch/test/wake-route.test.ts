import { expect, test, setDefaultTimeout } from "bun:test";
import { Database } from "bun:sqlite";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Delivery, State, Watcher } from "../src/lib.ts";
import type { LogEntry } from "../src/toollog.ts";
import { expandTelemetry } from "../src/log-format.ts";

setDefaultTimeout(30_000);

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
  sendKilled?: boolean;
  sendExit137?: boolean;
  requireSendJournal?: boolean;
  sendAmbiguous?: boolean;
  sendDiagnostic?: string;
  sendDiagnosticStream?: "stdout" | "stderr" | "split";
  strictWakeKey?: boolean;
  wakeAmbiguousOnce?: boolean;
  sendSleep?: boolean;
  sendSpawnError?: boolean;
  wakeError?: boolean;
  imessageError?: boolean;
  telegramError?: boolean;
  noOverride?: boolean;
  missingCli?: boolean;
  nativeOutput?: string;
  statusOutput?: string;
  nativeSleep?: boolean;
  statusSleep?: boolean;
  statusSleepOnce?: boolean;
  nativeSleepOnce?: boolean;
  statusEmptyError?: boolean;
  statusFailure?: string;
  sendFailure?: string;
  sendOutput?: string;
  runEvidence?: Record<string, unknown>;
  runMissing?: boolean;
};

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

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
import { appendFileSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ cli: ${JSON.stringify(cli)}, args }) + '\\n');
const config = JSON.parse(readFileSync(${JSON.stringify(config)}, 'utf8'));
if (${JSON.stringify(cli)} === 't3ctl') {
  if (args[0] === 'send' && config.sendKilled) process.kill(process.pid, 'SIGKILL');
  if (args[0] === 'send' && config.sendExit137) process.exit(137);
  if (args[0] === 'send' && config.requireSendJournal) {
    const state = JSON.parse(readFileSync(${JSON.stringify(join(dir, 'root/watchers/route-test/state.json'))}, 'utf8'));
    if (state.pending?.creatorSend?.thread !== args[1] || !(state.pending.creatorSend.sentAt <= Date.now())) process.exit(1);
  }
  if (args[0] === 'send' && config.sendAmbiguous) process.exit(4);
  if (args[0] === 'send' && config.sendDiagnostic) {
    const quote = ${shellQuote.toString()};
    const retry = ['t3ctl', 'send', quote(args[1]), '--request-id', quote(args[4]), '--mode', quote(args[6]), '--', quote(args[2])].join(' ');
    if (config.sendDiagnosticStream === 'split') {
      console.log('Retry safely with: ' + retry);
      console.error(config.sendDiagnostic);
    } else console[config.sendDiagnosticStream === 'stdout' ? 'log' : 'error'](config.sendDiagnostic + '. Retry safely with: ' + retry);
    process.exit(4);
  }
  if (args[0] === 'status' && config.sendSpawnError) unlinkSync(import.meta.path);
  if (config[args[0] + 'SleepOnce']) {
    delete config[args[0] + 'SleepOnce'];
    writeFileSync(${JSON.stringify(config)}, JSON.stringify(config));
    console.error('probe waiting'); await Bun.sleep(10_000);
  }
  if (config[args[0] + 'Sleep']) { console.error('probe waiting'); await Bun.sleep(10_000); }
  if (args[0] === 'status' && config.statusEmptyError) process.exit(1);
  if (config[args[0] + 'Failure']) { console.error(config[args[0] + 'Failure']); process.exit(1); }
  if (config[args[0] + 'Error']) { console.error((args[0] === 'status' ? 'not_found: ' : '') + args[0] + ' stub failure'); process.exit(1); }
  console.log(config[args[0] + 'Output'] ?? JSON.stringify(args[0] === 'send' ? { ok: true, duplicate: false } : { ok: true, thread: config.status }));
} else {
  if (args[0] === 'wake' && config.strictWakeKey) {
    const file = ${JSON.stringify(join(dir, 'accepted-wake.json'))};
    let previous;
    try { previous = JSON.parse(readFileSync(file, 'utf8')); } catch {}
    if (previous && JSON.stringify(previous) !== JSON.stringify(args)) process.exit(9);
    writeFileSync(file, JSON.stringify(args));
  }
  if (args[0] === 'wake' && config.wakeAmbiguousOnce) {
    delete config.wakeAmbiguousOnce;
    writeFileSync(${JSON.stringify(config)}, JSON.stringify(config));
    process.exit(4);
  }
  if (args[0] === 'wake' && config.wakeError || args[0] === 'send' && config.imessageError
    || ${JSON.stringify(cli)} === 'telegram' && config.telegramError) process.exit(1);
  console.log(JSON.stringify({ ok: true }));
}
`, { mode: 0o755 });
      return file;
    };
    writeFileSync(join(dir, "client.mjs"), `
import { appendFileSync, readFileSync } from 'node:fs';
export class ControlClient {
  async request(method, path) {
    appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ cli: 'run-lookup', args: [method, path] }) + '\\n');
    const config = JSON.parse(readFileSync(${JSON.stringify(config)}, 'utf8'));
    const parts = path.split('/');
    const threadId = decodeURIComponent(parts[2]);
    const runId = decodeURIComponent(parts[4]);
    if (config.runMissing) throw Object.assign(new Error(\`Run \${runId} was not found on thread \${threadId}.\`), { code: 'not_found' });
    if (!config.runEvidence) throw new Error('lookup unavailable');
    return { ok: true, threadId, runId, ...config.runEvidence };
  }
}`);
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
import { Database } from 'bun:sqlite';
import { deliver, normalize, loadState, saveState, confirmWakes, wakeInboundId, sameDestination, queueEvent, sealBatch, testEnv } from ${JSON.stringify(libPath)};
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
      ROBOB_WATCH_TEST_CREATOR_SEND_TIMEOUT_MS: "2000",
      ROBOB_WATCH_LOAD_OVERRIDE: "0.1", TOOLLOG_DIR: join(dir, "logs") };
    // LaunchAgent sends stdout to runner.log; exercise that same file redirection.
    const runnerLogPath = join(dir, "runner.log");
    const fd = openSync(runnerLogPath, "w");
    try {
      const child = Bun.spawn([process.execPath, "-e", code], { env, stdout: fd, stderr: "pipe" });
      const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
      expect(exitCode, stderr).toBe(0);
    } finally { closeSync(fd); }
    const stdout = readFileSync(runnerLogPath, "utf8");
    const lines = stdout.trim().split("\n");
    const logsDir = join(dir, "logs");
    return { result: JSON.parse(lines.pop()!) as Delivery & { state: State; held: State; before: State; same: boolean; env: string; deliveries: Delivery[] },
      sentLogs: existsSync(logsDir) ? readdirSync(logsDir).filter(file => file.endsWith(".ndjson"))
        .flatMap(file => readFileSync(join(logsDir, file), "utf8").trim().split("\n").flatMap(line => expandTelemetry(JSON.parse(line)) as LogEntry[]))
        .filter(row => row.name === "wake.sent") : [],
      runnerLog: lines.join("\n"),
      logs: existsSync(logsDir) ? readdirSync(logsDir).filter(file => file.endsWith(".ndjson")).flatMap(file => readFileSync(join(logsDir, file), "utf8").trim().split("\n").flatMap(line => expandTelemetry(JSON.parse(line)) as LogEntry[])) : [],
      fallbacks: existsSync(logsDir) ? readdirSync(logsDir).filter(file => file.endsWith(".ndjson"))
        .flatMap(file => readFileSync(join(logsDir, file), "utf8").trim().split("\n").flatMap(line => expandTelemetry(JSON.parse(line)) as LogEntry[]))
        .filter(row => row.name === "wake.creator_fallback") : [],
      calls: existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n").map(line => JSON.parse(line) as Call) : [],
      log: existsSync(join(watcherDir, "log")) ? readFileSync(join(watcherDir, "log"), "utf8") : "" };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const wakeText = (calls: Call[]) => calls.find(c => c.cli === "spectrum" && c.args[0] === "wake")!.args.find(a => a.startsWith("--text="))!.slice(7);
const helperRuns = (logs: LogEntry[], op: string) => logs.filter(row => row.name === "helper.run" && row.props?.op === op);
const helperContext = (op: string, timedOut: boolean, timeoutMs = 2000) => ({
  ids: { watcher: "route-test" }, props: { op, timeoutMs, timedOut },
});

test("a project creator gets one queued send with its event key, context and provenance, without a bridge wake", async () => {
  const { result, calls, fallbacks, runnerLog, log, logs } = await fixture({ status: { recentRuns: [{ data: "x".repeat(2000) }] } });
  for (const op of ["status", "send"]) {
    expect(helperRuns(logs, op)).toHaveLength(1);
    expect(helperRuns(logs, op)[0]).toMatchObject({ ok: true, ...helperContext(op, false) });
  }
  expect(logs.find(row => row.name === "helper.run" && row.ids?.helper === "sqlite3"))
    .toMatchObject({ ids: { watcher: "route-test" }, props: { timeoutMs: 10_000, timedOut: false } });
  expect(fallbacks).toHaveLength(0);
  expect(runnerLog).not.toContain("creator wake fallback");
  expect(log).not.toContain("creator wake fallback");
  expect(result).toMatchObject({ ok: false, accepted: true, confirmed: "pending", via: "thread:abcd1234" });
  expect(calls.map(c => c.cli)).toEqual(["t3ctl", "t3ctl"]);
  expect(calls[0]!.args).toEqual(["status", projectThread]);
  const [send] = calls.filter(c => c.args[0] === "send");
  expect(send!.args).toEqual(["send", projectThread, expect.any(String), "--request-id", "robob-watch:route-test:1:stable-event", "--mode", "queue"]);
  expect(send!.args[2]).toStartWith("[Watcher event from robob-watch route-test, not typed by anyone in this thread.]\n");
  expect(send!.args[2]).toContain("event happened");
  expect(send!.args[2]).toContain("Handle this event in its work thread.");
});

test.each([
  { name: "exit", sendError: true, reason: "exit:1" },
    { name: "spawn error", sendSpawnError: true, reason: "error" },
])("creator send $name logs one fallback and wakes the owner once", async ({ name, reason, ...options }) => {
  const { result, calls, fallbacks, runnerLog, log, logs } = await fixture(options);
  expect(helperRuns(logs, "send")).toHaveLength(1);
  expect(helperRuns(logs, "send")[0]).toMatchObject({ ok: false, ...helperContext("send", false),
    error: { tag: options.sendSpawnError ? "helper.spawn_failed" : "helper.exit_failed" } });
  if (!options.sendSpawnError) expect(helperRuns(logs, "send")[0]!.props!.exitCode).toBe(1);
  expect(logs.filter(row => row.name === "helper.run").every(row => row.ids?.watcher === "route-test")).toBe(true);
  expect(result).toMatchObject({ ok: false, accepted: true, via: "wake:owner-fallback", route: "owner" });
  expect(calls.filter(c => c.cli === "spectrum")).toHaveLength(1);
  expect(calls.filter(c => c.cli === "telegram")).toHaveLength(0);
  expect(calls.filter(c => c.cli === "t3ctl").map(c => c.args[0]))
    .toEqual(options.sendSpawnError ? ["status"] : ["status", "send"]);
  expect(wakeText(calls)).toStartWith("(meant for thread abcd1234, which could not be reached)\n");
  expect(calls.find(c => c.cli === "spectrum")!.args).toContain("--key=robob-watch:route-test:1:stable-event");
  expect(log).toContain(`creator wake fallback thread=${projectThread} send `);
  expect(runnerLog.split("\n")).toHaveLength(1);
  expect(runnerLog).toContain(`creator wake fallback watcher=route-test thread=${projectThread} reason=${reason}`);
  expect(fallbacks).toHaveLength(1);
  expect(fallbacks[0]!.props!.durationMs).toBeGreaterThanOrEqual(0);
  expect(fallbacks[0]!.durationMs).toBe(fallbacks[0]!.props!.durationMs);
  if (options.sendSleep) expect(fallbacks[0]!.durationMs).toBeLessThan(5_000);
  expect(fallbacks[0]).toMatchObject({ component: "wakes", kind: "error", ok: false, ids: { watcher: "route-test" },
    props: { step: "send", reason, durationMs: expect.any(Number) } });
});

test.each([{ sendKilled: true }, { sendExit137: true }])("an external send kill or exit 137 is not a helper timeout (%j)", async options => {
  const { logs } = await fixture(options);
  expect(helperRuns(logs, "send")).toHaveLength(1);
  expect(helperRuns(logs, "send")[0]).toMatchObject({ ok: false,
    ...helperContext("send", false), props: { op: "send", timeoutMs: 2000, timedOut: false, exitCode: 137 } });
});

test.each(["stdout", "stderr"])("a %s read failure keeps the live helper's deadline", async pipe => {
  const { logs, result } = await fixture({ sendSleep: true }, `(async () => {
    const spawn = Bun.spawn;
    let send;
    Bun.spawn = (args, options) => {
      const child = spawn(args, options);
      if (args[0] !== process.env.ROBOB_WATCH_T3CTL || args[1] !== 'send') return child;
      send = child;
      return {
        stdout: child.stdout, stderr: child.stderr,
        ${pipe}: new ReadableStream({ start(controller) { controller.error(new Error('fixture pipe failed')); } }),
        exited: child.exited, kill: child.kill.bind(child),
        get exitCode() { return child.exitCode; }, get signalCode() { return child.signalCode; },
      };
    };
    const delivery = await deliver(watcher, 'event happened', key, state);
    if (!send || await send.exited !== 137 || send.signalCode !== 'SIGKILL') throw new Error('pipe failure cancelled the deadline');
    return delivery;
  })()`);
  expect(result.via).toBe("wake:owner-fallback");
  expect(helperRuns(logs, "send")).toHaveLength(1);
  expect(helperRuns(logs, "send")[0]).toMatchObject({ ok: false, ...helperContext("send", false),
    error: { tag: "helper.spawn_failed" } });
});

test.each(["stdout", "stderr"])("a %s pipe draining after exit does not turn success into a timeout", async pipe => {
  const { logs, result } = await fixture({}, `(async () => {
    const spawn = Bun.spawn;
    Bun.spawn = (args, options) => {
      const child = spawn(args, options);
      if (args[0] !== process.env.ROBOB_WATCH_T3CTL || args[1] !== 'send') return child;
      // Simulate an inherited pipe held past the helper's 2s deadline after it exits.
      const held = new ReadableStream({ start(controller) {
        child.exited.then(async () => { await Bun.sleep(2100); controller.close(); });
      } });
      return {
        stdout: child.stdout, stderr: child.stderr, ${pipe}: held,
        exited: child.exited, kill: child.kill.bind(child),
        get exitCode() { return child.exitCode; }, get signalCode() { return child.signalCode; },
      };
    };
    return await deliver(watcher, 'event happened', key, state);
  })()`);
  expect(result.via).toBe("thread:abcd1234");
  expect(helperRuns(logs, "send")).toHaveLength(1);
  expect(helperRuns(logs, "send")[0]).toMatchObject({ ok: true, ...helperContext("send", false) });
  expect(helperRuns(logs, "send")[0]!.durationMs).toBeGreaterThanOrEqual(2000);
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
    { name: "send failure", sendError: true, reason: "send stub failure" },
  { name: "spawn failure", missingCli: true, reason: "send error after" },
])("$name falls back to the owner wake with the intended thread and a logged reason", async ({ name, reason, ...options }) => {
  const { result, calls, log } = await fixture(options);
  expect(result).toMatchObject({ ok: false, accepted: true, via: "wake:owner-fallback" });
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
  { name: "exit", nativeError: true, reason: "exit:1" },
  { name: "spawn", missingCli: true, reason: "exit:127" },
  ...["not json", "null", "[]", "{}", '{"thread":null}', '{"thread":[]}',
    '{"thread":{"threadId":12}}', '{"thread":{"threadId":""}}', '{"thread":{"threadId":"   "}}']
    .map(nativeOutput => ({ name: `invalid ${nativeOutput}`, nativeOutput, reason: "invalid" })),
])("native $name logs one fallback and delivers once to the owner", async ({ name, reason, ...options }) => {
  const session = "ses_gone_123456789";
  const { result, calls, fallbacks, runnerLog } = await fixture({ watcher: { created_by_session: session }, ...options });
  expect(result).toMatchObject({ ok: false, accepted: true, via: "wake" });
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
  { name: "exit", statusError: true, reason: "exit:1" },
  { name: "archived", status: { archived: true }, reason: "archived" },
])("status $name logs one fallback and keeps the intended-thread prefix", async ({ name, reason, ...options }) => {
  const { result, calls, fallbacks, runnerLog } = await fixture(options);
  expect(result).toMatchObject({ ok: false, accepted: true, via: "wake:owner-fallback" });
  expect(calls.filter(c => c.cli === "spectrum")).toHaveLength(1);
  expect(wakeText(calls)).toStartWith("(meant for thread abcd1234, which could not be reached)\n");
  expect(runnerLog).toContain(`creator lookup failed watcher=route-test session=${projectThread.slice(0, 12)} reason=${reason}`);
  expect(fallbacks).toHaveLength(1);
  expect(fallbacks[0]!.props!.durationMs).toBeGreaterThanOrEqual(0);
  expect(fallbacks[0]).toMatchObject({ component: "wakes", ok: false, ids: { watcher: "route-test" },
    props: { step: "status", reason } });
});

test.each([
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
  expect(result.deliveries.map(d => d.via)).toEqual([options.watcher ? "wake" : "wake:owner-fallback", options.watcher ? "wake" : "wake:owner-fallback", "thread:abcd1234"]);
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
  expect(result.held.pending?.creatorSend).toBeUndefined();
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
  expect(result.via).toBe("wake:owner-fallback");
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
    expect(sentLogs[0]).toMatchObject({ component: "wakes", kind: "event", ok: !sendError,
      ids: { watcher: "route-test" }, props: { via: sendError ? "wake:owner-fallback" : "thread:abcd1234", confirmed: "pending", accepted: true, events: 1 } });
    expect(sentLogs[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(sentLogs)).not.toContain("event happened");
    expect(JSON.stringify(sentLogs)).not.toContain("Handle this event");
  }
});

for (const entry of [
  { name: 'one status timeout', statusSleepOnce: true, probes: 2 },
  { name: 'two status timeouts', statusSleep: true, probes: 2 },
  { name: 'empty failing status', statusEmptyError: true, probes: 2 },
  { name: 'malformed JSON', statusOutput: 'not json', probes: 1 },
  { name: 'malformed status', status: { archived: null }, probes: 1 },
  { name: 'one native timeout', nativeSleepOnce: true, watcher: { created_by_session: 'ses_old' }, probes: 1 },
]) {
  test(`${entry.name} still queues to creator`, async () => {
    const { result, calls, log, logs } = await fixture(entry);
    const op = entry.nativeSleepOnce ? "native" : "status";
    const timeout = !!(entry.nativeSleepOnce || entry.statusSleepOnce || entry.statusSleep);
    expect(helperRuns(logs, op)).toHaveLength(1);
    expect(helperRuns(logs, op)[0]).toMatchObject(helperContext(op, timeout));
    const retries = helperRuns(logs, `${op}_retry`);
    expect(retries).toHaveLength(timeout || entry.statusEmptyError ? 1 : 0);
    if (retries.length) expect(retries[0]).toMatchObject(helperContext(`${op}_retry`, !!entry.statusSleep));
    if (process.env.TOOLLOG_SAMPLES && timeout) console.log("LOG_SAMPLE " + JSON.stringify(helperRuns(logs, op)[0]));
    expect(result).toMatchObject({ ok: false, accepted: true, confirmed: 'pending', via: 'thread:abcd1234' });
    expect(calls.filter(call => call.args[0] === 'status')).toHaveLength(entry.probes);
    expect(calls.filter(call => call.args[0] === 'send' && call.cli === 't3ctl')).toHaveLength(1);
    expect(calls.filter(call => call.cli === 'spectrum')).toHaveLength(0);
    if (entry.statusSleep) {
      expect(log).toContain('status timeout after');
      expect(log).toContain('retry timeout after');
      expect(log).toContain('probe waiting');
    }
  });
}

const confirmBody = (body: string, event = 'event happened') => `(async () => {
  state.pending = { key, event: ${JSON.stringify(event)}, at: new Date().toISOString(), watcher };
  saveState(watcher.id, state);
  const { tickOne } = await import(${JSON.stringify(runnerPath)});
  await tickOne(watcher.id);
  const before = loadState(watcher.id);
  const base = before.confirm.sentAt;
  const at = base + 10 * 60_000 + 1;
  Date.now = () => at;
  ${body}
  return { before, state: loadState(watcher.id) };
})()`;

const routeFailureWords = ['archived', 'not_found', 'invalid id', 'invalid_id', 'invalid thread', 'invalid_thread', 'invalid session', 'invalid_session'];
const sendPhases = ['initial', 'retry', 'escalation'] as const;
const retryHintCases = routeFailureWords.flatMap((word, index) => sendPhases.map(phase => ({
  word, phase,
  transport: index % 2 ? 'timed out' : 'connection dropped',
  stream: index % 4 < 2 ? 'stderr' as const : 'stdout' as const,
  field: ['title', 'event', 'context'][index % 3]!,
})));

test.each(retryHintCases)('retry hint payload $word in $field stays on the thread during $phase ($transport, $stream)', async ({ word, phase, transport, stream, field }) => {
  const payload = `watcher's ${word} event${field === 'title' ? '' : '\nfollow-up context'}`;
  const event = field === 'event' ? payload : 'event happened';
  const watcher = field === 'event' ? {} : { [field]: payload };
  const sendDiagnostic = `send ${transport}; it may or may not have been delivered`;
  const options: Fixture = { watcher, ...(phase === 'initial' ? { sendDiagnostic, sendDiagnosticStream: stream }
    : phase === 'retry' ? { sendFailure: 'fetch failed' } : { sendAmbiguous: true }) };
  const { result, calls, logs, sentLogs, log } = await fixture(options, confirmBody(phase === 'initial' ? '' : `
    writeFileSync(configPath, JSON.stringify({ status: { threadId: watcher.created_by_session, archived: false },
      sendDiagnostic: ${JSON.stringify(sendDiagnostic)}, sendDiagnosticStream: ${JSON.stringify(stream)} }));
    ${phase === 'retry' ? 'Date.now = () => before.confirm.nextAt;' : ''}
    await tickOne(watcher.id);
    ${phase === 'escalation' ? 'Date.now = () => at + 31_000; await tickOne(watcher.id);' : ''}
  `, event));
  expect(result.state.confirm).toMatchObject({ thread: projectThread });
  expect(result.state.confirm?.ownerFallback).not.toBe(true);
  expect(result.state.confirm?.sendPending).toBeUndefined();
  expect(calls.filter(call => call.cli === 'spectrum')).toHaveLength(0);
  expect(log).not.toContain('via=wake:owner-fallback');
  const sends = calls.filter(call => call.cli === 't3ctl' && call.args[0] === 'send');
  expect(sends).toHaveLength(phase === 'initial' ? 1 : 2);
  expect(sends[0]!.args[2]).toContain(payload);
  if (phase === 'initial') {
    expect(sentLogs[0]?.props?.via).toBe('thread:abcd1234');
    expect(sentLogs[0]?.props?.failureClass).toBe(transport === 'timed out' ? 'timeout' : 'control_api_unavailable');
  } else {
    expect(sends[1]!.args).toEqual(sends[0]!.args);
    expect(logs.find(row => row.name === 'wake.send_retry')?.props?.outcome).toBe('ambiguous');
  }
  if (phase === 'retry') expect(log).toContain('creator send delivered after 1 retries');
  expect(calls.filter(call => call.cli === 'telegram')).toHaveLength(phase === 'escalation' ? 1 : 0);
});

test.each(routeFailureWords.flatMap(word => sendPhases.map(phase => ({ word, phase }))))(
  'an actual $word send diagnostic still falls back during $phase', async ({ word, phase }) => {
    const sendFailure = `${word}: thread gone after server_restart`;
    const { result, calls, sentLogs, logs } = await fixture(phase === 'initial' ? { sendFailure }
      : phase === 'retry' ? { sendFailure: 'fetch failed' } : { sendAmbiguous: true }, confirmBody(phase === 'initial' ? '' : `
      writeFileSync(configPath, JSON.stringify({ status: { threadId: watcher.created_by_session, archived: false },
        sendFailure: ${JSON.stringify(sendFailure)} }));
      ${phase === 'retry' ? 'Date.now = () => before.confirm.nextAt;' : ''}
      await tickOne(watcher.id);
    `));
    expect(result.state.confirm?.ownerFallback).toBe(true);
    expect(calls.filter(call => call.cli === 'spectrum')).toHaveLength(1);
    expect(wakeText(calls)).toStartWith('(meant for thread abcd1234, which could not be reached)\n');
    if (phase === 'initial') expect(sentLogs[0]?.props?.failureClass).toBe('definite');
    else expect(logs.find(row => row.name === 'wake.send_retry')?.props?.outcome).toBe('definite');
  },
);

test.each(routeFailureWords.flatMap(word => sendPhases.map(phase => ({ word, phase }))))(
  'exit-1 unavailable code overrides quoted $word message during $phase', async ({ word, phase }) => {
    const sendFailure = `unavailable: Backend recovering for thread title '${word} event'`;
    const { result, calls, sentLogs, logs } = await fixture(phase === 'initial' ? { sendFailure }
      : phase === 'retry' ? { sendFailure: 'fetch failed' } : { sendAmbiguous: true }, confirmBody(phase === 'initial' ? '' : `
      writeFileSync(configPath, JSON.stringify({ status: { threadId: watcher.created_by_session, archived: false },
        sendFailure: ${JSON.stringify(sendFailure)} }));
      ${phase === 'retry' ? 'Date.now = () => before.confirm.nextAt;' : ''}
      await tickOne(watcher.id);
    `));
    expect(result.state.confirm).toMatchObject({ thread: projectThread, sendPending: true });
    expect(result.state.confirm?.ownerFallback).not.toBe(true);
    expect(calls.filter(call => call.cli === 'spectrum')).toHaveLength(0);
    if (phase === 'initial') expect(sentLogs[0]?.props?.failureClass).toBe('timeout');
    else expect(logs.find(row => row.name === 'wake.send_retry')?.props?.outcome).toBe('deferred');
  },
);

test.each(routeFailureWords)('exit-1 status unavailable code overrides quoted %s message', async word => {
  const { result, calls } = await fixture({ statusFailure: `unavailable: Backend recovering for thread title '${word} event'` });
  expect(result.via).toBe('thread:abcd1234');
  expect(calls.filter(call => call.cli === 'spectrum')).toHaveLength(0);
});

test.each(sendPhases)('a combined retry hint before its diagnostic stays ambiguous during %s', async phase => {
  const sendDiagnostic = 'send connection dropped; it may or may not have been delivered';
  const { result, calls, sentLogs, logs, log } = await fixture({ watcher: { title: 'archived event' },
    ...(phase === 'initial' ? { sendDiagnostic, sendDiagnosticStream: 'split' }
      : phase === 'retry' ? { sendFailure: 'fetch failed' } : { sendAmbiguous: true }) }, confirmBody(phase === 'initial' ? '' : `
    writeFileSync(configPath, JSON.stringify({ status: { threadId: watcher.created_by_session, archived: false },
      sendDiagnostic: ${JSON.stringify(sendDiagnostic)}, sendDiagnosticStream: 'split' }));
    ${phase === 'retry' ? 'Date.now = () => before.confirm.nextAt;' : ''}
    await tickOne(watcher.id);
  `));
  expect(result.state.confirm).toMatchObject({ thread: projectThread });
  expect(result.state.confirm?.ownerFallback).not.toBe(true);
  expect(result.state.confirm?.sendPending).toBeUndefined();
  expect(calls.filter(call => call.cli === 'spectrum')).toHaveLength(0);
  const sends = calls.filter(call => call.cli === 't3ctl' && call.args[0] === 'send');
  expect(sends).toHaveLength(phase === 'initial' ? 1 : 2);
  expect(helperRuns(logs, 'send').at(-1)?.props?.exitCode).toBe(4);
  if (phase === 'initial') {
    expect(log).toContain(sendDiagnostic);
    expect(sentLogs[0]?.props?.failureClass).toBe('control_api_unavailable');
  } else {
    expect(sends[1]!.args).toEqual(sends[0]!.args);
    expect(logs.find(row => row.name === 'wake.send_retry')?.props?.outcome).toBe('ambiguous');
  }
});

test.each([
  'fetch failed', 'ECONNREFUSED: connect failed', 'ECONNRESET', 'socket hang up', 'EPIPE',
  'http_error: HTTP 502', 'http_error: HTTP 503', 'http_error: HTTP 504', 'server_restart',
  'TimeoutError: The operation was aborted due to timeout',
])('transport failure %s stays deferred on its thread', async failure => {
  const { result, calls, sentLogs, log } = await fixture({ statusFailure: 'fetch failed', sendFailure: failure }, confirmBody(''));
  expect(result.before.confirm).toMatchObject({ sendPending: true, sendAttempts: 0, thread: projectThread });
  expect(calls.filter(call => call.cli !== 't3ctl')).toHaveLength(0);
  expect(log).toContain('via=thread:abcd1234 confirmed=pending send=deferred');
  expect(sentLogs[0]?.props).toMatchObject({ sendDeferred: true,
    failureClass: failure.startsWith('TimeoutError') ? 'timeout' : 'control_api_unavailable' });
});

test('an outage recovers with the same key and payload on the next retry tick', async () => {
  const { result, calls, logs, log } = await fixture({ statusFailure: 'fetch failed', sendFailure: 'fetch failed' }, confirmBody(`
    Date.now = () => before.confirm.nextAt;
    writeFileSync(configPath, JSON.stringify({ status: { threadId: watcher.created_by_session, archived: false } }));
    await tickOne(watcher.id);
  `));
  expect(result.before.confirm?.sendPending).toBe(true);
  expect(result.state.confirm).toMatchObject({ sendAttempts: 1, sentAt: result.before.confirm!.sentAt });
  expect(result.state.confirm?.sendPending).toBeUndefined();
  const sends = calls.filter(call => call.cli === 't3ctl' && call.args[0] === 'send');
  expect(sends).toHaveLength(2);
  expect(sends[0]!.args).toEqual(sends[1]!.args);
  expect(calls.filter(call => call.cli !== 't3ctl')).toHaveLength(0);
  expect(log).toContain('creator send delivered after 1 retries');
  expect(logs.find(row => row.name === 'wake.send_retry')).toMatchObject({ durationMs: expect.any(Number), ids: { watcher: 'route-test' }, props: { op: 'send', attempt: 1, outcome: 'accepted' } });
  expect(logs.find(row => row.name === 'wake.send_delivered_late')).toMatchObject({ ids: { watcher: 'route-test' }, props: { op: 'send', retries: 1, totalDelayMs: result.before.confirm!.nextAt! - result.before.confirm!.sentAt } });
});

test('show exposes deferred attempts and the next retry', async () => {
  const { result } = await fixture({ sendFailure: 'fetch failed' }, confirmBody(`
    const show = Bun.spawnSync([process.execPath, ${JSON.stringify(join(import.meta.dir, '../src/cli.ts'))}, 'show', watcher.id], { env: process.env });
    if (show.exitCode !== 0 || !show.stdout.toString().includes('send=deferred attempts=0 next_retry=')) throw new Error('show omitted deferred state');
  `));
  expect(result.state.confirm?.sendPending).toBe(true);
});

test('an ambiguous retry clears sendPending and reconciles a subsequent run', async () => {
  const { result, calls } = await fixture({ sendFailure: 'fetch failed' }, confirmBody(`
    Date.now = () => before.confirm.nextAt;
    writeFileSync(configPath, JSON.stringify({ sendAmbiguous: true, status: { threadId: watcher.created_by_session, archived: false } }));
    await tickOne(watcher.id);
    if (loadState(watcher.id).confirm.sendPending) throw new Error('ambiguous retry still deferred');
    const delivered = loadState(watcher.id).confirm.sentAt;
    writeFileSync(configPath, JSON.stringify({ status: { threadId: watcher.created_by_session, archived: false,
      recentRuns: [{ requestedAt: new Date(delivered).toISOString() }] } }));
    const next = loadState(watcher.id).confirm.nextAt;
    Date.now = () => next;
    await tickOne(watcher.id);
  `));
  expect(result.state.confirm).toBeUndefined();
  expect(calls.filter(call => call.cli !== 't3ctl')).toHaveLength(0);
});

test.each([
  'unavailable: Thread send timed out waiting for message command admission for thread ' + projectThread,
  'unavailable: Thread send is temporarily unavailable',
  'send_timeout: Thread send timed out waiting for message command admission for thread ' + projectThread,
])('admission failure %s defers and retries the same key', async failure => {
  const { result, calls, logs, log } = await fixture({ sendFailure: failure }, confirmBody(`
    Date.now = () => before.confirm.nextAt;
    writeFileSync(configPath, JSON.stringify({ status: { threadId: watcher.created_by_session, archived: false } }));
    await tickOne(watcher.id);
  `));
  expect(result.before.confirm?.sendPending).toBe(true);
  expect(result.state.confirm?.sendPending).toBeUndefined();
  const sends = calls.filter(call => call.cli === 't3ctl' && call.args[0] === 'send');
  expect(sends).toHaveLength(2);
  expect(sends[0]!.args).toEqual(sends[1]!.args);
  expect(calls.filter(call => call.cli !== 't3ctl')).toHaveLength(0);
  expect(log).toContain('send=deferred');
  expect(log).toContain('creator send delivered after 1 retries');
  expect(logs.find(row => row.name === 'wake.sent')?.props?.failureClass).toBe('timeout');
});

test('a deferred escalation retry can confirm the original completed run', async () => {
  const { result, calls, log } = await fixture({}, confirmBody(`
    writeFileSync(configPath, JSON.stringify({ sendFailure: 'fetch failed', status: { threadId: watcher.created_by_session, archived: false } }));
    await tickOne(watcher.id);
    if (!loadState(watcher.id).confirm.sendPending) throw new Error('escalation did not defer');
    const due = loadState(watcher.id).confirm.nextAt;
    Date.now = () => due;
    writeFileSync(configPath, JSON.stringify({ sendOutput: JSON.stringify({ ok: true, duplicate: true }),
      status: { threadId: watcher.created_by_session, archived: false, state: 'idle',
        recentRuns: [{ requestedAt: new Date(base + 1).toISOString(), status: 'completed' }] } }));
    await tickOne(watcher.id);
  `));
  expect(result.state.confirm).toBeUndefined();
  expect(calls.filter(call => call.cli === 'spectrum')).toHaveLength(0);
  expect(log).toContain('creator send delivered after 2 retries');
});

test('deferred recovery follows a rotated iMessage creator to the live owner route', async () => {
  const { result, calls } = await fixture({ statusFailure: 'fetch failed', sendFailure: 'fetch failed' }, confirmBody(`
    Date.now = () => before.confirm.nextAt;
    writeFileSync(configPath, JSON.stringify({ status: { threadId: watcher.created_by_session, archived: false, origin: 'imessage' } }));
    await tickOne(watcher.id);
  `));
  expect(result.state.confirm?.ownerFallback).toBe(true);
  expect(result.state.last_delivery).toBe('wake');
  expect(calls.filter(call => call.cli === 't3ctl' && call.args[0] === 'send')).toHaveLength(1);
  expect(wakeText(calls)).toStartWith('Routing event\n');
  expect(wakeText(calls)).not.toContain('meant for thread');
});

test('native recovery defers a transport error once its thread resolves', async () => {
  const { result, calls } = await fixture({ nativeSleep: true, watcher: { created_by_session: 'ses_old' } }, confirmBody(`
    writeFileSync(configPath, JSON.stringify({ sendFailure: 'fetch failed', status: { threadId: ${JSON.stringify(projectThread)}, archived: false } }));
    Date.now = () => base + 60_000;
    await tickOne(watcher.id);
  `));
  expect(result.state.confirm).toMatchObject({ sendPending: true, thread: projectThread });
  expect(calls.filter(call => call.cli !== 't3ctl')).toHaveLength(0);
});

test.each(['not_found', 'archived', 'invalid_thread'])('a deferred send falls back only after a definite %s re-check', async failure => {
  const { result, calls } = await fixture({ sendFailure: 'fetch failed' }, confirmBody(`
    Date.now = () => before.confirm.nextAt;
    writeFileSync(configPath, JSON.stringify({ statusFailure: ${JSON.stringify(failure)} }));
    await tickOne(watcher.id);
  `));
  expect(result.state.confirm).toMatchObject({ ownerFallback: true });
  expect(result.state.confirm?.sendPending).toBeUndefined();
  expect(wakeText(calls)).toStartWith('(meant for thread abcd1234, which could not be reached)\n');
  expect(calls.filter(call => call.cli === 't3ctl' && call.args[0] === 'send')).toHaveLength(1);
});

test('a definite send failure takes precedence over outage text', async () => {
  const { result, calls, sentLogs } = await fixture({ sendFailure: 'not_found: thread gone after server_restart' });
  expect(result.via).toBe('wake:owner-fallback');
  expect(wakeText(calls)).toContain('which could not be reached');
  expect(sentLogs[0]?.props?.failureClass).toBe('definite');
});

test.each([false, true])('a slow or unavailable target escalates to the same thread (unavailable: %j)', async unavailable => {
  const { result, calls, logs, log } = await fixture({ sendAmbiguous: true }, confirmBody(`
    writeFileSync(configPath, JSON.stringify({ ${unavailable ? "statusFailure: 'fetch failed', sendFailure: 'fetch failed'" : "status: { threadId: watcher.created_by_session, archived: false }"} }));
    await tickOne(watcher.id);
    Date.now = () => at + 31_000;
    await tickOne(watcher.id);
  `));
  expect(result.state.confirm?.ownerFallback).not.toBe(true);
  expect(logs.filter(row => row.name === 'wake.unconfirmed')).toHaveLength(1);
  expect(calls.filter(call => call.cli === 'telegram')).toHaveLength(1);
  expect(calls.filter(call => call.cli === 'spectrum')).toHaveLength(0);
  expect(log).toContain(`confirmed=pending (target ${unavailable ? 'unverified' : 'live'})`);
  expect(log).not.toContain('via=wake:owner-fallback');
});

test('an archived escalation target falls back to the owner', async () => {
  const { result, calls } = await fixture({ sendAmbiguous: true }, confirmBody(`
    writeFileSync(configPath, JSON.stringify({ status: { threadId: watcher.created_by_session, archived: true } }));
    await tickOne(watcher.id);
  `));
  expect(result.state.confirm?.ownerFallback).toBe(true);
  expect(wakeText(calls)).toStartWith('(meant for thread abcd1234, which could not be reached)\n');
});

test('busy thread queue acceptance stays pending during one-shot escalation', async () => {
  const { result, calls, logs, log } = await fixture({ watcher: { max_fires: 1 }, sendAmbiguous: true }, confirmBody(`
    if (before.status !== 'done') throw new Error('one-shot watcher did not finish');
    writeFileSync(configPath, JSON.stringify({ status: { threadId: watcher.created_by_session, archived: false,
      recentRuns: [{ requestedAt: new Date(base - 60_000).toISOString() }] },
      sendOutput: JSON.stringify({ ok: true, runId: 'wake-X', messageId: 'message-X', status: 'queued', delivery: 'queued' }) }));
    await tickOne(watcher.id);
    Date.now = () => at + 31_000;
    await tickOne(watcher.id);
  `));
  expect(result.state.status).toBe('done');
  expect(result.state.confirm).toMatchObject({ runId: 'wake-X', runState: 'queued' });
  expect(calls.filter(call => call.cli === 'telegram')).toHaveLength(1);
  expect(calls.filter(call => call.cli === 'spectrum')).toHaveLength(0);
  const sends = calls.filter(call => call.cli === 't3ctl' && call.args[0] === 'send');
  expect(sends).toHaveLength(2);
  expect(sends[0]!.args).toEqual(sends[1]!.args);
  expect(logs.filter(row => row.name === 'wake.confirmed')).toHaveLength(0);
  expect(log).not.toContain('via=wake:owner-fallback');
});

test('a busy thread queue receipt stays pending on the first send too', async () => {
  const { result } = await fixture({ sendOutput: JSON.stringify({ ok: true, status: 'queued', delivery: 'queued' }) });
  expect(result).toMatchObject({ ok: false, accepted: true, confirmed: 'pending' });
  expect(result.confirmation).toBeDefined();
});

test('deferred retries follow exponential backoff and the five-minute cap', async () => {
  const { result, calls } = await fixture({ sendFailure: 'fetch failed' }, confirmBody(`
    const { wakeSendBackoff } = await import(${JSON.stringify(libPath)});
    process.env.ROBOB_WATCH_SEND_RETRY_MS = '1000';
    if (wakeSendBackoff(0) !== 1000 || wakeSendBackoff(20) !== 300_000) throw new Error('configured backoff');
    delete process.env.ROBOB_WATCH_SEND_RETRY_MS;
    for (let attempt = 0; attempt < 7; attempt++) {
      const fresh = loadState(watcher.id);
      const due = fresh.confirm.nextAt;
      Date.now = () => due - 1;
      await tickOne(watcher.id);
      if ((loadState(watcher.id).confirm.sendAttempts ?? 0) !== attempt) throw new Error('early retry');
      Date.now = () => due;
      await tickOne(watcher.id);
      const after = loadState(watcher.id).confirm;
      if (after.sendAttempts !== attempt + 1 || after.nextAt - due !== Math.min(300_000, 30_000 * 2 ** (attempt + 1))) throw new Error('wrong backoff');
    }
  `));
  expect(result.state.confirm).toMatchObject({ sendPending: true, sendAttempts: 7 });
  expect(calls.filter(call => call.cli === 't3ctl' && call.args[0] === 'send')).toHaveLength(8);
  expect(calls.filter(call => call.cli === 'spectrum')).toHaveLength(0);
});

test('send backoff does not delay the ten-minute alert or trigger an early retry', async () => {
  const { result, calls, logs } = await fixture({ sendFailure: 'fetch failed' }, confirmBody(`
    for (let i = 0; i < 4; i++) {
      const due = loadState(watcher.id).confirm.nextAt;
      Date.now = () => due;
      await tickOne(watcher.id);
    }
    const due = loadState(watcher.id).confirm.nextAt;
    if (due <= at) throw new Error('fixture did not span the alert deadline');
    Date.now = () => at;
    await tickOne(watcher.id);
    if (loadState(watcher.id).confirm.nextAt !== due) throw new Error('alert changed retry schedule');
    Date.now = () => at + 1000;
    await tickOne(watcher.id);
  `));
  expect(result.state.confirm).toMatchObject({ sendPending: true, sendAttempts: 4, alertDone: true });
  expect(calls.filter(call => call.cli === 't3ctl' && call.args[0] === 'send')).toHaveLength(5);
  expect(calls.filter(call => call.cli === 'telegram')).toHaveLength(1);
  expect(calls.filter(call => call.cli === 'spectrum')).toHaveLength(0);
  expect(logs.filter(row => row.name === 'wake.unconfirmed')).toHaveLength(1);
});

test('deferred sends respect quiet hours and their asynchronous probes yield to timers', async () => {
  const { result, calls } = await fixture({ sendFailure: 'fetch failed' }, confirmBody(`
    const hour = new Date(at).getUTCHours();
    watcher.quiet = { start: hour, end: (hour + 1) % 24, time_zone: 'UTC' };
    await confirmWakes(watcher);
    const held = loadState(watcher.id);
    if (held.confirm.sendAttempts !== 0) throw new Error('retried during quiet hours');
    delete watcher.quiet;
    Date.now = () => at + 31_000;
    writeFileSync(configPath, JSON.stringify({ statusSleep: true, sendFailure: 'fetch failed' }));
    let timerRan = false;
    const timer = setTimeout(() => { timerRan = true; }, 10);
    await confirmWakes(watcher);
    clearTimeout(timer);
    if (!timerRan) throw new Error('deferred send blocked timers');
  `));
  expect(result.state.confirm?.sendAttempts).toBe(1);
  expect(calls.filter(call => call.cli === 'spectrum')).toHaveLength(0);
});

test.each([false, true])('an unconfirmed send escalates once, including a send timeout (%j)', async sendSleep => {
  const { result, calls, logs, runnerLog, log } = await fixture({ sendSleep }, confirmBody(`
    await tickOne(watcher.id);
    Date.now = () => at + 31_000;
    await tickOne(watcher.id);
  `));
  expect(result.before.confirm).toMatchObject({ key: 'robob-watch:route-test:1:stable-event', thread: projectThread, attempts: 0 });
  expect(result.before.pending).toBeUndefined();
  expect(result.state.confirm).toMatchObject({ escalated: true, fallbackDone: true });
  expect(result.state.confirm?.ownerFallback).not.toBe(true);
  expect(calls.filter(call => call.cli === 'telegram')).toHaveLength(1);
  expect(calls.filter(call => call.cli === 'telegram')[0]!.args).toContain('--severity=attention');
  expect(calls.filter(call => call.cli === 'spectrum')).toHaveLength(0);
  const sends = calls.filter(call => call.cli === 't3ctl' && call.args[0] === 'send');
  expect(sends).toHaveLength(2);
  expect(sends[0]!.args).toEqual(sends[1]!.args);
  expect(logs.filter(row => row.name === 'wake.unconfirmed')).toHaveLength(1);
  expect(runnerLog).toContain('wake unconfirmed');
  expect(log).toContain('wake unconfirmed');
});

for (const status of [
  { recentRuns: [{ requestedAt: 'future' }] },
  { runs: [{ startedAt: 'future' }] },
  { run: { requestedAt: 'future' } },
  { state: 'running' },
]) {
  test.each([false, true])(`a new run confirms via ${Object.keys(status)[0]} (send timeout: %j)`, async sendSleep => {
    const { result, calls, logs, log } = await fixture({ sendSleep }, confirmBody(`
      const status = JSON.parse(JSON.stringify(${JSON.stringify(status)}).replaceAll('future', new Date(base).toISOString()));
      writeFileSync(configPath, JSON.stringify({ status: { threadId: watcher.created_by_session, archived: false, ...status } }));
      await tickOne(watcher.id);
    `));
    expect(helperRuns(logs, "confirm")).toHaveLength(1);
    expect(helperRuns(logs, "confirm")[0]).toMatchObject({ ok: true, ...helperContext("confirm", false) });
    expect(helperRuns(logs, "send")[0]).toMatchObject(helperContext("send", sendSleep));
    expect(result.state.confirm).toBeUndefined();
    expect(calls.filter(call => call.cli !== 't3ctl')).toHaveLength(0);
    expect(logs.filter(row => row.name === 'wake.confirmed')).toHaveLength(1);
    expect(logs.find(row => row.name === 'wake.confirmed')!.durationMs).toBeGreaterThanOrEqual(600_000);
    expect(log).toContain('wake confirmed after');
  });
}

test('owner fallback confirms when the inbound row moves from pending to processing; show includes confirmation and route', async () => {
  const { result, calls, logs, log } = await fixture({ statusError: true }, confirmBody(`
    const db = new Database(process.env.ROBOB_WATCH_BRIDGE_DB);
    db.query('insert into inbound values (?, ?)').run(wakeInboundId(key), 'pending');
    Date.now = () => base + 1_000;
    await tickOne(watcher.id);
    if (!loadState(watcher.id).confirm) throw new Error('pending row confirmed too early');
    const show = Bun.spawnSync([process.execPath, ${JSON.stringify(join(import.meta.dir, '../src/cli.ts'))}, 'show', watcher.id]);
    if (!show.stdout.toString().includes('wake:owner-fallback') || !show.stdout.toString().includes('"confirm"')) throw new Error('show omitted delivery state');
    db.query('update inbound set state = ?').run('processing');
    db.close();
    Date.now = () => base + 32_000;
    await tickOne(watcher.id);
  `));
  expect(result.state.confirm).toBeUndefined();
  expect(calls.filter(call => call.cli === 'telegram')).toHaveLength(0);
  expect(logs.filter(row => row.name === 'wake.confirmed')).toHaveLength(1);
  expect(log).toContain('via=wake:owner-fallback meant_for=abcd1234 confirmed=pending');
});

test('native timeouts hold the event, retry resolution on ticks and escalate once without an immediate owner wake', async () => {
  const { result, calls, logs } = await fixture({ nativeSleep: true, watcher: { created_by_session: 'ses_old' } }, confirmBody(`
    if (before.last_delivery !== 'native:pending') throw new Error('native timeout escaped to owner');
    await tickOne(watcher.id);
    Date.now = () => at + 31_000;
    await tickOne(watcher.id);
  `));
  expect(result.before.confirm).toMatchObject({ nativeSession: 'ses_old' });
  expect(calls.filter(call => call.cli === 'spectrum')).toHaveLength(1);
  expect(calls.filter(call => call.cli === 'telegram')).toHaveLength(1);
  expect(logs.filter(row => row.name === 'wake.unconfirmed')).toHaveLength(1);
});

test('native lookup recovers after two timeouts and confirms the creator run without owner fallback', async () => {
  const { result, calls, logs } = await fixture({ nativeSleep: true, watcher: { created_by_session: 'ses_old' } }, confirmBody(`
    writeFileSync(configPath, JSON.stringify({ status: { threadId: ${JSON.stringify(projectThread)}, archived: false, recentRuns: [{ requestedAt: new Date(at).toISOString() }] } }));
    await tickOne(watcher.id);
  `));
  expect(result.state.confirm).toBeUndefined();
  expect(calls.filter(call => call.args[0] === 'send' && call.cli === 't3ctl')).toHaveLength(1);
  expect(calls.filter(call => call.cli !== 't3ctl')).toHaveLength(0);
  expect(logs.filter(row => row.name === 'wake.confirmed')).toHaveLength(1);
});

test('an old run does not confirm, and multiple fires retain separate once-only escalation across reloads', async () => {
  const { result, calls, logs } = await fixture({ status: { recentRuns: [{ requestedAt: '2020-01-01T00:00:00Z' }] } }, confirmBody(`
    const second = await deliver(watcher, 'second event', key + ':second', loadState(watcher.id));
    const fresh = loadState(watcher.id);
    fresh.confirmations = [second.confirmation];
    fresh.status = 'done';
    saveState(watcher.id, fresh);
    await tickOne(watcher.id);
    Date.now = () => at + 10 * 60_000 + 1;
    await tickOne(watcher.id);
    Date.now = () => at + 11 * 60_000;
    await tickOne(watcher.id);
  `));
  expect(result.state.confirm?.escalated).toBe(true);
  expect(result.state.confirmations?.[0]?.escalated).toBe(true);
  expect(calls.filter(call => call.cli === 'telegram')).toHaveLength(2);
  expect(logs.filter(row => row.name === 'wake.unconfirmed')).toHaveLength(2);
  expect(logs.filter(row => row.name === 'wake.confirmed')).toHaveLength(0);
});

test('a slow confirmation probe yields to runner timers and a done watcher still confirms', async () => {
  const { result, calls, logs } = await fixture({}, confirmBody(`
    const fresh = loadState(watcher.id);
    fresh.status = 'done';
    saveState(watcher.id, fresh);
    writeFileSync(configPath, JSON.stringify({ statusSleep: true }));
    let timerRan = false;
    const timer = setTimeout(() => { timerRan = true; }, 10);
    Date.now = () => base + 1_000;
    await tickOne(watcher.id);
    clearTimeout(timer);
    if (!timerRan) throw new Error('confirmation blocked timers');
  `));
  expect(helperRuns(logs, "confirm")).toHaveLength(1);
  expect(helperRuns(logs, "confirm")[0]).toMatchObject({ ok: false, ...helperContext("confirm", true),
    props: { op: "confirm", timeoutMs: 2000, timedOut: true, exitCode: 137 } });
  expect(result.state.confirm?.attempts).toBe(1);
  expect(calls.filter(call => call.cli !== 't3ctl')).toHaveLength(0);
});

test('t3ctl exit 4 reconciles the creator run without an owner wake', async () => {
  const { result, calls, logs } = await fixture({ sendAmbiguous: true }, confirmBody(`
    writeFileSync(configPath, JSON.stringify({ status: { threadId: watcher.created_by_session, archived: false,
      recentRuns: [{ requestedAt: new Date(base).toISOString() }] } }));
    await tickOne(watcher.id);
  `));
  expect(result.before.last_delivery).toBe('thread:abcd1234');
  expect(result.state.confirm).toBeUndefined();
  expect(calls.filter(call => call.cli !== 't3ctl')).toHaveLength(0);
  expect(logs.filter(row => row.name === 'wake.confirmed')).toHaveLength(1);
});

test.each([true, false])('escalation preserves the accepted owner-wake payload (creator fallback: %j)', async statusError => {
  const { result, calls } = await fixture({ statusError, strictWakeKey: true,
    ...(statusError ? {} : { watcher: { created_by_session: null } }) }, confirmBody(`await tickOne(watcher.id);`));
  const wakes = calls.filter(call => call.cli === 'spectrum' && call.args[0] === 'wake');
  expect(wakes).toHaveLength(2);
  expect(wakes[0]!.args).toEqual(wakes[1]!.args);
  expect(calls.filter(call => call.cli === 'spectrum' && call.args[0] === 'send')).toHaveLength(0);
  expect(result.state.confirm?.fallbackDone).toBe(true);
});

test.each(['alert', 'fallback'])('interrupted escalation resumes only the unfinished %s action', async unfinished => {
  const { result, calls, logs } = await fixture({}, confirmBody(`
    const fresh = loadState(watcher.id);
    Object.assign(fresh.confirm, { escalated: true, unconfirmedAt: at, alertDone: ${unfinished !== 'alert'}, fallbackDone: ${unfinished !== 'fallback'} });
    saveState(watcher.id, fresh);
    await tickOne(watcher.id);
    Date.now = () => at + 31_000;
    await tickOne(watcher.id);
  `));
  expect(calls.filter(call => call.cli === 'telegram')).toHaveLength(unfinished === 'alert' ? 1 : 0);
  expect(calls.filter(call => call.cli === 'spectrum')).toHaveLength(0);
  expect(calls.filter(call => call.cli === 't3ctl' && call.args[0] === 'send')).toHaveLength(unfinished === 'fallback' ? 2 : 1);
  expect(logs.filter(row => row.name === 'wake.unconfirmed')).toHaveLength(0);
  expect(result.state.confirm).toMatchObject({ alertDone: true, fallbackDone: true });
});

test.each([false, true])('quiet hours defer native recovery and escalation event sends (%j)', async native => {
  const { result, calls } = await fixture(native ? { nativeSleep: true, watcher: { created_by_session: 'ses_old' } } : {}, confirmBody(`
    const hour = new Date(at).getUTCHours();
    const quiet = { start: hour, end: (hour + 1) % 24, time_zone: 'UTC' };
    const path = join(process.env.ROBOB_WATCH_ROOT, 'watchers', watcher.id, 'watcher.json');
    writeFileSync(path, JSON.stringify({ ...watcher, quiet }));
    writeFileSync(configPath, JSON.stringify({ status: { threadId: ${JSON.stringify(projectThread)}, archived: false } }));
    await tickOne(watcher.id);
  `));
  expect(calls.filter(call => call.cli === 'telegram' || call.cli === 'spectrum')).toHaveLength(0);
  expect(calls.filter(call => call.cli === 't3ctl' && call.args[0] === 'send')).toHaveLength(native ? 0 : 1);
  expect(result.state.confirm).toBeDefined();
});

test('native recovery cannot confirm from an unrelated run before its actual send', async () => {
  const { result, calls, logs } = await fixture({ nativeSleep: true, watcher: { created_by_session: 'ses_old' } }, confirmBody(`
    writeFileSync(configPath, JSON.stringify({ sendAmbiguous: true, status: { threadId: ${JSON.stringify(projectThread)}, archived: false,
      recentRuns: [{ requestedAt: new Date(base + 1).toISOString() }] } }));
    Date.now = () => base + 60_000;
    await tickOne(watcher.id);
  `));
  expect(result.state.confirm?.sentAt).toBeGreaterThan(result.before.confirm!.sentAt);
  expect(result.state.confirm?.deadlineAt).toBe(result.before.confirm!.sentAt);
  expect(logs.filter(row => row.name === 'wake.confirmed')).toHaveLength(0);
  expect(calls.filter(call => call.cli !== 't3ctl')).toHaveLength(0);
});

test('ambiguous native-to-owner recovery preserves its route and payload at the escalation deadline', async () => {
  const { result, calls } = await fixture({ nativeSleep: true, watcher: { created_by_session: 'ses_old' } }, confirmBody(`
    writeFileSync(configPath, JSON.stringify({ strictWakeKey: true, wakeAmbiguousOnce: true,
      status: { threadId: ${JSON.stringify(projectThread)}, archived: false, origin: 'imessage' } }));
    await tickOne(watcher.id);
    Date.now = () => at + 31_000;
    await tickOne(watcher.id);
  `));
  const wakes = calls.filter(call => call.cli === 'spectrum' && call.args[0] === 'wake');
  expect(wakes).toHaveLength(2);
  expect(wakes[0]!.args).toEqual(wakes[1]!.args);
  expect(calls.filter(call => call.cli === 'spectrum' && call.args[0] === 'send')).toHaveLength(0);
  expect(calls.filter(call => call.cli === 'telegram')).toHaveLength(1);
  expect(result.state.confirm).toMatchObject({ ownerFallback: true, alertDone: true, fallbackDone: true });
});

test.each([{ sendError: true }, { sendSpawnError: true }])('native recovery falls back after a rejected send even when the creator is running (%j)', async failure => {
  const { result, calls, logs } = await fixture({ nativeSleep: true, watcher: { created_by_session: 'ses_old' } }, confirmBody(`
    writeFileSync(configPath, JSON.stringify({ ...${JSON.stringify(failure)}, status: { threadId: ${JSON.stringify(projectThread)}, archived: false, state: 'running' } }));
    Date.now = () => base + 60_000;
    await tickOne(watcher.id);
  `));
  expect(calls.filter(call => call.cli === 'spectrum' && call.args[0] === 'wake')).toHaveLength(1);
  expect(result.state.confirm).toMatchObject({ ownerFallback: true, thread: projectThread });
  expect(logs.filter(row => row.name === 'wake.confirmed')).toHaveLength(0);
});

test.each([{ sendSleep: true }, { sendAmbiguous: true }])('native recovery keeps ambiguous sends pending without an owner fallback (%j)', async failure => {
  const { result, calls, logs } = await fixture({ nativeSleep: true, watcher: { created_by_session: 'ses_old' } }, confirmBody(`
    writeFileSync(configPath, JSON.stringify({ ...${JSON.stringify(failure)}, status: { threadId: ${JSON.stringify(projectThread)}, archived: false } }));
    Date.now = () => base + 60_000;
    await tickOne(watcher.id);
  `));
  expect(result.state.confirm).toMatchObject({ thread: projectThread });
  expect(result.state.confirm?.ownerFallback).not.toBe(true);
  expect(calls.filter(call => call.cli !== 't3ctl')).toHaveLength(0);
  expect(logs.filter(row => row.name === 'wake.confirmed')).toHaveLength(0);
});

for (const outcome of ['completed', 'failed', 'cancelled', 'five newer runs']) {
  test(`restart preserves the first send time when replaying a ${outcome} run`, async () => {
    const { result, calls, logs } = await fixture({}, `(async () => {
      state.pending = { key, event: 'event happened', at: new Date().toISOString(), watcher };
      saveState(watcher.id, state);
      await deliver(watcher, 'event happened', key, state);
      // The runner stopped after acceptance; the original attempt survives with the pending event.
      const originalAt = loadState(watcher.id).pending.creatorSend.sentAt;
      const run = { runId: 'original-run', status: ${JSON.stringify(outcome === 'five newer runs' ? 'completed' : outcome)},
        requestedAt: new Date(originalAt).toISOString(), startedAt: new Date(originalAt + 1).toISOString() };
      const recentRuns = ${outcome === 'five newer runs'} ? Array.from({ length: 5 }, (_, i) => ({
        runId: 'newer-' + i, status: 'completed', requestedAt: new Date(originalAt + 100 + i).toISOString() })) : [run];
      writeFileSync(configPath, JSON.stringify({ sendOutput: JSON.stringify({ ok: true, runId: 'original-run', status: run.status }),
        status: { threadId: watcher.created_by_session, archived: false, recentRuns }, runEvidence: run }));
      const restartTick = async at => {
        const code = 'Date.now = () => ' + at + '; const { tickOne } = await import(' + ${JSON.stringify(JSON.stringify(runnerPath))} + '); await tickOne("route-test");';
        const child = Bun.spawn([process.execPath, '-e', code], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
        const [output, error, codeValue] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        if (codeValue) throw new Error(error);
        process.stdout.write(output);
      };
      await restartTick(originalAt + 60_000);
      const before = loadState(watcher.id);
      if (before.confirm.sentAt !== originalAt) throw new Error('replay replaced the persisted first attempt');
      await restartTick(originalAt + 11 * 60_000);
      return { before, state: loadState(watcher.id) };
    })()`);
    const sends = calls.filter(call => call.cli === 't3ctl' && call.args[0] === 'send');
    expect(sends).toHaveLength(2);
    expect(sends[0]!.args).toEqual(sends[1]!.args);
    expect(result.state.confirm).toBeUndefined();
    expect(logs.filter(row => row.name === 'wake.confirmed')).toHaveLength(1);
    expect(calls.filter(call => call.cli !== 't3ctl' && call.cli !== 'run-lookup')).toHaveLength(0);
    expect(calls.filter(call => call.cli === 'run-lookup')).toHaveLength(outcome === 'five newer runs' ? 1 : 0);
  });
}

test('the first send time is persisted before dispatch even when the send times out', async () => {
  const { result, calls } = await fixture({ sendSleep: true, requireSendJournal: true }, `(async () => {
    state.pending = { key, event: 'event happened', at: new Date().toISOString(), watcher };
    saveState(watcher.id, state);
    const beforeAt = Date.now();
    const delivery = await deliver(watcher, 'event happened', key, state);
    const pending = loadState(watcher.id).pending;
    if (!pending.creatorSend || pending.creatorSend.sentAt < beforeAt) throw new Error('send attempt was not persisted');
    if (delivery.confirmation.sentAt !== pending.creatorSend.sentAt) throw new Error('confirmation lost the attempt');
    return { ...delivery, state: loadState(watcher.id) };
  })()`);
  expect(result.accepted).toBe(true);
  expect(result.state.pending?.creatorSend?.thread).toBe(projectThread);
  expect(calls.filter(call => call.cli !== 't3ctl')).toHaveLength(0);
});

const ownRunId = 'run:thread:work:ordinal:314';
const queuedReceipt = { ok: true, runId: ownRunId, messageId: 'message-X', status: 'queued', delivery: 'queued' };

test.each(['run', 'recentRuns', 'runs'])('only the wake own run confirms through %s, with queue timing and honest delivery logs', async field => {
  const { result, calls, logs, log } = await fixture({ sendOutput: JSON.stringify(queuedReceipt) }, confirmBody(`
    Date.now = () => base + 31_000;
    const own = { runId: ${JSON.stringify(ownRunId)}, status: 'queued', startedAt: null, requestedAt: new Date(base).toISOString() };
    const status = { threadId: watcher.created_by_session, state: 'running',
      run: { runId: 'unrelated-Y', status: 'running', startedAt: new Date(base + 1).toISOString() },
      ${field}: ${field === 'run' ? 'own' : '[own]'} };
    writeFileSync(configPath, JSON.stringify({ status }));
    await tickOne(watcher.id);
    if (!loadState(watcher.id).confirm) throw new Error('unrelated run or queue confirmed');
    const show = Bun.spawnSync([${JSON.stringify(process.execPath)}, ${JSON.stringify(join(import.meta.dir, '../src/cli.ts'))}, 'show', watcher.id], { env: { ...process.env, ...testEnv() } });
    if (!show.stdout.toString().includes('confirmation=pending run=314 state=queued')) throw new Error('show omitted run state');
    Date.now = () => base + 62_000;
    own.status = 'running'; own.startedAt = new Date(base + 40_000).toISOString();
    writeFileSync(configPath, JSON.stringify({ status }));
    await tickOne(watcher.id);
  `));
  expect(result.state.confirm).toBeUndefined();
  expect(calls.filter(call => call.args[0] === 'send')).toHaveLength(1);
  expect(logs.find(row => row.name === 'wake.confirmed')?.props).toMatchObject({ method: 'run', runState: 'running', queuedMs: 40_000 });
  expect(logs.find(row => row.name === 'wake.sent')).toMatchObject({ ok: true, props: { runId: ownRunId, messageId: 'message-X', delivery: 'queued' } });
  expect(log).toContain('send=ok delivery=queued run=314 via=thread:abcd1234 confirmed=pending');
  expect(log).not.toContain('ok=false');
  expect(log).not.toContain('"ok":true');
});

test.each(['cancelled', 'interrupted', 'failed', 'server_restart'])('own run %s before starting re-sends once with a derived key, then confirms the replacement', async status => {
  const { result, calls, logs, log } = await fixture({ sendOutput: JSON.stringify(queuedReceipt) }, confirmBody(`
    Date.now = () => base + 31_000;
    writeFileSync(configPath, JSON.stringify({ status: { threadId: watcher.created_by_session,
      run: { runId: ${JSON.stringify(ownRunId)}, status: ${JSON.stringify(status)}, startedAt: null, cancelReason: 'server_restart' } },
      sendOutput: JSON.stringify({ ...${JSON.stringify(queuedReceipt)}, runId: 'replacement' }) }));
    await tickOne(watcher.id);
    const pending = loadState(watcher.id).confirm;
    if (pending.runId !== 'replacement' || pending.resends !== 1) throw new Error('replacement not tracked');
    Date.now = () => base + 62_000;
    writeFileSync(configPath, JSON.stringify({ status: { threadId: watcher.created_by_session,
      run: { runId: 'replacement', status: 'completed', startedAt: new Date(base + 32_000).toISOString() } } }));
    await tickOne(watcher.id);
  `));
  expect(result.state.confirm).toBeUndefined();
  const sends = calls.filter(call => call.args[0] === 'send');
  expect(sends.map(call => [call.args[1], call.args[4]])).toEqual([[projectThread, 'robob-watch:route-test:1:stable-event'], [projectThread, 'robob-watch:route-test:1:stable-event:r1']]);
  expect(sends[0]!.args[2]).toBe(sends[1]!.args[2]);
  expect(log).toContain('wake run lost key=robob-watch:route-test:1:stable-event run=314');
  expect(logs.find(row => row.name === 'wake.run_lost')?.props).toMatchObject({ state: status, attempt: 1 });
  expect(logs.find(row => row.name === 'wake.resent')?.props).toMatchObject({ requestId: 'robob-watch:route-test:1:stable-event:r1', runId: 'replacement', attempt: 1 });
  expect(logs.find(row => row.name === 'wake.confirmed')?.props?.method).toBe('run');
});

test('three lost-run re-sends cap out and retain once-only thread escalation and alert', async () => {
  const { result, calls, logs } = await fixture({ sendOutput: JSON.stringify(queuedReceipt) }, confirmBody(`
    for (let n = 1; n <= 6; n++) {
      Date.now = () => at + n * 31_000;
      const pending = loadState(watcher.id).confirm;
      writeFileSync(configPath, JSON.stringify({ status: { threadId: watcher.created_by_session,
        run: { runId: pending.runId, status: 'cancelled', startedAt: null } },
        sendOutput: JSON.stringify({ ...${JSON.stringify(queuedReceipt)}, runId: n <= 3 ? 'replacement-' + n : pending.runId }) }));
      await tickOne(watcher.id);
    }
  `));
  expect(result.state.confirm).toMatchObject({ resends: 3, alertDone: true, fallbackDone: true });
  const keys = calls.filter(call => call.args[0] === 'send').map(call => call.args[4]);
  expect([...new Set(keys)]).toEqual(['robob-watch:route-test:1:stable-event', ...[1, 2, 3].map(n => 'robob-watch:route-test:1:stable-event:r' + n)]);
  expect(logs.filter(row => row.name === 'wake.resent')).toHaveLength(3);
  expect(calls.filter(call => call.cli === 'telegram')).toHaveLength(1);
  expect(calls.filter(call => call.cli === 'spectrum')).toHaveLength(0);
});

test('a lost-run send deferred across an outage retries the reserved derived key after reload', async () => {
  const { result, calls } = await fixture({ sendOutput: JSON.stringify(queuedReceipt) }, confirmBody(`
    Date.now = () => base + 31_000;
    writeFileSync(configPath, JSON.stringify({ status: { threadId: watcher.created_by_session,
      run: { runId: ${JSON.stringify(ownRunId)}, status: 'failed', startedAt: null } }, sendFailure: 'fetch failed' }));
    await tickOne(watcher.id);
    const pending = loadState(watcher.id).confirm;
    if (pending.requestId !== key + ':r1' || !pending.sendPending) throw new Error('retry key not reserved');
    Date.now = () => pending.nextAt;
    writeFileSync(configPath, JSON.stringify({ status: { threadId: watcher.created_by_session },
      sendOutput: JSON.stringify({ ...${JSON.stringify(queuedReceipt)}, runId: 'replacement' }) }));
    await tickOne(watcher.id);
  `));
  expect(result.state.confirm).toMatchObject({ resends: 1, runId: 'replacement' });
  expect(calls.filter(call => call.args[0] === 'send').map(call => call.args[4])).toEqual(['robob-watch:route-test:1:stable-event', 'robob-watch:route-test:1:stable-event:r1', 'robob-watch:route-test:1:stable-event:r1']);
});

test.each([
  { name: 'completed beyond recent window', evidence: { status: 'completed' }, confirmed: true },
  { name: 'queued beyond recent window', evidence: { status: 'queued' }, confirmed: false },
  { name: 'older cancelled evidence without start timestamp', evidence: { status: 'cancelled' }, confirmed: false },
  { name: 'lookup unavailable', evidence: undefined, confirmed: false },
])('$name never treats recent retention as a lost wake', async ({ evidence, confirmed }) => {
  const { result, calls, logs } = await fixture({ sendOutput: JSON.stringify(queuedReceipt) }, confirmBody(`
    Date.now = () => base + 31_000;
    writeFileSync(configPath, JSON.stringify({ status: { threadId: watcher.created_by_session, state: 'running',
      recentRuns: [{ runId: 'unrelated-Y', status: 'running' }] }, runEvidence: ${JSON.stringify(evidence)} }));
    await tickOne(watcher.id);
  `));
  expect(!!result.state.confirm).toBe(!confirmed);
  expect(calls.filter(call => call.cli === 'run-lookup')).toHaveLength(1);
  expect(calls.filter(call => call.args[0] === 'send')).toHaveLength(1);
  expect(logs.filter(row => row.name === 'wake.run_lost')).toHaveLength(0);
});

test('a queued run confirmed absent by per-run lookup is re-sent', async () => {
  const { result, calls } = await fixture({ sendOutput: JSON.stringify(queuedReceipt) }, confirmBody(`
    Date.now = () => base + 31_000;
    writeFileSync(configPath, JSON.stringify({ status: { threadId: watcher.created_by_session }, runMissing: true,
      sendOutput: JSON.stringify({ ...${JSON.stringify(queuedReceipt)}, runId: 'replacement' }) }));
    await tickOne(watcher.id);
  `));
  expect(result.state.confirm).toMatchObject({ runId: 'replacement', resends: 1 });
  expect(calls.filter(call => call.args[0] === 'send')).toHaveLength(2);
});

test('cancelled after starting is confirmed rather than duplicated', async () => {
  const { result, calls } = await fixture({ sendOutput: JSON.stringify(queuedReceipt) }, confirmBody(`
    Date.now = () => base + 31_000;
    writeFileSync(configPath, JSON.stringify({ status: { threadId: watcher.created_by_session,
      run: { runId: ${JSON.stringify(ownRunId)}, status: 'cancelled', startedAt: new Date(base + 1).toISOString() } } }));
    await tickOne(watcher.id);
  `));
  expect(result.state.confirm).toBeUndefined();
  expect(calls.filter(call => call.args[0] === 'send')).toHaveLength(1);
});

test('old server sends use explicitly logged heuristic confirmation', async () => {
  const { result, logs, log } = await fixture({}, confirmBody(`
    writeFileSync(configPath, JSON.stringify({ status: { threadId: watcher.created_by_session, state: 'running' } }));
    await tickOne(watcher.id);
  `));
  expect(result.state.confirm).toBeUndefined();
  expect(logs.find(row => row.name === 'wake.confirmed')?.props?.method).toBe('heuristic');
  expect(log).toContain('confirm=heuristic');
});
