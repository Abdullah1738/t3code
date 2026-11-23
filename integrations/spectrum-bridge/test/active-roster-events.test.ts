import { afterEach, expect, spyOn, test } from "bun:test";
import { ActiveRoster } from "../src/active-roster.ts";
import { ControlClient, type ControlEventFrame, type ThreadDetail, type ThreadSummary } from "../src/control.ts";

const row = (id: string, extra: Partial<ThreadDetail> = {}): ThreadDetail => ({
  threadId: id, projectId: "fixture", title: id, state: "running", status: "running", origin: "imessage",
  nativeSessionId: `ses_${id}`, runtimeMode: "full-access", parentThreadId: null, rootThreadId: id,
  worktreePath: "/fixture", pendingRequest: null, pendingRequests: [], run: null, recentRuns: [],
  activeRunId: "run-1", latestRunId: "run-1", createdAt: null, updatedAt: null, ...extra,
});
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function fixture() {
  let clock = 1_000, sequence = 0;
  const server = new Map<string, ThreadDetail>([["owner", row("owner")], ["other", row("other")]]);
  const client = new ControlClient({ url: "http://127.0.0.1:1", token: "fixture" });
  const lists = spyOn(client, "listThreads").mockImplementation(async () => {
    const threads = [...server.values()].filter(thread => !thread.archived && ["running", "queued", "needs-input"].includes(thread.state)).map(thread => structuredClone(thread));
    return { total: threads.length, threads };
  });
  const detail = spyOn(client, "thread").mockImplementation(async id => ({ thread: structuredClone(server.get(id) ?? row(id, { state: "idle" })) }));
  const roster = new ActiveRoster(client, () => clock); roster.streamState(true);
  const event = (data: ControlEventFrame["data"], id = String(++sequence)) => roster.event({ id, data });
  const view = () => roster.read(false, new Map());
  const admission = () => roster.read(true, new Map());
  await admission();
  cleanups.push(() => { roster.stop(); lists.mockRestore(); detail.mockRestore(); });
  return { roster, server, lists, detail, event, view, admission, time: (next: number) => { clock = next; },
    confirmed: (id: string) => roster["eventDetails"].get(id) };
}

test.each(["idle", "waiting"] as const)("known %s status confirms aggregate idle without a full list", async state => {
  const f = await fixture(), response = Promise.withResolvers<{ thread: ThreadDetail }>();
  f.detail.mockReturnValueOnce(response.promise);
  f.event({ type: "thread.status", threadId: "owner", state, runId: "run-1" });
  expect((await f.view()).owner?.type).toBe("busy");
  response.resolve({ thread: row("owner", { state: "idle" }) }); await f.confirmed("owner");
  expect((await f.view()).owner).toBeUndefined(); expect((await f.admission()).other?.type).toBe("busy");
  expect(f.lists).toHaveBeenCalledTimes(1); expect(f.detail).toHaveBeenCalledTimes(1);
});

test("a stale event detail cannot clear a newer busy event", async () => {
  const f = await fixture(), response = Promise.withResolvers<{ thread: ThreadDetail }>();
  f.detail.mockReturnValueOnce(response.promise);
  f.event({ type: "thread.status", threadId: "owner", state: "idle" }); const pending = f.confirmed("owner");
  f.event({ type: "thread.status", threadId: "owner", state: "queued", runId: "run-1" });
  response.resolve({ thread: row("owner", { state: "idle" }) }); await pending;
  expect((await f.view()).owner?.type).toBe("busy"); expect(f.lists).toHaveBeenCalledTimes(1);
});

test("twenty unpatchable events share one detail read per id", async () => {
  const f = await fixture(), response = Promise.withResolvers<{ thread: ThreadDetail }>();
  f.detail.mockReturnValueOnce(response.promise);
  for (let i = 0; i < 20; i++) f.event({ type: "thread.status", threadId: "owner", state: "idle" });
  expect(f.detail).toHaveBeenCalledTimes(1); expect(f.roster.status().detailJoins).toBe(19);
  response.resolve({ thread: row("owner", { state: "idle" }) }); await f.confirmed("owner");
  expect((await f.view()).owner?.type).toBe("busy"); expect(f.lists).toHaveBeenCalledTimes(1);
});

