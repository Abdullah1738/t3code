import { expect, spyOn, test } from "bun:test";
import { ActiveRoster, ROSTER_REASONS } from "../src/active-roster.ts";
import { ControlClient, type ControlEventFrame, type ThreadSummary } from "../src/control.ts";
import { createRosterAggregation, ROSTER_TRIGGERS } from "../src/log-active-roster.ts";
import { toolLog, type LogLine } from "../src/toollog.ts";

const row = (id: string, extra: Partial<ThreadSummary> = {}): ThreadSummary => ({
  threadId: id, projectId: `project-${Number(id.replace(/\D/g, "")) % 4}`, title: id,
  state: "running", status: "running", origin: "imessage", nativeSessionId: `ses_${id}`,
  runtimeMode: "full-access", parentThreadId: null, rootThreadId: id, worktreePath: "/fixture",
  pendingRequest: null, createdAt: null, updatedAt: null, activeRunId: "run", latestRunId: "run", ...extra,
});

// Virtual network completions are released explicitly; no wall-clock sleeps or live services.
test("ten-minute all-project event replay prints full-list fetches by trigger", async () => {
  let clock = 0, sequence = 0;
  const server = new Map(Array.from({ length: 94 }, (_, i) => [`known-${i}`, row(`known-${i}`)]));
  const client = new ControlClient({ url: "http://127.0.0.1:1", token: "fixture" });
  const pending: { at: number; id?: string; resolve: () => void }[] = [];
  let fullLists = 0, detailReads = 0, concurrentDetails = 0, maxDetails = 0;
  const inFlight = new Set<string>();
  const aggregate = createRosterAggregation(), lines: LogLine[] = [];
  const log = spyOn(toolLog, "write").mockImplementation(entry => {
    lines.push(...aggregate.accept({ ...entry, ts: new Date(clock).toISOString(), tool: "imessage" } as LogLine));
  });
  const lists = spyOn(client, "listThreads").mockImplementation(async args => {
    expect(args).toEqual({ active: true, includeSubagents: true, limit: 500 });
    fullLists++;
    const threads = [...server.values()].filter(thread => ["running", "queued", "needs-input"].includes(thread.state)).map(thread => ({ ...thread }));
    await new Promise<void>(resolve => pending.push({ at: clock + 305, resolve }));
    return { total: threads.length, threads };
  });
  const detail = spyOn(client, "thread").mockImplementation(async id => {
    expect(inFlight.has(id)).toBe(false);
    inFlight.add(id); detailReads++; concurrentDetails++; maxDetails = Math.max(maxDetails, concurrentDetails);
    const thread = { ...server.get(id)! };
    await new Promise<void>(resolve => pending.push({ at: clock + 305, id, resolve }));
    inFlight.delete(id); concurrentDetails--;
    return { thread: { ...thread, pendingRequests: [], run: null, recentRuns: [] } };
  });
  const roster = new ActiveRoster(client, () => clock);
  roster.streamState(true);
  const event = (data: ControlEventFrame["data"]) => roster.event({ id: String(++sequence), data });
  const jobs = new Map<number, (() => void)[]>();
  const at = (time: number, job: () => void) => jobs.set(time, [...jobs.get(time) ?? [], job]);
  for (let minute = 0; minute < 10; minute++) {
    const base = minute * 60_000 + 1_000;
    for (let i = 0; i < 15; i++) {
      const id = `known-${(minute * 15 + i) % 94}`;
      at(base + i * 4_000, () => {
        server.set(id, row(id, { state: "idle", status: "idle", activeRunId: null }));
        event({ type: "thread.status", threadId: id, state: "idle", runId: "run" });
      });
      // Busy events land inside a typical 305ms full-list/detail read.
      const other = `known-${(minute * 15 + i + 40) % 94}`;
      at(base + i * 4_000 + 100, () => event({ type: "thread.status", threadId: other, state: "running", runId: "run" }));
      at(base + i * 4_000 + 2_000, () => {
        server.set(id, row(id)); event({ type: "thread.status", threadId: id, state: "running", runId: "run" });
      });
    }
    for (let i = 0; i < 10; i++) at(base + 500 + i * 5_000, () => event({ type: "thread.status", threadId: `unknown-idle-${minute}-${i}`, state: "idle" }));
    for (let i = 0; i < 3; i++) at(base + 700 + i * 20_000, () => {
      const id = `new-${minute}-${i}`;
      server.set(id, row(id, i === 2 ? { parentThreadId: "known-90", rootThreadId: "known-90" } : {}));
      event({ type: "thread.status", threadId: id, state: "running", runId: "run" });
    });
    for (const offset of [12_600, 32_600]) at(base + offset, () => event({ type: "thread.updated", threadId: "known-90", change: "thread.metadata-updated" }));
    at(base + 52_600, () => {
      const id = `created-idle-${minute}`; server.set(id, row(id, { state: "idle", status: "idle" }));
      event({ type: "thread.created", threadId: id });
    });
  }
  at(300_000, () => roster.streamState(false));
  at(304_000, () => event({ type: "ready" }));
  try {
    const startup = roster.read(true, new Map());
    clock = 400;
    for (const job of pending.splice(0)) job.resolve();
    await startup;
    for (clock = 500; clock <= 600_000; clock += 100) {
      const due = pending.filter(job => job.at <= clock);
      const completing = due.map(job => job.id ? roster["eventDetails"].get(job.id) : roster["fetching"]);
      for (const job of due) { pending.splice(pending.indexOf(job), 1); job.resolve(); }
      // Drain the exact completions released above before emitting the next timestamp's facts.
      if (due.length) {
        // Only await reads whose virtual network completion was just released.
        await Promise.all(completing);
      }
      for (const job of jobs.get(clock) ?? []) job();
      roster.view(new Map());
    }
    // The endpoint has no event; finish a final safety read if it started there.
    for (const job of pending.splice(0)) job.resolve();
    await roster["fetching"];
    lines.push(...aggregate.flush());
    const summaries = lines.filter(line => line.name === "robob.active_roster");
    const sum = (key: string) => summaries.reduce((total, line) => total + Number(line.props?.[key] ?? 0), 0);
    const fetchesByTrigger = Object.fromEntries(ROSTER_TRIGGERS.map(trigger => [trigger, sum(`fetch_${trigger}`)]).filter(([, count]) => count));
    const missesByTrigger = Object.fromEntries(ROSTER_TRIGGERS.map(trigger => [trigger, sum(`miss_${trigger}`)]).filter(([, count]) => count));
    expect(sum("fetches")).toBe(fullLists);
    expect(ROSTER_REASONS.reduce((total, reason) => total + sum(reason), 0)).toBe(fullLists);
    expect(Object.values(fetchesByTrigger).reduce<number>((a, b) => a + Number(b), 0)).toBe(sum("roster_event"));
    expect(Object.values(missesByTrigger).reduce<number>((a, b) => a + Number(b), 0)).toBe(sum("misses"));
    expect(roster.status().fetches).toBe(fullLists);
    console.log("roster replay", JSON.stringify({ minutes: 10, fullLists, listsPerMinute: fullLists / 10,
      fetchesByReason: Object.fromEntries(ROSTER_REASONS.map(reason => [reason, sum(reason)])),
      fetchesByTrigger, missesByTrigger, detailReads, detailsPerMinute: detailReads / 10, maxDetails }));
    expect(fullLists / 10).toBeLessThanOrEqual(3);
    expect(detailReads / 10).toBeLessThanOrEqual(40);
    expect(maxDetails).toBeLessThanOrEqual(2);
    expect(inFlight.size).toBe(0);
  } finally { roster.stop(); log.mockRestore(); lists.mockRestore(); detail.mockRestore(); }
});
