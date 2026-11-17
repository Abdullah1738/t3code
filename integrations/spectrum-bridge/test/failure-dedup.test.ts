import { expect, spyOn, test } from "bun:test";
import { ControlClient } from "../src/control.ts";
import { bounded } from "../src/router.ts";
import { toolError, toolLog, type LogLine } from "../src/toollog.ts";
import { captureLogs } from "./log-fixture.ts";
import { summarizeLog } from "../src/log-rollup.ts";

const client = () => new ControlClient({ url: "http://127.0.0.1:3773", token: "PRIVATE_TOKEN" });
const echo = "91274f60-34f8-4298-bf6d-a96a95f36503";
const fetchMock = (implementation: () => Promise<Response>): typeof fetch =>
  Object.assign(implementation, { preconnect: globalThis.fetch.preconnect });

test.each(["http", "invalid_json", "body_timeout", "fetch_timeout", "refused", "cancelled"])("%s request and its caller catches count once on disk and in the rollup", async shape => {
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(fetchMock(async () => {
    if (shape === "fetch_timeout") throw new DOMException("PRIVATE_BODY", "TimeoutError");
    if (shape === "refused") throw Object.assign(new TypeError("PRIVATE_BODY"), { code: "ECONNREFUSED" });
    if (shape === "cancelled") throw new DOMException("PRIVATE_BODY", "AbortError");
    if (shape === "body_timeout") return { ok: true, status: 200, headers: new Headers(), json: async () => {
      throw new DOMException("PRIVATE_BODY", "TimeoutError");
    } } as unknown as Response;
    return new Response(shape === "invalid_json" ? "PRIVATE_BODY" : JSON.stringify({ ok: false }), {
      status: shape === "invalid_json" ? 200 : 409, headers: { "x-request-id": echo },
    });
  }));
  try {
    let result: Awaited<ReturnType<typeof toolLog.rollup>>;
    const rows = await captureLogs(async () => {
      toolLog.beginRun("id-thread", "id-message");
      await client().request("GET", "/threads/id-thread/messages?text=PRIVATE_QUERY").catch(error => {
        toolError("router", "router.catch1", error, { inboundId: "id-inbound" }, { probeIndex: 1, probeCount: 3 });
        toolError("sb-main", "sb-main.catch12", new Error("PRIVATE_WRAPPER", { cause: new Error("PRIVATE_WRAPPER", { cause: error }) }));
        const frozen = Object.freeze(new Error("PRIVATE_WRAPPER", { cause: error }));
        toolError("secrets", "secrets.catch1", frozen);
      });
      toolLog.flush();
      result = await toolLog.rollup(new Date().toISOString().slice(0, 10));
    });
    const requests = rows.filter(row => row.name === "turn.robob_call" && row.ok === false);
    const catches = rows.filter(row => row.name === "bridge.catch");
    expect(requests).toHaveLength(1);
    expect(requests[0].error?.tag).toBe(shape === "invalid_json" ? "control.invalid_json" : "control.request_failed");
    expect(catches).toHaveLength(3);
    for (const row of catches) expect(row).toMatchObject({ alreadyLogged: true, ids: { requestId: requests[0].ids?.requestId } });
    expect(catches[0]).toMatchObject({ ids: { inboundId: "id-inbound" }, props: { probeIndex: 1, probeCount: 3 } });
    const linkRows = rows.filter(row => row.name.startsWith("robob.link_")).length;
    expect(result!).toMatchObject({ total: 4 + linkRows, recordedRows: 5 + linkRows, failed: 1, dedupedFailures: 3, errorRate: 1 / (4 + linkRows),
      countsByName: { "turn.robob_call": 1, "bridge.catch": 3 }, countsByKind: { error: 3 } });
    expect(result!.topErrorTags).toHaveLength(1);
    expect(result!.topErrorTags[0]).toMatchObject({ tag: requests[0].error?.tag, count: 1 });
    expect(result!.topCauses.every(item => item.tag === requests[0].error?.tag)).toBe(true);
    expect(result!.byComponent.router["bridge.catch"]).toMatchObject({ count: 1, failed: 0, errorRate: 0 });
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_");
  } finally { fetcher.mockRestore(); }
});