test.each(["idle", "waiting"] as const)("unknown %s status changes nothing and makes no reads", async state => {
  const f = await fixture(), before = await f.view();
  f.event({ type: "thread.status", threadId: "unknown", state }); expect(await f.view()).toEqual(before);
  expect(f.lists).toHaveBeenCalledTimes(1); expect(f.detail).toHaveBeenCalledTimes(0);
  expect(f.roster.status()).toMatchObject({ miss_status_unknown: 1, drops: 1 });
});

test("unknown busy child resolves root and native aliases from detail", async () => {
  const f = await fixture(); f.server.set("child", row("child", { parentThreadId: "owner", rootThreadId: "owner" }));
  f.event({ type: "thread.status", threadId: "child", state: "running" }); expect((await f.view()).child?.type).toBe("busy");
  await f.confirmed("child");
  expect(await f.roster.read(false, new Map([["ses_imported", "owner"]]))).toMatchObject({
    child: { type: "busy", root: "ses_imported" }, ses_child: { type: "busy", root: "ses_imported" },
    owner: { type: "busy", root: null }, ses_imported: { type: "busy", root: null },
  });
  expect(f.lists).toHaveBeenCalledTimes(1); expect(f.detail).toHaveBeenCalledTimes(1);
});

test("top-level busy detail, idle creation and metadata avoid full lists", async () => {
  const f = await fixture(); f.server.set("new", row("new"));
  f.event({ type: "thread.status", threadId: "new", state: "running" }); await f.confirmed("new");
  expect((await f.view()).ses_new).toEqual({ type: "busy", root: null });
  f.event({ type: "thread.created", threadId: "idle-created" }); await f.confirmed("idle-created");
  expect((await f.view())["idle-created"]).toBeUndefined();
  f.event({ type: "thread.created", threadId: "explicit-idle", state: "idle" });
  f.event({ type: "thread.updated", threadId: "new", change: "thread.metadata-updated" });
  expect(f.lists).toHaveBeenCalledTimes(1); expect(f.detail).toHaveBeenCalledTimes(2);
});

const createdFamilies = [
  { family: "top-level", parentThreadId: null, rootThreadId: "created", missingRoot: false },
  { family: "known-root child", parentThreadId: "owner", rootThreadId: "owner", missingRoot: false },
  { family: "inactive-root child", parentThreadId: "inactive-parent", rootThreadId: "inactive-parent", missingRoot: true },
  { family: "inactive-root fork", parentThreadId: "inactive-parent", rootThreadId: "inactive-root", missingRoot: true },
  { family: "rootless child", parentThreadId: "inactive-parent", rootThreadId: "", missingRoot: true },
];
const createdCases = createdFamilies.flatMap(family =>
  (["idle", "waiting", "running", "queued", "needs-input"] as const).map(state => ({ ...family, state })));
test.each(createdCases)("state-less creation: $family, detail $state", async ({ parentThreadId, rootThreadId, missingRoot, state }) => {
  const f = await fixture(), before = await f.view();
  const busy = state !== "idle" && state !== "waiting";
  const pendingRequest = state === "needs-input" ? { requestId: "created-question", kind: "question" as const, requestKind: "user_input" } : null;
  f.server.set("created", row("created", { parentThreadId, rootThreadId, state, pendingRequest }));
  // Creation frames supply family identity but no aggregate state.
  f.event({ type: "thread.created", threadId: "created", parentThreadId });
  await f.confirmed("created"); await f.roster["fetching"];
  const statuses = await f.admission();
  if (busy) {
    const expected = { type: "busy", root: parentThreadId === null ? null : rootThreadId };
    expect(statuses.created).toEqual(expected); expect(statuses.ses_created).toEqual(expected);
  } else expect(statuses).toEqual(before);
  expect(f.detail).toHaveBeenCalledTimes(1);
  expect(f.lists).toHaveBeenCalledTimes(busy && missingRoot ? 2 : 1);
  expect(f.roster.status().fetch_created).toBe(busy && missingRoot ? 1 : 0);
});

