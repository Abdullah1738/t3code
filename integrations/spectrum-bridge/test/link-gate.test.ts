import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { ControlClient, ControlError, type PendingRequest } from "../src/control.ts";
import type { NormalizedInbound } from "../src/photon.ts";
import { RobobLinkDown, RobobLinkGate } from "../src/robob-link-gate.ts";
import { RobobBackend } from "../src/robob.ts";
import { MessageCache } from "../src/message-cache.ts";
import { ChatMirror, HttpMirrorSink, type MirrorItem } from "../src/mirror.ts";
import { Router } from "../src/router.ts";
import { ProbeBackoff, ProbeBudget } from "../src/probe-policy.ts";
import { Store } from "../src/store.ts";
import { createToolLog, toolError, toolLog } from "../src/toollog.ts";
import { summarizeLog } from "../src/log-rollup.ts";
import { captureLogs } from "./log-fixture.ts";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const start = Date.parse("2026-11-18T08:00:00Z");
const stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); setSystemTime(); });
function harness(random = 0.5, network = false, options: { storePath?: string; replies?: boolean; markers?: boolean; detailResponse?: Promise<void> } = {}) {
  let at = start, healthy = false, booting = false, healthStatus = "healthy";
  let loseReplyResponse = false, recoverBeforeLostReply = false;
  let mirrorBodyFailure: Error | undefined;
  setSystemTime(at);
  const timers: { at: number; run: () => Promise<void> }[] = [];
  const delays: number[] = [], calls: string[] = [];
  const sends: { id: string; text: string }[] = [];
  const messages: object[] = [];
  const runs: object[] = [];
  const requests: PendingRequest[] = [];
  const responses: { id: string; body: unknown }[] = [];
  const responseReceipts = new Set<string>();
  const creates: string[] = [];
  const mirrored: MirrorItem[] = [];
  const uploads: string[] = [];
  const gate = new RobobLinkGate({ skip: site => toolLog.skipRobob(site), firstAtSite: site => toolLog.robobSite(site), persistedDown: () => toolLog.robobLinkDown() }, {
    random: () => random, schedule: (run, delay) => { delays.push(delay); timers.push({ at: at + delay, run }); return {}; },
  });
  const rawFetch = globalThis.fetch;
  const handler = async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace("/api/ardud/control", ""); calls.push(path);
    if (!healthy) {
      if (booting) return Response.json({ ok: false }, { status: 503 });
      throw Object.assign(new TypeError("fetch failed"), { code: "ECONNREFUSED" });
    }
    const ok = (data: object) => Response.json({ ok: true, ...data });
    if (mirrorBodyFailure && (path === "/mirror-threads" || path === "/threads/mirror/history")) {
      const response = Response.json({});
      response.json = async () => { throw mirrorBodyFailure; };
      return response;
    }
    const thread = { model: { instanceId: "codex", model: "fixture" }, threadId: "thread", projectId: "project", title: "Chat", state: "idle", status: "idle", origin: "imessage",
      nativeSessionId: null, runtimeMode: "full-access", parentThreadId: null, rootThreadId: "thread", worktreePath: "/test/chat",
      createdAt: new Date(start).toISOString(), updatedAt: new Date(at).toISOString(), run: null, recentRuns: runs, pendingRequests: requests, pendingRequest: null };
    if (path === "/health") return ok({ status: healthStatus, time: new Date(at).toISOString() });
    if (path === "/mirror-threads") return Response.json({ threadId: "mirror" });
    if (path === "/threads/mirror/history") {
      const { items } = JSON.parse(String(init?.body)) as { items: MirrorItem[] };
      const fresh = items.filter(item => !mirrored.some(saved => saved.id === item.id));
      mirrored.push(...fresh);
      return Response.json({ appended: fresh.length, skipped: items.length - fresh.length });
    }
    if (path === "/attachments") return ok({ attachmentId: "attachment", relativeUrl: "/upload" });
    if (path === "/upload") { uploads.push(path); return Response.json({}); }
    if (path === "/projects") return ok({ projects: [{ projectId: "project", workspaceRoot: "/test/chat" }] });
    if (path === "/threads") {
      if (init?.method === "POST") {
        creates.push("thread");
        return ok({ threadId: "thread", directory: "/test/chat" });
      }
      const ids = new URL(String(url)).searchParams.get("ids")?.split(",") ?? [];
      if (options.markers && ids.length) return ok({ threads: ids.map(threadId => ({ ...thread, threadId, changeMarker: 1 })), total: ids.length });
      return ok({ threads: [], total: 0 });
    }
    if (options.markers && path === "/messages") return ok({ messages: [], nextCursor: null });
    if (options.markers && /^\/threads\/[^/]+$/.test(path)) {
      await options.detailResponse;
      return ok({ thread: { ...thread, threadId: decodeURIComponent(path.split("/")[2]!), changeMarker: 1 } });
    }
    if (path === "/threads/thread") return ok({ thread });
    if (path === "/threads/thread/messages") return ok({ messages });
    if (path.endsWith("/evidence")) return ok({ toolEvidence: "ran", complete: !!options.replies, status: options.replies ? "completed" : "running" });
    if (path.endsWith("/respond")) {
      const id = path.split("/").at(-2)!;
      const pending = requests.findIndex(request => request.requestId === id);
      if (pending === -1) return Response.json({ ok: false, error: {
        code: "conflict", reason: "request_resolved", retrySafe: false,
      } }, { status: 409 });
      const body = JSON.parse(String(init?.body)) as { clientRequestId: string };
      if (!responseReceipts.has(body.clientRequestId)) {
        responses.push({ id, body });
        responseReceipts.add(body.clientRequestId);
      }
      requests.splice(pending, 1);
      if (loseReplyResponse) {
        healthy = false;
        for (let n = 0; n < 3; n++) await client.thread("thread").catch(() => {});
        if (recoverBeforeLostReply) { healthy = true; await advance(at + 1_000); }
        throw Object.assign(new Error("response lost after acceptance"), { code: "ECONNRESET" });
      }
      return ok({});
    }
    if (path === "/threads/thread/send") {
      const body = JSON.parse(String(init?.body)) as { clientRequestId: string; text: string };
      if (!sends.some(send => send.id === body.clientRequestId)) {
        sends.push({ id: body.clientRequestId, text: body.text });
        const runId = `run:thread:thread:ordinal:${sends.length}`;
        messages.push({ messageId: `ardud-control:send:thread:${encodeURIComponent(body.clientRequestId)}`, role: "user", text: body.text,
          runId, streaming: false, createdBy: "system", createdAt: new Date(at).toISOString() });
        runs.push({ runId, ordinal: sends.length, status: options.replies ? "completed" : "running",
          ...(options.replies ? { completedAt: new Date(at + 1).toISOString() } : {}) });
        if (options.replies) {
          messages.push({ messageId: `reply-${sends.length}`, role: "assistant", text: `Reply ${sends.length}`, phase: "answer",
            runId, streaming: false, createdAt: new Date(at + 1).toISOString() });
        }
      }
      return ok({ delivery: "started" });
    }
    return ok({});
  };
  const serve = (port: number) => Bun.serve({ hostname: "127.0.0.1", port, fetch: async request => handler(request.url, {
    method: request.method, ...(request.method === "POST" ? { body: await request.text() } : {}) }) });
  let listener = network ? serve(0) : undefined;
  const url = listener?.url.origin ?? "http://127.0.0.1:1";
  const port = listener?.port;
  listener?.stop(true); listener = undefined;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (!network) return handler(input, init);
    if (!healthy) calls.push(new URL(String(input)).pathname.replace("/api/ardud/control", ""));
    return rawFetch(input, init);
  }, { preconnect: rawFetch.preconnect }));
  const fetcher = { mockRestore() { listener?.stop(true); fetchMock.mockRestore(); } };
  const client = new ControlClient({ url, token: "fixture", linkGate: gate });
  const backend = new RobobBackend({ chatRoot: "/test/chat", client, model: async () => undefined, finishes: () => new Map(), completedSteps: () => new Map(), runEvidence: () => "unknown" });
  const store = new Store(options.storePath ?? ":memory:"); stores.push(store);
  store.set("route", { id: "thread", directory: "/test/chat", generation: 1 }); store.set("routeGeneration", 1);
  const alerts: number[] = [];
  const restartRouter = () => new Router(store, backend, { read: async () => {}, typing: async () => {}, downloadAttachment: async () => { throw new Error("no files"); } }, {
    owner: "+15555550123", chatGuid: "dm:test", timezone: "Asia/Dubai", skillPath: "/missing/skill", alertSkillPath: "/missing/alert", alertSocketPath: "/missing/alert.sock", openCodeConfigRoot: "/nonexistent/config", quietMs: 0,
    context: { chat: { key: "dm:test", slug: "owner", kind: "owner", title: "owner" }, roleOf: () => ({ role: "admin", name: "owner" }), typing: () => false, react: async () => {} },
    notifyUnanswered: async () => { alerts.push(at); return true; },
  });
  const router = restartRouter();
  const input = (id: string, text = id, extra: Partial<NormalizedInbound> = {}) => store.acceptInbound(id, { id, text, source: "typed", attachments: [], isAudioMessage: false, receivedAt: at, ...extra });
  const down = async () => { for (let i = 0; i < 3; i++) await client.thread("thread").catch(() => {}); expect(backend.linkAvailable).toBe(false); };
  const advance = async (until: number) => {
    for (;;) {
      timers.sort((a,b) => a.at - b.at); if (!timers[0] || timers[0].at > until) break;
      const next = timers.shift()!; at = next.at; setSystemTime(at); await next.run();
    }
    at = until; setSystemTime(at);
  };
  return { gate, delays, calls, sends, fetcher, client, backend, store, router, restartRouter, alerts, input, down, advance, requests, responses, creates, mirrored, uploads,
    set loseReplyResponse(value: boolean) { loseReplyResponse = value; },
    set mirrorBodyFailure(value: Error | undefined) { mirrorBodyFailure = value; },
    set recoverBeforeLostReply(value: boolean) { recoverBeforeLostReply = value; },
    get at() { return at; }, set healthy(value: boolean) { healthy = value; if (network) { if (value && !listener) listener = serve(port!); if (!value) { listener?.stop(true); listener = undefined; } } }, set booting(value: boolean) { booting = value; }, set healthStatus(value: string) { healthStatus = value; } };
}

