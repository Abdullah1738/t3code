import { afterEach, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolLog, type LogLine } from "../src/toollog.ts";

const dirs: string[] = [];
const day = "2026-11-13";
const at = Date.parse(`${day}T12:00:00Z`);
const entry = { component: "fixture", kind: "perf", name: "turn.robob_call", ok: true, durationMs: 12, ids: { messageId: "msg-fixture" } } as const;
function setup(options: { capBytes?: number; now?: () => number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "toollog-")); dirs.push(root);
  return { root, log: createToolLog({ root, now: () => at, ...options }), lines: () => readFileSync(join(root, `${day}.ndjson`), "utf8").trim().split("\n").map(s => JSON.parse(s) as LogLine) };
}
afterEach(() => dirs.splice(0).forEach(root => {
  if (process.env.TOOLLOG_SAMPLE_FILE) for (const file of readdirSync(root).filter(file => file.endsWith(".ndjson"))) {
    appendFileSync(process.env.TOOLLOG_SAMPLE_FILE, readFileSync(join(root, file)));
  }
  rmSync(root, { recursive: true, force: true });
}));

test("notice suppression reasons survive structured-log redaction", () => {
  const { log, lines } = setup();
  const reasons = ["grace", "not-waiting", "already-sent", "rate-limited"];
  for (const reason of reasons) log.write({ component: "remote-box", kind: "event", name: "moni-notice-suppressed", props: { reason } });
  expect(lines().map(line => line.props?.reason)).toEqual(reasons);
});

test("wake lifecycle rows survive the log cap and keep only delivery metadata", () => {
  const { log, lines } = setup({ capBytes: 1 });
  for (const name of ["wake.accepted", "wake.turn_start", "wake.send_ambiguous", "wake.admitted", "wake.retry_scheduled", "wake.failed"]) {
    log.write({ component: "router", kind: "event", name, ids: { inboundId: "wake:fixture", threadId: "thread-1" },
      durationMs: 60_000, props: { source: "robob-watch reauth failing", waitMs: 300, batchSize: 2, holderRunId: "run-1",
        route: "/threads/:id/send", causeKey: "code.ECONNRESET", attempt: 2, nextAt: at + 60_000,
        reason: "ambiguity_deadline", ageMs: 1_800_000, text: "PRIVATE_EVENT", body: "PRIVATE_BODY", token: "PRIVATE_TOKEN" } });
  }
  const kept = lines().filter(line => line.name.startsWith("wake."));
  expect(kept).toHaveLength(6);
  for (const line of kept) {
    expect(line.ids?.inboundId).toBe("wake:fixture");
    expect(line.props).toMatchObject({ source: "robob-watch reauth failing", holderRunId: "run-1", nextAt: at + 60_000,
      causeKey: "code.ECONNRESET", reason: "ambiguity_deadline" });
    expect(JSON.stringify(line)).not.toContain("PRIVATE_");
  }
  log.write({ component: "router", kind: "error", name: "other", props: { source: "PRIVATE_SOURCE", causeKey: "PRIVATE_CAUSE", nextAt: at } });
  expect(lines().at(-1)?.props).toBeUndefined();
});

test("shared format, UTC milliseconds, append-only and private modes", () => {
  const { root, log, lines } = setup();
  chmodSync(root, 0o755);
  log.write(entry); log.write({ ...entry, durationMs: 24 });
  expect(lines().map(({ ids, ...line }) => ({ ...line, ids: { messageId: ids?.messageId } })) ).toEqual([{ ts: `${day}T12:00:00.000Z`, tool: "imessage", ...entry }, { ts: `${day}T12:00:00.000Z`, tool: "imessage", ...entry, durationMs: 24 }]);
  expect(statSync(root).mode & 0o777).toBe(0o700);
  expect(statSync(join(root, `${day}.ndjson`)).mode & 0o777).toBe(0o600);
});