test.each(createdFamilies.filter(family => family.missingRoot))("idle creation with a pending request still discovers $family", async ({ parentThreadId, rootThreadId }) => {
  const f = await fixture();
  const pendingRequest = { requestId: "created-question", kind: "question" as const, requestKind: "user_input" };
  f.server.set("created", row("created", { parentThreadId, rootThreadId, state: "needs-input", pendingRequest }));
  f.detail.mockResolvedValueOnce({ thread: row("created", { parentThreadId, rootThreadId, state: "idle", pendingRequest }) });
  f.event({ type: "thread.created", threadId: "created", parentThreadId });
  await f.confirmed("created"); await f.roster["fetching"];
  expect((await f.admission()).created).toEqual({ type: "busy", root: rootThreadId });
  expect(f.detail).toHaveBeenCalledTimes(1); expect(f.lists).toHaveBeenCalledTimes(2);
});

const createdRequestCases = createdFamilies.flatMap(family =>
  (["idle", "waiting"] as const).flatMap(state =>
    ([undefined, "running"] as const).flatMap(eventState =>
      (["question", "approval"] as const).map(kind => ({ ...family, state, eventState, kind })))));
test.each(createdRequestCases)("inactive creation then $kind: $family, detail $state, event $eventState", async ({ parentThreadId, rootThreadId, missingRoot, state, eventState, kind }) => {
  const f = await fixture(), before = await f.view();
  f.server.set("created", row("created", { parentThreadId, rootThreadId, state }));
  f.event({ type: "thread.created", threadId: "created", parentThreadId, ...(eventState ? { state: eventState } : {}) });
  await f.confirmed("created");
  expect(await f.admission()).toEqual(before); expect(f.lists).toHaveBeenCalledTimes(1);
  const pendingRequest = { requestId: "later-request", kind, requestKind: kind === "question" ? "user_input" : "tool_approval" };
  f.server.set("created", row("created", { parentThreadId, rootThreadId, state: "needs-input", pendingRequest }));
  f.event({ type: "request.opened", threadId: "created", ...pendingRequest });
  await f.confirmed("created"); await f.roster["fetching"];
  const statuses = await f.admission(), expected = { type: "busy", root: parentThreadId === null ? null : rootThreadId };
  expect(statuses.created).toEqual(expected); expect(statuses.ses_created).toEqual(expected);
  expect(f.detail).toHaveBeenCalledTimes(2);
  expect(f.lists).toHaveBeenCalledTimes(missingRoot ? 2 : 1);
});

test("idle creation detail cannot clear a newer busy child's provisional identity", async () => {
  const f = await fixture(), response = Promise.withResolvers<{ thread: ThreadDetail }>();
  f.detail.mockReturnValueOnce(response.promise);
  f.event({ type: "thread.created", threadId: "created", parentThreadId: "inactive-parent" });
  const pending = f.confirmed("created");
  f.server.set("created", row("created", { parentThreadId: "owner", rootThreadId: "owner" }));
  f.event({ type: "thread.status", threadId: "created", state: "running" });
  expect((await f.view()).created?.type).toBe("busy");
  response.resolve({ thread: row("created", { state: "idle", parentThreadId: "inactive-parent", rootThreadId: "inactive-parent" }) });
  await pending; await f.roster["fetching"];
  expect((await f.admission()).created).toEqual({ type: "busy", root: "owner" });
  expect(f.detail).toHaveBeenCalledTimes(1); expect(f.lists).toHaveBeenCalledTimes(2);
});

