import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardAskKey, enqueueNotice, flushBursts } from "../src/notification-policy.ts";
import { redact } from "../src/redact.ts";
import { Store } from "../src/store.ts";

const HOUR = 3_600_000;
const notice = (id: string) => ({ id, source: "offbox", text: `failure ${id}`, severity: "error", burstKey: "infra" });
afterEach(() => setSystemTime());

test.each([
  ["token=secret", "token=[redacted]"],
  ["token=https://example.test/?part=1&sig=FAKE_SECRET", "token=[redacted]"],
  ["access_token=Bearer https://example.test/?part=1&sig=FAKE_SECRET", "access_token=[redacted]"],
  ["token=prefix:https://example.test/?part=1&sig=FAKE_SECRET", "token=[redacted]"],
  ['{"token":"https://example.test/?part=1&sig=FAKE_SECRET"}', '{"token":[redacted]}'],
  ["access_token=Bearer FAKE_SECRET", "access_token=[redacted]"],
  ['token="Bearer FAKE_SECRET"', 'token=[redacted]'],
  [String.raw`{"token":"one \"two\" three"}`, String.raw`{"token":[redacted]}`],
  [String.raw`{\"token\":\"one \\\"two\\\" three\"}`, String.raw`{\"token\":[redacted]}`],
  [String.raw`{"token":"prefix https://example.test/?sig=x\" FAKE_SECRET"}`, String.raw`{"token":[redacted]}`],
  [String.raw`{\"token\":\"prefix https://example.test/?sig=x\\\" FAKE_SECRET\"}`, String.raw`{\"token\":[redacted]}`],
  ["ACCESS_TOKEN = secret&ok=1", "ACCESS_TOKEN = [redacted]&ok=1"],
  ['{"access_token":"secret"}', '{"access_token":[redacted]}'],
  [String.raw`{\"access_token\":\"secret\"}`, String.raw`{\"access_token\":[redacted]}`],
  ["'token' : 'secret'", "'token' : [redacted]"],
  ["token: 'secret value'", "token: [redacted]"],
  ["token%3Dsecret%2Fvalue", "token%3D[redacted]"],
  ["eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.signature", "[redacted]"],
  ["eyJtruncated", "[redacted]"],
  ["https://example.test/path?token=secret&tab=1#fragment", "https://example.test/path"],
  ["https://example.test/path?code=secret", "https://example.test/path"],
  ["https://example.test/path#access_token=secret", "https://example.test/path"],
  [String.raw`https://example.test/?token=FAKE_PREFIX\FAKE_SECRET`, "https://example.test/"],
  [String.raw`{"url":"https://example.test/?token=FAKE_PREFIX\\FAKE_SECRET"}`, '{"url":"https://example.test/"}'],
  [String.raw`{\"url\":\"https://example.test/?token=FAKE_PREFIX\\\\FAKE_SECRET\"}`, String.raw`{\"url\":\"https://example.test/\"}`],
  [String.raw`{"url":"https://example.test/?sig=FAKE_PREFIX\"FAKE_SECRET"}`, '{"url":"https://example.test/"}'],
  [String.raw`{\"url\":\"https://example.test/?sig=FAKE_PREFIX\\\"FAKE_SECRET\"}`, String.raw`{\"url\":\"https://example.test/\"}`],
  [String.raw`https://example.test/token=FAKE_PREFIX\FAKE_SECRET`, "https://example.test/token=[redacted]"],
  ["https://example.test/token=FAKE_SECRET?sig=FAKE_QUERY", "https://example.test/token=[redacted]"],
  ['{"url":"https://example.test/token=FAKE_SECRET?sig=FAKE_QUERY"}', '{"url":"https://example.test/token=[redacted]"}'],
  [String.raw`{\"url\":\"https://example.test/token=FAKE_SECRET?sig=FAKE_QUERY\"}`, String.raw`{\"url\":\"https://example.test/token=[redacted]\"}`],
  ['{"token":"prefix https://example.test/?sig=x","access_token":"FAKE_OTHER"}', '{"token":[redacted],"access_token":[redacted]}'],
  [String.raw`{\"token\":\"prefix https://example.test/?sig=x\",\"access_token\":\"FAKE_OTHER\"}`, String.raw`{\"token\":[redacted],\"access_token\":[redacted]}`],
  ["https://example.test/path and token count is 3", "https://example.test/path and token count is 3"],
])("redacts %s", (input, expected) => {
  expect(redact(input)).toBe(expected);
  expect(redact(redact(input))).toBe(expected);
});