test("an entire message/error fixture cannot leak text, secrets, health values or arbitrary fields", () => {
  const { root, log } = setup();
  const message = { id: "m-fixture", text: "PRIVATE_MESSAGE_SENTINEL", prompt: "PRIVATE_PROMPT_SENTINEL", attachments: [], token: "TOKEN_SENTINEL", otp: "654321", health: 83.7 };
  log.write({ ...entry, ...message, kind: "error", error: { tag: "fixture.failed", message: "Bearer TOKEN_SENTINEL PRIVATE_MESSAGE_SENTINEL" },
    ids: { text: message.text, token: message.token, messageId: message.id, inboundId: message.id, password: "PASSWORD_SENTINEL", card: "4111111111111111" },
    props: { text: message.text, token: message.token, otp: message.otp, count: 2, body: "EMAIL_BODY_SENTINEL", value: 83.7, caption: "PRIVATE_CAPTION" } });
  const raw = readFileSync(join(root, `${day}.ndjson`), "utf8");
  for (const secret of [message.text, message.prompt, message.token, message.otp, "83.7", "PASSWORD_SENTINEL", "4111111111111111", "EMAIL_BODY_SENTINEL", "PRIVATE_CAPTION"]) expect(raw).not.toContain(secret);
  expect(JSON.parse(raw).ids.inboundId).toBe(message.id);
  expect(JSON.parse(raw).props).toEqual({ count: 2 });
  expect(JSON.parse(raw).error).toEqual({ tag: "fixture.failed", name: "UnknownError", message: "[redacted]", causeKey: "callsite_failure" });
});

test("retention runs on the first write of each UTC day and touches only old log artifacts", () => {
  let time = at;
  const { root, log } = setup({ now: () => time });
  for (const file of ["2026-10-13.ndjson", "rollup-2026-10-13.json", "2026-10-13.cap", "2026-10-14.ndjson", "keep.txt"]) writeFileSync(join(root, file), "");
  log.write(entry);
  expect(readdirSync(root)).toEqual(expect.arrayContaining(["2026-10-14.ndjson", "keep.txt"]));
  expect(existsSync(join(root, "2026-10-13.ndjson"))).toBe(false);
  expect(existsSync(join(root, "rollup-2026-10-13.json"))).toBe(false);
  time += 86400_000; log.write(entry);
  expect(existsSync(join(root, "2026-10-14.ndjson"))).toBe(false);
});

test("cap suppresses event/perf, retains errors and emits one notice across writer restarts", () => {
  const { root, log, lines } = setup({ capBytes: 1 });
  log.write(entry); log.write(entry); log.write({ ...entry, kind: "event" });
  createToolLog({ root, now: () => at, capBytes: 1 }).write(entry);
  log.write({ ...entry, kind: "error", name: "reply.failed", ok: false, error: { tag: "stop_opt_out", message: "private" } });
  expect(lines().map(l => l.name)).toEqual(["turn.robob_call", "log.degraded", "reply.failed"]);
});

test("remote fence diagnostics survive the log cap and writer restart", () => {
  const { root, log, lines } = setup({ capBytes: 1 }); log.write(entry);
  for (const name of ["moni-box-backend-state", "moni-box-fenced", "moni-box-unfenced", "moni-box-wake-autofailed"]) {
    createToolLog({ root, now: () => at, capBytes: 1 }).write({ component: "remote-box", kind: "event", name,
      props: { backend: "remote-box", active: false, fenced: true, event: "609fe8828d46", queuedBehind: 3, ageMs: 600_000 } });
  }
  expect(lines().filter(l => l.component === "remote-box")).toHaveLength(4);
  expect(lines().at(-1)?.props).toMatchObject({ event: "609fe8828d46", queuedBehind: 3, ageMs: 600_000 });
});

test("degraded mode uses the five-second call threshold and retains every failure", () => {
  const { log, lines } = setup({ capBytes: 1 });
  log.write(entry);
  for (const durationMs of [1_500, 5_000, 5_000.01]) log.write({ ...entry, durationMs });
  log.write({ ...entry, durationMs: 2, ok: false, error: { tag: "control.request_failed" } });
  expect(lines().filter(line => line.name === "turn.robob_call").map(line => line.durationMs)).toEqual([12, 5_000.01, 2]);
});