const createdListCases = createdFamilies.flatMap(family =>
  (["list-first", "detail-first"] as const).flatMap(start =>
    (["list-first", "detail-first"] as const).map(finish => ({ ...family, start, finish }))));
test.each(createdListCases)("creation removal and list fences: $family, start $start, finish $finish", async ({ parentThreadId, rootThreadId, start, finish }) => {
  const f = await fixture(), before = await f.view();
  const list = Promise.withResolvers<{ total: number; threads: ThreadSummary[] }>(), detail = Promise.withResolvers<{ thread: ThreadDetail }>();
  f.lists.mockReturnValueOnce(list.promise); f.detail.mockReturnValueOnce(detail.promise);
  let fetching: Promise<void> | undefined, confirming: Promise<void> | undefined;
  const startList = () => { f.time(31_000); f.roster.view(new Map()); fetching = f.roster["fetching"]; };
  const startDetail = () => { f.event({ type: "thread.created", threadId: "created", parentThreadId }); confirming = f.confirmed("created"); };
  if (start === "list-first") { startList(); startDetail(); } else { startDetail(); startList(); }
  const finishList = async () => { list.resolve({ total: 3, threads: [...f.server.values(), row("created", { parentThreadId, rootThreadId })] }); await fetching; };
  const finishDetail = async () => { detail.resolve({ thread: row("created", { parentThreadId, rootThreadId, state: "idle" }) }); await confirming; };
  if (finish === "list-first") { await finishList(); await finishDetail(); } else { await finishDetail(); await finishList(); }
  const statuses = await f.admission();
  if (start === "list-first") expect(statuses).toEqual(before);
  else {
    const expected = { type: "busy", root: parentThreadId === null ? null : rootThreadId };
    expect(statuses.created).toEqual(expected); expect(statuses.ses_created).toEqual(expected);
  }
  expect(f.lists).toHaveBeenCalledTimes(2); expect(f.detail).toHaveBeenCalledTimes(1);
});

test("child missing its root falls back to one full list", async () => {
  const f = await fixture(); f.server.set("child", row("child", { parentThreadId: "missing", rootThreadId: "missing" }));
  f.event({ type: "thread.status", threadId: "child", state: "running" }); await f.confirmed("child"); await f.roster["fetching"];
  expect((await f.view()).child).toEqual({ type: "busy", root: "missing" }); expect(f.lists).toHaveBeenCalledTimes(2);
  expect(f.roster.status().fetch_status_unknown).toBe(1);
});

test.each(["thread.archived", "thread.deleted"])("%s removes busy and fences older detail", async change => {
  const f = await fixture(), older = f.roster.checkpoint("owner");
  f.server.set("owner", row("owner", { archived: true }));
  f.event({ type: "thread.updated", threadId: "owner", change }); await f.confirmed("owner"); f.roster.observe(row("owner"), older);
  expect((await f.view()).owner).toBeUndefined(); expect((await f.view()).other?.type).toBe("busy");
  expect(f.lists).toHaveBeenCalledTimes(1); expect(f.detail).toHaveBeenCalledTimes(change === "thread.archived" ? 1 : 0);
});

test.each(["thread.settled", "thread.unsettled", "thread.unarchived"])("%s confirms only the affected thread", async change => {
  const f = await fixture(); f.server.set("owner", row("owner", { state: "idle" }));
  f.event({ type: "thread.updated", threadId: "owner", change }); await f.confirmed("owner");
  expect((await f.view()).owner).toBeUndefined(); expect(f.lists).toHaveBeenCalledTimes(1); expect(f.detail).toHaveBeenCalledTimes(1);
});

test("unordered archive retains busy until detail confirmation", async () => {
  const f = await fixture(), response = Promise.withResolvers<{ thread: ThreadDetail }>(); f.detail.mockReturnValueOnce(response.promise);
  f.event({ type: "thread.updated", threadId: "owner", change: "thread.archived" }, "bad-id");
  expect((await f.view()).owner?.type).toBe("busy"); response.resolve({ thread: row("owner") }); await f.confirmed("owner");
  expect((await f.view()).owner?.type).toBe("busy");
});