test("a bounded timeout remains a separate failure when the control call fails later", async () => {
  const pending = Promise.withResolvers<Response>();
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(fetchMock(() => pending.promise));
  try {
    let result: Awaited<ReturnType<typeof toolLog.rollup>>;
    const rows = await captureLogs(async () => {
      const request = client().request("GET", "/threads/id-thread/messages");
      await bounded(request, 0).catch(error => toolError("router", "router.catch1", error));
      toolLog.flush();
      const timeoutOnly = await toolLog.rollup(new Date().toISOString().slice(0, 10));
      expect(timeoutOnly).toMatchObject({ total: 1, failed: 1, dedupedFailures: 0, errorRate: 1 });
      pending.reject(new DOMException("PRIVATE_BODY", "TimeoutError"));
      await request.catch(error => toolError("router", "router.completion_read", error));
      toolLog.flush();
      result = await toolLog.rollup(new Date().toISOString().slice(0, 10));
    });
    const catches = rows.filter(row => row.name === "bridge.catch");
    expect(catches).toHaveLength(2);
    expect(catches[0].alreadyLogged).toBeUndefined();
    expect(catches[0].ids?.requestId).toBeUndefined();
    expect(catches[1].alreadyLogged).toBe(true);
    const total = 3 + rows.filter(row => row.name.startsWith("robob.link_")).length;
    expect(result!).toMatchObject({ failed: 2, total, dedupedFailures: 1, errorRate: 2 / total });
    expect(result!.topErrorTags.map(item => item.tag).sort()).toEqual(["control.request_failed", "router.catch1"]);
  } finally { fetcher.mockRestore(); }
});

test.each([true, false, undefined, "true", 1])("only boolean true deduplicates a catch (%s), with and without a call summary", async marker => {
  for (const aggregated of [false, true]) {
    const request: LogLine = { ts: "2026-11-16T12:00:00Z", tool: "imessage", component: "robob", kind: "perf",
      name: "turn.robob_call", ok: false, durationMs: 25, ids: { callBatchId: "batch" },
      props: { method: "GET", route: "/threads/:id", failureFormat: "single" },
      error: { tag: "control.invalid_json", name: "SyntaxError", message: "[redacted]" } };
    const caught: LogLine = { ts: request.ts, tool: "imessage", component: "router", kind: "error", name: "bridge.catch",
      ok: false, alreadyLogged: marker as boolean, error: { tag: "router.catch1", name: "ControlError", message: "[redacted]" } };
    const records = [request, caught];
    if (aggregated) records.push({ ts: request.ts, tool: "imessage", component: "robob", kind: "perf", name: "turn.robob_calls",
      ids: request.ids, calls: { thread: { count: 1, ok: 0, failed: 1, p50: 25, p95: 25, max: 25, histogram: [[25, 1]] } } });
    const result = await summarizeLog((async function* () { yield* records; })());
    const deduped = marker === true;
    expect(result).toMatchObject({ total: 2, recordedRows: records.length, failed: deduped ? 1 : 2,
      errorRate: deduped ? .5 : 1, dedupedFailures: Number(deduped), countsByName: { "turn.robob_call": 1, "bridge.catch": 1 } });
    expect(result.topErrorTags.map(item => item.tag)).toEqual(deduped ? ["control.invalid_json"] : ["control.invalid_json", "router.catch1"]);
  }
});

test("unmarked local failures, cyclic causes, and throwing cause accessors keep their catch rows", async () => {
  const cycle = new Error("PRIVATE_BODY", { cause: undefined });
  cycle.cause = cycle;
  const accessor = Object.defineProperty(new Error("PRIVATE_BODY"), "cause", { get() { throw new Error("PRIVATE_BODY"); } });
  let result: Awaited<ReturnType<typeof toolLog.rollup>>;
  const rows = await captureLogs(async () => {
    for (const error of [cycle, accessor, "PRIVATE_BODY", null]) toolError("router", "router.catch1", error);
    toolLog.flush();
    result = await toolLog.rollup(new Date().toISOString().slice(0, 10));
  });
  expect(rows.filter(row => row.name === "bridge.catch")).toHaveLength(4);
  expect(rows.every(row => row.alreadyLogged === undefined)).toBe(true);
  expect(result!).toMatchObject({ failed: 4, total: 4, dedupedFailures: 0, errorRate: 1 });
});
