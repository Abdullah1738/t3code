import { afterEach, expect, spyOn, test } from "bun:test";
import { ActiveRoster } from "../src/active-roster.ts";
import { ControlClient, type PendingRequest, type ThreadDetail } from "../src/control.ts";
import { RobobBackend } from "../src/robob.ts";
import { Router } from "../src/router.ts";
import { Store } from "../src/store.ts";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.db.close(); });

const question: PendingRequest = { requestId: "question", kind: "question", requestKind: "user_input", canRespond: true,
  questions: [{ id: "pick", header: "Pick", question: "Which?", options: [{ label: "A" }] }] };
const row = (id: string, extra: Partial<ThreadDetail> = {}): ThreadDetail => ({
  threadId: id, projectId: "chats", title: id, state: "queued", status: "queued", origin: "imessage",
  nativeSessionId: null, runtimeMode: "full-access", parentThreadId: "owner", rootThreadId: "owner",
  worktreePath: "/chats", pendingRequest: null, pendingRequests: [], run: null, recentRuns: [],
  createdAt: null, updatedAt: null, activeRunId: "run-1", latestRunId: "run-1", ...extra,
});

function fixture(now: () => number = Date.now) {
  const server = { child: row("child") };
  const client = new ControlClient({ url: "http://127.0.0.1:1", token: "test" });
  const lists = spyOn(client, "listThreads").mockImplementation(async () => ({ total: 1, threads: [structuredClone(server.child)] }));
  const detail = spyOn(client, "thread").mockImplementation(async id => ({ thread: id === "owner"
    ? row("owner", { state: "idle", status: "idle", parentThreadId: null, rootThreadId: "owner" }) : structuredClone(server.child) }));
  const roster = new ActiveRoster(client, now); roster.streamState(true);
  const backend = new RobobBackend({ chatRoot: "/chats", client, activeRoster: roster, finishes: () => new Map() });
  const store = new Store(":memory:"); stores.push(store);
  const router = new Router(store, backend, { async typing() {}, async read() {}, async downloadAttachment() { throw new Error("unused"); } }, {
    owner: "+15555550123", chatGuid: "dm:+15555550123", timezone: "UTC", skillPath: "/skills", alertSkillPath: "/alert", alertSocketPath: "/alert.sock",
    context: { chat: { key: "dm:+15555550123", slug: "owner", title: "Owner", kind: "owner" },
      roleOf: () => ({ name: "Owner", role: "owner" }), typing: () => false, react: async () => {} },
  });
  const turn = { id: "owner", directory: "/chats", generation: 1, messageId: "msg_work", startedAt: Date.now(), phase: "running" as const };
  const scan = async () => router["requests"](turn, await backend.statuses(true), true);
  const reads = () => lists.mock.calls.filter(([args]) => args?.active).length;
  return { server, client, detail, lists, roster, backend, router, store, turn, scan, reads };
}

const bootstrapRaces = (["startup", "retry"] as const).flatMap(stage =>
  ([true, false] as const).flatMap(listed => (["running", "question"] as const).flatMap(change =>
    (["detail-first", "list-first"] as const).map(order => ({ stage, listed, change, order })))));

