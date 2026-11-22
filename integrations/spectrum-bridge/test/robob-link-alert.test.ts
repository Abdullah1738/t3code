import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRobobLinkAlert } from "../src/robob-link-alert.ts";
import { createToolLog, toolLog, type LogLine } from "../src/toollog.ts";
import { ControlClient } from "../src/control.ts";
import { RobobLinkDown, RobobLinkGate } from "../src/robob-link-gate.ts";
import type { Post } from "../src/telegram-fallback.ts";

const dirs: string[] = [];
const start = Date.parse("2026-11-17T07:24:16.494Z");
const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "robob-link-alert-")); dirs.push(root);
  let at = start;
  const posts: { at: number; body: Record<string, string> }[] = [];
  const events: Omit<LogLine, "ts" | "tool">[] = [];
  const statuses: (number | undefined)[] = [];
  const post: Post = async (path, body) => {
    expect(path).toBe("/notify"); posts.push({ at, body });
    return statuses.length ? statuses.shift() : 202;
  };
  const file = join(root, "robob-link-alert.json");
  const options = { root, post, now: () => at, log: (event: Omit<LogLine, "ts" | "tool">) => { events.push(event); } };
  const alert = createRobobLinkAlert(options);
  const down = (outageId = id) => ({ ts: new Date(at).toISOString(), tool: "imessage", component: "robob", kind: "event", name: "robob.link_down",
    link: { outageId, firstFailureAt: new Date(at).toISOString(), cause: "ECONNREFUSED", route: "/threads", failedCalls: 3, suppressedCalls: 0, causes: {},
      inboundReceivedDuringOutage: 0, inboundAckedDuringOutage: 0, inboundAnsweredAfter: 0, inboundAnsweredDuringOutage: 0 } }) as LogLine;
  const success = (): LogLine => ({ ts: new Date(at).toISOString(), tool: "imessage", component: "robob", kind: "perf", name: "turn.robob_call", ok: true });
  return { root, file, alert, options, posts, statuses, events, down, success, state: () => JSON.parse(readFileSync(file, "utf8")),
    advance: (ms: number) => { at += ms; }, set: (time: number) => { at = time; } };
}

test("119 s is quiet; 120 s sends once with a private atomic state file", async () => {
  const f = setup(); f.alert.accept(f.down());
  f.advance(119_000); await f.alert.tick(); expect(f.posts).toHaveLength(0);
  f.advance(1_000); await f.alert.tick(); f.advance(60_000); await f.alert.tick();
  expect(f.posts).toHaveLength(1);
  expect(f.posts[0]!.body).toEqual({ source: "iMessage bridge", severity: "error", dedupeKey: `robob-link-down:${id}`,
    text: "Robob is down: the iMessage bridge can't reach it since 11:24 Dubai (2 min, ECONNREFUSED). iMessage replies and board threads are stalled." });
  expect(f.state().downAlertSentAt).toBe("2026-11-17T07:26:16.494Z");
  expect(statSync(f.file).mode & 0o777).toBe(0o600);
  expect(readdirSync(f.root).filter(file => file.endsWith(".tmp"))).toEqual([]);
});

const rawSuccessCases: { name: string; props: NonNullable<LogLine["props"]>; recovered: boolean }[] = [
  { name: "legacy", props: {}, recovered: true },
  { name: "gate disabled", props: { linkGated: false }, recovered: true },
  { name: "late request, unspecified gate state", props: { linkGated: true }, recovered: false },
  { name: "late request, closed gate", props: { linkGated: true, linkProbe: false, linkGateDown: true }, recovered: false },
  { name: "request after gate opened", props: { linkGated: true, linkGateDown: false }, recovered: true },
  { name: "probe before gate opens", props: { linkGated: true, linkProbe: true, linkGateDown: true }, recovered: true },
  { name: "probe after gate opens", props: { linkGated: true, linkProbe: true, linkGateDown: false }, recovered: true },
];
test.each(rawSuccessCases)("raw success recovery respects $name", async ({ props, recovered }) => {
  const f = setup(); f.alert.accept(f.down()); f.advance(120_000); await f.alert.tick();
  f.alert.accept({ ...f.success(), props }); await f.alert.tick();
  expect(f.posts).toHaveLength(recovered ? 2 : 1);
  expect(!!f.state().recoveredAt).toBe(recovered);
});

