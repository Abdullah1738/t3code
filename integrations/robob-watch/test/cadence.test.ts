import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckSlots, checkLane, LoadMode, type SlotEvent } from "../src/host.ts";
import { rollup } from "../src/toollog.ts";
import { replaySlots } from "./slot-replay.ts";
import capture from "./fixtures/cadence-replay.json";

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test("load hysteresis requires sustained entry and a full low dwell before exit", () => {
  const mode = new LoadMode({ high: 1.5, low: 1.2, dwellMs: 60_000 });
  for (let at = 0; at < 120_000; at += 1000) expect(mode.sample(at % 2000 ? 1.49 : 1.51, at)).toBe(false);
  expect(mode.sample(1.51, 120_000)).toBe(false);
  expect(mode.sample(1.51, 180_000)).toBe(true);
  for (let at = 181_000; at < 300_000; at += 1000) expect(mode.sample(at % 2000 ? 1.49 : 1.51, at)).toBe(true);
  expect(mode.sample(1.1, 300_000)).toBe(true);
  expect(mode.sample(1.2, 359_000)).toBe(true);
  expect(mode.sample(1.1, 360_000)).toBe(true);
  expect(mode.sample(1.1, 419_999)).toBe(true);
  expect(mode.sample(1.1, 420_000)).toBe(false);
});

test.each([undefined, NaN, Infinity, -1, 10_000, 60_000])("unknown/invalid/slow runtime %s stays in slow pool", value => {
  expect(checkLane(value)).toBe("slow");
});
test.each([0, 500, 9_999])("runtime %s qualifies for reserved capacity", value => {
  expect(checkLane(value)).toBe("fast");
});

test("fast checks bypass ten slow waiters and keep twelve runs per simulated hour", async () => {
  const result = await replaySlots(undefined, 2, 1, { fastSlots: 2, mix: {
    source: "two slots occupied by 60s checks, ten more queued; a half-second health check is due",
    watchers: [...Array.from({ length: 12 }, (_, i) => ({ watcher: `slow-${i}`, intervalMs: 300_000, checkMs: 60_000 })),
      { watcher: "meds-nag", intervalMs: 300_000, checkMs: 500 }],
  } });
  expect(result.byWatcher.find(row => row.watcher === "meds-nag")).toMatchObject({ runs: 12, maxS: 0 });
  expect(result.minRuns).toBeGreaterThan(0);
});

test("two checks turning slow preserve fast capacity after ten seconds without interrupting them", async () => {
  let clock = 0;
  const events: SlotEvent[] = [], releases: (() => void)[] = [], started: string[] = [];
  const slots = new CheckSlots(() => 2, { now: () => clock, emit: event => events.push(event) }, 2);
  const hold = (watcher: string, lane: "fast" | "slow") => slots.run(async () => {
    started.push(watcher);
    await new Promise<void>(resolve => releases.push(resolve));
  }, { watcher, lane });
  const jobs = [hold("slow-a", "slow"), hold("slow-b", "slow"), hold("became-slow-a", "fast"), hold("became-slow-b", "fast")];
  await flush();
  jobs.push(hold("slow-waiter", "slow"));
  const fast = slots.run(async () => { started.push("cheap"); }, { watcher: "cheap", lane: "fast" });
  await flush();
  clock = 9_999; slots.drain(); await flush();
  expect(started).not.toContain("cheap");
  clock = 10_000; slots.drain(); await fast;
  expect(started).toContain("cheap");
  expect(started).not.toContain("slow-waiter");
  expect(events.filter(event => event.name === "slot.overrun")).toHaveLength(2);
  clock = 20_000; slots.drain();
  expect(events.filter(event => event.name === "slot.overrun")).toHaveLength(2);
  for (const release of releases.splice(0)) release();
  await flush();
  expect(started).toContain("slow-waiter");
  for (const release of releases.splice(0)) release();
  await Promise.all(jobs);
});