test("twenty full-roster triggers coalesce into one initial and one trailing read", async () => {
  const f = await fixture(); f.event({ type: "thread.status", state: "running" }); await f.roster["fetching"];
  for (let i = 0; i < 19; i++) { f.time(1_100 + i * 100); f.event({ type: "thread.status", state: "running" }); }
  expect(f.lists).toHaveBeenCalledTimes(2); f.time(5_999); await f.view(); expect(f.lists).toHaveBeenCalledTimes(2);
  f.time(6_000); await f.view(); await f.roster["fetching"]; expect(f.lists).toHaveBeenCalledTimes(3);
  expect(f.roster.status().fetch_status_unknown).toBe(2);
});

test("dirty steer admission bypasses coalescing and awaits a fresh list", async () => {
  const f = await fixture(); f.event({ type: "thread.status" }); await f.roster["fetching"];
  f.time(1_100); f.event({ type: "thread.status" });
  const response = Promise.withResolvers<{ total: number; threads: ThreadSummary[] }>(); f.lists.mockReturnValueOnce(response.promise);
  let admitted = false; const admission = f.admission().then(result => { admitted = true; return result; });
  expect(f.lists).toHaveBeenCalledTimes(3); expect(admitted).toBe(false);
  response.resolve({ total: 2, threads: [...f.server.values()] }); expect((await admission).owner?.type).toBe("busy"); expect(admitted).toBe(true);
});

test("stream gap admission waits and ready/resync bypass coalescing", async () => {
  const f = await fixture(); f.roster.streamState(false);
  const response = Promise.withResolvers<{ total: number; threads: ThreadSummary[] }>(); f.lists.mockReturnValueOnce(response.promise);
  let admitted = false; const admission = f.admission().then(() => { admitted = true; });
  expect(admitted).toBe(false); expect(f.lists).toHaveBeenCalledTimes(2);
  response.resolve({ total: 2, threads: [...f.server.values()] }); await admission;
  f.event({ type: "ready" }); await f.roster["fetching"]; f.time(1_100); f.event({ type: "resync" }); await f.roster["fetching"];
  expect(f.lists).toHaveBeenCalledTimes(4);
});

test("detail error falls back once and list failure retains last good busy map", async () => {
  const f = await fixture(); f.detail.mockRejectedValueOnce(new Error("detail offline")); f.lists.mockRejectedValueOnce(new Error("list offline"));
  f.event({ type: "thread.status", threadId: "owner", state: "idle" }); await f.confirmed("owner"); await f.roster["fetching"]?.catch(() => {});
  expect(await f.view()).toMatchObject({ owner: { type: "busy", root: null }, other: { type: "busy", root: null } });
  expect(f.lists).toHaveBeenCalledTimes(2); expect(f.roster.status()).toMatchObject({ detailErrors: 1, errors: 1, fetch_status_terminal: 1 });
  await expect(f.admission()).rejects.toThrow("list offline");
});

const laterListCases = (["running", "question"] as const).flatMap(change =>
  (["list-first", "detail-first"] as const).map(order => ({ change, order })));
