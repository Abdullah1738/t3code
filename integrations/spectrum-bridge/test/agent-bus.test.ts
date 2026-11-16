import { afterEach, expect, test } from "bun:test";
import { AgentBus, type AgentAnswerReceipt, type AgentBusDeps } from "../src/agent-bus.ts";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAgentPolicy } from "../src/agent-policy.ts";
import type { ChatInfo } from "../src/chats.ts";
import { chatKey } from "../src/line.ts";
import { Store } from "../src/store.ts";

const stores: Store[] = [];
const dirs: string[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const infos: ChatInfo[] = [
  { slug: "owner", title: "Abdullah", kind: "owner", key: chatKey.dm("owner") },
  { slug: "moni", title: "Moni", kind: "dm", key: chatKey.dm("moni") },
  { slug: "sam", title: "Sam", kind: "dm", key: chatKey.dm("sam") },
  { slug: "guest", title: "Guest", kind: "dm", key: chatKey.dm("guest") },
  { slug: "group-family", title: "Family", kind: "group", key: chatKey.group("family") },
  { slug: "group-work", title: "Work", kind: "group", key: chatKey.group("work") },
];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "agent-policy-")); dirs.push(dir);
  const policyPath = join(dir, "agent-policy.json");
  const store = new Store(":memory:"); stores.push(store);
  let now = 1_000;
  let fail = false;
  let failAfter = false;
  let failedSlug: string | undefined;
  const wakes: { slug: string; text: string; key: string; receipt?: AgentAnswerReceipt }[] = [];
  const logs: [string, string | undefined][] = [];
  const deps: AgentBusDeps = {
    db: store.db, forSession: session => infos.find(chat => session === `session-${chat.slug}`),
    bySlug: slug => infos.find(chat => chat.slug === slug), policyPath,
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
  return { store, bus, deps, policyPath, wakes, logs, ask, id, answer, time: (at: number) => { now = at; }, fail: (value: boolean) => { fail = value; }, failAfter: (value: boolean) => { failAfter = value; },
    failSlug: (slug: string | undefined) => { failedSlug = slug; } };
}

const pairs = infos.flatMap(from => infos.map(to => ({ from: from.slug, to: to.slug,
  expected: from.slug === to.slug ? 400 : from.slug === "owner" && to.slug === "moni"
    || from.slug === "moni" && to.slug === "owner" || from.kind === "group" && ["moni", "owner"].includes(to.slug) ? 202 : 403 })));
test.each(pairs)("pair $from > $to is $expected", ({ from, to, expected }) => {
  const env = setup();
  expect(env.ask(from, to).status).toBe(expected);
  expect(env.wakes.length).toBe(expected === 202 ? 1 : 0);
  expect(env.logs[1]?.[0]).toBe(expected === 202 ? "agent-ask" : "agent-ask-refused");
});

test("missing sessions/targets are refused without logging supplied values", () => {
  const env = setup();
  expect(env.ask("PRIVATE_SESSION").status).toBe(409);
  expect(env.ask("owner", "PRIVATE_TARGET").status).toBe(404);
  expect(JSON.stringify(env.logs)).not.toContain("PRIVATE");
});

test.each(["single roster", "newer blank roster", "superseded roster"])("repeated audience reads preserve all members: %s", kind => {
  const env = setup();
  if (kind === "superseded roster") env.store.acceptInbound("old", { sender: "old", participants: ["old"] });
  env.store.acceptInbound("roster", { sender: "owner", participants: ["owner", "moni", "silent"] });
  env.store.acceptInbound("new-member", { sender: "sam" });
  if (kind === "newer blank roster") env.store.acceptInbound("blank", { sender: "owner", participants: ["\t"] });
  const expected = ["moni", "owner", "sam", "silent"];
  for (let read = 0; read < 3; read++) expect(env.store.groupAudience().sort()).toEqual(expected);
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
  expect(env.logs).toContainEqual(["agent-ask", `group-family>${to} hop=1 group=1`]);
  expect(JSON.stringify(env.logs)).not.toMatch(/PRIVATE|Family|Abdullah|Moni|Sam/);
});