test("closed-gate marker ticks coalesce outage logs and count no physical polling GETs", async () => {
  const h = harness(0.5, false, { markers: true });
  const ids = Array.from({ length: 5 }, (_, i) => `thread-${i}`);
  try {
    const rows = await captureLogs(async () => {
      await h.down();
      for (let tick = 0; tick < 60; tick++) await h.backend.beginMessageTick(ids);
      expect(h.calls).toHaveLength(3);
      h.healthy = true; await h.advance(start + 1_000);
      await h.backend.beginMessageTick(ids);
      await h.backend.beginMessageTick(ids);
      expect(h.calls.filter(path => path === "/threads")).toHaveLength(2);
      expect(h.calls.filter(path => path === "/messages")).toHaveLength(1);
    });
    const reads = rows.filter(row => row.name === "robob.message_reads");
    const sum = (field: string) => reads.reduce((total, row) => total + Number(row.props?.[field] ?? 0), 0);
    expect(sum("markerPolls")).toBe(2);
    expect(sum("crossThreadPages")).toBe(1);
    expect(sum("fallbacks")).toBe(0);
    const up = rows.find(row => row.name === "robob.link_up")!;
    expect(up.link).toMatchObject({ skippedCalls: 60, bySite: { "robob.marker_poll": 60 } });
    expect(rows.filter(row => row.ts < up.ts && row.name === "robob.messages_read")).toEqual([]);
    expect(rows.filter(row => row.name === "robob.link_down_summary").length).toBeLessThanOrEqual(1);
  } finally { h.fetcher.mockRestore(); }
});

test.each(["marker", "first page", "next page"])("a gate closing before %s counts only admitted polling GETs", async stage => {
  const h = harness(0.5, false, { markers: true });
  const cache = new MessageCache(h.client);
  const summaries = h.client.threadSummaries.bind(h.client), messages = h.client.crossThreadMessages.bind(h.client);
  const intercepts = [
    spyOn(h.client, "threadSummaries").mockImplementation(async ids => {
      if (stage === "marker") { h.healthy = false; await h.down(); }
      return summaries(ids);
    }),
    spyOn(h.client, "crossThreadMessages").mockImplementation(async options => {
      if (stage === "first page" || options.cursor) { h.healthy = false; await h.down(); }
      const page = await messages(options);
      return stage === "next page" ? { ...page, nextCursor: "page2" } : page;
    }),
  ];
  try {
    const rows = await captureLogs(async () => {
      h.healthy = true;
      await cache.beginTick(["thread"]);
      expect(h.gate.available).toBe(false);
      expect(await cache.prepared("thread")).toBe(false);
      await cache.beginTick(["thread"]);
      await expect(cache.read("thread", "fallback")).rejects.toBeInstanceOf(RobobLinkDown);
    });
    const reads = rows.filter(row => row.name === "robob.message_reads");
    const sum = (field: string) => reads.reduce((total, row) => total + Number(row.props?.[field] ?? 0), 0);
    expect(sum("markerPolls")).toBe(stage === "marker" ? 0 : 1);
    expect(sum("crossThreadReads")).toBe(stage === "next page" ? 1 : 0);
    expect(sum("crossThreadPages")).toBe(stage === "next page" ? 1 : 0);
    expect(sum("fullReads") + sum("incrementalReads") + sum("fallbacks")).toBe(0);
    expect(h.calls.filter(path => path === "/threads")).toHaveLength(stage === "marker" ? 0 : 1);
    expect(h.calls.filter(path => path === "/messages")).toHaveLength(stage === "next page" ? 1 : 0);
  } finally { intercepts.forEach(intercept => intercept.mockRestore()); h.fetcher.mockRestore(); }
});

test.each(["before", "after"])("three failures %s any successful detail keep the outage and physical counts", async order => {
  const release = Promise.withResolvers<void>();
  const h = harness(0.5, false, { markers: true, detailResponse: release.promise });
  const cache = new MessageCache(h.client), read = h.client.thread.bind(h.client);
  let succeeded = false;
  const detail = spyOn(h.client, "thread").mockImplementation(async (...args) => {
    const response = read(...args);
    const fail = async () => {
      h.healthy = false;
      for (let i = 0; i < 3; i++) await read("failed-probe").catch(() => {});
      expect(h.gate.available).toBe(false);
    };
    if (order === "before") { await fail(); expect(succeeded).toBe(false); }
    release.resolve();
    const result = await response; succeeded = true;
    if (order === "after") await fail();
    expect(h.gate.available).toBe(false);
    return result;
  });
  try {
    const rows = await captureLogs(async () => {
      h.healthy = true;
      await cache.beginTick(["thread"]);
      expect(succeeded).toBe(true);
      expect(h.gate.available).toBe(false);
      expect(await cache.prepared("thread")).toBe(false);
      await cache.beginTick(["thread"]);
      await expect(cache.read("thread", "fallback")).rejects.toBeInstanceOf(RobobLinkDown);
    });
    const reads = rows.filter(row => row.name === "robob.message_reads");
    const sum = (field: string) => reads.reduce((total, row) => total + Number(row.props?.[field] ?? 0), 0);
    expect(sum("markerPolls")).toBe(1);
    expect(sum("crossThreadReads") + sum("crossThreadPages") + sum("fallbacks") + sum("fullReads") + sum("incrementalReads")).toBe(0);
    expect(h.calls.filter(path => path === "/threads")).toHaveLength(1);
    expect(h.calls.filter(path => path === "/messages")).toHaveLength(0);
    expect(rows.filter(row => row.name === "robob.link_down_summary").length).toBeLessThanOrEqual(1);
  } finally { release.resolve(); detail.mockRestore(); h.fetcher.mockRestore(); }
});

test("a gate refusal during a prepared transcript rebuild remains outage uncertainty", async () => {
  const h = harness(0.5, false, { markers: true });
  const cache = new MessageCache(h.client);
  try {
    const rows = await captureLogs(async () => {
      h.healthy = true;
      await cache.beginTick(["thread"]);
      await cache.beginTick(["thread"]);
      expect(await cache.prepared("thread")).toBe(true);
      h.healthy = false; await h.down();
      await expect(cache.read("thread", "missing-until", () => false)).rejects.toBeInstanceOf(RobobLinkDown);
      expect(await cache.prepared("thread")).toBe(false);
    });
    const reads = rows.filter(row => row.name === "robob.message_reads");
    const sum = (field: string) => reads.reduce((total, row) => total + Number(row.props?.[field] ?? 0), 0);
    expect(sum("markerPolls")).toBe(2);
    expect(sum("crossThreadPages")).toBe(1);
    expect(sum("fallbacks") + sum("fullReads") + sum("incrementalReads")).toBe(0);
    expect(h.calls.filter(path => path === "/messages")).toHaveLength(1);
  } finally { h.fetcher.mockRestore(); }
});