test.each(bootstrapRaces)("bootstrap Router preflight retains $change: $stage, listed=$listed, $order", async ({ stage, listed, change, order }) => {
  let clock = 1_000;
  const f = fixture(() => clock); f.roster.streamState(false);
  f.server.child = row("child", { state: "waiting", status: "waiting", activeRunId: null });
  const older = { total: listed ? 1 : 0, threads: listed ? [structuredClone(f.server.child)] : [] };
  const snapshot = Promise.withResolvers<typeof older>(), reconciliation = Promise.withResolvers<typeof older>();
  const reconciling = Promise.withResolvers<void>();
  let activeReads = 0;
  f.lists.mockImplementation(async args => {
    if (args?.parentThreadId) return { total: 1, threads: [structuredClone(f.server.child)] };
    activeReads++;
    if (stage === "retry" && activeReads === 1) throw new Error("initial active-list deadline");
    if (activeReads === (stage === "retry" ? 2 : 1)) return snapshot.promise;
    reconciling.resolve(); return reconciliation.promise;
  });
  if (stage === "retry") await expect(f.backend.statuses(true)).rejects.toThrow("initial active-list deadline");
  // In production the initial GET starts before SSE ready; a failed attempt still has no cache.
  f.roster.event({ data: { type: "ready" } }); clock += 1_000;
  let startupFinished = false;
  const startup = f.backend.statuses(true).then(statuses => { startupFinished = true; return statuses; });
  f.server.child = change === "question"
    ? row("child", { state: "needs-input", pendingRequest: question, pendingRequests: [question] })
    : row("child", { state: "running", status: "running", activeRunId: "run-2", latestRunId: "run-2" });
  const detail = Promise.withResolvers<{ thread: ThreadDetail }>(), entered = Promise.withResolvers<void>();
  const canonical = structuredClone(f.server.child);
  f.detail.mockImplementationOnce(async () => { entered.resolve(); return detail.promise; });
  f.store.set("route", { id: f.turn.id, directory: f.turn.directory, generation: f.turn.generation });
  f.store.set("activeTurn", f.turn);
  const oldQuestion = { id: "old-question", sessionID: "child", title: "Question", questions: [] };
  f.store.set("pendingApprovals", [{ id: oldQuestion.id, sessionId: "owner", generation: 1, kind: "question",
    signature: f.router["signature"](oldQuestion), operationId: "request:1:old-question", state: "pending",
    requestSessionId: "child", requestDirectory: "/chats", prompt: "request:old-question" }]);
  const preflight = f.router.beforeSend({ id: "request:old-question", kind: "control", text: "Old question", state: "pending", attempts: 0 });
  await entered.promise;
  if (order === "list-first") { snapshot.resolve(older); await startup; }
  detail.resolve({ thread: canonical }); expect(await preflight).toBe("cancel");
  expect(f.roster.isBusy("child")).toBe(true);
  if (order === "detail-first") {
    expect(f.roster.status().complete).toBe(false);
    expect(startupFinished).toBe(false);
    expect(await f.backend.statuses()).toEqual({ child: { type: "busy", root: "owner" } });
    expect(f.roster.view(new Map([["ses_owner", "owner"], ["ses_child", "child"]]))).toEqual({
      child: { type: "busy", root: "ses_owner" }, ses_child: { type: "busy", root: "ses_owner" },
    });
    snapshot.resolve(older);
  }
  await reconciling.promise;
  let admitted = 0;
  const admissions = Promise.all(Array.from({ length: 6 }, () => f.backend.statuses(true).then(statuses => { admitted++; return statuses; })));
  expect(await f.backend.statuses()).toEqual({ child: { type: "busy", root: "owner" } });
  expect(admitted).toBe(0);
  if (order === "detail-first") expect(startupFinished).toBe(false);
  reconciliation.resolve({ total: 1, threads: [canonical] }); await startup;
  for (const statuses of await admissions) expect(statuses).toEqual({ child: { type: "busy", root: "owner" } });
  const admissionScan = await f.scan();
  expect(admissionScan.map(item => item.request.id)).toEqual(change === "question" ? [question.requestId] : []);
  f.router["synchronizeRequests"](f.turn, admissionScan);
  expect(f.store.get<{ id: string; state: string }[]>("pendingApprovals")?.find(item => item.id === oldQuestion.id)?.state).toBe("expired");
  expect(f.roster.status()).toMatchObject({ complete: true, ambiguous: 1, errors: stage === "retry" ? 1 : 0 });
  expect(f.reads()).toBe(stage === "retry" ? 3 : 2);
});