test("all logging failures, malformed input and optional attribution failures are swallowed", async () => {
  const { root } = setup(); const file = join(root, "file"); writeFileSync(file, "");
  const bad = createToolLog({ root: join(file, "child") });
  expect(() => bad.write(entry)).not.toThrow();
  expect(() => bad.capture(() => { throw new Error("private"); })).not.toThrow();
  await expect(bad.rollup(day)).resolves.toBeUndefined();
  await expect(bad.tick()).resolves.toBeUndefined();
  const throwing = { ...entry, get ids(): Record<string, string> { throw new Error("secret"); } };
  expect(() => bad.write(throwing)).not.toThrow();
});

test("fixture rollup counts names/kinds, rates, percentiles and top tags with one id", async () => {
  const { root, log } = setup();
  for (let i = 1; i <= 100; i++) log.write({ ...entry, durationMs: i });
  for (let i = 0; i < 25; i++) log.write({ ...entry, kind: "error", name: "reply.failed", ok: false, error: { tag: `failure.${i}`, message: "no raw bodies" } });
  appendFileSync(join(root, `${day}.ndjson`), '{incomplete\nnull\n');
  const result = await log.rollup(day);
  expect(result?.total).toBe(125);
  expect(result?.countsByName).toEqual({ "turn.robob_call": 100, "reply.failed": 25 });
  expect(result?.countsByKind).toEqual({ event: 0, perf: 100, error: 25 });
  expect(result?.okRate).toBe(.8); expect(result?.errorRate).toBe(.2);
  expect(result?.durationMs[entry.name]).toEqual({ p50: 50, p95: 95, max: 100 });
  expect(result?.topErrorTags).toHaveLength(20);
  expect(result?.topErrorTags[0].sampleId).toBe("msg-fixture");
  expect(statSync(join(root, `rollup-${day}.json`)).mode & 0o777).toBe(0o600);
  expect(await log.rollup("../bad")).toBeUndefined();
});

test("rollup joins unique inbound chains per chat using first start and first accepted reply", async () => {
  let time = at;
  const { log } = setup({ now: () => time });
  const emit = (name: string, chat: string, id: string, ms: number) => {
    time = at + ms;
    log.write({ component: "fixture", kind: "event", name, ...(name === "reply.sent" ? { ok: true } : {}),
      ids: { chat, ...(name === "msg.received" ? { messageId: id } : { messageId: "different-turn-id", inboundId: id }) } });
  };
  for (let i = 1; i <= 100; i++) {
    emit("msg.received", "owner", `in-${i}`, 0);
    emit("turn.start", "owner", `in-${i}`, i);
    emit("reply.sent", "owner", `in-${i}`, i * 10);
    emit("reply.sent", "owner", `in-${i}`, i * 10 + 1);
  }
  emit("msg.received", "owner", "in-1", 5000); // Replayed receipt cannot move the clock.
  emit("msg.received", "owner", "unanswered", 0);
  emit("turn.start", "owner", "unanswered", 200);
  emit("msg.received", "moni", "in-1", 0); // Same id in another chat is independent.
  emit("reply.sent", "moni", "in-1", 500);
  emit("turn.start", "moni", "in-1", 100); // File order need not be time order.
  emit("msg.received", "moni", "backwards", 1000);
  emit("turn.start", "moni", "backwards", 900);
  emit("reply.sent", "moni", "backwards", 900);
  emit("reply.sent", "moni", "unmatched", 500);
  log.write({ component: "fixture", name: "turn.start", kind: "event", ids: { chat: "moni", messageId: "in-1" } });
  const result = await log.rollup(day);
  expect(result?.chains).toEqual({
    owner: { received: 101, turnStarted: 101, replySent: 100, completed: 100,
      receivedToStartMs: { p50: 51, p95: 96, max: 200 }, receivedToReplyMs: { p50: 500, p95: 950, max: 1000 } },
    moni: { received: 2, turnStarted: 1, replySent: 1, completed: 1,
      receivedToStartMs: { p50: 100, p95: 100, max: 100 }, receivedToReplyMs: { p50: 500, p95: 500, max: 500 } },
  });
  expect(JSON.stringify(result?.chains)).not.toContain("in-1");
});