test.each([false, true].flatMap(retry => [false, true].map(split => ({ retry, split }))))(
  "a racing gate refusal cancels probe telemetry and refunds only its retry slot (retry=$retry split=$split)", async ({ retry, split }) => {
    const h = harness();
    const policy = new ProbeBackoff(h.store), budget = new ProbeBudget(h.store);
    const promptKey = "prompt:thread:original-prompt";
    try {
      const rows = await captureLogs(async () => {
        if (retry) {
          policy.reserve("original", promptKey); policy.failed("original"); policy.failed(promptKey);
          await h.advance(start + 60_000);
        }
        h.input("original", "Original message", { receivedAt: h.at - 120_000 });
        h.input("later", "Later message");
        h.store.updateInbound("original", "processing");
        const sealed = { id: "thread", directory: "/test/chat", generation: 1, inboundId: "original",
          messageId: "original-prompt", earlier: ["earlier-prompt"], startedAt: h.at - 120_000, phase: "unknown" };
        h.store.set("failed-delivery:original", sealed);
        expect(budget.take(h.at - 2)).toBe(true);
        expect(budget.take(h.at - 1)).toBe(true);
        const refusedAt = h.at;
        let leases: { leader: ReturnType<ProbeBackoff["get"]>; prompt: ReturnType<ProbeBackoff["get"]> };
        const accepted = h.backend.promptAccepted.bind(h.backend);
        const race = spyOn(h.backend, "promptAccepted").mockImplementation(async (...args) => {
          expect(budget.take()).toBe(true); // A different router reserves in the same millisecond.
          if (split) policy.split("original", ["original", "member"]);
          leases = { leader: policy.get("original"), prompt: policy.get(promptKey) };
          h.healthy = false; await h.down();
          return accepted(...args);
        });
        try { await h.router.checkInboundLatency(); } finally { race.mockRestore(); }
        expect(h.calls).toHaveLength(3);
        expect(h.sends).toEqual([]);
        expect(h.store.pendingInbound().map(row => [row.id, row.state])).toEqual([["original", "processing"], ["later", "pending"]]);
        expect(h.store.get<typeof sealed>("failed-delivery:original")).toEqual(sealed);
        expect(h.store.get("human-retry-prompt:original")).toBeUndefined();
        expect(h.store.get<number[]>("replay-probe-starts")).toEqual([refusedAt - 2, refusedAt - 1, refusedAt]);
        if (split) {
          expect(policy.get("original")).toEqual(leases!.leader);
          expect(policy.get(promptKey)).toEqual(leases!.prompt);
        } else {
          expect(policy.get("original")).toMatchObject({ delay: retry ? 60_000 : 0, nextAt: 0 });
          expect(policy.get(promptKey)).toMatchObject({ delay: retry ? 60_000 : 0, nextAt: 0 });
        }
        for (let n = 0; n < 3; n++) await h.router.checkInboundLatency();
        expect(h.calls).toHaveLength(3);
        h.healthy = true; await h.advance(refusedAt + 60_000);
        const recovered = spyOn(h.backend, "promptAccepted").mockResolvedValue(true);
        try { await h.router.checkInboundLatency(); } finally { recovered.mockRestore(); }
        expect(h.sends).toEqual([]);
        expect(h.store.pendingInbound().map(row => row.id)).toEqual(["later"]);
      });
      expect(rows.filter(row => row.name === "router.probe_backoff")).toEqual([]);
      expect(rows.filter(row => row.error?.tag === "router.catch1").every(row => row.props?.causeKind === undefined)).toBe(true);
      expect(rows.filter(row => row.promptProbe).map(row => row.promptProbe)).toEqual([
        expect.objectContaining({ calls: 1, accepted: 1, transport: 0, http: 0, timeout: 0, notAcceptedYet: 0, attempts: [[1, 1]] }),
      ]);
      const up = rows.find(row => row.name === "robob.link_up")?.link;
      expect(up).toMatchObject({ failedCalls: 3, skippedCalls: 4 });
      expect(up?.failedProbes ?? 0).toBe(0);
      const summary = await summarizeLog((async function* () { yield* rows; })());
      expect(summary.topCauses).toEqual([{ tag: "robob.link_down", causeKey: "robob_unavailable", count: 1 }]);
      expect(summary.promptProbe).toMatchObject({ calls: 1, accepted: 1, transport: 0 });
    } finally { h.fetcher.mockRestore(); }
  },
);

test.each([false, true])("a real failed probe that closes the gate retains telemetry and backoff (retry=%s)", async retry => {
  const h = harness();
  const policy = new ProbeBackoff(h.store);
  try {
    const rows = await captureLogs(async () => {
      if (retry) {
        policy.reserve("original"); policy.failed("original");
        await h.advance(start + 60_000);
      }
      h.input("original", "Original message", { receivedAt: h.at - 120_000 });
      h.store.updateInbound("original", "processing");
      h.store.set("failed-delivery:original", { id: "thread", directory: "/test/chat", generation: 1,
        inboundId: "original", messageId: "original-prompt", startedAt: h.at - 120_000, phase: "unknown" });
      for (let n = 0; n < 2; n++) await h.client.thread("thread").catch(() => {});
      expect(h.gate.available).toBe(true);
      await h.router.checkInboundLatency();
      expect(h.gate.available).toBe(false);
      expect(h.calls).toHaveLength(3);
      expect(policy.get("original")).toMatchObject({ delay: retry ? 120_000 : 60_000, nextAt: h.at + (retry ? 120_000 : 60_000) });
      expect(h.store.get<number[]>("replay-probe-starts") ?? []).toEqual(retry ? [h.at] : []);
      expect(h.store.pendingInbound().map(row => row.state)).toEqual(["processing"]);
      h.healthy = true; await h.advance(h.at + (retry ? 120_000 : 60_000));
      const recovered = spyOn(h.backend, "promptAccepted").mockResolvedValue(true);
      try { await h.router.checkInboundLatency(); } finally { recovered.mockRestore(); }
      expect(h.sends).toEqual([]);
      expect(h.store.pendingInbound()).toEqual([]);
    });
    expect(rows.find(row => row.error?.tag === "router.catch1")).toMatchObject({ alreadyLogged: true, props: { causeKind: "transport", attempt: 1 } });
    const summary = await summarizeLog((async function* () { yield* rows; })());
    expect(summary.promptProbe).toMatchObject({ calls: 2, transport: 1, accepted: 1, attempts: { count: 1, max: 2 } });
    expect(summary.topCauses.filter(cause => cause.tag === "robob.link_down")).toEqual([{ tag: "robob.link_down", causeKey: "robob_unavailable", count: 1 }]);
    expect(summary.topErrorTags.filter(error => error.tag === "router.catch1" || error.tag === "control.request_failed")).toEqual([]);
  } finally { h.fetcher.mockRestore(); }
});

test("mirror creation, history and uploads share the closed Robob gate", async () => {
  const h = harness();
  try {
    await captureLogs(async () => {
      const sink = new HttpMirrorSink({ url: h.client.url, token: "fixture", linkGate: h.gate });
      await h.down();
      expect(sink.linkAvailable).toBe(false);
      const signal = new AbortController().signal;
      await expect(sink.ensure(signal)).rejects.toBeInstanceOf(RobobLinkDown);
      await expect(sink.append("mirror", [], signal)).rejects.toBeInstanceOf(RobobLinkDown);
      await expect(sink.upload({ name: "x.pdf", mimeType: "application/pdf", bytes: Buffer.from("file") }, signal)).rejects.toBeInstanceOf(RobobLinkDown);
      expect(h.calls).toHaveLength(3);
      h.healthy = true; await h.advance(start + 1_000);
      expect(sink.linkAvailable).toBe(true);
      await expect(sink.ensure(signal)).resolves.toEqual({ threadId: "mirror" });
      await expect(sink.append("mirror", [], signal)).resolves.toEqual({ appended: 0, skipped: 0 });
      await expect(sink.upload({ name: "x.pdf", mimeType: "application/pdf", bytes: Buffer.from("file") }, signal)).resolves.toMatchObject({ attachmentId: "attachment" });
      expect(h.uploads).toHaveLength(1);
    });
  } finally { h.fetcher.mockRestore(); }
});

test.each([{ code: "not_mirror" }, { error: { code: "not_mirror" } }])("mirror direct responses retain definitive refusal codes: %j", async body => {
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json(body, { status: 409 }), { preconnect: globalThis.fetch.preconnect }));
  try {
    await captureLogs(async () => {
      const sink = new HttpMirrorSink({ url: "http://127.0.0.1:1", token: "fixture", linkGate: false });
      await expect(sink.append("mirror", [], new AbortController().signal)).rejects.toMatchObject({ name: "ControlError", status: 409, code: "not_mirror" });
    });
  } finally { fetcher.mockRestore(); }
});

test.each([
  { method: "ensure", cause: "ECONNRESET" }, { method: "ensure", cause: "TimeoutError" },
  { method: "append", cause: "ECONNRESET" }, { method: "append", cause: "TimeoutError" },
] as const)("mirror $method body $cause closes the gate after three failures", async ({ method, cause }) => {
  const h = harness();
  try {
    const logs = await captureLogs(async () => {
      h.healthy = true;
      h.mirrorBodyFailure = cause === "TimeoutError" ? new DOMException("body timed out", "TimeoutError")
        : Object.assign(new Error("body reset"), { code: cause });
      const sink = new HttpMirrorSink({ url: h.client.url, token: "fixture", linkGate: h.gate });
      const signal = new AbortController().signal;
      const call = () => method === "ensure" ? sink.ensure(signal) : sink.append("mirror", [], signal);
      for (let n = 0; n < 3; n++) await expect(call()).rejects.toMatchObject({ name: "ControlError", status: 200 });
      expect(sink.linkAvailable).toBe(false);
      await expect(call()).rejects.toBeInstanceOf(RobobLinkDown);
      expect(h.calls).toHaveLength(3);
      h.mirrorBodyFailure = undefined;
      await h.advance(start + 1_000);
      expect(sink.linkAvailable).toBe(true);
      await expect(call()).resolves.toBeDefined();
    });
    expect(logs.filter(row => row.name === "robob.link_down")).toHaveLength(1);
    expect(logs.filter(row => row.name === "turn.robob_call" && row.ok && row.props?.route !== "/health")).toHaveLength(1);
  } finally { h.fetcher.mockRestore(); }
});