test.each(["running", "question"] as const)("bootstrap %s details survive list errors without claiming completeness", async change => {
  let clock = 1_000;
  const f = fixture(() => clock);
  f.lists.mockRejectedValue(new Error("startup offline"));
  await expect(f.backend.statuses(true)).rejects.toThrow("startup offline");
  f.server.child = change === "question"
    ? row("child", { state: "needs-input", pendingRequest: question, pendingRequests: [question] })
    : row("child", { state: "running", status: "running" });
  expect(await f.backend.sessionBusy("child")).toBe(true);
  const generation = f.roster.generation;
  for (let i = 0; i < 6; i++) {
    expect(await f.backend.sessionBusy("child")).toBe(true);
    expect(await f.backend.statuses()).toEqual({ child: { type: "busy", root: "owner" } });
  }
  expect(f.roster.generation).toBe(generation);
  expect(f.roster.status()).toMatchObject({ complete: false, ambiguous: 0 });
  await expect(f.backend.statuses(true)).rejects.toThrow("startup offline");
  expect(f.reads()).toBe(1);
  clock += 1_000;
  await expect(f.backend.statuses(true)).rejects.toThrow("startup offline");
  expect(await f.backend.statuses()).toEqual({ child: { type: "busy", root: "owner" } });
  expect(f.roster.status()).toMatchObject({ complete: false, errors: 2, ambiguous: 0 });
  expect(f.reads()).toBe(2);
});

test.each(["running", "question"] as const)("an incomplete first list retains earlier %s detail evidence", async change => {
  const f = fixture();
  f.server.child = change === "question"
    ? row("child", { state: "needs-input", pendingRequest: question, pendingRequests: [question] })
    : row("child", { state: "running", status: "running" });
  expect(await f.backend.sessionBusy("child")).toBe(true);
  expect(f.reads()).toBe(0);
  f.lists.mockResolvedValue({ total: 2, threads: [row("owner", { state: "idle", parentThreadId: null })] });
  await expect(f.backend.statuses(true)).rejects.toThrow("Incomplete active family discovery");
  expect(await f.backend.statuses()).toEqual({ child: { type: "busy", root: "owner" } });
  expect(f.roster.status().complete).toBe(false);
});

test.each(["running", "question"] as const)("a first-list removal fences an older %s detail for a known idle child", async change => {
  const f = fixture();
  f.server.child = row("child", { state: "running", status: "running" });
  expect(await f.backend.sessionBusy("child")).toBe(true);
  f.server.child = row("child", { state: "idle", status: "idle", activeRunId: null });
  expect(await f.backend.sessionBusy("child")).toBe(false);
  const response = Promise.withResolvers<{ thread: ThreadDetail }>(), entered = Promise.withResolvers<void>();
  f.detail.mockImplementationOnce(async () => { entered.resolve(); return response.promise; });
  const olderDetail = f.backend.questions("child"); await entered.promise;
  f.lists.mockResolvedValue({ total: 0, threads: [] });
  expect(await f.backend.statuses(true)).toEqual({});
  response.resolve({ thread: change === "question"
    ? row("child", { state: "needs-input", pendingRequest: question, pendingRequests: [question] })
    : row("child", { state: "running", status: "running" }) });
  await olderDetail;
  expect(await f.backend.statuses(true)).toEqual({});
  expect(f.reads()).toBe(1);
  expect(f.roster.status().ambiguous).toBe(0);
});

function signalDetail(backend: RobobBackend, first: "permissions" | "questions", signal: () => void) {
  if (first === "permissions") {
    const read = backend.permissions.bind(backend);
    spyOn(backend, first).mockImplementation(async (...args) => { const result = await read(...args); if (args[0] === "child") signal(); return result; });
  } else {
    const read = backend.questions.bind(backend);
    spyOn(backend, first).mockImplementation(async (...args) => { const result = await read(...args); if (args[0] === "child") signal(); return result; });
  }
}

const races = (["question", "running"] as const).flatMap(change =>
  (["permissions", "questions"] as const).flatMap(newFact =>
    (["new-first", "old-first"] as const).map(order => ({ change, newFact, order }))));

