import { afterEach, expect, test } from "bun:test";
import { AgentBus, type AgentAnswerReceipt, type AgentBusDeps } from "../src/agent-bus.ts";
import type { ChatInfo } from "../src/chats.ts";
import { chatKey } from "../src/line.ts";
import { Store } from "../src/store.ts";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const infos: ChatInfo[] = [
  { slug: "owner", title: "Abdullah", kind: "owner", key: chatKey.dm("owner") },
  { slug: "moni", title: "Moni", kind: "dm", key: chatKey.dm("moni") },
  { slug: "sam", title: "Sam", kind: "dm", key: chatKey.dm("sam") },
  { slug: "guest", title: "Guest", kind: "dm", key: chatKey.dm("guest") },
  { slug: "group-family", title: "Family", kind: "group", key: chatKey.group("family") },
  { slug: "group-work", title: "Work", kind: "group", key: chatKey.group("work") },
];
function setup() {
  const store = new Store(":memory:"); stores.push(store);
  let now = 1_000;
  let fail = false;
  let failAfter = false;
  let failedSlug: string | undefined;
  const wakes: { slug: string; text: string; key: string; receipt?: AgentAnswerReceipt }[] = [];
  const logs: [string, string | undefined][] = [];
  const deps: AgentBusDeps = {
    db: store.db, forSession: session => infos.find(chat => session === `session-${chat.slug}`),
    bySlug: slug => infos.find(chat => chat.slug === slug), isAdmin: chat => chat.slug === "moni",
    adminGroup: (caller, target) => caller.slug === "moni" && target.slug === "group-family",
    groupMembers: () => ["Abdullah", "Moni", "Sam"],
    deliver: (target, text, key, receipt) => {
      if (fail || target.slug === failedSlug) throw new Error("delivery unavailable");
      if (!wakes.some(wake => wake.key === key)) wakes.push({ slug: target.slug, text, key, receipt });
      if (failAfter) throw new Error("crash after target insert");
    },
    receipt: (target, key) => wakes.find(wake => wake.slug === target.slug && wake.key === key)?.receipt,
    log: (event, code) => { logs.push([event, code]); }, now: () => now,
  };
  const bus = new AgentBus(deps);
  const ask = (from = "owner", to = "moni", key = "key", parent?: string) =>
    bus.ask({ sessionId: `session-${from}`, to, text: "PRIVATE_QUESTION", dedupeKey: key, ...(parent ? { parent } : {}) });
  const id = (outcome: ReturnType<typeof ask>) => (outcome.body as { id: string }).id;
  const answer = (request: string, status?: "done" | "declined" | "pending", from = "moni") =>
    bus.answer({ sessionId: `session-${from}`, request, text: "PRIVATE_ANSWER", status });
  return { store, bus, deps, wakes, logs, ask, id, answer, time: (at: number) => { now = at; }, fail: (value: boolean) => { fail = value; }, failAfter: (value: boolean) => { failAfter = value; },
    failSlug: (slug: string | undefined) => { failedSlug = slug; } };
}

const pairs = infos.flatMap(from => infos.map(to => ({ from: from.slug, to: to.slug,
  expected: from.slug === to.slug ? 400 : from.slug === "owner" || to.slug === "owner"
    || from.kind === "group" && to.slug === "moni" || from.slug === "moni" && to.slug === "group-family" ? 202 : 403 })));
test.each(pairs)("pair $from > $to is $expected", ({ from, to, expected }) => {
  const env = setup();
  expect(env.ask(from, to).status).toBe(expected);
  expect(env.wakes.length).toBe(expected === 202 ? 1 : 0);
  expect(env.logs[0]?.[0]).toBe(expected === 202 ? "agent-ask" : "agent-ask-refused");
});

test("missing sessions/targets are refused without logging supplied values", () => {
  const env = setup();
  expect(env.ask("PRIVATE_SESSION").status).toBe(409);
  expect(env.ask("owner", "PRIVATE_TARGET").status).toBe(404);
  expect(JSON.stringify(env.logs)).not.toContain("PRIVATE");
});

test.each(["owner", "moni"])("group requests tell %s the audience and return the answer only to the group assistant", to => {
  const env = setup();
  const id = env.id(env.ask("group-family", to));
  expect(env.wakes[0]?.text).toContain('This answer will be posted in the group "Family" (members: Abdullah, Moni, Sam).');
  expect(env.wakes[0]?.text).toContain("Share only what is fine for everyone there to read.");
  expect(env.wakes[0]?.text).toContain("If it's private and the person it belongs to isn't the one asking, say what can be shared instead.");
  expect(env.answer(id, "done", to).status).toBe(202);
  expect(env.wakes.map(wake => wake.slug)).toEqual([to, "group-family"]);
  expect(env.wakes[1]?.text).toEndWith("\nPRIVATE_ANSWER");
  expect(env.logs[0]).toEqual(["agent-ask", `group-family>${to} hop=1 group=1`]);
  expect(JSON.stringify(env.logs)).not.toMatch(/PRIVATE|Family|Abdullah|Moni|Sam/);
});