test.each([
  ["Robob board -582", "q2 in Needs Owner", "robob:582:q2"],
  ["Robob board -582", "(Q2, open since 8 Nov)", "robob:582:q2"],
  ["Robob board", "#582 needs your OK (q2)", "robob:582:q2"],
  ["Crpko board -582", "q2", "crpko:582:q2"],
  ["Robob board -582", "informational status", undefined],
  ["offbox", "#582 q2", undefined],
])("legacy ask identity %s %s", (source, text, expected) => {
  expect(boardAskKey(source, text)).toBe(expected);
});

test("asks send immediately, once after 24 hours, and isolate board/card/ask identities across restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "telegram-policy-"));
  let store = new Store(join(dir, "state.sqlite"));
  const ask = (id: string, text = "q2 needs your OK", source = "Robob board -582") => ({ id, text, source, severity: "attention" });
  try {
    expect(enqueueNotice(store, ask("first"), 0)).toBe(true);
    store.outboxState("first", "sent");
    expect(enqueueNotice(store, ask("changed", "new wording for q2"), 23 * HOUR)).toBe(false);
    expect(enqueueNotice(store, ask("other-ask", "q3"), HOUR)).toBe(true);
    expect(enqueueNotice(store, ask("other-board", "q2", "Crpko board -582"), HOUR)).toBe(true);
    expect(enqueueNotice(store, { ...ask("explicit"), askKey: "card-other:q1" }, HOUR)).toBe(true);
    store.close();
    store = new Store(join(dir, "state.sqlite"));
    expect(enqueueNotice(store, ask("too-early"), 24 * HOUR - 1)).toBe(false);
    expect(enqueueNotice(store, ask("reminder"), 24 * HOUR)).toBe(true);
    expect(enqueueNotice(store, ask("third"), 48 * HOUR)).toBe(false);
    expect(enqueueNotice(store, ask("first"), 48 * HOUR)).toBe(false);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test("first failure is immediate; retries count once; quiet bursts flush without another failure", () => {
  const store = new Store(":memory:");
  try {
    expect(enqueueNotice(store, notice("first"), 0)).toBe(true);
    store.outboxState("first", "sent");
    for (let i = 1; i < 12; i++) {
      expect(enqueueNotice(store, notice(String(i)), i)).toBe(false);
      expect(enqueueNotice(store, notice(String(i)), i)).toBe(false);
    }
    expect(() => enqueueNotice(store, { ...notice("1"), text: "changed" }, 20)).toThrow();
    flushBursts(store, HOUR - 1);
    expect(store.pendingOutbox()).toHaveLength(0);
    flushBursts(store, HOUR);
    expect(store.pendingOutbox().map(op => op.text)).toEqual([
      "[offbox] 12 failures in the last hour, latest: failure 11",
    ]);
    flushBursts(store, HOUR);
    store.outboxState(store.pendingOutbox()[0]!.id, "sent");
    expect(enqueueNotice(store, notice("next"), HOUR)).toBe(false);
    expect(enqueueNotice(store, { ...notice("watcher"), source: "Watcher health" }, HOUR)).toBe(true);
    flushBursts(store, 2 * HOUR);
    expect(store.pendingOutbox().at(-1)?.text).toBe("[offbox] 1 failure in the last hour, latest: failure next");
    store.outboxState(store.pendingOutbox().at(-1)!.id, "sent");
    expect(enqueueNotice(store, notice("fresh"), 4 * HOUR)).toBe(true);
  } finally { store.close(); }
});

test("run.cloud up notices are suppressed while lifecycle warnings remain", () => {
  const store = new Store(":memory:");
  try {
    expect(enqueueNotice(store, { id: "up", source: "run.cloud", text: "Run Cloud iOS simulator up: demo", severity: "info" })).toBe(false);
    expect(enqueueNotice(store, { id: "down", source: "run.cloud", text: "Simulator heartbeat overdue", severity: "attention" })).toBe(true);
    expect(store.pendingOutbox()).toHaveLength(1);
  } finally { store.close(); }
});

test("an enqueue rollback cannot consume the first ask or failure alert", () => {
  const store = new Store(":memory:");
  try {
    store.db.exec("CREATE TRIGGER reject_send BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'test rejection'); END");
    const ask = { id: "ask", source: "tests", text: "please answer", severity: "attention", askKey: "card:q1" };
    expect(() => enqueueNotice(store, ask, 0)).toThrow();
    expect(() => enqueueNotice(store, notice("failure"), 0)).toThrow();
    store.db.exec("DROP TRIGGER reject_send");
    expect(enqueueNotice(store, ask, 1)).toBe(true);
    expect(enqueueNotice(store, notice("failure"), 1)).toBe(true);
  } finally { store.close(); }
});

test("definitely rejected first alerts can be replaced immediately; ambiguous sends stay deduplicated", () => {
  const store = new Store(":memory:");
  try {
    const ask = { id: "ask", source: "tests", text: "answer", severity: "attention", askKey: "card:q1" };
    enqueueNotice(store, ask, 0);
    enqueueNotice(store, notice("failure"), 0);
    for (const id of ["ask", "failure"]) {
      store.outboxState(id, "failed");
      store.set(`sendAmbiguous:${id}`, false);
    }
    expect(enqueueNotice(store, { ...ask, id: "ask-replacement" }, 1)).toBe(true);
    expect(enqueueNotice(store, notice("failure-replacement"), 1)).toBe(true);
    store.outboxState("ask-replacement", "failed");
    store.set("sendAmbiguous:ask-replacement", true);
    expect(enqueueNotice(store, { ...ask, id: "ask-ambiguous" }, 2)).toBe(false);
    store.outboxState("failure-replacement", "uncertain");
    expect(enqueueNotice(store, notice("failure-ambiguous"), 2)).toBe(false);
  } finally { store.close(); }
});

test("replacing a rejected first alert retains accumulated failures in its hourly summary", () => {
  const store = new Store(":memory:");
  try {
    enqueueNotice(store, notice("rejected"), 0);
    for (let i = 0; i < 5; i++) enqueueNotice(store, notice(`suppressed-${i}`), i + 1);
    store.outboxState("rejected", "failed");
    store.set("sendAmbiguous:rejected", false);
    expect(enqueueNotice(store, notice("replacement"), 6)).toBe(true);
    store.outboxState("replacement", "sent");
    flushBursts(store, HOUR + 6);
    expect(store.pendingOutbox().map(op => op.text)).toEqual([
      "[offbox] 7 failures in this failure burst, latest: failure replacement",
    ]);
  } finally { store.close(); }
});

test("a rejected summary also carries its unreported failures into a replacement", () => {
  const store = new Store(":memory:");
  try {
    enqueueNotice(store, notice("first"), 0);
    store.outboxState("first", "sent");
    for (let i = 0; i < 5; i++) enqueueNotice(store, notice(`repeat-${i}`), i + 1);
    flushBursts(store, HOUR);
    const summary = store.pendingOutbox()[0]!;
    store.outboxState(summary.id, "failed");
    store.set(`sendAmbiguous:${summary.id}`, false);
    expect(enqueueNotice(store, notice("replacement"), HOUR + 1)).toBe(true);
    store.outboxState("replacement", "sent");
    flushBursts(store, 2 * HOUR + 1);
    expect(store.pendingOutbox().map(op => op.text)).toEqual([
      "[offbox] 7 failures in this failure burst, latest: failure replacement",
    ]);
  } finally { store.close(); }
});