test.each(races)("parallel Router requests preserve $change: $newFact has new facts, $order", async ({ change, newFact, order }) => {
  const f = fixture(); await f.backend.statuses(true);
  const permissions = Promise.withResolvers<{ thread: ThreadDetail }>(), questions = Promise.withResolvers<{ thread: ThreadDetail }>();
  const entered = Promise.withResolvers<void>(), landed = Promise.withResolvers<void>();
  let childReads = 0;
  f.detail.mockImplementation(async id => {
    if (id === "owner") return { thread: row("owner", { state: "idle", status: "idle", parentThreadId: null }) };
    childReads++;
    if (childReads === 1) return permissions.promise;
    if (childReads === 2) { entered.resolve(); return questions.promise; }
    return { thread: structuredClone(f.server.child) };
  });
  const first = order === "new-first" ? newFact : newFact === "permissions" ? "questions" : "permissions";
  signalDetail(f.backend, first, () => landed.resolve());
  const scan = f.scan(); await entered.promise;
  const stale = row("child", { state: "waiting", status: "waiting", activeRunId: null });
  f.server.child = change === "question" ? row("child", { state: "needs-input", pendingRequest: question, pendingRequests: [question] })
    : row("child", { state: "running", status: "running" });
  const responses = { permissions, questions };
  const snapshots = { permissions: newFact === "permissions" ? f.server.child : stale, questions: newFact === "questions" ? f.server.child : stale };
  responses[first].resolve({ thread: structuredClone(snapshots[first]) }); await landed.promise;
  const second = first === "permissions" ? "questions" : "permissions";
  responses[second].resolve({ thread: structuredClone(snapshots[second]) }); await scan;
  expect(await f.backend.statuses(true)).toEqual({ child: { type: "busy", root: "owner" } });
  const admission = await f.scan();
  if (change === "question") expect(admission.map(item => item.request.id)).toEqual(["question"]);
  else expect(admission).toEqual([]);
  expect(childReads).toBe(4);
  expect(f.reads()).toBeLessThanOrEqual(2);
});

test.each(["waiting", "running", "needs-input"] as const)("identical concurrent Router details are no-ops: %s", async state => {
  const f = fixture(); f.server.child = row("child", { state, pendingRequest: state === "needs-input" ? question : null,
    pendingRequests: state === "needs-input" ? [question] : [] });
  // Waiting is discovered through a busy view captured before its unchanged detail responses.
  if (state === "waiting") f.server.child.state = "running";
  const statuses = await f.backend.statuses(true);
  if (state === "waiting") { f.server.child.state = "waiting"; await f.backend.sessionBusy("child"); }
  const generation = f.roster.generation;
  for (let i = 0; i < 6; i++) await f.router["requests"]({ id: "owner", directory: "/chats", generation: 1,
    messageId: "msg_work", startedAt: Date.now(), phase: "running" }, statuses, true);
  expect(f.reads()).toBe(1);
  expect(f.roster.status().ambiguous).toBe(0);
  expect(f.roster.generation).toBe(generation);
});

test.each((["running", "needs-input"] as const).flatMap(state =>
  (["permissions", "questions"] as const).map(first => ({ state, first }))))("a $state clear through $first waits for the other detail", async ({ state, first }) => {
  const f = fixture(); f.server.child = row("child", { state, pendingRequest: state === "needs-input" ? question : null,
    pendingRequests: state === "needs-input" ? [question] : [] });
  await f.backend.statuses(true);
  const permissions = Promise.withResolvers<{ thread: ThreadDetail }>(), questions = Promise.withResolvers<{ thread: ThreadDetail }>();
  const aggregate = Promise.withResolvers<{ total: number; threads: ThreadDetail[] }>();
  const entered = Promise.withResolvers<void>(), landed = Promise.withResolvers<void>();
  let childReads = 0;
  f.detail.mockImplementation(async id => {
    if (id === "owner") return { thread: row("owner", { state: "idle", status: "idle", parentThreadId: null }) };
    if (++childReads === 2) entered.resolve();
    return childReads === 1 ? permissions.promise : questions.promise;
  });
  signalDetail(f.backend, first, () => landed.resolve());
  const scan = f.scan(); await entered.promise;
  f.server.child = row("child", { state: "idle", status: "idle", activeRunId: null });
  f.lists.mockImplementation(async args => args?.active ? aggregate.promise : { total: 1, threads: [f.server.child] });
  const responses = { permissions, questions };
  responses[first].resolve({ thread: structuredClone(f.server.child) }); await landed.promise;
  expect(f.roster.isBusy("child")).toBe(true);
  expect(f.roster.status().ambiguous).toBe(1);
  responses[first === "permissions" ? "questions" : "permissions"].resolve({ thread: structuredClone(f.server.child) });
  await scan;
  aggregate.resolve({ total: 1, threads: [structuredClone(f.server.child)] }); await f.backend.statuses(true);
  f.detail.mockResolvedValue({ thread: structuredClone(f.server.child) });
  expect(await f.backend.sessionBusy("child")).toBe(false);
  expect(await f.backend.statuses(true)).toEqual({});
  expect(f.reads()).toBe(2);
});

