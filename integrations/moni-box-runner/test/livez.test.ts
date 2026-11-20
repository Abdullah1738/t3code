import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRouterReadinessTracker, routerConfig, routerReady } from "../src/router-auth.ts";
import { BoxRunner } from "../src/runner.ts";
import { opaqueId } from "../../spectrum-bridge/src/remote-protocol.ts";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()));

test("blocked worker health never gates a turn; livez 503 preserves authority and the running turn", async () => {
  let healthRequests = 0, now = 0, healthy = true, calls = 0;
  const worker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    healthRequests++; return new Promise<Response>(() => {});
  } }); cleanup.push(() => { worker.stop(true); });
  const logs: unknown[] = [];
  const livez = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => {
    expect(req.method).toBe("GET"); expect(new URL(req.url).pathname).toBe("/livez");
    expect(req.headers.get("x-api-key")).toBeNull(); expect(req.headers.get("authorization")).toBeNull();
    return Response.json({ ready: healthy, reason: "not_ready", key: "PRIVATE_KEY", text: "PRIVATE_TEXT" }, { status: healthy ? 200 : 503 });
  } }); cleanup.push(() => { livez.stop(true); });
  const root = mkdtempSync(join(tmpdir(), "box-livez-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const config = { root, boxId: "bx_test", epoch: "test", token: "t".repeat(32), callbackToken: "c".repeat(32),
    callbackUrl: "http://callback", privateKey: "unused", system: "system" };
  let began!: () => void, finish!: () => void, signal: AbortSignal | undefined;
  const started = new Promise<void>(resolve => { began = resolve; });
  const completed = new Promise<void>(resolve => { finish = resolve; });
  const router = routerConfig({ boxRouterPort: worker.port, boxLivezPort: livez.port });
  const tracker = createRouterReadinessTracker(event => logs.push(event), () => now);
  const runner = new BoxRunner(config, { run: async input => { calls++; signal = input.signal; began(); await completed; return "NO_REPLY"; } }, {
    now: () => now, modelReady: () => routerReady(router, tracker, () => now),
    callbackReady: async () => true, fetch: async () => Response.json({ accepted: true }),
  }); cleanup.push(() => runner.db.close());
  const lease = () => runner.handle(new Request("http://box/lease", { method: "POST", headers: { authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ boxId: config.boxId, epoch: config.epoch }) }));
  expect(await (await lease()).json()).toMatchObject({ routerReady: true, callbackReady: true });
  runner.enqueue(opaqueId("livez-active"), { text: "PRIVATE_INPUT" }); const turn = runner.tick(); await started;
  expect(calls).toBe(1); expect(logs).toEqual([]); healthy = false;
  for (let i = 0; i < 6; i++) {
    now += 10_000;
    const response = await lease(); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ routerReady: false, callbackReady: true });
    await runner.tick(); expect(signal!.aborted).toBe(false); expect(runner.active()).toBe(true);
  }
  finish(); await turn;
  expect(runner.db.query("SELECT 1 FROM interruptions").get()).toBeNull();
  expect(runner.db.query<{ state: string }, []>("SELECT state FROM inbox").get()!.state).toBe("done");
  runner.enqueue(opaqueId("livez-next"), { text: "PRIVATE_NEXT" }); await runner.tick(); expect(calls).toBe(1);
  expect(logs).toEqual([{ code: "router-unready", reason: "not_ready", ms: 0 }]);
  healthy = true; await runner.tick(); expect(calls).toBe(2); expect(healthRequests).toBe(0);
  expect(logs).toEqual([{ code: "router-unready", reason: "not_ready", ms: 0 }, { code: "router-ready", downMs: 50_000, failures: 7 }]);
  expect(JSON.stringify(logs)).not.toContain("PRIVATE_"); expect(JSON.stringify(logs)).not.toContain(config.token);
});

test.each(["no_worker", "not_ready", "heartbeat_stale", "shutting_down", "PRIVATE_KEY PRIVATE_TEXT", null, [], {}].map(reason => ({ reason })))(
  "503 readiness logs one allow-listed metadata event for $reason", async ({ reason }) => {
    const logs: unknown[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ reason, token: "PRIVATE_TOKEN" }, { status: 503 }) });
    cleanup.push(() => { server.stop(true); });
    const tracker = createRouterReadinessTracker(event => logs.push(event), () => 0);
    expect(await routerReady(routerConfig({ boxLivezPort: server.port }), tracker, () => 0)).toBe(false);
    expect(logs).toEqual([{ code: "router-unready", reason: typeof reason === "string" && !reason.startsWith("PRIVATE_") ? reason : "unknown", ms: 0 }]);
    expect(JSON.stringify(logs)).not.toContain("PRIVATE_");
  });