test.each(["owner", "moni", "sam"])("%s DM requests have no group audience or group log flag", from => {
  const env = setup();
  if (from === "sam") writeFileSync(env.policyPath, JSON.stringify({ ...defaultAgentPolicy(),
    pairs: [...defaultAgentPolicy().pairs, { from: "sam", to: "owner", approval: "none" }] }));
  expect(env.ask(from, from === "owner" ? "moni" : "owner").status).toBe(202);
  expect(env.wakes[0]?.text).not.toContain("This answer will be posted in the group");
  expect(env.wakes[0]?.text).not.toContain("members:");
  expect(env.logs.find(([event]) => event === "agent-ask")?.[1]).not.toContain("group=1");
});

test("unknown group members are explicit and group audience survives a second hop", () => {
  const env = setup();
  env.deps.groupMembers = () => [];
  const root = env.id(env.ask("group-family", "owner"));
  expect(env.wakes[0]?.text).toContain('(members: unknown)');
  env.ask("owner", "moni", "forwarded", root);
  expect(env.wakes[1]?.text).toContain('This answer will be posted in the group "Family" (members: unknown).');
});

test.each(["owner", "moni"])("group audience survives the second hop through %s alongside its policy", via => {
  const env = setup();
  const rule = "tell me when Moni orders";
  expect(env.bus.notifyRules({ sessionId: "session-owner", action: "add", text: rule }).status).toBe(200);
  const first = env.ask("group-family", via);
  expect(first.status).toBe(202);
  const to = via === "owner" ? "moni" : "owner";
  const second = env.ask(via, to, "forwarded", env.id(first));
  expect(second.status).toBe(202);
  const header = env.wakes[1]!.text;
  expect(header).toContain('This answer will be posted in the group "Family" (members: Abdullah, Moni, Sam). Share only what is fine for everyone there to read. If it\'s private and the person it belongs to isn\'t the one asking, say what can be shared instead.');
  expect(header).not.toContain("This answer will be posted in a group.");
  if (via === "owner") {
    expect(header).toContain("Answer anything the owner's agent asks, in full. Send the answer back through agent-answer.");
    expect(header).not.toContain(rule);
  } else {
    expect(header).toContain("Exception: installing or downloading anything onto the Mac.");
    expect(header).toContain("Use --status pending only for this install/download exception");
    expect(header).toContain(`owner-go record-delegated --principal moni --bus-request ${env.id(second)}`);
    expect(header).toContain(rule);
  }
  expect(env.logs).toContainEqual(["agent-ask", `group-family>${via} hop=1 group=1`]);
  expect(env.logs).toContainEqual(["agent-ask", `${via}>${to} hop=2`]);
  expect(JSON.stringify(env.logs)).not.toMatch(/PRIVATE|Family|Abdullah|Moni|Sam|tell me/);
});

test("a group answering a DM request still supplies its own audience when it asks another assistant", () => {
  const env = setup();
  writeFileSync(env.policyPath, JSON.stringify({ ...defaultAgentPolicy(),
    pairs: [...defaultAgentPolicy().pairs, { from: "owner", to: "group-family", approval: "none" }] }));
  const first = env.ask("owner", "group-family");
  expect(first.status).toBe(202);
  expect(env.ask("group-family", "moni", "followup", env.id(first)).status).toBe(202);
  expect(env.wakes[1]?.text).toContain('This answer will be posted in the group "Family" (members: Abdullah, Moni, Sam).');
});

test("dedupe is caller scoped and survives a new bus; changed payload does not redeliver", () => {
  const env = setup();
  const first = env.ask(); const id = env.id(first);
  expect(first.status).toBe(202);
  const restarted = new AgentBus(env.deps);
  expect(restarted.ask({ sessionId: "session-owner", to: "moni", text: "changed", dedupeKey: "key" }))
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
  writeFileSync(env.policyPath, JSON.stringify({ ...defaultAgentPolicy(), pairs: [...defaultAgentPolicy().pairs, { from: "owner", to: "group-family", approval: "none" }] }));
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
  writeFileSync(env.policyPath, JSON.stringify({ ...defaultAgentPolicy(), pairs: [...defaultAgentPolicy().pairs, { from: "moni", to: "group-family", approval: "none" }] }));
  expect(() => env.ask("moni", "group-family")).toThrow();
  writeFileSync(env.policyPath, JSON.stringify(defaultAgentPolicy()));
  env.fail(false);
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
  const second = env.id(env.ask("group-family", "owner", "second"));
  env.time(601_001); env.failSlug("moni"); env.bus.sweep();
  expect(env.logs).toContainEqual(["agent-timeout-failed", first]);
  expect(env.logs).toContainEqual(["agent-timeout", second]);
  env.failSlug(undefined); env.bus.sweep();
  expect(env.logs.filter(([event]) => event === "agent-timeout")).toHaveLength(2);
});