test("a failed parallel detail releases its ticket before the other read clears busy", async () => {
  const f = fixture(); await f.backend.statuses(true);
  const permissions = Promise.withResolvers<{ thread: ThreadDetail }>(), questions = Promise.withResolvers<{ thread: ThreadDetail }>();
  const entered = Promise.withResolvers<void>(), landed = Promise.withResolvers<void>();
  let childReads = 0;
  f.detail.mockImplementation(async id => {
    if (id === "owner") return { thread: row("owner", { state: "idle", status: "idle", parentThreadId: null }) };
    if (++childReads === 2) entered.resolve();
    return childReads === 1 ? permissions.promise : questions.promise;
  });
  const read = f.backend.questions.bind(f.backend);
  spyOn(f.backend, "questions").mockImplementation(async (...args) => { const result = await read(...args); if (args[0] === "child") landed.resolve(); return result; });
  const failed = f.scan().catch((error: unknown) => error); await entered.promise;
  permissions.reject(new Error("detail offline")); expect(await failed).toMatchObject({ message: "detail offline" });
  questions.resolve({ thread: row("child", { state: "idle", status: "idle", activeRunId: null }) }); await landed.promise;
  expect(await f.backend.statuses(true)).toEqual({});
  expect(f.reads()).toBe(1);
  expect(f.roster.status().ambiguous).toBe(0);
});

test("an aggregate removal fences both parallel details against reviving a child", async () => {
  const f = fixture(); await f.backend.statuses(true);
  const permission = Promise.withResolvers<{ thread: ThreadDetail }>(), questionRead = Promise.withResolvers<{ thread: ThreadDetail }>();
  const entered = Promise.withResolvers<void>(); let childReads = 0;
  f.detail.mockImplementation(async id => {
    if (id === "owner") return { thread: row("owner", { state: "idle", status: "idle", parentThreadId: null }) };
    if (++childReads === 2) entered.resolve();
    return childReads === 1 ? permission.promise : questionRead.promise;
  });
  const scan = f.scan(); await entered.promise;
  f.lists.mockResolvedValue({ total: 0, threads: [] });
  f.roster.event({ id: "20", data: { type: "thread.updated", threadId: "child", change: "thread.deleted" } });
  expect(await f.backend.statuses(true)).toEqual({});
  const stale = row("child", { state: "needs-input", pendingRequest: question, pendingRequests: [question] });
  permission.resolve({ thread: stale }); questionRead.resolve({ thread: stale }); await scan;
  expect(await f.backend.statuses(true)).toEqual({});
  expect(await f.scan()).toEqual([]);
  expect(childReads).toBe(2);
  expect(f.reads()).toBe(2);
});

test.each(["running", "needs-input"] as const)("fetch merge retains %s detail facts across a later non-state event", async state => {
  const f = fixture(); const statuses = await f.backend.statuses(true);
  const response = Promise.withResolvers<{ total: number; threads: ThreadDetail[] }>();
  f.lists.mockImplementationOnce(async () => response.promise);
  f.roster.event({ id: "1", data: { type: "thread.updated", threadId: "child", change: "thread.metadata-updated" } });
  f.server.child = row("child", { state, pendingRequest: state === "needs-input" ? question : null,
    pendingRequests: state === "needs-input" ? [question] : [] });
  await f.router["requests"]({ id: "owner", directory: "/chats", generation: 1, messageId: "msg_work", startedAt: Date.now(), phase: "running" }, statuses, true);
  f.roster.event({ id: "2", data: { type: "message.completed", threadId: "child" } });
  response.resolve({ total: 1, threads: [row("child", { state: "idle", status: "idle" })] });
  expect(await f.backend.statuses(true)).toEqual({ child: { type: "busy", root: "owner" } });
  if (state === "needs-input") expect((await f.scan()).map(item => item.request.id)).toEqual(["question"]);
  expect(f.reads()).toBe(3);
});

