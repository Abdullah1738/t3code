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

function fixture() {
  const server = { child: row("child") };
  const client = new ControlClient({ url: "http://127.0.0.1:1", token: "test" });
  const lists = spyOn(client, "listThreads").mockImplementation(async () => ({ total: 1, threads: [structuredClone(server.child)] }));
  const detail = spyOn(client, "thread").mockImplementation(async id => ({ thread: id === "owner"
    ? row("owner", { state: "idle", status: "idle", parentThreadId: null, rootThreadId: "owner" }) : structuredClone(server.child) }));
  const roster = new ActiveRoster(client); roster.streamState(true);
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
  return { server, client, detail, lists, roster, backend, router, scan, reads };
}

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
  f.lists.mockImplementation(async args => args?.active ? response.promise : { total: 1, threads: [f.server.child] });
  f.roster.event({ id: "1", data: { type: "thread.updated", threadId: "child", change: "thread.metadata-updated" } });
  f.server.child = row("child", { state, pendingRequest: state === "needs-input" ? question : null,
    pendingRequests: state === "needs-input" ? [question] : [] });
  await f.router["requests"]({ id: "owner", directory: "/chats", generation: 1, messageId: "msg_work", startedAt: Date.now(), phase: "running" }, statuses, true);
  f.roster.event({ id: "2", data: { type: "message.completed", threadId: "child" } });
  response.resolve({ total: 1, threads: [row("child", { state: "idle", status: "idle" })] });
  expect(await f.backend.statuses(true)).toEqual({ child: { type: "busy", root: "owner" } });
  if (state === "needs-input") expect((await f.scan()).map(item => item.request.id)).toEqual(["question"]);
  expect(f.reads()).toBe(2);
});