test("table and event log retain metadata only; lists are scoped and capped at 20", () => {
  const env = setup();
  for (let i = 0; i < 25; i++) env.ask("owner", "moni", `PRIVATE_KEY_${i}`);
  const id = env.id(env.ask("group-family", "owner", "group")); env.answer(id, "done", "owner");
  const row = env.store.db.query("SELECT * FROM agent_requests WHERE id = ?").get(id);
  expect(row).toEqual({ id, from_slug: "group-family", to_slug: "owner", parent_id: null, hop: 1, status: "done",
    text_chars: "PRIVATE_QUESTION".length, answer_chars: "PRIVATE_ANSWER".length, created_at: 1000, answered_at: 1000, timed_out_at: null });
  expect(JSON.stringify(env.store.db.query("SELECT * FROM agent_requests").all())).not.toContain("PRIVATE");
  expect(JSON.stringify(env.logs)).not.toContain("PRIVATE");
  const rows = (who: string) => (env.bus.requests(`session-${who}`).body as { requests: { id: string }[] }).requests;
  expect(rows("owner")).toHaveLength(20); expect(rows("owner")[0]?.id).toBe(id);
  expect(rows("moni")).toHaveLength(20); expect(rows("group-family")).toHaveLength(1); expect(rows("guest")).toHaveLength(0);
  expect(env.bus.requests("gone").status).toBe(409);
});

test("missing policy loads defaults and an override reloads pairs", () => {
  const env = setup();
  expect(env.logs[0]).toEqual(["agent-policy-loaded", "pairs=4 rules=0"]);
  expect(env.ask("guest", "owner").status).toBe(403);
  writeFileSync(env.policyPath, JSON.stringify({ pairs: [{ from: "sam", to: "owner", approval: "none" }], notify: [] }));
  expect(env.ask("sam", "owner").status).toBe(202);
  expect(env.ask("moni", "owner").status).toBe(403);
  expect(env.logs).toContainEqual(["agent-policy-loaded", "pairs=1 rules=0"]);
});

test.each([
  "{", "missing", "null", "[]", "{}",
  JSON.stringify({ ...defaultAgentPolicy(), pairs: [{ from: "*", to: "owner", approval: "none" }] }),
  JSON.stringify({ ...defaultAgentPolicy(), pairs: [{ from: "moni", to: "owner", approval: "none" }] }),
  JSON.stringify({ ...defaultAgentPolicy(), pairs: [{ from: "group:*", to: "moni", approval: "none" }] }),
  JSON.stringify({ ...defaultAgentPolicy(), notify: [{ id: 1, text: "" }] }),
  JSON.stringify({ ...defaultAgentPolicy(), notify: [{ id: 1, text: "x" }, { id: 1, text: "y" }] }),
])("invalid policy falls back safely without overwriting: %s", source => {
  const env = setup(); writeFileSync(env.policyPath, source);
  expect(env.ask("guest", "owner").status).toBe(403);
  expect(env.ask("moni", "owner").status).toBe(202);
  expect(env.logs).toContainEqual(["agent-policy-invalid", undefined]);
  expect(env.wakes[0]?.text).toContain("Exception: installing or downloading anything onto the Mac.");
  expect(env.bus.notifyRules({ sessionId: "session-owner", action: "add", text: "rule" }).status).toBe(409);
  expect(readFileSync(env.policyPath, "utf8")).toBe(source);
});