for (const cause of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "FETCH_FAILED", "HTTP_503"]) test.each(["none", "before alert", "after alert"])(`gate suppresses calls, alerts, and recovers via its own health call (${cause}, restart=%s)`, async restart => {
  const f = setup(); const root = join(f.root, "gate-logs");
  const makeLog = () => createToolLog({ root, defer: true, capBytes: 1, now: f.options.now, linkAlert: { root: f.root, post: f.options.post } });
  let log = makeLog(), healthy = false;
  let releaseLate!: (response: Response) => void;
  const requests: string[] = [];
  const timers: { at: number; run: () => Promise<void> }[] = [];
  const makeClient = () => {
    const gate = new RobobLinkGate({ skip: site => log.skipRobob(site), firstAtSite: site => log.robobSite(site), persistedDown: log.robobLinkDown }, {
      random: () => 0.5, schedule: (run, delay) => { timers.push({ at: f.options.now() + delay, run }); return {}; },
    });
    return { gate, client: new ControlClient({ url: "http://127.0.0.1:1", token: "fixture", linkGate: gate }) };
  };
  let { client, gate } = makeClient();
  const write = spyOn(toolLog, "write").mockImplementation(entry => log.write(entry));
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: Parameters<typeof fetch>[0]) => {
    const path = new URL(String(url)).pathname.replace("/api/ardud/control", ""); requests.push(path);
    if (path === "/threads/late") return new Promise<Response>(resolve => { releaseLate = resolve; });
    if (healthy) return Response.json({ ok: true, status: "healthy" });
    if (cause === "HTTP_503") return Response.json({ ok: false }, { status: 503 });
    if (cause === "FETCH_FAILED") throw new TypeError("fetch failed");
    throw Object.assign(new Error("fetch failed"), { code: cause });
  }, { preconnect: globalThis.fetch.preconnect }));
  const advance = async (target: number) => {
    while (timers[0] && timers[0].at <= target) { const timer = timers.shift()!; f.set(timer.at); await timer.run(); }
    f.set(target); await log.tick(); await log.settled();
  };
  const reboot = async () => {
    await log.settled(); log.flush(); timers.splice(0);
    log = makeLog(); ({ client, gate } = makeClient());
    await expect(client.thread("restart")).rejects.toThrow();
    expect(gate.available).toBe(false);
  };
  try {
    const late = client.thread("late");
    for (let n = 0; n < 3; n++) await expect(client.thread("failure")).rejects.toThrow();
    expect(gate.available).toBe(false);
    releaseLate(Response.json({ ok: true })); await late;
    await advance(start + 60_000);
    expect(f.state().recoveredAt).toBeUndefined();
    if (restart === "before alert") await reboot();
    await advance(start + 119_000); expect(f.posts).toHaveLength(0);
    await advance(start + 120_000); expect(f.posts).toHaveLength(1);
    const original = f.state();
    expect(f.posts[0]!.body).toMatchObject({ dedupeKey: `robob-link-down:${original.outageId}`, severity: "error" });
    expect(f.posts[0]!.body.text).toContain(`2 min, ${cause}`);
    if (restart === "after alert") await reboot();
    const beforeSkips = requests.length;
    for (let n = 0; n < 12; n++) await expect(client.thread("blocked")).rejects.toBeInstanceOf(RobobLinkDown);
    expect(requests).toHaveLength(beforeSkips);
    await advance(start + 180_000); expect(f.posts).toHaveLength(1);
    expect(f.state().outageId).toBe(original.outageId);
    expect(f.state().snapshot.skippedCalls).toBe(12);
    expect(f.state().snapshot.failedProbes).toBeGreaterThan(0);
    const beforeRecovery = requests.length;
    healthy = true; await advance(start + 210_000);
    expect(gate.available).toBe(true);
    expect(requests.slice(beforeRecovery)).toEqual(["/health"]);
    expect(requests.filter(path => path === "/threads/blocked")).toEqual([]);
    expect(f.posts).toHaveLength(2);
    expect(f.posts[1]!.body).toMatchObject({ dedupeKey: `robob-link-up:${original.outageId}`, severity: "info" });
    const n = Math.max(1, Math.round((Date.parse(f.state().recoveredAt) - start) / 60_000));
    expect(f.posts[1]!.body.text).toBe(`Robob is up again after ${n} min (down since 11:24 Dubai).`);
    log.flush(); const rows: LogLine[] = readFileSync(join(root, "2026-11-17.ndjson"), "utf8").trim().split("\n").map(row => JSON.parse(row));
    expect(rows.filter(row => row.name === "robob.link_up")).toHaveLength(1);
    expect(rows.filter(row => row.name === "robob.link_down_summary").length).toBeGreaterThan(0);
    expect(rows.filter(row => row.name === "robob.link_alert")).toHaveLength(2);
    expect(f.state().upAlertSentAt).toBeDefined();
  } finally { fetcher.mockRestore(); write.mockRestore(); await log.settled(); log.flush(); }
});

