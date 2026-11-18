import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { routerConfig, routerReady } from "../src/router-auth.ts";
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
  const runner = new BoxRunner(config, { run: async input => { calls++; signal = input.signal; began(); await completed; return "NO_REPLY"; } }, {
    now: () => now, modelReady: () => routerReady(router, (code, detail) => logs.push({ code, ...detail })),
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
  expect(logs).toEqual(Array.from({ length: 7 }, () => ({ code: "router-unready", reason: "not_ready" })));
  healthy = true; await runner.tick(); expect(calls).toBe(2); expect(healthRequests).toBe(0);
  expect(JSON.stringify(logs)).not.toContain("PRIVATE_"); expect(JSON.stringify(logs)).not.toContain(config.token);
});

test.each(["no_worker", "not_ready", "heartbeat_stale", "shutting_down", "PRIVATE_KEY PRIVATE_TEXT", null, [], {}].map(reason => ({ reason })))(
  "503 readiness logs one allow-listed metadata event for $reason", async ({ reason }) => {
    const logs: unknown[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ reason, token: "PRIVATE_TOKEN" }, { status: 503 }) });
    cleanup.push(() => { server.stop(true); });
    expect(await routerReady(routerConfig({ boxLivezPort: server.port }), (code, detail) => logs.push({ code, ...detail }))).toBe(false);
    expect(logs).toEqual([{ code: "router-unready", reason: typeof reason === "string" && !reason.startsWith("PRIVATE_") ? reason : "unknown" }]);
    expect(JSON.stringify(logs)).not.toContain("PRIVATE_");
  });

test.each([
  [200, '{"ready":true}', true], [200, '{"ready":false}', false], [200, '{"ready":"true"}', false],
  [200, '{"ready":1}', false], [200, '{}', false], [200, 'null', false], [200, '[]', false],
  [200, 'invalid', false], [201, '{"ready":true}', false], [503, '{"ready":true}', false], [503, 'invalid', false],
])("livez status %i body %s gives ready=%s", async (status, body, ready) => {
  const logs: unknown[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(body, { status }) });
  cleanup.push(() => { server.stop(true); });
  expect(await routerReady(routerConfig({ boxLivezPort: server.port }), (code, detail) => logs.push({ code, ...detail }))).toBe(ready);
  expect(logs).toEqual(status === 503 ? [{ code: "router-unready", reason: "unknown" }] : []);
});

test("livez's short deadline also bounds a stalled response body", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"ready":')); } })) });
  cleanup.push(() => { server.stop(true); });
  expect(await routerReady(routerConfig({ boxLivezPort: server.port }))).toBe(false);
}, 3000);