test.each([[1, 1], [2, 1], [2, 2], [6, 2]])("repeated overruns stay bounded and preserve slow FIFO: %s slow, %s fast", async (cap, fastCap) => {
  let clock = 0;
  const active = new Set<string>(), releases = new Map<string, () => void>(), jobs: Promise<void>[] = [], events: SlotEvent[] = [];
  const slots = new CheckSlots(() => cap, { now: () => clock, emit: event => events.push(event) }, fastCap);
  const hold = (watcher: string, lane: "fast" | "slow") => jobs.push(slots.run(async () => {
    active.add(watcher);
    await new Promise<void>(resolve => releases.set(watcher, resolve));
    active.delete(watcher);
  }, { watcher, lane }));
  for (let i = 0; i < cap; i++) hold(`slow-${i}`, "slow");
  hold("old-slow-waiter", "slow");
  hold("new-slow-waiter", "slow");
  for (let i = 0; i < 12; i++) hold(`fast-${i}`, "fast");
  await flush();
  for (clock = 10_000; clock <= 60_000; clock += 10_000) {
    slots.drain(); await flush();
    expect(active.size).toBeLessThanOrEqual(cap + fastCap + 1);
  }
  expect(events.filter(event => event.name === "slot.overrun")).toHaveLength(fastCap + 1);
  releases.get("slow-0")!(); releases.delete("slow-0"); await flush();
  expect(active).toContain("old-slow-waiter");
  expect(active).not.toContain("new-slow-waiter");
  releases.get("old-slow-waiter")!(); releases.delete("old-slow-waiter"); await flush();
  expect(active).toContain("new-slow-waiter");
  for (let i = 0; i < 16; i++) {
    const current = [...releases.values()]; releases.clear();
    for (const release of current) release();
    await flush();
    expect(active.size).toBeLessThanOrEqual(cap + fastCap + 1);
  }
  await Promise.all(jobs);
  expect(active.size).toBe(0);
});

test("captured live mix meets cadence with hysteresis and two fast slots, without anchoring", async () => {
  const before = await replaySlots(undefined, 6, 24, capture);
  const after = await replaySlots(undefined, 6, 24, { ...capture, hysteresis: true, fastSlots: 2 });
  for (const id of ["meds-nag", "gym-nudge", "nutrition-checkin", "nutrition-nudge"]) {
    expect(after.byWatcher.find(row => row.watcher === id)!.runs).toBeGreaterThanOrEqual(280);
  }
  expect(after.byWatcher.find(row => row.watcher === "forge-workouts")!.runs).toBeGreaterThanOrEqual(140);
  for (const current of after.byWatcher) {
    const old = before.byWatcher.find(row => row.watcher === current.watcher)!;
    expect(current.p95S).toBeLessThanOrEqual(old.p95S);
    expect(current.maxS).toBeLessThanOrEqual(old.maxS);
    expect(current.runs).toBeGreaterThan(0);
  }
  expect(after.switches).toBeLessThanOrEqual(1);
}, 30_000);