test.each(["ensure", "upload", "append"] as const)("mirror holds ordered work when the gate closes immediately before %s", async stage => {
  const h = harness();
  try {
    const logs = await captureLogs(async () => {
      h.healthy = true;
      const sink = new HttpMirrorSink({ url: h.client.url, token: "fixture", linkGate: h.gate });
      const mirror = new ChatMirror(h.store, sink, { now: () => h.at });
      const sha256 = h.store.putBlob(Buffer.from("file"));
      mirror.inbound("first", { text: "First", attachments: [{ sha256, fileName: "x.pdf", mimeType: "application/pdf" }] });
      mirror.outbound("second", "Second", undefined);
      const close = async (method: typeof stage) => { if (method === stage) { h.healthy = false; await h.down(); } };
      const ensure = sink.ensure.bind(sink), upload = sink.upload.bind(sink), append = sink.append.bind(sink);
      const intercepts = [
        spyOn(sink, "ensure").mockImplementation(async (...args) => { await close("ensure"); return ensure(...args); }),
        spyOn(sink, "upload").mockImplementation(async (...args) => { await close("upload"); return upload(...args); }),
        spyOn(sink, "append").mockImplementation(async (...args) => { await close("append"); return append(...args); }),
      ];
      try { await mirror.tick(); } finally { intercepts.forEach(intercept => intercept.mockRestore()); }
      const before = h.calls.length;
      for (let n = 0; n < 20; n++) await mirror.tick();
      expect(h.calls).toHaveLength(before);
      expect(h.mirrored).toEqual([]);
      expect(h.store.db.query("SELECT id,attempt,rejected,next_at FROM mirror_items WHERE payload IS NOT NULL ORDER BY seq").all()).toEqual([
        { id: "first", attempt: 0, rejected: 0, next_at: 0 }, { id: "send:second", attempt: 0, rejected: 0, next_at: 0 },
      ]);
      h.healthy = true; await h.advance(start + 1_000);
      await mirror.tick(); await mirror.tick(); await mirror.tick();
      expect(h.mirrored.map(item => item.id)).toEqual(["first", "send:second"]);
      expect(h.mirrored[0]?.attachments).toEqual([{ attachmentId: "attachment" }]);
      expect(h.calls.filter(path => path === "/threads/mirror/history")).toHaveLength(2);
      expect(h.uploads).toHaveLength(1);
      expect(h.store.db.query("SELECT id FROM mirror_items WHERE payload IS NOT NULL").all()).toEqual([]);
    });
    expect(logs.filter(row => row.component === "mirror" && (row.name === "mirror-fail" || row.ok === false))).toEqual([]);
  } finally { h.fetcher.mockRestore(); }
});

type ReplyForm = { name: string; kind: "approval" | "question"; text: string; body: object; poll?: boolean; multiple?: boolean; steps?: boolean };
const replyForms: ReplyForm[] = [
  { name: "plain yes", kind: "approval", text: "yes", body: { decision: "approve" } },
  { name: "plain no", kind: "approval", text: "no", body: { decision: "deny" } },
  { name: "explicit approve", kind: "approval", text: "/approve request once", body: { decision: "approve" } },
  { name: "explicit reject", kind: "approval", text: "/approve request reject", body: { decision: "deny" } },
  { name: "question label", kind: "question", text: "A", body: { answers: { q0: "A" } } },
  { name: "question number", kind: "question", text: "1", body: { answers: { q0: "A" } } },
  { name: "custom answer", kind: "question", text: "Free answer", body: { answers: { q0: "Free answer" } } },
  { name: "multiple choices", kind: "question", text: "1, 2", multiple: true, body: { answers: { q0: ["A", "B"] } } },
  { name: "explicit answer", kind: "question", text: '/answer request [["A"]]', body: { answers: { q0: "A" } } },
  { name: "explicit multiple", kind: "question", text: '/answer request [["A","B"]]', multiple: true, body: { answers: { q0: ["A", "B"] } } },
  { name: "poll vote", kind: "question", text: "A", poll: true, body: { answers: { q0: "A" } } },
  { name: "last form step", kind: "question", text: "B", steps: true, body: { answers: { q0: "A", q1: "B" } } },
];

async function prepareAnswer(h: ReturnType<typeof harness>, form: ReplyForm): Promise<void> {
  h.healthy = true;
  h.input("first"); await h.router.tick();
  const question = (n: number) => ({ id: `q${n}`, header: "Pick", question: "Which?", options: [{ label: "A" }, { label: "B" }], multiSelect: form.multiple, allowCustomAnswer: true });
  h.requests.push({ requestId: "request", kind: form.kind, requestKind: form.kind, title: "Pick", prompt: "git status", canRespond: true,
    ...(form.kind === "question" ? { questions: form.steps ? [question(0), question(1)] : [question(0)] } : {}) });
  await h.router.checkCompletion();
  await h.router.tick();
  const deliver = () => { for (const op of h.store.pendingOutbox()) h.store.outboxState(op.id, "sent"); };
  deliver();
  if (form.steps) { h.input("step-one", "A"); await h.router.tick(); deliver(); }
  const pending = h.store.get<{ prompt: string; state: string }[]>("pendingApprovals")!;
  expect(pending.some(entry => entry.state === "pending")).toBe(true);
  h.input("answer", form.text, form.poll ? { source: "composed", poll: {
    guid: "poll", optionIdentifier: "A", optionText: "A", vote: "voted", operationId: pending.find(entry => entry.state === "pending")!.prompt,
  } } : {});
  h.input("after", "Later message");
}

test.each(replyForms.flatMap(form => ["validation", "reply POST"].map(stage => ({ ...form, stage }))))(
  "$name holds when the gate closes before $stage, then responds once",
  async form => {
    const h = harness();
    try {
      await captureLogs(async () => {
        await prepareAnswer(h, form);
        const closeGate = async () => { h.healthy = false; await h.down(); };
        const permissions = h.backend.permissions.bind(h.backend), questions = h.backend.questions.bind(h.backend);
        const permissionReply = h.backend.permissionReply.bind(h.backend), questionReply = h.backend.questionReply.bind(h.backend);
        const intercept = form.stage === "validation"
          ? form.kind === "approval"
            ? spyOn(h.backend, "permissions").mockImplementation(async (...args) => { await closeGate(); return permissions(...args); })
            : spyOn(h.backend, "questions").mockImplementation(async (...args) => { await closeGate(); return questions(...args); })
          : form.kind === "approval"
            ? spyOn(h.backend, "permissionReply").mockImplementation(async (...args) => { await closeGate(); return permissionReply(...args); })
            : spyOn(h.backend, "questionReply").mockImplementation(async (...args) => { await closeGate(); return questionReply(...args); });
        try { await expect(h.router.tick()).rejects.toBeInstanceOf(RobobLinkDown); }
        finally { intercept.mockRestore(); }
        expect(h.store.pendingInbound().map(row => [row.id, row.state])).toEqual([["answer", form.stage === "validation" ? "pending" : "processing"], ["after", "pending"]]);
        expect(h.store.get<{ state: string }[]>("pendingApprovals")![0]!.state).toBe(form.stage === "validation" ? "pending" : "submitting");
        if (form.stage === "reply POST") expect(h.store.get("steer-attempt:answer")).toMatchObject({ response: { linkRetry: true, retry: { request: { id: "request" } } } });
        expect(h.responses).toEqual([]);
        expect(h.sends).toHaveLength(1);
        expect(h.store.pendingOutbox().filter(op => op.replyTo === "answer")).toEqual([]);
        h.healthy = true; await h.advance(start + 1_000);
        await h.router.tick(); await h.router.tick();
        expect(h.responses).toHaveLength(1);
        expect(h.responses[0]).toMatchObject({ id: "request", body: form.body });
        expect(h.calls.filter(path => path.endsWith("/respond"))).toHaveLength(1);
        expect(h.store.db.query("SELECT id FROM inbound WHERE state IN ('failed','unknown')").all()).toEqual([]);
        expect(h.store.db.query<{ state: string }, []>("SELECT state FROM inbound WHERE id = 'answer'").get()?.state).toBe("admitted");
      });
    } finally { h.fetcher.mockRestore(); }
  },
);

test.each(replyForms.flatMap(form => [false, true].map(restart => ({ ...form, restart }))))(
  "$name resumes the sealed response when its refused POST closes the gate (restart=$restart)", async form => {
  const h = harness();
  try {
    await captureLogs(async () => {
      await prepareAnswer(h, form);
      const respond = h.client.respond.bind(h.client);
      let original: Parameters<typeof respond> | undefined;
      const intercept = spyOn(h.client, "respond").mockImplementation(async (...args) => {
        original = args;
        h.healthy = false;
        for (let n = 0; n < 2; n++) await h.client.thread("thread").catch(() => {});
        return respond(...args);
      });
      try { await h.router.tick(); } finally { intercept.mockRestore(); }
      expect(h.gate.available).toBe(false);
      expect(h.responses).toEqual([]);
      expect(h.store.pendingInbound().map(row => [row.id, row.state])).toEqual([["answer", "processing"], ["after", "pending"]]);
      expect(h.store.get("steer-attempt:answer")).toMatchObject({ response: { linkUncertain: true, operation: { request: { id: "request" } } } });
      h.input("status", "/status");
      const router = form.restart ? h.restartRouter() : h.router;
      const before = h.calls.length;
      await router.tick();
      expect(h.calls).toHaveLength(before);
      h.healthy = true; await h.advance(start + 1_000);
      const ordered = spyOn(h.client, "respond").mockImplementation(async (...args) => {
        expect(args).toEqual(original!);
        expect(h.store.pendingOutbox().filter(op => op.replyTo === "status")).toEqual([]);
        expect(h.sends.map(send => send.text)).toEqual(["first"]);
        return respond(...args);
      });
      try { await router.tick(); await router.tick(); } finally { ordered.mockRestore(); }
      expect(h.responses).toHaveLength(1);
      expect(h.responses[0]).toEqual({ id: "request", body: original![2] });
      expect(h.responses[0]!.body).toMatchObject(form.body);
      expect(h.calls.filter(path => path.endsWith("/respond"))).toHaveLength(2);
      expect(h.requests).toEqual([]);
      expect(h.store.db.query<{ state: string }, []>("SELECT state FROM inbound WHERE id = 'answer'").get()?.state).toBe("admitted");
      expect(h.store.get("steer-attempt:answer")).toBeNull();
      expect(h.store.pendingOutbox().filter(op => op.replyTo === "status")).toHaveLength(1);
      expect(h.sends.map(send => send.text)).toEqual(["first", "Later message"]);
      expect(h.store.db.query("SELECT id FROM inbound WHERE state IN ('failed','unknown')").all()).toEqual([]);
    });
  } finally { h.fetcher.mockRestore(); }
});

