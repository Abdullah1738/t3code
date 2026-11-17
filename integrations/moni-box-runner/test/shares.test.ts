import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Shares, type StartTunnel } from "../../spectrum-bridge/src/share.ts";
import { Store } from "../../spectrum-bridge/src/store.ts";
import { startShareMaintenance } from "../src/main.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "box-share-life-")), appsRoot = join(root, "apps");
  cleanup.push(async () => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(appsRoot, "page"), { recursive: true }); writeFileSync(join(appsRoot, "page/index.html"), "<title>Page</title>");
  const store = new Store(join(root, "shares.sqlite")); cleanup.push(async () => store.close());
  let now = 1000;
  const tunnels: { dead: boolean; port: number }[] = [];
  const startTunnel: StartTunnel = async port => {
    const state = { dead: false, port }; tunnels.push(state);
    return { url: `https://test${tunnels.length}.trycloudflare.com`, pid: 0, alive: () => !state.dead,
      kill: () => { state.dead = true; }, stop: async () => { state.dead = true; } };
  };
  const make = () => { const shares = new Shares({ store, appsRoot, startTunnel, now: () => now }); cleanup.push(() => shares.stopAll()); return shares; };
  const status = (port: number) => fetch(`http://127.0.0.1:${port}/`).then(r => r.status, () => 0);
  return { make, store, tunnels, status, advance: () => { now += 2 * 86400_000; } };
}

test("runner's scheduled maintenance closes expired quick links", async () => {
  const s = setup(), shares = s.make(); let tick!: () => Promise<void>;
  await startShareMaintenance(shares, () => {}, (fn, ms) => { tick = fn; expect(ms).toBe(30_000); });
  await shares.share("page", 1); const port = s.tunnels[0]!.port;
  expect(await s.status(port)).toBe(200);
  s.advance(); await tick();
  expect(await s.status(port)).not.toBe(200); expect(s.tunnels[0]!.dead).toBe(true); expect(shares.list()).toEqual([]);
});

test("runner restores unexpired shares at startup and recovers a dead tunnel on the schedule", async () => {
  const s = setup(), old = s.make(); await old.share("page", 1); await old.stopAll();
  const shares = s.make(); let tick!: () => Promise<void>;
  await startShareMaintenance(shares, () => {}, fn => { tick = fn; });
  expect(s.tunnels).toHaveLength(2); expect(await s.status(s.tunnels[1]!.port)).toBe(200);
  s.tunnels[1]!.dead = true; await tick();
  expect(s.tunnels).toHaveLength(3); expect(await s.status(s.tunnels[2]!.port)).toBe(200);
});

test("maintenance failures are contained and log only fixed codes", async () => {
  const codes: string[] = []; let tick!: () => Promise<void>;
  await startShareMaintenance({ restore: async () => { throw new Error("private URL"); }, sweep: async () => { throw new Error("private filename"); } }, code => codes.push(code), fn => { tick = fn; });
  await tick(); expect(codes).toEqual(["share-restore-error", "share-sweep-error"]);
});
