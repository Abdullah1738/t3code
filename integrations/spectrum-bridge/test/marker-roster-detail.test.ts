import { expect, spyOn, test } from "bun:test";
import { ActiveRoster } from "../src/active-roster.ts";
import { ControlClient, type ThreadDetail } from "../src/control.ts";
import { RobobBackend } from "../src/robob.ts";

function fixture() {
  const idle: ThreadDetail = { threadId: "route", projectId: "chats", title: "route", state: "idle", status: "completed",
    origin: "imessage", nativeSessionId: null, runtimeMode: "full-access", parentThreadId: null, rootThreadId: "route",
    worktreePath: "/chats", pendingRequest: null, pendingRequests: [], run: null, recentRuns: [], activeRunId: null,
    latestRunId: null, createdAt: null, updatedAt: null, changeMarker: 1 };
  const client = new ControlClient({ url: "http://127.0.0.1:1", token: "isolated-test", linkGate: false });
  const lists = spyOn(client, "listThreads").mockResolvedValue({ total: 1, threads: [idle] });
  const summaries = spyOn(client, "threadSummaries").mockResolvedValue({ threads: [idle] });
  const detail = spyOn(client, "thread").mockResolvedValue({ thread: idle });
  const pages = spyOn(client, "crossThreadMessages").mockResolvedValue({ messages: [], nextCursor: null });
  const roster = new ActiveRoster(client); roster.streamState(true);
  const checkpoint = spyOn(roster, "checkpoint"), finish = spyOn(roster, "finish");
  const backend = new RobobBackend({ chatRoot: "/chats", client, activeRoster: roster, finishes: () => new Map() });
  const busy = () => roster.event({ id: "10", data: { type: "thread.status", threadId: "route", state: "running" } });
  return { idle, client, roster, checkpoint, finish, backend, summaries, detail, pages, busy,
    close() { for (const mock of [lists, summaries, detail, pages, checkpoint, finish]) mock.mockRestore(); } };
}

test("marker roster: cached idle detail cannot overwrite newer SSE busy evidence", async () => {
  const f = fixture();
  try {
    await f.backend.beginMessageTick(["route"]);
    expect(f.checkpoint).toHaveBeenCalledTimes(1);
    f.busy();
    expect(await f.backend.sessionBusy("route")).toBe(true);
    await f.backend.beginMessageTick(["route"]);
    expect(await f.backend.sessionBusy("route")).toBe(true);
    expect(f.detail).toHaveBeenCalledTimes(1);
    expect(f.checkpoint).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

test.each([false, true])("marker roster: physical detail starts its ticket before newer SSE (marker=%s)", async marker => {
  const f = fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<{ thread: ThreadDetail }>();
  f.detail.mockImplementationOnce(async () => { entered.resolve(); return release.promise; });
  try {
    const reading = marker ? f.backend.beginMessageTick(["route"]) : f.backend.sessionBusy("route");
    await entered.promise;
    expect(f.checkpoint).toHaveBeenCalledTimes(1);
    f.busy(); release.resolve({ thread: f.idle }); await reading;
    expect(f.roster.isBusy("route")).toBe(true);
    expect(f.finish.mock.calls.some(([, read]) => read === f.checkpoint.mock.results[0]!.value)).toBe(true);
  } finally { release.resolve({ thread: f.idle }); f.close(); }
});

test("marker roster: fresh batch detail reconciles busy state without a consumer GET", async () => {
  const f = fixture();
  try {
    const busy = { ...f.idle, state: "running" as const, status: "running", changeMarker: 2 };
    f.summaries.mockResolvedValue({ threads: [busy] }); f.detail.mockResolvedValue({ thread: busy });
    await f.backend.beginMessageTick(["route"]);
    expect(f.roster.isBusy("route")).toBe(true);
    expect(f.checkpoint).toHaveBeenCalledTimes(1);
    expect(f.detail).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

test("marker roster: deferred details release tickets and never publish a late idle result", async () => {
  const f = fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<{ thread: ThreadDetail }>();
  try {
    await f.backend.beginMessageTick(["route"]);
    f.busy();
    const changed = { ...f.idle, changeMarker: 2, latestRunId: "next" };
    f.summaries.mockResolvedValue({ threads: [changed] });
    f.detail.mockImplementationOnce(async () => { entered.resolve(); return release.promise; });
    const tick = f.backend.beginMessageTick(["route"]); await entered.promise; await tick;
    expect(f.checkpoint).toHaveBeenCalledTimes(2);
    expect(f.finish.mock.calls.some(([, read]) => read === f.checkpoint.mock.results[1]!.value)).toBe(true);
    expect(await f.backend.sessionBusy("route")).toBe(true);
    expect(f.checkpoint).toHaveBeenCalledTimes(2);
    release.resolve({ thread: changed }); await release.promise; await Promise.resolve();
    expect(f.roster.isBusy("route")).toBe(true);
    f.detail.mockResolvedValue({ thread: changed });
    await f.backend.beginMessageTick(["route"]);
    expect(f.checkpoint).toHaveBeenCalledTimes(3);
    expect(f.roster.isBusy("route")).toBe(false);
  } finally { release.resolve({ thread: f.idle }); f.close(); }
});