test.each([
  [200, '{"ready":true}', true], [200, '{"ready":false}', false], [200, '{"ready":"true"}', false],
  [200, '{"ready":1}', false], [200, '{}', false], [200, 'null', false], [200, '[]', false],
  [200, 'invalid', false], [200, '"PRIVATE_TEXT"', false], [200, 'true', false],
  [201, '{"ready":true}', false], [500, '{"ready":true,"token":"PRIVATE_TOKEN"}', false],
  [503, '{"ready":true}', false], [503, 'invalid PRIVATE_TEXT', false], [503, 'null', false], [503, '[]', false],
])("livez status %i body %s gives ready=%s", async (status, body, ready) => {
  const logs: unknown[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(body, { status }) });
  cleanup.push(() => { server.stop(true); });
  const tracker = createRouterReadinessTracker(event => logs.push(event), () => 0);
  expect(await routerReady(routerConfig({ boxLivezPort: server.port }), tracker, () => 0)).toBe(ready);
  expect(logs).toEqual(ready ? [] : [{ code: "router-unready", ms: 0,
    reason: status === 503 ? "unknown" : status === 200 ? "not_ready_body" : "bad_status",
    ...(status !== 200 && status !== 503 ? { status } : {}),
  }]);
  expect(JSON.stringify(logs)).not.toContain("PRIVATE_");
});

test.each(["headers", "body"])("livez's 1.5 s deadline classifies stalled %s as timeout", async part => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => part === "headers" ? new Promise<Response>(() => {})
    : new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"ready":')); } })) });
  cleanup.push(() => { server.stop(true); });
  const logs: unknown[] = [], tracker = createRouterReadinessTracker(event => logs.push(event));
  expect(await routerReady(routerConfig({ boxLivezPort: server.port }), tracker)).toBe(false);
  expect(logs).toEqual([{ code: "router-unready", reason: "timeout", ms: expect.any(Number) }]);
}, 3000);

test("closed livez port is unreachable", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ready: true }) });
  const port = server.port; await server.stop(true);
  const logs: unknown[] = [], tracker = createRouterReadinessTracker(event => logs.push(event));
  expect(await routerReady(routerConfig({ boxLivezPort: port }), tracker)).toBe(false);
  expect(logs).toEqual([{ code: "router-unready", reason: "unreachable", ms: expect.any(Number) }]);
});

test.each(["TimeoutError", "AbortError", "TypeError"])("fetch %s logs only a fixed reason and elapsed time", async name => {
  let now = 100;
  const implementation = Object.assign(async () => { now += 25; throw new DOMException("PRIVATE_TOKEN PRIVATE_TEXT", name); }, { preconnect: globalThis.fetch.preconnect });
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(implementation);
  cleanup.push(() => fetcher.mockRestore());
  const logs: unknown[] = [], tracker = createRouterReadinessTracker(event => logs.push(event), () => now);
  expect(await routerReady(routerConfig({}), tracker, () => now)).toBe(false);
  expect(logs).toEqual([{ code: "router-unready", reason: name === "TypeError" ? "unreachable" : "timeout", ms: 25 }]);
});

test("50 identical failures log once, reason changes log once, and recovery closes and resets the episode", async () => {
  let now = 1_000, status = 503;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    now += 7; return Response.json({ ready: true, reason: "not_ready", token: "PRIVATE_TOKEN", text: "PRIVATE_TEXT" }, { status });
  } }); cleanup.push(() => { server.stop(true); });
  const logs: unknown[] = [], tracker = createRouterReadinessTracker(event => logs.push(event), () => now);
  const probe = () => routerReady(routerConfig({ boxLivezPort: server.port }), tracker, () => now);
  for (let i = 0; i < 50; i++) expect(await probe()).toBe(false);
  expect(logs).toEqual([{ code: "router-unready", reason: "not_ready", ms: 7 }]);
  now = 2_000; status = 500; expect(await probe()).toBe(false);
  expect(logs).toHaveLength(2);
  now = 2_500; status = 502; expect(await probe()).toBe(false);
  expect(logs).toHaveLength(2);
  now = 4_000; status = 200; expect(await probe()).toBe(true);
  now = 5_000; expect(await probe()).toBe(true);
  expect(logs).toEqual([
    { code: "router-unready", reason: "not_ready", ms: 7 },
    { code: "router-unready", reason: "bad_status", ms: 7, status: 500 },
    { code: "router-ready", downMs: 3_000, failures: 52 },
  ]);
  now = 6_000; status = 503; expect(await probe()).toBe(false);
  now = 6_100; status = 200; expect(await probe()).toBe(true);
  expect(logs.slice(3)).toEqual([
    { code: "router-unready", reason: "not_ready", ms: 7 },
    { code: "router-ready", downMs: 100, failures: 1 },
  ]);
});

test("ready to ready produces no lines", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ready: true }) });
  cleanup.push(() => { server.stop(true); });
  const logs: unknown[] = [], tracker = createRouterReadinessTracker(event => logs.push(event));
  for (let i = 0; i < 2; i++) expect(await routerReady(routerConfig({ boxLivezPort: server.port }), tracker)).toBe(true);
  expect(logs).toEqual([]);
});
