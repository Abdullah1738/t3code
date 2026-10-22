import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupLines, jevJudge, JudgeError, judgeState, replyTarget, speakerName, type JudgeState } from "../src/group-judge.ts";
import { Store } from "../src/store.ts";

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const store of stores.splice(0)) store.db.close();
});

function keyFile(contents = "sk-test-key\n"): string {
  const dir = mkdtempSync(join(tmpdir(), "group-judge-"));
  dirs.push(dir);
  const file = join(dir, "key");
  writeFileSync(file, contents, { mode: 0o600 });
  return file;
}

const state = (message: string): JudgeState => ({
  recent_conversation: [], new_message_from: "Moni", new_message: message, previous_message_was_from: null,
  minutes_since_robob_last_wrote: null, robob_last_message_asked_a_question: false,
  robob_is_working_on_their_request: false, minutes_since_they_last_addressed_robob: null,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("jev gets one question per message in a single call and its probabilities come back in order", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const judge = jevJudge({
    keyFile: keyFile(),
    fetch: async (url, init) => {
      calls.push({ url, init });
      return json({ answers: { m0: { type: "noul", noul: 0.91 }, m1: { type: "noul", noul: 0.03 } } });
    },
  });
  expect(await judge([state("can you book it for 11.50"), state("how u feeling")])).toEqual([0.91, 0.03]);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://openrouter.ai/api/alpha/decisions");
  expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test-key");
  const body = JSON.parse(calls[0]!.init.body as string);
  expect(body.model).toBe("typesafe/jev-1.13");
  expect(Object.keys(body.state)).toEqual(["m0", "m1"]);
  expect(body.state.m1.new_message).toBe("how u feeling");
  expect(body.questions.m1.type).toBe("noul");
  expect(body.questions.m1.instructions).toContain("`m1.new_message`");
  expect(body.questions.m1.instructions).not.toContain("`K.");
  expect(body.questions.m1.criteria.true).toBeString();
});

test("jev is retried once, then the failure code is reported", async () => {
  let calls = 0;
  const flaky = jevJudge({ keyFile: keyFile(), timeoutsMs: [1_000, 1_000], fetch: async () => {
    calls += 1;
    if (calls === 1) throw new Error("socket hang up");
    return json({ answers: { m0: { noul: 0.5 } } });
  } });
  expect(await flaky([state("x")])).toEqual([0.5]);
  expect(calls).toBe(2);

  calls = 0;
  const down = jevJudge({ keyFile: keyFile(), timeoutsMs: [1_000, 1_000], fetch: async () => { calls += 1; return json({ error: "x" }, 503); } });
  const error = await down([state("x")]).catch(e => e);
  expect(error).toBeInstanceOf(JudgeError);
  expect(error.code).toBe("http503");
  expect(calls).toBe(2);
});

test("jev without a usable key or with a bad answer fails instead of guessing", async () => {
  const fetch = async () => json({ answers: { m0: { noul: 1.7 } } });
  const noKey = await jevJudge({ keyFile: "/nonexistent/key", fetch })([state("x")]).catch(e => e);
  expect(noKey.code).toBe("keyUnavailable");
  const blank = await jevJudge({ keyFile: keyFile("  \n"), fetch })([state("x")]).catch(e => e);
  expect(blank.code).toBe("keyUnavailable");
  const bad = await jevJudge({ keyFile: keyFile(), timeoutsMs: [1_000], fetch })([state("x")]).catch(e => e);
  expect(bad.code).toBe("invalidResponse");
  const missing = await jevJudge({ keyFile: keyFile(), timeoutsMs: [1_000], fetch: async () => json({ answers: {} }) })([state("x")]).catch(e => e);
  expect(missing.code).toBe("invalidResponse");
  expect(await jevJudge({ keyFile: "/nonexistent/key", fetch })([])).toEqual([]);
});

test("the judge sees people and Robob in order, with Robob labelled and bridge rows left out", () => {
  const store = new Store(":memory:");
  stores.push(store);
  const t0 = Date.parse("2026-10-22T10:01:00Z");
  const names: Record<string, string> = { "+971585933213": "Moni", "+15555550123": "Abdullah" };
  const nameOf = (address: string) => names[address] ?? "Someone";
  const person = (id: string, text: string, sender: string, at: number, extra: object = {}) =>
    store.acceptInbound(id, { id, text, sender, attachments: [], isAudioMessage: false, receivedAt: at, ...extra });
  person("m1", "What time r we leaving tomo", "+971585933213", t0);
  person("m2", "Robob when is that", "+15555550123", t0 + 40_000);
  store.acceptInbound("wake:x", { id: "wake:x", text: "[Watcher event] gate B23", attachments: [], isAudioMessage: false, receivedAt: t0 + 50_000 });
  person("m3", "/status", "+15555550123", t0 + 55_000);
  store.enqueue({ id: "reply:1:a", kind: "conversation", text: "Flight's EK57 tomorrow at 2:25pm. Want me to book a car?", sessionId: "s", generation: 1 });
  store.outboxState("reply:1:a", "sent", "robob-a");
  store.set("sent-at:reply:1:a", t0 + 108_000);
  store.enqueue({ id: "reply:1:b", kind: "conversation", text: "never sent", sessionId: "s", generation: 1 });
  person("m4", "Can you book a Wheely first class for 11.50 please", "+15555550123", t0 + 142_000, { replyTo: "m1" });

  const lines = groupLines(store.db, nameOf, ["m4"]);
  expect(lines.map(line => line.id)).toEqual(["m1", "m2", "reply:1:a", "m4"]);
  const item = lines.at(-1)!;
  const judged = judgeState(lines, item, {
    timezone: "Asia/Dubai", working: false,
    replyTo: replyTarget(store.db, lines, "m1", nameOf),
    addressed: id => id === "m2",
  });
  expect(judged.recent_conversation).toEqual([
    "[Thu 14:01] Moni: What time r we leaving tomo",
    "[Thu 14:01] Abdullah: Robob when is that",
    "[Thu 14:02] Robob (AI assistant): Flight's EK57 tomorrow at 2:25pm. Want me to book a car?",
  ]);
  expect(judged.new_message_from).toBe("Abdullah");
  expect(judged.new_message_is_inline_reply_to).toBe("Moni: What time r we leaving tomo");
  expect(judged.previous_message_was_from).toBe("Robob (AI assistant)");
  expect(judged.minutes_since_robob_last_wrote).toBe(1);
  expect(judged.robob_last_message_asked_a_question).toBe(true);
  expect(judged.minutes_since_they_last_addressed_robob).toBe(2);

  const first = judgeState(lines, lines[0]!, { timezone: "Asia/Dubai", working: false, addressed: () => false });
  expect(first.recent_conversation).toEqual([]);
  expect(first.minutes_since_robob_last_wrote).toBeNull();
  expect(first).not.toHaveProperty("new_message_is_inline_reply_to");
  // History stops at the newest row being judged.
  expect(groupLines(store.db, nameOf, ["m2"]).map(line => line.id)).toEqual(["m1", "m2"]);
});

test("a backlog's oldest message is judged with the messages that came before it", () => {
  const store = new Store(":memory:");
  stores.push(store);
  const t0 = Date.parse("2026-10-22T10:00:00Z");
  const nameOf = () => "Moni";
  for (let n = 0; n < 150; n += 1) {
    store.acceptInbound(`m${n}`, { id: `m${n}`, text: `line ${n}`, sender: "+971585933213", attachments: [], isAudioMessage: false, receivedAt: t0 + n * 1_000 });
  }
  // Sent long before the window starts: it must not look like the line just before m70.
  store.enqueue({ id: "reply:1:old", kind: "conversation", text: "old answer", sessionId: "s", generation: 1 });
  store.outboxState("reply:1:old", "sent", "robob-old");
  store.set("sent-at:reply:1:old", t0 - 60_000);
  const backlog = Array.from({ length: 80 }, (_, n) => `m${n + 70}`);
  const lines = groupLines(store.db, nameOf, backlog);
  expect(lines[0]!.id).toBe("m10");
  expect(lines.at(-1)!.id).toBe("m149");
  expect(lines.some(line => line.robob)).toBe(false);
  const judged = judgeState(lines, lines.find(line => line.id === "m70")!, { timezone: "Asia/Dubai", working: false, addressed: () => false });
  expect(judged.recent_conversation.at(-1)).toEndWith("Moni: line 69");
  expect(judged.recent_conversation).toHaveLength(15);
  expect(judged.minutes_since_robob_last_wrote).toBeNull();
});

test("Robob's question stays in view after a run of commands, a busy outbox and a reply sent after the row", () => {
  const store = new Store(":memory:");
  stores.push(store);
  const t0 = Date.parse("2026-10-22T10:00:00Z");
  const nameOf = () => "Moni";
  const row = (id: string, text: string, at: number) =>
    store.acceptInbound(id, { id, text, sender: "+971585933213", attachments: [], isAudioMessage: false, receivedAt: at });
  row("m0", "can you find us a table for 8", t0);
  // Sixty commands fill the window, so no person's line is left in it before m1.
  for (let n = 0; n < 60; n += 1) row(`c${n}`, "/status", t0 + 2_000 + n);
  store.enqueue({ id: "reply:1:q", kind: "conversation", text: "Zuma or Coya?", sessionId: "s", generation: 1 });
  store.outboxState("reply:1:q", "sent", "robob-q");
  store.set("sent-at:reply:1:q", t0 + 3_000);
  // Robob's queue is busy with controls that never went out.
  for (let n = 0; n < 250; n += 1) store.enqueue({ id: `ctl:${n}`, kind: "control", text: "x", sessionId: "s", generation: 1 });
  row("m1", "zuma please", t0 + 5_000);
  store.enqueue({ id: "reply:1:later", kind: "conversation", text: "Booked.", sessionId: "s", generation: 1 });
  store.outboxState("reply:1:later", "sent", "robob-later");
  store.set("sent-at:reply:1:later", t0 + 9_000);

  const lines = groupLines(store.db, nameOf, ["m1"]);
  expect(lines.map(line => line.id)).toEqual(["reply:1:q", "m1"]);
  const judged = judgeState(lines, lines.at(-1)!, { timezone: "Asia/Dubai", working: false, addressed: () => false });
  expect(judged.robob_last_message_asked_a_question).toBe(true);
  expect(judged.previous_message_was_from).toBe("Robob (AI assistant)");
});

test("a late delivery sits where it was sent, and Robob's same-millisecond messages keep their order", () => {
  const store = new Store(":memory:");
  stores.push(store);
  const t0 = Date.parse("2026-10-22T10:00:00Z");
  const nameOf = () => "Moni";
  const row = (id: string, text: string, receivedAt: number, sentAt?: number) =>
    store.acceptInbound(id, { id, text, sender: "+971585933213", attachments: [], isAudioMessage: false, receivedAt, ...(sentAt === undefined ? {} : { sentAt }) });
  for (const id of ["reply:1:a", "reply:1:b"]) {
    store.enqueue({ id, kind: "conversation", text: id.endsWith("a") ? "first" : "second?", sessionId: "s", generation: 1 });
    store.outboxState(id, "sent", `robob-${id}`);
    store.set(`sent-at:${id}`, t0 + 2_000);
  }
  // m1 was written before Robob's messages but reached the bridge together with m2.
  row("m1", "earlier thought", t0 + 10_000, t0);
  row("m2", "yes", t0 + 10_000, t0 + 5_000);
  expect(groupLines(store.db, nameOf, ["m2"]).map(line => line.id)).toEqual(["m1", "reply:1:a", "reply:1:b", "m2"]);
});

test("an old row with no time yet is placed at the judging time, after the question it answers", () => {
  const store = new Store(":memory:");
  stores.push(store);
  const t0 = Date.parse("2026-10-22T10:00:00Z");
  store.acceptInbound("m0", { id: "m0", text: "can you find us a table for 8", sender: "+971585933213", attachments: [], isAudioMessage: false, receivedAt: t0 });
  store.enqueue({ id: "reply:1:q", kind: "conversation", text: "Zuma or Coya?", sessionId: "s", generation: 1 });
  store.outboxState("reply:1:q", "sent", "robob-q");
  store.set("sent-at:reply:1:q", t0 + 3_000);
  store.acceptInbound("m1", { id: "m1", text: "zuma please", sender: "+971585933213", attachments: [], isAudioMessage: false });

  const lines = groupLines(store.db, () => "Moni", ["m1"], t0 + 5_000);
  expect(lines.map(line => [line.id, line.at])).toEqual([["m0", t0], ["reply:1:q", t0 + 3_000], ["m1", t0 + 5_000]]);
  expect(judgeState(lines, lines.at(-1)!, { timezone: "Asia/Dubai", working: false, addressed: () => false }).robob_last_message_asked_a_question).toBe(true);
});

test("an untimed row stays ahead of a later row that has a time", () => {
  const store = new Store(":memory:");
  stores.push(store);
  const t0 = Date.parse("2026-10-22T10:00:00Z");
  store.enqueue({ id: "reply:1:q", kind: "conversation", text: "Zuma or Coya?", sessionId: "s", generation: 1 });
  store.outboxState("reply:1:q", "sent", "robob-q");
  store.set("sent-at:reply:1:q", t0);
  store.acceptInbound("m1", { id: "m1", text: "zuma please", sender: "+971585933213", attachments: [], isAudioMessage: false });
  store.acceptInbound("m2", { id: "m2", text: "no, coya instead", sender: "+971585933213", attachments: [], isAudioMessage: false, receivedAt: t0 + 6_000 });

  const lines = groupLines(store.db, () => "Moni", ["m1", "m2"], t0 + 10_000);
  expect(lines.map(line => [line.id, line.at])).toEqual([["reply:1:q", t0], ["m1", t0 + 6_000], ["m2", t0 + 6_000]]);
  // A replay passes no judging time, so it leaves the untimed row out rather than guess.
  expect(groupLines(store.db, () => "Moni", ["m1", "m2"]).map(line => line.id)).toEqual(["reply:1:q", "m2"]);
});

test("a send time that isn't a whole number never puts a message in the history", () => {
  const store = new Store(":memory:");
  stores.push(store);
  const t0 = Date.parse("2026-10-22T10:00:00Z");
  const sent = (id: string, at: unknown) => {
    store.enqueue({ id, kind: "conversation", text: id, sessionId: "s", generation: 1 });
    store.outboxState(id, "sent", `robob-${id}`);
    store.set(`sent-at:${id}`, at);
  };
  sent("reply:1:null", null);
  sent("reply:1:text", "soon");
  sent("reply:1:zero", 0);
  sent("reply:1:half", t0 + 0.5);
  sent("reply:1:ok", t0 + 1_000);
  store.acceptInbound("m1", { id: "m1", text: "ok", sender: "+971585933213", attachments: [], isAudioMessage: false, receivedAt: t0 + 2_000 });
  expect(groupLines(store.db, () => "Moni", ["m1"]).map(line => line.id)).toEqual(["reply:1:ok", "m1"]);
});

test("an unknown guest is labelled for the judge without their full number", () => {
  expect(speakerName({ name: "+447700900999", role: "guest" }, "+447700900999")).toBe("Guest …0999");
  expect(speakerName({ name: "Tom", role: "guest" }, "+447700900123")).toBe("Tom");
  expect(speakerName({ name: "Moni", role: "admin" }, "+971585933213")).toBe("Moni");
});
