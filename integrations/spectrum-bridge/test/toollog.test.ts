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
    ids: { text: message.text, token: message.token, messageId: message.id, password: "PASSWORD_SENTINEL", card: "4111111111111111" },
    props: { text: message.text, token: message.token, otp: message.otp, count: 2, body: "EMAIL_BODY_SENTINEL", value: 83.7, caption: "PRIVATE_CAPTION" } });
  const raw = readFileSync(join(root, `${day}.ndjson`), "utf8");
  for (const secret of [message.text, message.prompt, message.token, message.otp, "83.7", "PASSWORD_SENTINEL", "4111111111111111", "EMAIL_BODY_SENTINEL", "PRIVATE_CAPTION"]) expect(raw).not.toContain(secret);
  expect(JSON.parse(raw).props).toEqual({ count: 2 });
  expect(JSON.parse(raw).error).toEqual({ tag: "fixture.failed", message: "Operation failed" });
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
  await expect(broken.rollup()).resolves.toBeUndefined();
  await expect(broken.tick()).resolves.toBeUndefined();
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