test.each(replyForms)("$name keeps submission uncertainty when an accepted POST loses its response", async form => {
  const h = harness();
  try {
    await captureLogs(async () => {
      await prepareAnswer(h, form);
      h.loseReplyResponse = true;
      await h.router.tick();
      expect(h.gate.available).toBe(false);
      expect(h.responses).toHaveLength(1);
      expect(h.responses[0]).toMatchObject({ id: "request", body: form.body });
      expect(h.store.get<{ state: string; submittedAt: number }[]>("pendingApprovals")![0]).toMatchObject({ state: "unknown", submittedAt: start });
      expect(h.store.pendingInbound().map(row => [row.id, row.state])).toEqual([["answer", "processing"], ["after", "pending"]]);
      const retained = h.store.get<{ response: { retry?: unknown } }>("steer-attempt:answer");
      expect(retained).toMatchObject({ response: { linkUncertain: true, operation: { request: { id: "request" } } } });
      expect(retained!.response.retry).toBeUndefined();
      const router = h.restartRouter();
      const calls = h.calls.length;
      await router.tick();
      expect(h.calls).toHaveLength(calls);
      expect(h.store.get<typeof retained>("steer-attempt:answer")).toEqual(retained);
      h.healthy = true; await h.advance(start + 1_000);
      await router.tick(); await router.tick();
      await h.advance(start + 61_000);
      await router.checkCompletion(); await router.tick();
      expect(h.responses).toHaveLength(1);
      expect(h.calls.filter(path => path.endsWith("/respond"))).toHaveLength(1);
      expect(h.sends.map(send => send.text)).toEqual(["first", "Later message"]);
      expect(h.store.db.query<{ state: string }, []>("SELECT state FROM inbound WHERE id = 'answer'").get()?.state).toBe("processing");
      expect(h.store.get<typeof retained>("steer-attempt:answer")).toEqual(retained);
    });
  } finally { h.fetcher.mockRestore(); }
});

test.each([replyForms[0]!, replyForms[4]!])("$name reuses the response receipt when a pending read races an accepted operation", async form => {
  const h = harness();
  try {
    await captureLogs(async () => {
      await prepareAnswer(h, form);
      const pending = h.requests[0]!;
      const respond = h.client.respond.bind(h.client);
      const attempts: Parameters<typeof respond>[] = [];
      const intercept = spyOn(h.client, "respond").mockImplementation(async (...args) => { attempts.push(args); return respond(...args); });
      try {
        h.loseReplyResponse = true;
        await h.router.tick();
        expect(h.gate.available).toBe(false);
        expect(h.responses).toHaveLength(1);
        // Robob's command receipt can precede the pending-request projection.
        h.requests.push(pending);
        h.loseReplyResponse = false;
        h.healthy = true; await h.advance(start + 1_000);
        const router = h.restartRouter(); await router.tick(); await router.tick();
        expect(attempts).toHaveLength(2);
        expect(attempts[1]).toEqual(attempts[0]);
        expect(h.calls.filter(path => path.endsWith("/respond"))).toHaveLength(2);
        expect(h.responses).toHaveLength(1);
        expect(h.store.get("steer-attempt:answer")).toBeNull();
        expect(h.sends.map(send => send.text)).toEqual(["first", "Later message"]);
        expect(h.store.db.query("SELECT id FROM inbound WHERE state IN ('failed','unknown')").all()).toEqual([]);
      } finally { intercept.mockRestore(); }
    });
  } finally { h.fetcher.mockRestore(); }
});

test.each(replyForms.flatMap(form => ["request_resolved", "gate refusal", "retry-safe refusal"].map(stage => ({ ...form, stage }))))(
  "$name keeps the earlier uncertain POST fenced when it commits before a $stage retry (with restarts)", async form => {
  const h = harness();
  try {
    await captureLogs(async () => {
      await prepareAnswer(h, form);
      const respond = h.client.respond.bind(h.client);
      let original: Parameters<typeof respond> | undefined;
      const lost = spyOn(h.client, "respond").mockImplementation(async (...args) => {
        original = args;
        h.healthy = false; await h.down();
        throw new ControlError(0);
      });
      try { await h.router.tick(); } finally { lost.mockRestore(); }
      expect(h.responses).toEqual([]);
      expect(h.gate.available).toBe(false);
      h.healthy = true; await h.advance(start + 1_000);
      const resolved = h.backend.responseResolved.bind(h.backend);
      let first = true;
      const read = spyOn(h.backend, "responseResolved").mockImplementation(async (...args) => {
        const result = await resolved(...args);
        if (first) {
          first = false;
          expect(result).toBe(false);
          await respond(...original!);
          if (form.stage === "gate refusal") { h.healthy = false; await h.down(); }
        }
        return result;
      });
      let attempts = 0;
      const retry = spyOn(h.client, "respond").mockImplementation(async (...args) => {
        attempts++;
        expect(args).toEqual(original!);
        if (form.stage === "retry-safe refusal") throw new ControlError(503, "unavailable", { reason: "startup_unavailable", retrySafe: true });
        return respond(...args);
      });
      try {
        const router = h.restartRouter();
        if (form.stage === "gate refusal") {
          await expect(router.tick()).rejects.toBeInstanceOf(RobobLinkDown);
          expect(h.store.get("steer-attempt:answer")).toMatchObject({ response: { linkUncertain: true, retry: { request: { id: "request" } } } });
          h.healthy = true; await h.advance(start + 2_000);
        } else await router.tick();
        const restarted = h.restartRouter();
        await restarted.tick(); await restarted.tick();
        const retained = h.store.get<{ response: { retry?: unknown } }>("steer-attempt:answer");
        expect(retained).toMatchObject({ response: { linkUncertain: true, operation: { request: { id: "request" } } } });
        expect(retained!.response.retry).toBeUndefined();
        expect(h.responses).toEqual([{ id: "request", body: original![2] }]);
        expect(h.responses[0]!.body).toMatchObject(form.body);
        expect(attempts).toBe(form.stage === "gate refusal" ? 2 : 1);
        h.store.set("activeTurn", null);
        await restarted.tick(); await restarted.tick();
        expect(h.sends.map(send => send.text)).toEqual(["first", "Later message"]);
        expect(h.store.db.query<{ state: string }, []>("SELECT state FROM inbound WHERE id = 'answer'").get()?.state).toBe("processing");
        expect(h.store.get<typeof retained>("steer-attempt:answer")).toEqual(retained);
        expect(h.store.db.query("SELECT id FROM inbound WHERE state IN ('failed','unknown')").all()).toEqual([]);
      } finally { retry.mockRestore(); read.mockRestore(); }
    });
  } finally { h.fetcher.mockRestore(); }
});

test.each(replyForms)("$name keeps first-POST uncertainty when the probe recovers before its receipt is lost", async form => {
  const h = harness();
  try {
    await captureLogs(async () => {
      await prepareAnswer(h, form);
      h.loseReplyResponse = true; h.recoverBeforeLostReply = true;
      await h.router.tick();
      expect(h.gate.available).toBe(true);
      expect(h.responses).toHaveLength(1);
      expect(h.responses[0]).toMatchObject({ id: "request", body: form.body });
      const retained = h.store.get<{ response: { retry?: unknown } }>("steer-attempt:answer");
      expect(retained).toMatchObject({ response: { linkUncertain: true, operation: { request: { id: "request" } } } });
      expect(retained!.response.retry).toBeUndefined();
      const router = h.restartRouter();
      await router.tick(); await router.tick();
      await h.advance(start + 61_000); await router.checkCompletion(); await router.tick();
      expect(h.responses).toHaveLength(1);
      expect(h.calls.filter(path => path.endsWith("/respond"))).toHaveLength(1);
      expect(h.sends.map(send => send.text)).toEqual(["first", "Later message"]);
      expect(h.store.db.query<{ state: string }, []>("SELECT state FROM inbound WHERE id = 'answer'").get()?.state).toBe("processing");
      expect(h.store.get<typeof retained>("steer-attempt:answer")).toEqual(retained);
    });
  } finally { h.fetcher.mockRestore(); }
});

test.each([replyForms[0]!, replyForms[4]!])("$name retains a gate-held response through restart and another retry refusal ahead of later controls", async form => {
  const h = harness();
  try {
    await captureLogs(async () => {
      await prepareAnswer(h, form);
      const respond = h.client.respond.bind(h.client);
      const refuse = () => spyOn(h.client, "respond").mockImplementation(async (...args) => {
        h.healthy = false; await h.down(); return respond(...args);
      });
      let intercept = refuse();
      try { await expect(h.router.tick()).rejects.toBeInstanceOf(RobobLinkDown); }
      finally { intercept.mockRestore(); }
      const retained = h.store.get<{ response: { retry: unknown } }>("steer-attempt:answer")!.response.retry;
      h.input("status", "/status");
      h.healthy = true; await h.advance(start + 1_000);
      intercept = refuse();
      try { await expect(h.restartRouter().tick()).rejects.toBeInstanceOf(RobobLinkDown); }
      finally { intercept.mockRestore(); }
      expect(h.store.get<{ response: { retry: unknown } }>("steer-attempt:answer")!.response.retry).toEqual(retained);
      expect(h.store.pendingInbound().map(row => [row.id, row.state])).toEqual([["answer", "processing"], ["after", "pending"], ["status", "pending"]]);
      expect(h.responses).toEqual([]);
      h.healthy = true; await h.advance(start + 2_000);
      const ordered = spyOn(h.client, "respond").mockImplementation(async (...args) => {
        expect(h.store.pendingOutbox().filter(op => op.replyTo === "status")).toEqual([]);
        return respond(...args);
      });
      try { await h.restartRouter().tick(); } finally { ordered.mockRestore(); }
      expect(h.responses).toHaveLength(1);
      expect(h.responses[0]).toMatchObject({ id: "request", body: { ...form.body, inboundId: "answer" } });
      expect(h.store.pendingOutbox().filter(op => op.replyTo === "status")).toHaveLength(1);
      expect(h.sends.map(send => send.text)).toEqual(["first", "Later message"]);
      expect(h.store.db.query("SELECT id FROM inbound WHERE state IN ('failed','unknown')").all()).toEqual([]);
    });
  } finally { h.fetcher.mockRestore(); }
});