const listDetailRaces = (["question", "running"] as const).flatMap(change =>
  [true, false].flatMap(listed => (["list-first", "detail-first"] as const).map(order => ({ change, listed, order }))));

test.each(listDetailRaces)("overlapping list/detail preserve $change: listed=$listed, $order", async ({ change, listed, order }) => {
  let clock = 1_000;
  const f = fixture(() => clock), statuses = await f.backend.statuses(true);
  const aggregate = Promise.withResolvers<{ total: number; threads: ThreadDetail[] }>();
  const reconciliation = Promise.withResolvers<{ total: number; threads: ThreadDetail[] }>();
  const reconciling = Promise.withResolvers<void>();
  const responses = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const stale = listed ? [row("child", { state: "waiting", status: "waiting", activeRunId: null })] : [];
  let fetches = 0, childReads = 0;
  f.lists.mockImplementation(async args => {
    if (!args?.active) return { total: 1, threads: [structuredClone(f.server.child)] };
    if (++fetches === 1) return aggregate.promise;
    reconciling.resolve(); return reconciliation.promise;
  });
  f.detail.mockImplementation(async id => {
    if (id === "owner") return { thread: row("owner", { state: "idle", status: "idle", parentThreadId: null }) };
    const snapshot = structuredClone(f.server.child);
    if (++childReads === 2) entered.resolve();
    if (childReads <= 2) await responses.promise;
    return { thread: snapshot };
  });
  clock += 30_000; const refresh = f.backend.statuses(true);
  f.server.child = change === "question" ? row("child", { state: "needs-input", pendingRequest: question, pendingRequests: [question] })
    : row("child", { state: "running", status: "running", activeRunId: "run-2", latestRunId: "run-2" });
  const scan = f.router["requests"]({ id: "owner", directory: "/chats", generation: 1,
    messageId: "msg_work", startedAt: clock, phase: "running" }, statuses, true);
  await entered.promise;
  if (order === "list-first") { aggregate.resolve({ total: stale.length, threads: stale }); await reconciling.promise; }
  responses.resolve(); await scan;
  if (order === "detail-first") { aggregate.resolve({ total: stale.length, threads: stale }); await reconciling.promise; }
  // Incoming evidence is visible while reconciliation is held, without waiting for a list GET.
  expect(f.roster.isBusy("child")).toBe(true);
  const admissions = Array.from({ length: 6 }, () => f.backend.statuses(true));
  reconciliation.resolve({ total: 1, threads: [structuredClone(f.server.child)] });
  await refresh;
  for (const status of await Promise.all(admissions)) expect(status).toEqual({ child: { type: "busy", root: "owner" } });
  expect((await f.scan()).map(item => item.request.id)).toEqual(change === "question" ? ["question"] : []);
  expect(childReads).toBe(4);
  expect(f.reads()).toBe(3);
  expect(f.roster.status()).toMatchObject({ complete: true, ambiguous: 1 });
});

const eventPairs = (["running", "question", "idle", "resolved", "deleted", "archived"] as const).flatMap(change =>
  (["event-first", "list-first"] as const).map(order => ({ change, order })));
test.each(eventPairs)("list/SSE writers: $change, $order", async ({ change, order }) => {
  let clock = 1_000;
  const f = fixture(() => clock);
  if (change === "resolved") f.server.child = row("child", { state: "needs-input", pendingRequest: question, pendingRequests: [question] });
  await f.backend.statuses(true);
  const stale = structuredClone(f.server.child), aggregate = Promise.withResolvers<{ total: number; threads: ThreadDetail[] }>();
  let lists = 0;
  f.lists.mockImplementation(async args => {
    const threads = change === "deleted" || change === "archived" ? [] : [structuredClone(f.server.child)];
    return args?.active && ++lists === 1 ? aggregate.promise : { total: threads.length, threads };
  });
  clock += 30_000; const refresh = f.backend.statuses(true);
  const event = () => {
    f.server.child = change === "question" ? row("child", { state: "needs-input", pendingRequest: question, pendingRequests: [question] })
      : row("child", { state: change === "running" ? "running" : "idle", status: change === "running" ? "running" : "completed" });
    f.roster.event({ id: "30", data: change === "question" ? { type: "request.opened", threadId: "child", ...question }
      : change === "resolved" ? { type: "request.resolved", threadId: "child", requestId: "question" }
      : change === "deleted" || change === "archived" ? { type: "thread.updated", threadId: "child", change: `thread.${change}` }
      : { type: "thread.status", threadId: "child", runId: "run-1", state: f.server.child.state, status: f.server.child.status } });
  };
  if (order === "event-first") event();
  aggregate.resolve({ total: 1, threads: [stale] }); await refresh;
  if (order === "list-first") event();
  const statuses = await f.backend.statuses(true);
  expect(statuses).toEqual(change === "running" || change === "question" ? { child: { type: "busy", root: "owner" } } : {});
  expect((await f.scan()).map(item => item.request.id)).toEqual(change === "question" ? ["question"] : []);
  expect(f.reads()).toBeLessThanOrEqual(3);
  expect(f.roster.status().ambiguous).toBeLessThanOrEqual(1);
});