test.each(laterListCases)("newer list evidence fences old request-resolution detail: $change, $order", async ({ change, order }) => {
  const f = await fixture();
  const request = { requestId: "A", kind: "question" as const, requestKind: "user_input" };
  f.roster.observe(row("owner", { state: "needs-input", pendingRequest: request }));
  const detail = Promise.withResolvers<{ thread: ThreadDetail }>(); f.detail.mockReturnValueOnce(detail.promise);
  f.event({ type: "request.resolved", threadId: "owner", ...request });
  const confirming = f.confirmed("owner");
  const newer = row("owner", { state: change === "question" ? "needs-input" : "running", activeRunId: "run-2", latestRunId: "run-2",
    pendingRequest: change === "question" ? { ...request, requestId: "B" } : null });
  const response = Promise.withResolvers<{ total: number; threads: ThreadSummary[] }>(); f.lists.mockReturnValueOnce(response.promise);
  f.time(31_000); f.roster.view(new Map()); const fetching = f.roster["fetching"];
  if (order === "detail-first") { detail.resolve({ thread: row("owner", { state: "idle" }) }); await confirming; }
  response.resolve({ total: 1, threads: [newer] }); await fetching;
  expect((await f.view()).owner?.type).toBe("busy");
  if (order === "list-first") { detail.resolve({ thread: row("owner", { state: "idle" }) }); await confirming; }
  expect((await f.admission()).owner?.type).toBe("busy");
  if (change === "question") expect(f.roster["known"].get("owner")?.pendingRequest?.requestId).toBe("B");
  expect(f.lists).toHaveBeenCalledTimes(2);
});

test.each(["1", "bad-id"])("delayed archive sequence %s cannot clear fresher HTTP busy evidence", async sequence => {
  const f = await fixture(), response = Promise.withResolvers<{ thread: ThreadDetail }>();
  f.roster.observe(row("owner", { activeRunId: "new-run" })); f.detail.mockReturnValueOnce(response.promise);
  f.event({ type: "thread.updated", threadId: "owner", change: "thread.archived" }, sequence);
  expect((await f.view()).owner?.type).toBe("busy");
  response.resolve({ thread: row("owner", { activeRunId: "new-run", archived: false }) }); await f.confirmed("owner");
  expect((await f.admission()).owner?.type).toBe("busy"); expect(f.lists).toHaveBeenCalledTimes(1);
});

const droppedDetailCases = (["idle", "waiting"] as const).flatMap(eventState =>
  (["running", "question"] as const).map(detailState => ({ eventState, detailState })));
test.each(droppedDetailCases)("dropped unknown $eventState does not fence outstanding $detailState detail", async ({ eventState, detailState }) => {
  const f = await fixture(), read = f.roster.checkpoint("child");
  f.event({ type: "thread.status", threadId: "child", state: eventState });
  const request = { requestId: "question", kind: "question" as const, requestKind: "user_input" };
  f.roster.observe(row("child", { parentThreadId: "owner", rootThreadId: "owner", state: detailState === "question" ? "needs-input" : "running",
    pendingRequest: detailState === "question" ? request : null }), read);
  expect((await f.admission()).child).toEqual({ type: "busy", root: "owner" }); expect(f.lists).toHaveBeenCalledTimes(1);
});

test("a 500-id burst reserves reply capacity and shares overflow discovery", async () => {
  const f = await fixture(), list = Promise.withResolvers<{ total: number; threads: ThreadSummary[] }>();
  const details = Promise.withResolvers<void>(); let active = 0, maximum = 0;
  f.detail.mockImplementation(async id => {
    active++; maximum = Math.max(maximum, active); await details.promise; active--;
    return { thread: f.server.get(id)! };
  });
  f.lists.mockReturnValueOnce(list.promise); f.time(31_000); f.roster.view(new Map());
  for (let i = 0; i < 500; i++) {
    const id = `burst-${i}`; f.server.set(id, row(id)); f.event({ type: "thread.status", threadId: id, state: "running" });
  }
  expect(f.detail).toHaveBeenCalledTimes(2); expect(maximum).toBe(2); expect(f.roster.status().detailOverflow).toBe(498);
  details.resolve(); await Promise.all(f.roster["eventDetails"].values());
  list.resolve({ total: f.server.size, threads: [...f.server.values()] }); await f.roster["fetching"];
  const statuses = await f.admission();
  for (let i = 0; i < 500; i++) expect(statuses[`burst-${i}`]?.type).toBe("busy");
  expect(f.lists).toHaveBeenCalledTimes(3); expect(f.detail).toHaveBeenCalledTimes(2);
});