test.each([replyForms[0]!, replyForms[4]!])("$name retains response preflight through gate refusal and restart", async form => {
  const h = harness();
  try {
    await captureLogs(async () => {
      await prepareAnswer(h, form);
      const messages = h.backend.messages.bind(h.backend);
      const intercept = spyOn(h.backend, "messages").mockImplementation(async (...args) => {
        h.healthy = false; await h.down(); return messages(...args);
      });
      try { await expect(h.router.tick()).rejects.toBeInstanceOf(RobobLinkDown); }
      finally { intercept.mockRestore(); }
      expect(h.store.get("steer-attempt:answer")).toMatchObject({ response: { preflight: true, linkRetry: true, retry: { request: { id: "request" } } } });
      expect(h.store.pendingInbound().map(row => [row.id, row.state])).toEqual([["answer", "processing"], ["after", "pending"]]);
      expect(h.responses).toEqual([]);
      h.healthy = true; await h.advance(start + 1_000);
      const router = h.restartRouter(); await router.tick(); await router.tick();
      expect(h.responses).toHaveLength(1);
      expect(h.responses[0]).toMatchObject({ id: "request", body: form.body });
      expect(h.store.db.query("SELECT id FROM inbound WHERE state IN ('failed','unknown')").all()).toEqual([]);
    });
  } finally { h.fetcher.mockRestore(); }
});

test.each([replyForms[0]!, replyForms[4]!])("$name consumes pre-send retry permission before the retry POST can lose its receipt across restart", async form => {
  const h = harness();
  try {
    await captureLogs(async () => {
      await prepareAnswer(h, form);
      const respond = h.client.respond.bind(h.client);
      const refused = spyOn(h.client, "respond").mockImplementation(async (...args) => {
        h.healthy = false; await h.down(); return respond(...args);
      });
      try { await expect(h.router.tick()).rejects.toBeInstanceOf(RobobLinkDown); }
      finally { refused.mockRestore(); }
      h.healthy = true; await h.advance(start + 1_000);
      const accepted = Promise.withResolvers<void>(), receipt = Promise.withResolvers<void>();
      const lost = spyOn(h.client, "respond").mockImplementation(async (...args) => {
        await respond(...args); accepted.resolve(); await receipt.promise;
        throw new ControlError(0);
      });
      const tick = h.router.tick();
      await accepted.promise;
      const retained = h.store.get<{ response: { retry?: unknown; linkRetry?: boolean } }>("steer-attempt:answer");
      expect(retained).toMatchObject({ response: { linkUncertain: true, operation: { request: { id: "request" } } } });
      expect(retained!.response.retry).toBeUndefined();
      expect(retained!.response.linkRetry).toBeUndefined();
      try {
        const router = h.restartRouter(); await router.tick(); await router.tick();
        expect(h.responses).toHaveLength(1);
        expect(h.store.get<typeof retained>("steer-attempt:answer")).toEqual(retained);
      } finally { receipt.resolve(); await tick; lost.mockRestore(); }
      expect(h.store.get("steer-attempt:answer")).toMatchObject({ response: { linkUncertain: true } });
      await h.advance(start + 61_000);
      const router = h.restartRouter(); await router.checkCompletion(); await router.tick(); await router.tick();
      expect(h.responses).toHaveLength(1);
      expect(h.sends.map(send => send.text)).toEqual(["first", "Later message"]);
      expect(h.store.db.query<{ state: string }, []>("SELECT state FROM inbound WHERE id = 'answer'").get()?.state).toBe("processing");
    });
  } finally { h.fetcher.mockRestore(); }
});

test.each(replyForms.flatMap(form => [false, true].map(closed => ({ ...form, closed }))))("$name definitive request_resolved refusal retains recovery with closed link $closed", async form => {
  const h = harness();
  try {
    const logs = await captureLogs(async () => {
      await prepareAnswer(h, form);
      const respond = h.client.respond.bind(h.client);
      const refused = spyOn(h.client, "respond").mockImplementation(async (...args) => {
        h.healthy = false; await h.down(); return respond(...args);
      });
      try { await expect(h.router.tick()).rejects.toBeInstanceOf(RobobLinkDown); }
      finally { refused.mockRestore(); }
      h.healthy = true; await h.advance(start + 1_000);
      const resolved = spyOn(h.client, "respond").mockImplementation(async () => {
        h.requests.splice(0);
        if (form.closed) { h.healthy = false; await h.down(); }
        throw new ControlError(409, "conflict", { reason: "request_resolved", retrySafe: false });
      });
      try { await h.restartRouter().tick(); } finally { resolved.mockRestore(); }
      expect(h.store.get("steer-attempt:answer")).toBeNull();
      expect(h.store.get<boolean>("human-own-turn:answer")).toBe(true);
      expect(h.store.pendingInbound().find(row => row.id === "answer")?.state).toBe("pending");
      expect(h.responses).toEqual([]);
      if (form.closed) {
        await h.restartRouter().tick();
        expect(h.store.pendingInbound().find(row => row.id === "answer")?.state).toBe("pending");
        expect(h.store.get("steer-attempt:answer")).toBeNull();
        h.healthy = true; await h.advance(start + 2_000);
        await h.restartRouter().tick();
        expect(h.store.get("steer-attempt:answer")).toBeNull();
      }
    });
    expect(logs.find(row => row.name === "inbound.requeued" && row.ids?.inboundId === "answer")?.props)
      .toMatchObject({ reason: "respond_failed", controlReason: "request_resolved", retrySafe: false });
  } finally { h.fetcher.mockRestore(); }
});

test("a typed gate refusal preserves a sealed steer across restart without requeue or failure", async () => {
  const h = harness();
  try {
    await captureLogs(async () => {
      h.healthy = true; h.input("first"); await h.router.tick();
      h.input("followup", "Exact follow up");
      const steer = h.backend.steer.bind(h.backend);
      const intercept = spyOn(h.backend, "steer").mockImplementation(async (id, directory, messageId, text, guidance, files, guard) => {
        if (!guard) throw new Error("Missing steer guard");
        return steer(id, directory, messageId, text, guidance, files, { ...guard, beforeSend: async () => {
          const admitted = await guard.beforeSend();
          h.healthy = false; await h.down();
          return admitted;
        } });
      });
      try { await expect(h.router.tick()).rejects.toBeInstanceOf(RobobLinkDown); }
      finally { intercept.mockRestore(); }
      expect(h.store.get("steer-attempt:followup")).toMatchObject({ text: "Exact follow up" });
      expect(h.store.pendingInbound().map(row => [row.id, row.state])).toEqual([["followup", "processing"]]);
      expect(h.store.get("human-own-turn:followup")).toBeUndefined();
      expect(h.store.inboundFailure("followup")).toBeUndefined();
      expect(h.sends.map(send => send.text)).toEqual(["first"]);
      h.healthy = true; await h.advance(start + 1_000);
      const router = h.restartRouter(); await router.tick(); await router.tick();
      expect(h.sends.map(send => send.text)).toEqual(["first", "Exact follow up"]);
      expect(h.store.db.query("SELECT id FROM inbound WHERE state IN ('failed','unknown')").all()).toEqual([]);
    });
  } finally { h.fetcher.mockRestore(); }
});

test.each(["closed gate", "projects read", "create POST"] as const)("a gate-refused /new stays queued ahead of following inbound at %s", async stage => {
  const h = harness();
  try {
    await captureLogs(async () => {
      h.healthy = true;
      h.store.set("route", null);
      h.input("new", "/new"); h.input("after", "Later message");
      const createChat = h.backend.createChat.bind(h.backend);
      const request = h.client.request.bind(h.client);
      const close = async () => {
        h.healthy = false;
        for (let n = 0; n < (stage === "closed gate" ? 3 : 2); n++) await h.client.thread("thread").catch(() => {});
      };
      const intercept = stage === "create POST"
        ? spyOn(h.client, "request").mockImplementation(async (...args) => {
          if (args[0] === "POST" && args[1] === "/threads") await close();
          return request(...args);
        })
        : spyOn(h.backend, "createChat").mockImplementation(async (...args) => { await close(); return createChat(...args); });
      try { await expect(h.router.tick()).rejects.toBeInstanceOf(stage === "closed gate" ? RobobLinkDown : ControlError); }
      finally { intercept.mockRestore(); }
      expect(h.gate.available).toBe(false);
      expect(h.store.pendingInbound().map(row => [row.id, row.state])).toEqual([["new", "pending"], ["after", "pending"]]);
      expect(h.store.pendingOutbox()).toEqual([]);
      expect(h.creates).toEqual([]); expect(h.sends).toEqual([]);
      h.healthy = true; await h.advance(start + 1_000);
      const router = h.restartRouter();
      await router.tick(); await router.tick();
      expect(h.creates).toHaveLength(1);
      expect(h.sends.map(send => send.text)).toEqual(["Later message"]);
      expect(h.calls.indexOf("/threads")).toBeLessThan(h.calls.indexOf("/threads/thread/send"));
      expect(h.store.pendingOutbox().filter(op => op.replyTo === "new").map(op => op.text)).toEqual(["Fresh start. What's up?"]);
      expect(h.store.db.query("SELECT id FROM inbound WHERE state IN ('failed','unknown')").all()).toEqual([]);
    });
  } finally { h.fetcher.mockRestore(); }
});