test.each(["owner", "moni", "sam"])("%s DM requests have no group audience or group log flag", from => {
  const env = setup();
  env.ask(from, from === "owner" ? "moni" : "owner");
  expect(env.wakes[0]?.text).not.toContain("This answer will be posted in the group");
  expect(env.wakes[0]?.text).not.toContain("members:");
  expect(env.logs[0]?.[1]).not.toContain("group=1");
});

test("unknown group members are explicit and group audience survives a second hop", () => {
  const env = setup();
  env.deps.groupMembers = () => [];
  const root = env.id(env.ask("group-family", "owner"));
  expect(env.wakes[0]?.text).toContain('(members: unknown)');
  env.ask("owner", "moni", "forwarded", root);
  expect(env.wakes[1]?.text).toContain('This answer will be posted in the group "Family" (members: unknown).');
});

test("a group answering a DM request still supplies its own audience when it asks another assistant", () => {
  const env = setup();
  const root = env.id(env.ask("owner", "group-family"));
  env.ask("group-family", "moni", "followup", root);
  expect(env.wakes[1]?.text).toContain('This answer will be posted in the group "Family" (members: Abdullah, Moni, Sam).');
});

test("dedupe is caller scoped and survives a new bus; changed payload does not redeliver", () => {
  const env = setup();
  const first = env.ask(); const id = env.id(first);
  expect(first.status).toBe(202);
  const restarted = new AgentBus(env.deps);
  expect(restarted.ask({ sessionId: "session-owner", to: "sam", text: "changed", dedupeKey: "key" }))
    .toEqual({ status: 200, body: { id, created: false } });
  expect(env.wakes).toHaveLength(1);
  expect(env.id(env.ask("moni", "owner"))).not.toBe(id);
  expect(env.wakes[0]?.text).toContain(`agent-answer --request ${id}`);
  expect(env.wakes[0]?.text).toContain(`--parent ${id}`);
  expect(env.wakes[0]?.text).toEndWith("\nPRIVATE_QUESTION");
});

test("parent must exist and belong to the handling chat; chain refuses loops and third hops", () => {
  const env = setup();
  const first = env.id(env.ask("group-family", "owner", "root"));
  expect(env.ask("owner", "moni", "missing", "areq_missing").status).toBe(404);
  expect(env.ask("moni", "owner", "forged", first).status).toBe(403);
  expect(env.ask("owner", "group-family", "loop", first)).toEqual({ status: 422, body: { error: "loop" } });
  const second = env.ask("owner", "moni", "child", first);
  expect(second.status).toBe(202);
  expect(env.wakes[1]?.text).toContain("hop 2");
  expect(env.ask("moni", "owner", "third", env.id(second))).toEqual({ status: 422, body: { error: "hop limit" } });
});

test.each(["done", "declined"] as const)("only the target may answer and %s is final", status => {
  const env = setup(); const id = env.id(env.ask());
  expect(env.answer(id, status, "owner").status).toBe(403);
  expect(env.answer(id, status, "guest").status).toBe(403);
  expect(env.answer(id, status, "gone").status).toBe(409);
  expect(env.answer("missing", status).status).toBe(404);
  env.time(1_250);
  expect(env.answer(id, status).status).toBe(202);
  expect(env.answer(id).status).toBe(409);
  expect(env.answer(id, "pending").status).toBe(409);
  expect(env.wakes).toHaveLength(2);
  expect(env.wakes[1]?.slug).toBe("owner");
  expect(env.logs.at(-1)).toEqual(["agent-answer", `${id} ${status} ms=250`]);
});

test("pending is sent once, then a final answer closes the request", () => {
  const env = setup(); const id = env.id(env.ask());
  expect(env.answer(id, "pending").status).toBe(202);
  expect(env.answer(id, "pending").status).toBe(409);
  expect(env.answer(id).status).toBe(202);
  expect(env.wakes).toHaveLength(3);
});

test.each([false, true])("timeout is sent once, late final delivered, pending first = %s", pending => {
  const env = setup(); const id = env.id(env.ask());
  if (pending) env.answer(id, "pending");
  env.time(601_000); env.bus.sweep();
  expect(env.logs.filter(([event]) => event === "agent-timeout")).toHaveLength(0);
  env.time(601_001); env.bus.sweep(); env.bus.sweep();
  expect(env.logs.filter(([event]) => event === "agent-timeout")).toEqual([["agent-timeout", id]]);
  expect(env.wakes.at(-1)?.text).toContain("no answer for 10 minutes");
  expect(env.answer(id, "pending").status).toBe(pending ? 409 : 202);
  env.bus.sweep();
  expect(env.answer(id)).toEqual({ status: 202, body: { id, status: "done_late" } });
  expect(env.answer(id).status).toBe(409);
  expect(env.logs.filter(([event]) => event === "agent-timeout")).toHaveLength(1);
});