test("rollup counts scheduled cadence, keeps zero-run watchers, and clips load time across midnight", async () => {
  const dir = mkdtempSync(join(tmpdir(), "watch-cadence-"));
  try {
    const start = Date.parse("2026-11-16T00:00:00Z"), end = start + 86400_000;
    const row = (name: string, at: number, watcher?: string, props = {}, durationMs?: number) => ({
      tool: "watchers", component: "runner", kind: "perf", name, ts: new Date(at).toISOString(), ids: { watcher }, props, durationMs,
    });
    const rows = [row("watch.cadence", start, "empty", { intervalMs: 300_000 }),
      ...[0, 300_000, 900_000].map((ms, i) => row("watch.run", start + ms, "meds-nag", { intervalMs: 300_000, trigger: "schedule", lateMs: i * 1000 })),
      row("watch.run", start + 20_000, "meds-nag", { intervalMs: 300_000, trigger: "trigger", lateMs: 0 }),
      row("watch.run", start + 40_000, "meds-nag", { intervalMs: 300_000, trigger: "retry", lateMs: 0 }),
      row("host.load_mode", start + 1000, undefined, { loadMode: true }),
      row("host.load_time", start + 30_000, undefined, {}, 60_000),
      row("host.load_mode", start + 50_000, undefined, { loadMode: false }),
    ];
    writeFileSync(join(dir, "2026-11-16.ndjson"), rows.map(row => JSON.stringify(row)).join("\n"));
    writeFileSync(join(dir, "2026-11-17.ndjson"), JSON.stringify(row("host.load_time", end + 30_000, undefined, {}, 60_000)));
    const daily = await rollup("2026-11-16", dir);
    expect(daily?.byWatcher["meds-nag"]).toMatchObject({ expectedRuns: 288, actualRuns: 3, missedTicks: 285, runs: 5, lateMs: { p50: 0, p95: 2000 } });
    expect(daily?.byWatcher.empty).toMatchObject({ expectedRuns: 288, actualRuns: 0, missedTicks: 288 });
    expect(daily?.loadMode).toEqual({ minutes: 1, switches: 2 });
    const window = await rollup({ since: new Date(start).toISOString(), until: new Date(start + 3600_000).toISOString() }, dir);
    expect(window?.byWatcher["meds-nag"]).toMatchObject({ expectedRuns: 12, actualRuns: 3, missedTicks: 9 });
    expect(window?.loadMode).toEqual({ minutes: .5, switches: 2 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.each(["00:00", "00:30", "01:00", "23:00"])("zero-run interval metadata survives a prior-day header at %s", async time => {
  const dir = mkdtempSync(join(tmpdir(), "watch-cadence-history-"));
  try {
    writeFileSync(join(dir, "2026-11-16.ndjson"), JSON.stringify({ ts: "2026-11-16T23:59:00Z", tool: "watchers", component: "runner", kind: "event",
      name: "watch.cadence", ids: { watcher: "queued" }, props: { intervalMs: 300_000 } }));
    const start = Date.parse(`2026-11-17T${time}:00Z`);
    const result = await rollup({ since: new Date(start).toISOString(), until: new Date(start + 1800_000).toISOString() }, dir);
    expect(result?.byWatcher.queued).toMatchObject({ expectedRuns: 6, actualRuns: 0, missedTicks: 6 });
    expect(result?.total).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("queued watchers keep emitting daily cadence headers across multiple midnights", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-queued-cadence-"));
  try {
    const child = Bun.spawnSync([process.execPath, "-e", `
      import {mock} from "bun:test";
      import {mkdirSync,writeFileSync,readFileSync,readdirSync} from "node:fs";
      import {join} from "node:path";
      mkdirSync(process.env.TOOLLOG_DIR,{recursive:true});
      const previous=new Date(Date.now()-86400_000).toISOString().slice(0,10);
      writeFileSync(join(process.env.TOOLLOG_DIR,"rollup-"+previous+".json"),"{}");
      let clock=Date.parse("2026-11-16T23:59:00Z"); Date.now=()=>clock;
      const path=${JSON.stringify(join(import.meta.dir, "../src/lib.ts"))}, lib=await import(path);
      let checks=0;
      mock.module(path,()=>({...lib,runCheck:async()=>{checks++;return await new Promise(()=>{});}}));
      for(const id of ["holder","queued"]){
        const root=lib.watcherDir(id);mkdirSync(root,{recursive:true});
        writeFileSync(join(root,"watcher.json"),JSON.stringify(lib.normalize({id,title:id,mode:"notify",check:"true",interval_s:3600,max_fires:0})));
        lib.saveState(id,{status:"active",fires:0,consecutive_failures:0,next_at:0});
      }
      const {tick}=await import(${JSON.stringify(join(import.meta.dir, "../src/runner.ts"))});
      for(let day=0;day<3;day++){
        clock=Date.parse("2026-11-16T23:59:00Z")+day*86400_000;
        await tick();for(let i=0;i<60;i++)await Promise.resolve();
      }
      const rows=readdirSync(process.env.TOOLLOG_DIR).filter(x=>x.endsWith(".ndjson")).flatMap(file=>readFileSync(join(process.env.TOOLLOG_DIR,file),"utf8").trim().split("\\n").map(JSON.parse));
      console.log(JSON.stringify({checks,headers:rows.filter(x=>x.name==="watch.cadence"&&x.ids.watcher==="queued").length,runs:rows.filter(x=>x.name==="watch.run").length}));
    `], { env: { ...process.env, BUN_INSPECT: undefined, ROBOB_TEST: "1", ROBOB_WATCH_ROOT: join(dir, "root"), TOOLLOG_DIR: join(dir, "logs"), ROBOB_WATCH_LOAD_OVERRIDE: ".1", ROBOB_WATCH_MAX_CONCURRENT: "1", ROBOB_WATCH_SSD_PATH: "/dev" } });
    expect(child.stderr.toString()).toBe(""); expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!)).toEqual({ checks: 1, headers: 3, runs: 0 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("runner persists sticky history and emits the classification statistic", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-cadence-"));
  try {
    const child = Bun.spawnSync([process.execPath, "-e", `
      import {mock} from "bun:test";
      import {mkdirSync,writeFileSync,readFileSync,readdirSync} from "node:fs";
      import {join} from "node:path";
      const path=${JSON.stringify(join(import.meta.dir, "../src/lib.ts"))};
      const lib=await import(path);
      mock.module(path,()=>({...lib,runCheck:async()=>({code:0,ms:11_000,stdout:"",stderr:"",timedOut:false,signal:null})}));
      const id="cadence", root=lib.watcherDir(id);mkdirSync(root,{recursive:true});
      writeFileSync(join(root,"watcher.json"),JSON.stringify(lib.normalize({id,title:id,mode:"notify",check:"true",interval_s:300,max_fires:0})));
      lib.saveState(id,{status:"active",fires:0,consecutive_failures:0,last_run_ms:500,next_at:Date.now()-1000});
      const {tickOne}=await import(${JSON.stringify(join(import.meta.dir, "../src/runner.ts"))});
      await tickOne(id);
      for(let i=0;i<2;i++){const state=lib.loadState(id);lib.saveState(id,{...state,next_at:0});await tickOne(id);}
      const first=lib.loadState(id);lib.saveState(id,{...first,next_at:0});
      await tickOne(id);
      const lines=readdirSync(process.env.TOOLLOG_DIR).filter(x=>x.endsWith(".ndjson")).flatMap(file=>readFileSync(join(process.env.TOOLLOG_DIR,file),"utf8").trim().split("\\n").map(JSON.parse));
      console.log(JSON.stringify(lines.filter(x=>x.name==="watch.run")));
    `], { env: { ...process.env, BUN_INSPECT: undefined, ROBOB_TEST: "1", ROBOB_WATCH_ROOT: join(dir, "root"), TOOLLOG_DIR: join(dir, "logs"), ROBOB_WATCH_LOAD_OVERRIDE: ".1" } });
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
    const rows = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
    expect(rows).toHaveLength(4);
    expect(rows[0].props).toMatchObject({ lane: "fast", loadMode: false, trigger: "schedule", intervalMs: 300_000 });
    expect(rows[0].props.dueAt).toBeNumber();
    expect(rows[0].props.lateMs).toBeGreaterThanOrEqual(1000);
    expect(rows[1].props).toMatchObject({ lane: "fast", lane_reason: "fast:sticky", recentMinMs: 500, loadMode: false });
    expect(rows[2].props).toMatchObject({ lane: "fast", lane_reason: "fast:sticky", recentMinMs: 500 });
    expect(rows[3].props).toMatchObject({ lane: "slow", lane_reason: "slow:recent", recentMinMs: 11_000 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