test("5h09 outage: only scheduled probes fetch, bounded logs, and ordered held delivery", async () => {
  const h = harness(0.5, false, { replies: true });
  const mirror = new ChatMirror(h.store, new HttpMirrorSink({ url: h.client.url, token: "fixture", linkGate: h.gate }), { now: () => h.at });
  try {
    const rows = await captureLogs(async () => {
      await h.down();
      for (let n = 0; n < 14; n++) {
        const id = `initial-${String(n).padStart(2,"0")}`;
        h.input(id); mirror.inbound(id, { text: id });
      }
      for (let seconds = 0; seconds <= 309 * 60; seconds++) {
        await h.advance(start + seconds * 1_000);
        if (seconds && seconds % 1_200 === 0) h.input(`arrived-${seconds}`);
        await h.router.tick(); await h.router.checkCompletion(); await h.router.checkInboundLatency();
        await h.router.checkUnanswered(); await h.router.checkFailedInbound();
        await mirror.tick();
        await h.client.thread("thread").catch(error => toolError("router", "router.catch12", error));

      }
      expect(h.calls.slice(3).every(path => path === "/health")).toBe(true);
      expect(h.calls.length).toBeLessThanOrEqual(625);
      expect(h.sends).toEqual([]);
      expect(h.store.db.query("SELECT id FROM inbound WHERE state IN ('failed','unknown')").all()).toEqual([]);

      const expected = h.store.pendingInbound().map(row => row.id);
      h.healthy = true; await h.advance(h.at + 30_000);
      expect(h.backend.linkAvailable).toBe(true);
      for (let n = 0; n < expected.length * 3; n++) {
        await h.router.tick();
        await mirror.tick();
        for (const operation of h.store.pendingOutbox()) h.store.outboxState(operation.id, "sent");
      }
      const outageFetches = h.calls.filter(path=>path === "/health").length + 3;
      const body = h.sends.map(send => send.text).join("\n");
      let previous = -1;
      for (const id of expected) { const index = body.indexOf(id); expect(index).toBeGreaterThan(previous); previous = index; }
      expect(h.sends.map(send => send.text)).toEqual(expected);
      expect(h.calls.filter(path=>path === "/threads/thread/send")).toHaveLength(expected.length);
      expect(h.store.db.query("SELECT id FROM inbound WHERE state IN ('failed','unknown')").all()).toEqual([]);
      expect(h.store.pendingInbound()).toEqual([]);
      expect(h.mirrored.map(item => item.id)).toEqual(expected.slice(0, 14));
      for (const id of expected) {
        const row = h.store.db.query<{ state: string; payload: string }, [string]>("SELECT state, payload FROM inbound WHERE id = ?").get(id)!;
        expect(row.state).toBe("done");
        expect(JSON.parse(row.payload).answeredAt).toBeNumber();
      }
      console.log(JSON.stringify({ outageMinutes: 309, fetches: outageFetches, heldRows: expected.length, sends: h.sends.length }));
    });
    const recoveredAt = rows.find(row=>row.name === "robob.link_up")!.ts;
    const downRows = rows.filter(row=>row.ts < recoveredAt);
    console.log(JSON.stringify({outageMinutes:309,logLinesWhileDown:downRows.length,summaries:downRows.filter(row=>row.name === "robob.link_down_summary").length}));
    const outageRows = downRows.filter(row => row.component === "robob" || row.name === "bridge.catch");
    expect(outageRows.length).toBeLessThanOrEqual(320);
    const summary = await summarizeLog((async function* () { yield* rows; })());
    expect(summary.topCauses.filter(c=>c.tag === "robob.link_down")).toEqual([{ tag: "robob.link_down", causeKey: "robob_unavailable", count: 1 }]);
    const summaries = rows.filter(row => row.name === "robob.link_down_summary");
    for (let n = 1; n < summaries.length; n++) expect(Date.parse(summaries[n]!.ts) - Date.parse(summaries[n - 1]!.ts)).toBeGreaterThanOrEqual(60_000);
    expect(summaries.length).toBeLessThanOrEqual(310);
    expect(rows.filter(row => row.name === "bridge.catch" && row.error?.tag === "router.catch12")).toHaveLength(1);
    expect(rows.filter(row => row.name === "turn.robob_call" && !row.ok).length).toBeLessThanOrEqual(5);
    expect(rows.filter(row => row.name === "robob.link_up")).toHaveLength(1);
  } finally { h.fetcher.mockRestore(); }
}, 30_000);

test("503 boot, first healthy probe, next outage resets to 1s", async () => {
  const h = harness();
  try {
    await captureLogs(async () => {
      h.booting = true; await h.down(); expect(h.delays).toEqual([1_000]);
      await expect(h.client.request("GET", "/health")).rejects.toBeInstanceOf(RobobLinkDown);
      await h.advance(start + 1_000); expect(h.delays).toEqual([1_000, 2_000]);
      h.healthy = true; await h.advance(start + 3_000); expect(h.backend.linkAvailable).toBe(true);
      h.healthy = false; await h.down(); expect(h.delays.at(-1)).toBe(1_000);
    });
  } finally { h.fetcher.mockRestore(); }
});

test("gate-held owner DM still alarms at 10 minutes and keeps the technical notice timing", async () => {
  const h = harness();
  try {
    await captureLogs(async () => {
      await h.down(); h.input("waiting");
      await h.advance(start + 300_000); await h.router.tick(); await h.router.checkUnanswered();
      expect(h.alerts).toEqual([]);
      await h.advance(start + 599_999); await h.router.tick(); await h.router.checkUnanswered();
      expect(h.alerts).toEqual([]);
      await h.advance(start + 600_000); await h.router.tick(); await h.router.checkUnanswered();
      expect(h.alerts).toEqual([start + 600_000]);
      expect(h.store.db.query("SELECT id FROM outbox WHERE json_extract(payload, '$.text') LIKE '%technical%'").all()).toHaveLength(1);
      expect(h.store.pendingInbound().map(row => row.id)).toEqual(["waiting"]);
    });
  } finally { h.fetcher.mockRestore(); }
});

test("an unhealthy 200 health response remains down and counts as a failed probe", async () => {
  const h = harness();
  try {
    const rows = await captureLogs(async () => {
      await h.down(); h.healthy = true; h.healthStatus = "starting";
      await h.advance(start + 60_000);
      expect(h.gate.available).toBe(false);
      h.healthStatus = "healthy";
      await h.advance(start + 90_000);
      expect(h.gate.available).toBe(true);
    });
    const up = rows.find(row => row.name === "robob.link_up")!;
    expect(up.link?.failedProbes).toBe(5);
    expect(rows.filter(row => row.name === "turn.robob_call" && !row.ok).length).toBeLessThanOrEqual(5);
  } finally { h.fetcher.mockRestore(); }
});

test.each([0, 1])("jitter endpoint %s respects the 30s ceiling", async random => {
  const h = harness(random);
  try {
    await captureLogs(async () => {
      await h.down(); await h.advance(start + 600_000);
      expect(h.delays[0]).toBe(random ? 1_200 : 800);
      expect(Math.max(...h.delays)).toBeLessThanOrEqual(30_000);
      expect(Math.min(...h.delays.slice(5))).toBeGreaterThanOrEqual(24_000);
    });
  } finally { h.fetcher.mockRestore(); }
});

test("late non-probe success cannot open the gate or log link_up", async () => {
  const h = harness();
  try {
    const rows = await captureLogs(async () => {
      await h.down();
      h.gate.outcome(true, false, async () => {}, false);
      toolLog.write({ component: "robob", kind: "perf", name: "turn.robob_call", ok: true, props: { linkGated: true } });
      expect(h.gate.available).toBe(false);
      await expect(h.client.thread("thread")).rejects.toBeInstanceOf(RobobLinkDown);
      await expect(h.client.upload({ name:"a", mimeType:"text/plain", bytes:new Uint8Array() })).rejects.toBeInstanceOf(RobobLinkDown);
      await expect(h.client.events({signal:new AbortController().signal}).next()).rejects.toBeInstanceOf(RobobLinkDown);
      expect(h.calls.length).toBe(3);
    });
    expect(rows.filter(row=>row.name === "robob.link_up")).toEqual([]);
  } finally { h.fetcher.mockRestore(); }
});