test.each([undefined, 199, 300, 409, 500])("status %s retries the same key; only 2xx records a send", async status => {
  const f = setup(); f.statuses.push(status, 200); f.alert.accept(f.down()); f.advance(120_000);
  await f.alert.tick(); expect(f.state().downAlertSentAt).toBeUndefined();
  await f.alert.tick(); await f.alert.tick();
  expect(f.posts.map(item => item.body.dedupeKey)).toEqual([`robob-link-down:${id}`, `robob-link-down:${id}`]);
  expect(f.events.filter(event => event.name === "robob.link_alert").map(event => event.props)).toEqual([{ kind: "down", status: status ?? 0, ok: false }, { kind: "down", status: 200, ok: true }]);
  expect(f.state().downAlertSentAt).toBeDefined();
});

test("restart adopts identity, first success recovers it, and a later outage gets a new key", async () => {
  const f = setup(); f.alert.accept(f.down()); f.advance(120_000); await f.alert.tick();
  const restarted = createRobobLinkAlert(f.options);
  expect(restarted.identity()).toMatchObject({ outageId: id, firstFailureAt: new Date(start).toISOString() });
  await restarted.tick(); expect(f.posts).toHaveLength(1);
  f.advance(180_000); restarted.accept(f.success()); await restarted.tick();
  expect(f.posts[1]!.body).toMatchObject({ severity: "info", dedupeKey: `robob-link-up:${id}`, text: "Robob is up again after 5 min (down since 11:24 Dubai)." });
  expect(f.state().upAlertSentAt).toBeDefined(); expect(restarted.identity()).toBeUndefined();
  const next = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
  restarted.accept(f.down(next)); f.advance(120_000); await restarted.tick();
  expect(f.posts[2]!.body.dedupeKey).toBe(`robob-link-down:${next}`);
});

test("recovery under two minutes closes quietly, including across restart", async () => {
  const f = setup(); f.alert.accept(f.down()); f.advance(119_000);
  const restarted = createRobobLinkAlert(f.options); restarted.accept(f.success()); await restarted.tick();
  expect(f.posts).toHaveLength(0); expect(f.state().recoveredAt).toBe(f.success().ts);
  expect(restarted.identity()).toBeUndefined();
});