test("completed requests never time out", () => {
  const env = setup(); env.answer(env.id(env.ask()));
  env.time(999_999); env.bus.sweep(); expect(env.wakes).toHaveLength(2);
});

test("failed request delivery retains metadata and recovers with the same key", () => {
  const env = setup(); env.fail(true);
  expect(() => env.ask()).toThrow("delivery unavailable");
  expect(env.store.db.query("SELECT * FROM agent_requests").all()).toHaveLength(1);
  env.fail(false); const retry = env.ask();
  expect(retry.status).toBe(200); expect(env.wakes).toHaveLength(1);
  expect(env.answer(env.id(retry)).status).toBe(202);
});

test("recovery cannot redirect an old request through a newly allowed target", () => {
  const env = setup(); env.fail(true);
  expect(() => env.ask("moni", "group-family")).toThrow();
  env.fail(false); env.deps.isAdmin = () => false;
  expect(env.ask("moni", "owner").status).toBe(200);
  expect(env.wakes).toHaveLength(0);
  expect(env.ask("moni", "group-family").status).toBe(403);
});

test.each(["ask", "answer", "timeout"])("failure after %s wake insertion converges on retry", operation => {
  const env = setup();
  let id: string;
  if (operation === "ask") {
    env.failAfter(true); expect(() => env.ask()).toThrow("crash after target insert");
    env.failAfter(false); id = env.id(env.ask()); expect(env.wakes).toHaveLength(1);
  } else {
    id = env.id(env.ask()); env.failAfter(true);
    if (operation === "answer") expect(() => env.answer(id)).toThrow("crash after target insert");
    else { env.time(601_001); env.bus.sweep(); }
    env.failAfter(false);
    if (operation === "timeout") env.bus.sweep();
  }
  env.time(601_001);
  env.bus.sweep();
  expect(env.answer(id).status).toBe(operation === "answer" ? 409 : 202);
  if (operation === "answer") {
    expect(env.logs.filter(([event]) => event === "agent-timeout")).toHaveLength(0);
    const row = env.store.db.query<{ status: string }, [string]>("SELECT status FROM agent_requests WHERE id = ?").get(id);
    expect(row?.status).toBe("done");
  }
  expect(env.wakes.filter(wake => wake.key.includes(":final"))).toHaveLength(1);
  expect(env.answer(id).status).toBe(409);
});

test("a late answer before the sweep gets timeout and done_late", () => {
  const env = setup(); const id = env.id(env.ask()); env.time(601_001);
  expect(env.answer(id)).toEqual({ status: 202, body: { id, status: "done_late" } });
  expect(env.wakes[1]?.key).toBe(`agent-timeout:${id}`);
  expect(env.wakes[2]?.key).toBe(`agent-answer:${id}:final`);
  env.bus.sweep(); expect(env.wakes).toHaveLength(3);
});

test("failed timeout delivery leaves that row retryable and other chats still time out", () => {
  const env = setup(); const first = env.id(env.ask("moni", "owner", "first"));
  const second = env.id(env.ask("sam", "owner", "second"));
  env.time(601_001); env.failSlug("moni"); env.bus.sweep();
  expect(env.logs).toContainEqual(["agent-timeout-failed", first]);
  expect(env.logs).toContainEqual(["agent-timeout", second]);
  env.failSlug(undefined); env.bus.sweep();
  expect(env.logs.filter(([event]) => event === "agent-timeout")).toHaveLength(2);
});

test("table and event log retain metadata only; lists are scoped and capped at 20", () => {
  const env = setup();
  for (let i = 0; i < 25; i++) env.ask("owner", "moni", `PRIVATE_KEY_${i}`);
  const id = env.id(env.ask("sam", "owner", "sam")); env.answer(id, "done", "owner");
  const row = env.store.db.query("SELECT * FROM agent_requests WHERE id = ?").get(id);
  expect(row).toEqual({ id, from_slug: "sam", to_slug: "owner", parent_id: null, hop: 1, status: "done",
    text_chars: "PRIVATE_QUESTION".length, answer_chars: "PRIVATE_ANSWER".length, created_at: 1000, answered_at: 1000, timed_out_at: null });
  expect(JSON.stringify(env.store.db.query("SELECT * FROM agent_requests").all())).not.toContain("PRIVATE");
  expect(JSON.stringify(env.logs)).not.toContain("PRIVATE");
  const rows = (who: string) => (env.bus.requests(`session-${who}`).body as { requests: { id: string }[] }).requests;
  expect(rows("owner")).toHaveLength(20); expect(rows("owner")[0]?.id).toBe(id);
  expect(rows("moni")).toHaveLength(20); expect(rows("sam")).toHaveLength(1); expect(rows("guest")).toHaveLength(0);
  expect(env.bus.requests("gone").status).toBe(409);
});