test("notify edits persist privately, preserve pairs, and appear in Moni's request header", () => {
  const env = setup();
  for (const sessionId of ["session-moni", "session-group-family", "session-guest"]) {
    for (const action of ["add", "list", "rm"] as const) {
      expect(env.bus.notifyRules({ sessionId, action, text: "PRIVATE_RULE", id: 1 }).status).toBe(403);
    }
  }
  const result = env.bus.notifyRules({ sessionId: "session-owner", action: "add", text: "tell me when Moni orders" });
  const rule = (result.body as { rule: { id: number; text: string } }).rule;
  expect(result.status).toBe(200);
  expect(statSync(env.policyPath).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(env.policyPath, "utf8"))).toEqual({ ...defaultAgentPolicy(), notify: [rule] });
  expect(env.bus.notifyRules({ sessionId: "session-owner", action: "add", text: rule.text }).body).toEqual(result.body);
  expect(new AgentBus(env.deps).notifyRules({ sessionId: "session-owner", action: "list" }).body).toEqual({ notify: [rule] });
  env.ask("moni", "owner");
  const header = env.wakes[0]!.text;
  for (const text of ["Moni's requests need no approval from Abdullah (his rule). Do it.", "installing or downloading anything onto the Mac",
    "message him in this chat", "status pending until he decides", "Spending for Moni follows the owner-go rule; see below",
    "owner-go record-delegated --principal moni --bus-request", "owner-go verify before checkout", `${rule.id}: ${rule.text}`,
    "If this request matches one of these, tell Abdullah in one line in this chat after it's done. Otherwise don't mention it."]) expect(header).toContain(text);
  expect(env.bus.notifyRules({ sessionId: "session-owner", action: "rm", id: rule.id }).status).toBe(200);
  expect(env.bus.notifyRules({ sessionId: "session-owner", action: "rm", id: rule.id }).status).toBe(404);
  expect(env.logs).toContainEqual(["notify-rule-added", `${rule.id}`]);
  expect(env.logs).toContainEqual(["notify-rule-removed", `${rule.id}`]);
  expect(JSON.stringify(env.logs)).not.toContain(rule.text);
  env.ask("moni", "owner", "after-remove");
  expect(env.wakes.at(-1)?.text).not.toContain(rule.text);
});

test("full answers and group audiences are scoped to the matching pair", () => {
  const env = setup(); env.ask();
  expect(env.wakes[0]?.text).toContain("Answer anything the owner's agent asks, in full.");
  env.ask("group-family", "moni", "group");
  expect(env.wakes[1]?.text).toContain('This answer will be posted in the group "Family" (members: Abdullah, Moni, Sam).');
  for (const text of ["in full", "no approval from Abdullah", "notify rules"]) expect(env.wakes[1]?.text).not.toContain(text);
});

test.each([false, true])("install/download audit uses persisted pending, late = %s", late => {
  const env = setup(); const id = env.id(env.ask("moni", "owner"));
  if (late) env.time(601_001);
  expect(env.answer(id, "pending", "owner").status).toBe(202);
  expect(env.store.db.query<{ status: string }, [string]>("SELECT status FROM agent_requests WHERE id = ?").get(id)?.status).toBe("pending");
  expect(env.answer(id, "pending", "owner").status).toBe(409);
  expect(env.logs.filter(([event]) => event === "agent-needs-owner")).toEqual([["agent-needs-owner", `${id} required=true`]]);
  env.answer(id, "done", "owner");
  expect(env.logs.filter(([event]) => event === "agent-needs-owner")).toHaveLength(1);
  const other = env.id(env.ask("moni", "owner", "no-install"));
  env.answer(other, "done", "owner");
  expect(env.logs).toContainEqual(["agent-needs-owner", `${other} required=false`]);
});

test("a pending wake committed before rollback is audited from repaired state", () => {
  const env = setup(); const id = env.id(env.ask("moni", "owner"));
  env.failAfter(true);
  expect(() => env.answer(id, "pending", "owner")).toThrow();
  expect(env.logs.filter(([event]) => event === "agent-needs-owner")).toHaveLength(0);
  env.failAfter(false);
  expect(env.answer(id, "pending", "owner").status).toBe(409);
  expect(env.logs.filter(([event]) => event === "agent-needs-owner")).toEqual([["agent-needs-owner", `${id} required=true`]]);
});