for (const mode of ["quiet", "sent", "pending"]) test.each(["flush", "tick", "rollup"])(`only the daemon owns alert state while a CLI reader overlaps recovery (mode=${mode}, reader=%s)`, async action => {
  const f = setup(), root = join(f.root, "logs");
  const daemon = createToolLog({ root, now: f.options.now, capBytes: 1 });
  daemon.write({ component: "process", kind: "event", name: "bridge.start" });
  daemon.startLinkAlerts({ root: f.root, post: f.options.post });
  const call = (ok: boolean) => daemon.write({ component: "robob", name: "turn.robob_call", kind: "perf", ok,
    props: { route: "/threads", ...(!ok ? { linkCause: "ECONNREFUSED" } : {}) } });
  call(false); call(false); call(false); f.advance(119_000); await daemon.tick();
  const reader = createToolLog({ root, now: f.options.now, defer: true });
  reader.write({ component: "process", kind: "event", name: "cli.start" });
  const read = () => action === "rollup" ? reader.rollup("2026-11-17") : action === "tick" ? reader.tick() : Promise.resolve(reader.flush());
  const reading = read();
  if (mode !== "quiet") { f.advance(1_000); await daemon.tick(); }
  if (mode === "pending") f.statuses.push(500);
  call(true); await daemon.settled();
  const recovery = readFileSync(f.file, "utf8"), attempts = f.posts.length;
  f.advance(5_000); await reading; await read(); reader.flush(); await reader.settled();
  expect(readFileSync(f.file, "utf8")).toBe(recovery); expect(f.posts).toHaveLength(attempts);
  expect(f.state().recoveredAt).toBeDefined();
  expect(f.posts).toHaveLength(mode === "quiet" ? 0 : 2);
  if (mode === "pending") {
    expect(f.state().upAlertSentAt).toBeUndefined(); await daemon.tick();
    expect(f.posts.at(-1)!.body.dedupeKey).toBe(`robob-link-up:${f.state().outageId}`);
    expect(f.state().upAlertSentAt).toBeDefined();
  }
  expect(readFileSync(join(root, "2026-11-17.ndjson"), "utf8")).toContain('"name":"robob.link_alert_loaded"');
});

test("pending recovery survives a restart and is retried without repeating the down alert", async () => {
  const f = setup(); f.alert.accept(f.down()); f.advance(120_000); await f.alert.tick();
  f.advance(60_000); f.statuses.push(503); f.alert.accept(f.success()); await f.alert.tick();
  const restarted = createRobobLinkAlert(f.options); await restarted.tick(); await restarted.tick();
  expect(f.posts.map(item => item.body.dedupeKey)).toEqual([`robob-link-down:${id}`, `robob-link-up:${id}`, `robob-link-up:${id}`]);
  expect(f.state().upAlertSentAt).toBeDefined();
});

const retryChanges = ["duration", "hold removed", "hold renamed", "recovered"] as const;
for (const restart of [false, true]) test.each([...retryChanges])(`lost-response retry freezes %s (restart=${restart})`, async change => {
  const f = setup(); const holdPath = join(f.root, "hold.json");
  const writeHold = (by: string) => writeFileSync(holdPath, JSON.stringify({ by, pid: process.pid, startedAt: start / 1000, beatAt: Math.max(f.options.now(), start + 120_000) / 1000 }));
  writeHold("overload-restart");
  const receipts = new Map<string, string>();
  const post: Post = async (_path, body) => {
    f.posts.push({ at: 0, body });
    const spec = JSON.stringify(body); const previous = receipts.get(body.dedupeKey!);
    if (previous !== undefined) return previous === spec ? 200 : 409;
    receipts.set(body.dedupeKey!, spec);
    return body.severity === "error" ? undefined : 202;
  };
  const options = { ...f.options, holdPath, post };
  let alert = createRobobLinkAlert(options); alert.accept(f.down()); f.advance(120_000); await alert.tick();
  expect(f.state().downAlertSentAt).toBeUndefined();
  expect(f.state().downText).toBe(f.posts[0]!.body.text);
  if (restart) alert = createRobobLinkAlert(options);
  f.advance(180_000);
  if (change === "hold removed") rmSync(holdPath);
  if (change === "hold renamed") writeHold("release-install");
  if (change === "duration") writeHold("overload-restart");
  if (change === "recovered") alert.accept(f.success());
  await alert.tick();
  expect(f.posts[1]!.body).toEqual(f.posts[0]!.body);
  expect(f.state().downAlertSentAt).toBeDefined();
  if (change !== "recovered") { alert.accept(f.success()); await alert.tick(); }
  expect(f.posts).toHaveLength(3); expect(f.state().upAlertSentAt).toBeDefined();
});

test("lost up response also retains exact text after time advances and the bridge restarts", async () => {
  const f = setup(); f.alert.accept(f.down()); f.advance(120_000); await f.alert.tick();
  f.advance(60_000); f.statuses.push(undefined); f.alert.accept(f.success()); await f.alert.tick();
  expect(f.state().upText).toBe(f.posts[1]!.body.text);
  f.advance(600_000); const restarted = createRobobLinkAlert(f.options); await restarted.tick();
  expect(f.posts[2]!.body).toEqual(f.posts[1]!.body); expect(f.state().upAlertSentAt).toBeDefined();
});