test("offbox simulation: real bridge HTTP against a refused port for 10 minutes, then recovery", async () => {
  const h = harness(0.5, true);
  try {
    const rows = await captureLogs(async () => {
      await h.down(); for (let n=0;n<14;n++) h.input(`sim-${String(n).padStart(2,"0")}`);
      for (let second=0;second<=600;second++) {
        await h.advance(start + second*1_000);
        await h.router.tick(); await h.router.checkCompletion(); await h.router.checkInboundLatency();
        await h.backend.health().catch(error=>toolError("sb-main", "sb-main.catch12", error));
      }
      const outageFetches = h.calls.length;
      expect(h.calls.slice(3).every(path=>path === "/health")).toBe(true);
      expect(outageFetches).toBeLessThanOrEqual(27);
      h.healthy = true; await h.advance(h.at+30_000); await h.router.tick(); await h.router.tick();
      expect(h.sends).toHaveLength(1);
      expect(h.calls.filter(path=>path === "/threads/thread/send")).toHaveLength(1);
      expect(h.sends[0]!.text.split("\n")).toEqual(Array.from({length:14},(_,n)=>`sim-${String(n).padStart(2,"0")}`));
      expect(h.store.db.query("SELECT key FROM kv WHERE key LIKE 'inbound-delivered:%' AND value != 'null'").all()).toHaveLength(14);
      expect(h.store.pendingInbound()).toEqual([]);
      console.log(JSON.stringify({simulation:"real-http-refusal-10-minutes",outageFetches,recoveryFetches:h.calls.length-outageFetches,deliveredRows:14,sends:h.sends.length}));
    });
    const summaries=rows.filter(row=>row.name === "robob.link_down_summary");
    expect(summaries.length).toBeLessThanOrEqual(10);
    console.log(JSON.stringify({simulation:"real-http-refusal-10-minutes",logLines:rows.length,summaries:summaries.length}));
  } finally { h.fetcher.mockRestore(); }
});

test("restart uses #77's persisted outage, gates the first failed read, and keeps the same outage id", async () => {
  const { createRobobLinkState } = await import("../src/log-robob-link.ts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "link-gate-restart-"));
  const log = createRobobLinkState({root, now:()=>start});
  let outageId: string | undefined;
  try {
    for(let n=0;n<3;n++) {
      const result = log.accept({ts:new Date(start).toISOString(),tool:"imessage",component:"robob",kind:"perf",name:"turn.robob_call",ok:false,
        props:{linkGated:true,linkCause:"ECONNREFUSED",route:"/threads/:id"}});
      outageId ??= result.events.find(row=>row.name === "robob.link_down")?.link?.outageId;
    }
    log.save();
    const restored = createRobobLinkState({root,now:()=>start});
    const schedules: number[] = [];
    const gate = new RobobLinkGate({persistedDown:restored.down,skip:site=>{restored.skip(site);},firstAtSite:restored.firstAtSite},
      {random:()=>0.5,schedule:(_run,ms)=>{schedules.push(ms);return {};}});
    expect(gate.available).toBe(true);
    const result=restored.accept({ts:new Date(start+1000).toISOString(),tool:"imessage",component:"robob",kind:"perf",name:"turn.robob_call",ok:false,
      props:{linkGated:true,linkCause:"ECONNREFUSED",route:"/threads/:id"}});
    gate.outcome(false,true,async()=>{},false);
    expect(gate.available).toBe(false); expect(schedules).toEqual([1000]);
    expect(result.events.find(row=>row.name === "robob.link_state")?.link?.outageId).toBe(outageId);
    expect(result.events.filter(row=>row.name === "robob.link_down")).toEqual([]);
    expect(()=>gate.guard("router.tick")).toThrow(RobobLinkDown);
    restored.save();
    const healthyRestart = createRobobLinkState({root, now:()=>start+2000});
    const success = healthyRestart.accept({ts:new Date(start+2000).toISOString(),tool:"imessage",component:"robob",kind:"perf",name:"turn.robob_call",ok:true,
      props:{linkGated:true,linkGateDown:false,route:"/threads/:id"}});
    expect(success.events.find(row=>row.name === "robob.link_up")?.link?.outageId).toBe(outageId);
    expect(healthyRestart.down()).toBe(false);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("restart while down preserves the durable queue and recovery never submits a delivered row twice", async () => {
  const root = mkdtempSync(join(tmpdir(), "link-gate-queue-"));
  const storePath = join(root, "bridge.sqlite");
  const close = (h: ReturnType<typeof harness>) => {
    h.fetcher.mockRestore();
    stores.splice(stores.indexOf(h.store), 1);
    h.store.close();
  };
  let live: ReturnType<typeof harness> | undefined;
  try {
    await captureLogs(async () => {
      live = harness(0.5, false, { storePath });
      await live.down();
      for (let n = 0; n < 14; n++) live.input(`restart-${String(n).padStart(2, "0")}`);
      await live.router.tick();
      const expected = live.store.pendingInbound().map(row => row.id);
      close(live);

      live = harness(0.5, false, { storePath });
      expect(live.gate.available).toBe(true);
      await live.client.thread("thread").catch(() => {});
      expect(live.gate.available).toBe(false);
      await live.router.tick();
      expect(live.calls).toHaveLength(1);
      expect(live.store.pendingInbound().map(row => row.id)).toEqual(expected);
      live.healthy = true;
      await live.advance(start + 1_000);
      await live.router.tick(); await live.router.tick();
      expect(live.sends.map(send => send.text.split("\n")).flat()).toEqual(expected);
      expect(live.calls.filter(path => path.endsWith("/send"))).toHaveLength(1);
      expect(live.store.db.query("SELECT id FROM inbound WHERE state IN ('failed','unknown')").all()).toEqual([]);
      close(live);

      live = harness(0.5, false, { storePath });
      live.healthy = true;
      await live.router.tick(); await live.router.tick();
      expect(live.sends).toEqual([]);
      expect(live.store.pendingInbound()).toEqual([]);
    });
  } finally {
    if (live && stores.includes(live.store)) close(live);
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart retains first-site suppression and the summary's 60-second cooldown", async () => {
  const { createRobobLinkState } = await import("../src/log-robob-link.ts");
  const root = mkdtempSync(join(tmpdir(), "link-gate-summary-"));
  let at = start;
  try {
    const log = createRobobLinkState({ root, now: () => at });
    for (let n = 0; n < 3; n++) log.accept({ ts: new Date(at).toISOString(), tool: "imessage", component: "robob", kind: "perf", name: "turn.robob_call", ok: false,
      props: { linkGated: true, linkCause: "ECONNREFUSED", route: "/threads/:id" } });
    expect(log.firstAtSite("router.catch12")).toBe(true);
    at += 60_000;
    expect(log.skip("router.tick").map(line => line.name)).toEqual(["robob.link_down_summary"]);
    log.save();
    const resumed = createRobobLinkState({ root, now: () => at });
    expect(resumed.down()).toBe(true);
    expect(resumed.firstAtSite("router.catch12")).toBe(false);
    expect(resumed.skip("router.tick")).toEqual([]);
    at += 59_999;
    expect(resumed.skip("router.tick")).toEqual([]);
    at++;
    expect(resumed.skip("router.tick").map(line => line.name)).toEqual(["robob.link_down_summary"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("deferred suppression persists counters before restart without a caller flush", async () => {
  const root = mkdtempSync(join(tmpdir(), "link-gate-deferred-"));
  let at = start;
  try {
    const logger = createToolLog({ root, now: () => at, defer: true });
    const failed = (probe: boolean) => logger.write({ component: "robob", kind: "perf", name: "turn.robob_call", ok: false,
      props: { route: probe ? "/health" : "/threads/:id", linkGated: true, linkProbe: probe, linkCause: "ECONNREFUSED" } });
    for (let n = 0; n < 3; n++) failed(false);
    failed(true);
    await Promise.resolve();
    at += 2_000;
    failed(true);
    for (let n = 0; n < 12; n++) logger.skipRobob("router.tick");
    await Promise.resolve();
    const restarted = createToolLog({ root, now: () => at, defer: true });
    restarted.write({ component: "robob", kind: "perf", name: "turn.robob_call", ok: true,
      props: { route: "/health", linkGated: true, linkProbe: true, linkGateDown: true } });
    await Promise.resolve();
    const rows = readdirSync(root).filter(file => file.endsWith(".ndjson")).flatMap(file => readFileSync(join(root, file), "utf8").trim().split("\n").map(line => JSON.parse(line)));
    const up = rows.find(row => row.name === "robob.link_up");
    expect(up.link).toMatchObject({ failedCalls: 5, failedProbes: 2, skippedCalls: 12, bySite: { "router.tick": 12 } });
    expect(rows.filter(row => row.name === "robob.link_down_summary")).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.each([
  {name:"ECONNREFUSED",failure:Object.assign(new Error("fetch failed"),{code:"ECONNREFUSED"}),down:true},
  {name:"nested ECONNRESET",failure:Object.assign(new Error("fetch failed"),{cause:{code:"ECONNRESET"}}),down:true},
  {name:"ETIMEDOUT",failure:Object.assign(new Error("fetch failed"),{code:"ETIMEDOUT"}),down:true},
  {name:"statusless TypeError",failure:new TypeError("fetch failed"),down:true},
  {name:"caller cancellation",failure:new DOMException("The operation was aborted", "AbortError"),down:false},
])("gated classification: $name",async fixture=>{
  const h=harness();
  const fetcher=spyOn(globalThis,"fetch").mockImplementation(Object.assign(async()=>{throw fixture.failure;},{preconnect:globalThis.fetch.preconnect}));
  const signal=new AbortController(); if (!fixture.down) signal.abort();
  try {
    await captureLogs(async()=>{
      for(let n=0;n<3;n++) await h.client.request("GET","/threads/thread",undefined,{signal:signal.signal}).catch(()=>{});
      expect(h.gate.available).toBe(!fixture.down);
    });
  } finally {fetcher.mockRestore();h.fetcher.mockRestore();}
});