test("first tick after 00:05 UTC rolls up yesterday, once across restarts", async () => {
  let time = at;
  const { root, log } = setup({ now: () => time }); log.write(entry);
  time = Date.parse("2026-11-14T00:04:59Z"); await log.tick();
  const path = join(root, `rollup-${day}.json`); expect(existsSync(path)).toBe(false);
  time += 1000; await log.tick(); expect(JSON.parse(readFileSync(path, "utf8")).total).toBe(1);
  const before = statSync(path).mtimeMs;
  await log.tick(); await createToolLog({ root, now: () => time }).tick();
  expect(statSync(path).mtimeMs).toBe(before);
});

test("empty days roll up once, and a broken clock cannot reject any logger operation", async () => {
  const { log } = setup();
  expect(await log.rollup(day)).toMatchObject({ total: 0, day, topErrorTags: [] });
  const broken = createToolLog({ now: () => { throw new Error("clock unavailable"); } });
  expect(() => broken.write(entry)).not.toThrow();
  expect(broken.flush()).toBe(false);
  expect(broken.flush()).toBe(true);
  await expect(broken.rollup()).resolves.toBeUndefined();
  await expect(broken.tick()).resolves.toBeUndefined();
});

test("rejected renders and failed capture cannot pass the next flush acknowledgement", () => {
  const { log, lines } = setup();
  log.write({ ...entry, component: "invalid component", name: "card.render" });
  expect(log.flush()).toBe(false);
  expect(() => log.capture(() => { throw new Error("PRIVATE capture failure"); })).not.toThrow();
  expect(log.flush()).toBe(false);
  log.write(entry);
  expect(log.flush()).toBe(true);
  expect(lines()).toHaveLength(1);
  expect(JSON.stringify(lines())).not.toContain("PRIVATE");
});

test.each([
  { field: "component", component: "invalid component" },
  { field: "name", name: "invalid name" },
  { field: "kind", kind: "invalid" as "perf" },
])("dropping a diagnostic with an invalid $field does not fail the next flush", invalid => {
  const { log, lines } = setup();
  log.write({ ...entry, ...invalid });
  log.write(entry);
  expect(log.flush()).toBe(true);
  expect(lines()).toHaveLength(1);
});

// Process and recovery records share the same schema without any payload content.
test("lifecycle event fixture round-trips only ids, sizes and exit status", () => {
  const { log, lines } = setup();
  const fixtures: Parameters<typeof log.write>[0][] = [
    { component: "process", name: "bridge.start", kind: "event" },
    { component: "process", name: "bridge.stop", kind: "event" },
    { component: "attachments", name: "attachment.received", kind: "event", ids: { messageId: "attachment-fixture" }, props: { attachmentBytes: 4, count: 1 } },
    { component: "recovery", name: "recovery.notice_failed", kind: "error", ok: false, props: { exitCode: 1 }, error: { tag: "recovery.notification_failed", message: "PRIVATE_PAYLOAD" } },
  ];
  for (const fixture of fixtures) log.write(fixture);
  expect(lines().map(l => l.name)).toEqual(fixtures.map(l => l.name));
  expect(JSON.stringify(lines())).not.toContain("PRIVATE_PAYLOAD");
});

test("runtime logging defers all filesystem work beyond synchronous transactions", async () => {
  const { root } = setup();
  const log = createToolLog({ root, now: () => at, defer: true });
  log.capture(() => log.write(entry));
  expect(existsSync(join(root, `${day}.ndjson`))).toBe(false);
  await Promise.resolve();
  expect(existsSync(join(root, `${day}.ndjson`))).toBe(true);
  log.write({ ...entry, name: "process.last" });
  log.flush();
  expect(readFileSync(join(root, `${day}.ndjson`), "utf8")).toContain("process.last");
});

test.each(["", '{"day":', "{}", '{"day":"2000-01-01","tool":"imessage","total":0}'])("tick replaces incomplete rollup %j atomically", async broken => {
  let time = at;
  const { root, log } = setup({ now: () => time }); log.write(entry);
  const path = join(root, `rollup-${day}.json`);
  writeFileSync(path, broken);
  time = Date.parse("2026-11-14T00:05:00Z");
  await Promise.all([log.tick(), log.tick()]);
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ day, total: 1 });
  expect(readdirSync(root).filter(file => file.endsWith(".tmp"))).toEqual([]);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test.each([
  ["nutrition.png", "nutrition"], ["nutrition-1234.png", "nutrition"],
  ["2026-11-13-nutrition-1234.png", "nutrition"], ["2026-11-13-morning-body.png", "nutrition"],
  ["2026-11-13_nutrition_1234.PNG", "nutrition"], ["/private/cards/2026-11-13-morning-recovery.png", "nutrition"],
  ["https://cards.example/q-stat-123/", "quick"], ["delivery-noon-id/preview.png", "delivery"],
  ["2026-11-13-ride-id.png", "ride"], ["report-nutrition.png", "other"], ["PRIVATE_CAPTION", "other"],
])("card filename %s classifies as %s without logging the name", async (name, expected) => {
  const { cardKind } = await import("../src/toollog.ts");
  expect(cardKind(name)).toBe(expected);
});