for (const alerted of [false, true]) for (const failures of [0, 1, 2, 3]) test.each(["missing", "corrupt", "present"])(`restart recovery closes logs with %s checkpoint (alerted=${alerted}, failures=${failures})`, async checkpoint => {
  const f = setup(); const originalRoot = join(f.root, "logs");
  const make = (root: string) => createToolLog({ root, now: f.options.now, capBytes: 1, linkAlert: { root: f.root, post: f.options.post } });
  let log = make(originalRoot);
  for (let i = 0; i < 3; i++) log.write({ component: "robob", name: "turn.robob_call", kind: "perf", ok: false, props: { route: "/threads", linkCause: "ECONNREFUSED" } });
  f.advance(alerted ? 120_000 : 60_000); await log.tick(); await log.settled(); log.flush();
  const before = f.state();
  const restartedRoot = join(f.root, "restarted"); mkdirSync(restartedRoot);
  writeFileSync(join(restartedRoot, "2026-11-17.ndjson"), readFileSync(join(originalRoot, "2026-11-17.ndjson")));
  const saved = join(restartedRoot, "robob-link-state.json");
  if (checkpoint === "present") writeFileSync(saved, readFileSync(join(originalRoot, "robob-link-state.json")));
  if (checkpoint === "corrupt") writeFileSync(saved, "{broken");
  if (checkpoint === "missing") expect(existsSync(saved)).toBe(false);
  log = make(restartedRoot);
  for (let i = 0; i < failures; i++) log.write({ component: "robob", name: "turn.robob_call", kind: "perf", ok: false, props: { route: "/threads", linkCause: "ECONNREFUSED" } });
  f.advance(1_000); log.write({ component: "robob", name: "turn.robob_call", kind: "perf", ok: true });
  await log.settled(); log.flush();
  const rows: LogLine[] = readFileSync(join(restartedRoot, "2026-11-17.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(rows.filter(row => row.name === "robob.link_up")).toMatchObject([{ link: { outageId: before.outageId, firstFailureAt: before.firstFailureAt, failedCalls: 3 + failures } }]);
  expect(rows.filter(row => row.name === "robob.link_down")).toHaveLength(1);
  expect(rows.filter(row => row.name === "robob.link_reset")).toHaveLength(0);
  const rollup = await log.rollup("2026-11-17"); await log.settled();
  expect(rollup?.robob_link.outages).toHaveLength(1);
  expect(rollup?.robob_link.outages[0]).toMatchObject({ outageId: before.outageId, firstFailureAt: before.firstFailureAt, open: false });
  expect(f.posts).toHaveLength(alerted ? 2 : 0);
  expect(f.state()?.upAlertSentAt !== undefined).toBe(alerted);
});

test("a lost down response followed by recovery reconciles the same down key before the up line", async () => {
  const f = setup(); f.statuses.push(undefined); f.alert.accept(f.down()); f.advance(120_000); await f.alert.tick();
  f.advance(60_000); const restarted = createRobobLinkAlert(f.options); restarted.accept(f.success()); await restarted.tick();
  expect(f.posts.map(item => item.body.dedupeKey)).toEqual([`robob-link-down:${id}`, `robob-link-down:${id}`, `robob-link-up:${id}`]);
});

for (const checkpointState of ["stale", "missing", "corrupt"]) for (const mode of ["quiet", "pending", "sent"]) for (const restartAgain of [false, true]) test.each([0, 1, 2, 3])(`recovery saved before its journal row closes logs (checkpoint=${checkpointState}, mode=${mode}, failures=%s, restartAgain=${restartAgain})`, async failures => {
  const f = setup(); const originalRoot = join(f.root, "logs");
  let recoveryBlocked = mode === "pending", previousId = "";
  const post: Post = async (path, body) => {
    if (recoveryBlocked && body.dedupeKey === `robob-link-up:${previousId}`) f.statuses.unshift(500);
    return f.options.post(path, body);
  };
  const make = (root: string, stateRoot: string) => createToolLog({ root, defer: true, now: f.options.now, linkAlert: { root: stateRoot, post } });
  let log = make(originalRoot, f.root);
  const call = (ok: boolean) => log.write({ component: "robob", name: "turn.robob_call", kind: "perf", ok,
    props: { route: "/threads", ...(!ok ? { linkCause: "ECONNREFUSED" } : {}) } });
  call(false); call(false); call(false);
  f.advance(mode === "quiet" ? 60_000 : 120_000); await log.tick(); await log.settled(); log.flush();
  const original = f.state();
  previousId = original.outageId;
  const journal = readFileSync(join(originalRoot, "2026-11-17.ndjson"));
  const checkpoint = readFileSync(join(originalRoot, "robob-link-state.json"));
  f.advance(1_000); const recoveredAt = f.success().ts;
  call(true);
  // The alert file is durable here, but defer leaves the recovery row queued in memory.
  const atBoundary = readFileSync(f.file);
  expect(JSON.parse(atBoundary.toString()).recoveredAt).toBe(recoveredAt);
  expect(readFileSync(join(originalRoot, "2026-11-17.ndjson"))).toEqual(journal);
  await log.settled();
  const savedAlert = mode === "sent" ? readFileSync(f.file) : atBoundary;
  const root = join(f.root, "restarted-logs"), stateRoot = join(f.root, "restarted-state");
  mkdirSync(root); mkdirSync(stateRoot);
  writeFileSync(join(root, "2026-11-17.ndjson"), journal);
  if (checkpointState === "stale") writeFileSync(join(root, "robob-link-state.json"), checkpoint);
  if (checkpointState === "corrupt") writeFileSync(join(root, "robob-link-state.json"), "{broken");
  writeFileSync(join(stateRoot, "robob-link-alert.json"), savedAlert);
  log = make(root, stateRoot); f.advance(10_000); const nextStart = f.success().ts;
  const postsBefore = f.posts.length;
  if (!failures) call(true);
  for (let i = 0; i < failures; i++) call(false);
  f.advance(120_000); await log.tick(); await log.settled(); log.flush(); await log.settled();
  if (mode === "pending") expect(f.posts.slice(postsBefore).every(row => row.body.dedupeKey === `robob-link-up:${original.outageId}`)).toBe(true);
  if (restartAgain) log = make(root, stateRoot);
  recoveryBlocked = false;
  await log.tick(); call(true); await log.settled(); log.flush();
  const rows: LogLine[] = readFileSync(join(root, "2026-11-17.ndjson"), "utf8").trim().split("\n").map(row => JSON.parse(row));
  const up = rows.filter(row => row.name === "robob.link_up" && row.link?.outageId === original.outageId);
  expect(up).toHaveLength(1); expect(up[0]!.link?.recoveredAt).toBe(recoveredAt);
  const calls = rows.filter(row => row.name === "turn.robob_call" && row.ok === false && row.ts >= nextStart);
  expect(calls).toHaveLength(failures);
  expect(calls.every(row => row.ids?.outageId && row.ids.outageId !== original.outageId)).toBe(true);
  if (failures) expect(new Set(calls.map(row => row.ids?.outageId)).size).toBe(1);
  const nextDown = f.posts.slice(postsBefore).filter(row => row.body.severity === "error");
  expect(nextDown).toHaveLength(failures >= 3 ? 1 : 0);
  if (failures >= 3) {
    const nextId = calls[0]!.ids!.outageId;
    expect(nextDown[0]!.body.dedupeKey).toBe(`robob-link-down:${nextId}`);
    expect(f.posts.at(-1)!.body.dedupeKey).toBe(`robob-link-up:${nextId}`);
  }
  const rollup = await log.rollup("2026-11-17"); await log.settled();
  expect(rollup?.robob_link.outages.find(row => row.outageId === original.outageId)).toMatchObject({ open: false, recoveredAt });
});

for (const tickAfterFailure of [false, true]) for (const initialFailures of [1, 2]) test.each([0, 1, 2])(`tentative checkpoint needs three failures across restart (before=${initialFailures}, after=%s, tick=${tickAfterFailure})`, async resumedFailures => {
  const f = setup(); const root = join(f.root, "logs");
  const make = () => createToolLog({ root, now: f.options.now, linkAlert: { root: f.root, post: f.options.post } });
  let log = make();
  const fail = () => log.write({ component: "robob", name: "turn.robob_call", kind: "perf", ok: false, props: { route: "/threads", linkCause: "ECONNREFUSED" } });
  for (let i = 0; i < initialFailures; i++) fail();
  f.advance(120_000); await log.tick(); await log.settled(); log.flush();
  expect(f.posts).toHaveLength(0); expect(f.state()).toBeNull();
  const saved = JSON.parse(readFileSync(join(root, "robob-link-state.json"), "utf8")).active;
  expect(saved.link.failedCalls).toBe(initialFailures); expect(saved.down).toBe(false);
  log = make();
  for (let i = 0; i < resumedFailures; i++) { fail(); if (tickAfterFailure) await log.tick(); }
  const confirmed = initialFailures + resumedFailures >= 3;
  expect(f.posts).toHaveLength(confirmed && tickAfterFailure ? 1 : 0);
  log.write({ component: "robob", name: "turn.robob_call", kind: "perf", ok: true });
  await log.tick(); await log.settled(); log.flush();
  expect(f.posts).toHaveLength(confirmed ? 2 : 0);
  if (confirmed) expect(f.posts[0]!.body.dedupeKey).toBe(`robob-link-down:${saved.link.outageId}`);
  expect(f.state()?.upAlertSentAt !== undefined).toBe(confirmed);
});

test("a later outage waits behind a failed recovery, retaining both across restart", async () => {
  const f = setup(); f.alert.accept(f.down()); f.advance(120_000); await f.alert.tick();
  f.alert.accept(f.success()); f.statuses.push(500); await f.alert.tick();
  const next = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
  f.alert.accept(f.down(next)); f.advance(120_000);
  const restarted = createRobobLinkAlert(f.options); await restarted.tick();
  expect(f.posts.map(item => item.body.dedupeKey)).toEqual([`robob-link-down:${id}`, `robob-link-up:${id}`, `robob-link-up:${id}`, `robob-link-down:${next}`]);
});

for (const duration of [119_999, 120_000, 180_000]) test.each(["none", "while down", "after recovery"])(`queued recovered outage retains its qualification (duration=${duration}, restart=%s)`, async restart => {
  const f = setup(); let alert = f.alert;
  alert.accept(f.down()); f.advance(120_000); await alert.tick();
  alert.accept(f.success()); f.statuses.push(500); await alert.tick();
  const next = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
  alert.accept(f.down(next)); f.advance(duration); f.statuses.push(500); await alert.tick();
  if (restart === "while down") alert = createRobobLinkAlert(f.options);
  alert.accept(f.success()); f.statuses.push(500); await alert.tick();
  expect(f.state().pending[0].recoveredAt).toBe(new Date(start + 120_000 + duration).toISOString());
  if (restart === "after recovery") alert = createRobobLinkAlert(f.options);
  f.advance(600_000); await alert.tick(); await alert.tick();
  const expected = [`robob-link-down:${id}`, ...Array<string>(4).fill(`robob-link-up:${id}`)];
  if (duration >= 120_000) expected.push(`robob-link-down:${next}`, `robob-link-up:${next}`);
  expect(f.posts.map(item => item.body.dedupeKey)).toEqual(expected);
  if (duration >= 120_000) {
    const n = Math.round(duration / 60_000);
    expect(f.posts[5]!.body.text).toContain(`(${n} min, ECONNREFUSED)`);
    expect(f.posts[6]!.body.text).toBe(`Robob is up again after ${n} min (down since 11:26 Dubai).`);
    expect(f.state().upAlertSentAt).toBeDefined(); expect(f.state().pending).toBeUndefined();
  } else expect(f.state().recoveredAt).toBeDefined();
  expect(alert.identity()).toBeUndefined();
});

test.each(["{broken", "{}", '{"outageId":"bad","firstFailureAt":"bad"}', '{"outageId":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","firstFailureAt":"2026-11-17T07:24:16.494Z","pending":{}}'])("corrupt state %s starts clean and logs an error", content => {
  const f = setup(); writeFileSync(f.file, content);
  const restarted = createRobobLinkAlert(f.options);
  expect(restarted.identity()).toBeUndefined(); expect(f.state()).toBeNull();
  expect(f.events.find(event => event.error)?.error?.tag).toBe("robob.link_alert.read");
});

test("an unreadable state path is absent and write failure prevents an unpersisted send", async () => {
  const f = setup(); rmSync(f.file); mkdirSync(f.file);
  const restarted = createRobobLinkAlert(f.options); restarted.accept(f.down()); f.advance(120_000); await restarted.tick();
  expect(f.posts).toHaveLength(0); expect(f.events.some(event => event.error?.tag === "robob.link_alert.read")).toBe(true);
});

test("overlapping ticks and recovery during a send produce one down and one up attempt", async () => {
  const f = setup(); let finish!: (status: number) => void;
  const post: Post = async (path, body) => { f.posts.push({ at: 0, body }); return body.severity === "error" ? await new Promise<number>(resolve => { finish = resolve; }) : 200; };
  const alert = createRobobLinkAlert({ ...f.options, post }); alert.accept(f.down()); f.advance(120_000);
  const sending = alert.tick(); await Promise.resolve();
  const overlapping = alert.tick(); expect(sending).toBe(overlapping);
  f.advance(60_000); alert.accept(f.success()); finish(202); await Promise.all([sending, overlapping]);
  expect(f.posts.map(item => item.body.dedupeKey)).toEqual([`robob-link-down:${id}`, `robob-link-up:${id}`]);
});

test("a live restart/install hold is named without muting the down alert", async () => {
  const f = setup(); const holdPath = join(f.root, "hold.json");
  writeFileSync(holdPath, JSON.stringify({ by: "overload-restart", pid: process.pid, startedAt: start / 1000, beatAt: (start + 120_000) / 1000 }));
  const alert = createRobobLinkAlert({ ...f.options, holdPath }); alert.accept(f.down()); f.advance(120_000); await alert.tick();
  expect(f.posts[0]!.body.text).toEndWith("Restart/install hold: overload-restart.");
});

test("17 Nov replay and restart keep log, rollup, and Telegram on one outage (309 min)", async () => {
  const f = setup();
  const make = (root = join(f.root, "logs")) => createToolLog({ root, now: f.options.now, capBytes: 1, linkAlert: { root: f.root, post: f.options.post } });
  let log = make();
  const call = (ok: boolean) => log.write({ component: "robob", kind: "perf", name: "turn.robob_call", ok,
    props: { route: "/threads", ...(!ok ? { linkCause: "ECONNREFUSED" } : {}) } });
  call(false); f.set(Date.parse("2026-11-17T07:24:17.800Z")); call(false); f.set(Date.parse("2026-11-17T07:24:19.130Z")); call(false);
  f.set(start + 119_000); await log.tick(); expect(f.posts).toHaveLength(0);
  f.advance(1_000); await log.tick(); expect(f.posts[0]!.at).toBe(start + 120_000);
  const original = f.state();
  await log.settled(); log.flush();
  // Losing the separate log checkpoint must still reuse the alert's durable identity.
  log = make(join(f.root, "restarted-logs"));
  f.advance(600_000); call(false); call(false); call(false); await log.tick();
  expect(f.posts).toHaveLength(1);
  f.set(Date.parse("2026-11-17T12:33:32.274Z")); call(true); await log.settled(); log.flush();
  expect(f.posts).toHaveLength(2);
  expect(f.posts[1]!.body).toMatchObject({ dedupeKey: `robob-link-up:${original.outageId}`, text: "Robob is up again after 309 min (down since 11:24 Dubai)." });
  const rows: LogLine[] = readFileSync(join(f.root, "restarted-logs", "2026-11-17.ndjson"), "utf8").trim().split("\n").map(row => JSON.parse(row));
  expect(rows.filter(row => row.link).every(row => row.link?.outageId === original.outageId && row.link?.firstFailureAt === original.firstFailureAt)).toBe(true);
  expect(rows.filter(row => row.name === "robob.link_alert")).toMatchObject([{ ok: true, ids: { outageId: original.outageId }, props: { kind: "up", status: 202, ok: true } }]);
  const rollup = await log.rollup("2026-11-17"); await log.settled();
  expect(rollup?.robob_link.outages[0]).toMatchObject({ outageId: original.outageId, firstFailureAt: original.firstFailureAt, open: false });
  expect(f.state().upAlertSentAt).toBeDefined();
});