test.each((["running", "needs-input"] as const).flatMap(state =>
  (["event-first", "detail-first"] as const).map(order => ({ state, order })) ))("non-state event/detail writers: $state, $order", async ({ state, order }) => {
  const f = fixture(), statuses = await f.backend.statuses(true);
  const response = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  let details = 0;
  f.server.child = row("child", { state, pendingRequest: state === "needs-input" ? question : null,
    pendingRequests: state === "needs-input" ? [question] : [] });
  f.detail.mockImplementation(async id => {
    if (id === "owner") return { thread: row("owner", { state: "idle", parentThreadId: null }) };
    const snapshot = structuredClone(f.server.child);
    if (++details === 2) entered.resolve();
    if (details <= 2) await response.promise;
    return { thread: snapshot };
  });
  const scan = f.router["requests"]({ id: "owner", directory: "/chats", generation: 1,
    messageId: "msg_work", startedAt: Date.now(), phase: "running" }, statuses, true);
  await entered.promise;
  if (order === "event-first") f.roster.event({ id: "20", data: { type: "message.completed", threadId: "child" } });
  response.resolve(); await scan;
  if (order === "detail-first") f.roster.event({ id: "20", data: { type: "message.completed", threadId: "child" } });
  expect(await f.backend.statuses(true)).toEqual({ child: { type: "busy", root: "owner" } });
  expect((await f.scan()).map(item => item.request.id)).toEqual(state === "needs-input" ? ["question"] : []);
  expect(f.reads()).toBe(1);
});

test.each(["running", "needs-input"] as const)("later-started idle reads clear held %s evidence", async state => {
  let clock = 1_000;
  const f = fixture(() => clock);
  f.server.child = row("child", { state, pendingRequest: state === "needs-input" ? question : null,
    pendingRequests: state === "needs-input" ? [question] : [] });
  await f.backend.statuses(true);
  f.server.child = row("child", { state: "idle", status: "completed", activeRunId: null });
  clock += 30_000;
  expect(await f.backend.statuses(true)).toEqual({});
  expect(await f.scan()).toEqual([]);
  expect(f.reads()).toBe(2);
  expect(f.roster.status().ambiguous).toBe(0);
});

test.each((["running", "question", "deleted", "archived"] as const).flatMap(change =>
  (["event-first", "detail-first"] as const).map(order => ({ change, order }))))("detail/SSE writers: $change, $order", async ({ change, order }) => {
  const f = fixture(), statuses = await f.backend.statuses(true);
  const responses = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  let details = 0;
  f.detail.mockImplementation(async id => {
    if (id === "owner") return { thread: row("owner", { state: "idle", parentThreadId: null }) };
    if (++details === 2) entered.resolve();
    if (details <= 2) { await responses.promise; return { thread: row("child", { state: "idle", activeRunId: null }) }; }
    return { thread: structuredClone(f.server.child) };
  });
  const scan = f.router["requests"]({ id: "owner", directory: "/chats", generation: 1,
    messageId: "msg_work", startedAt: Date.now(), phase: "running" }, statuses, true);
  await entered.promise;
  const event = () => {
    f.server.child = change === "question" ? row("child", { state: "needs-input", pendingRequest: question, pendingRequests: [question] })
      : row("child", { state: "running", status: "running" });
    if (change === "deleted" || change === "archived") f.lists.mockResolvedValue({ total: 0, threads: [] });
    f.roster.event({ id: "50", data: change === "question" ? { type: "request.opened", threadId: "child", ...question }
      : change === "running" ? { type: "thread.status", threadId: "child", runId: "run-1", state: "running" }
      : { type: "thread.updated", threadId: "child", change: `thread.${change}` } });
  };
  if (order === "event-first") event();
  responses.resolve(); await scan;
  if (order === "detail-first") event();
  expect(await f.backend.statuses(true)).toEqual(change === "running" || change === "question" ? { child: { type: "busy", root: "owner" } } : {});
  expect((await f.scan()).map(item => item.request.id)).toEqual(change === "question" ? ["question"] : []);
  expect(f.reads()).toBeLessThanOrEqual(3);
});