test.each([
  ["http_400:private_message_sentinel", "http_400:provider_error"],
  ["http_429:private_token_sentinel", "http_429:provider_error"],
  ["http_503:otp_654321", "http_503:provider_error"],
  ["http_400:stop_opt_out_private_sentinel", "http_400:provider_error"],
  ["http_400:STOP", "http_400:stop_opt_out"],
  ["http_400:invalid_number", "http_400:invalid_number"],
  ["http_503:worker_unavailable", "http_503:worker_unavailable"],
  ["http_400:5504", "http_400:5504"],
  ["sendblue.654321", "sendblue.async_failure"],
  ["sendblue.private_token_sentinel", "sendblue.async_failure"],
  ["sendblue.STOP", "sendblue.stop_opt_out"],
])("writer and rollup allowlist provider tag %s", async (tag, expected) => {
  const { root, log, lines } = setup();
  const row = { ...entry, kind: "error", name: "reply.failed", ok: false, error: { tag, message: "PRIVATE_MESSAGE" } } as const;
  log.write(row);
  expect(lines()[0].error?.tag).toBe(expected);
  // Older or externally supplied input must pass the same filter when aggregated.
  appendFileSync(join(root, `${day}.ndjson`), JSON.stringify({ ...row, ts: `${day}T12:00:00.000Z`, tool: "imessage" }) + "\n");
  const rollup = await log.rollup(day);
  expect(rollup?.topErrorTags).toHaveLength(1);
  expect(rollup?.topErrorTags[0]).toMatchObject({ tag: expected, count: 2, sampleId: "msg-fixture" });
  expect(JSON.stringify(rollup)).not.toContain("PRIVATE_MESSAGE");
});

test("failed control perf rows retain safe error detail and tick/completion measurements survive cleaning", () => {
  const h = setup();
  h.log.write({ component: "robob", kind: "perf", name: "turn.robob_call", ok: false, durationMs: 25_001,
    props: { method: "GET", route: "/threads/:id/messages" }, error: { tag: "control.request_failed", cause: new DOMException("private response content", "TimeoutError") } });
  h.log.write({ component: "router", kind: "perf", name: "turn.tick_timing", durationMs: 5_001,
    props: { route: "/threads", slowestReadMs: 5_000, completionCheck: "before", secret: "must be cut" } });
  h.log.write({ component: "router", kind: "perf", name: "run-completed-seen", props: { completionLagMs: 123 } });
  const lines = h.lines();
  expect(lines[0]!.error?.name).toBe("TimeoutError");
  expect(JSON.stringify(lines)).not.toContain("private response content");
  expect(lines[1]!.props).toEqual({ route: "/threads", slowestReadMs: 5_000, completionCheck: "before" });
  expect(lines[2]!.props).toEqual({ completionLagMs: 123 });
});


test("CLI send timeouts survive the cap with only hashed key, path and elapsed time", () => {
  const { log, lines } = setup({ capBytes: 1 });
  log.write(entry);
  log.write({ component: "cli", kind: "event", name: "cli.send_timeout",
    ids: { operationId: `send:${"a".repeat(64)}`, key: "PRIVATE_KEY" },
    props: { path: "/send", elapsedMs: 15_000, text: "PRIVATE_TEXT", name: "PRIVATE_FILE" } });
  expect(lines().at(-1)).toMatchObject({ name: "cli.send_timeout", ids: { operationId: `send:${"a".repeat(64)}` },
    props: { path: "/send", elapsedMs: 15_000 } });
  expect(JSON.stringify(lines())).not.toContain("PRIVATE");
});