test.each((["running", "needs-input"] as const).flatMap(state => [true, false].map(listed => ({ state, listed }))))("unchanged detail reaffirms $state against an older list: listed=$listed", async ({ state, listed }) => {
  let clock = 1_000;
  const f = fixture(() => clock);
  f.server.child = row("child", { state, pendingRequest: state === "needs-input" ? question : null,
    pendingRequests: state === "needs-input" ? [question] : [] });
  const statuses = await f.backend.statuses(true);
  const aggregate = Promise.withResolvers<{ total: number; threads: ThreadDetail[] }>();
  f.lists.mockImplementationOnce(async () => aggregate.promise);
  clock += 30_000; const refresh = f.backend.statuses(true);
  await f.router["requests"]({ id: "owner", directory: "/chats", generation: 1,
    messageId: "msg_work", startedAt: clock, phase: "running" }, statuses, true);
  const stale = listed ? [row("child", { state: "waiting", pendingRequest: null })] : [];
  aggregate.resolve({ total: stale.length, threads: stale }); await refresh;
  expect(await f.backend.statuses(true)).toEqual({ child: { type: "busy", root: "owner" } });
  expect((await f.scan()).map(item => item.request.id)).toEqual(state === "needs-input" ? ["question"] : []);
  expect(f.reads()).toBe(3);
  expect(f.roster.status().ambiguous).toBe(1);
});

test.each((["running", "needs-input"] as const).flatMap(state =>
  (["new-first", "old-first"] as const).map(order => ({ state, order }))))("unchanged parallel detail reaffirms $state: $order", async ({ state, order }) => {
  const f = fixture();
  f.server.child = row("child", { state, pendingRequest: state === "needs-input" ? question : null,
    pendingRequests: state === "needs-input" ? [question] : [] });
  await f.backend.statuses(true);
  const permissions = Promise.withResolvers<{ thread: ThreadDetail }>(), questions = Promise.withResolvers<{ thread: ThreadDetail }>();
  const entered = Promise.withResolvers<void>(), landed = Promise.withResolvers<void>();
  let childReads = 0;
  f.detail.mockImplementation(async id => {
    if (id === "owner") return { thread: row("owner", { state: "idle", parentThreadId: null }) };
    if (++childReads === 1) return permissions.promise;
    if (childReads === 2) { entered.resolve(); return questions.promise; }
    return { thread: structuredClone(f.server.child) };
  });
  const first = order === "new-first" ? "questions" : "permissions";
  signalDetail(f.backend, first, () => landed.resolve());
  const scan = f.scan(); await entered.promise;
  const snapshots = { permissions: row("child", { state: "waiting", status: "waiting", activeRunId: null }),
    questions: structuredClone(f.server.child) };
  const responses = { permissions, questions };
  responses[first].resolve({ thread: snapshots[first] }); await landed.promise;
  const second = first === "permissions" ? "questions" : "permissions";
  responses[second].resolve({ thread: snapshots[second] }); await scan;
  expect(await f.backend.statuses(true)).toEqual({ child: { type: "busy", root: "owner" } });
  expect((await f.scan()).map(item => item.request.id)).toEqual(state === "needs-input" ? ["question"] : []);
  expect(childReads).toBe(4);
  expect(f.reads()).toBe(2);
  expect(f.roster.status().ambiguous).toBe(1);
});
