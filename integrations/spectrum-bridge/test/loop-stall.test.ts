import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLoopOperations, createLoopStallMonitor, traceLoopOperation, loopOperations } from "../src/loop-stall.ts";
import { createToolLog } from "../src/toollog.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const host = () => ({ loadAvg1: 50, freeMemoryBytes: 1024, rssBytes: 2048 });

test("stalls above one second emit once, include overlapping operations and rate-limit for ten seconds", () => {
  let at = 0;
  const operations = createLoopOperations(() => at);
  const rows: unknown[] = [];
  const monitor = createLoopStallMonitor(row => rows.push(row), { now: () => at, operations, host });
  at = 1250; monitor.check();
  expect(rows).toHaveLength(0);
  const finish = operations.begin("inbound.pending");
  at = 3000; finish(); monitor.check();
  expect(rows).toEqual([{ ...host(), stallMs: 1500, operations: "inbound.pending" }]);
  monitor.check();
  at = 8000; monitor.check();
  expect(rows).toHaveLength(1);
  at = 13000; monitor.check();
  expect(rows).toHaveLength(2);
  expect(rows[1]).toEqual({ ...host(), stallMs: 4750, operations: "" });
});

test("per-name coverage retains active and just-finished operations and drops stale work", () => {
  let at = 0;
  const ops = createLoopOperations(() => at);
  const end = ops.begin("log.scan");
  for (let i = 0; i < 100; i++) { at++; ops.begin("log.append")(); }
  expect(ops.during(99, 100)).toBe("log.append,log.scan");
  at = 101; end();
  expect(ops.during(102, 103)).toBe("");
  expect(ops.during(0, 1)).toBe("log.scan");
});

test.each(["completed", "active"] as const)("slow %s operation survives a burst before the heartbeat", state => {
  let at = 0;
  const operations = createLoopOperations(() => at);
  const rows: { operations: string }[] = [];
  const monitor = createLoopStallMonitor(row => rows.push(row), { now: () => at, operations, host });
  const finish = operations.begin("inbound.pending");
  at = 2000;
  if (state === "completed") finish();
  for (let i = 0; i < 1000; i++) operations.begin("log.append")();
  monitor.check();
  expect(rows[0]?.operations.split(",")).toEqual(["inbound.pending", "log.append"]);
  finish(); finish();
  at = 14000; monitor.check();
  expect(rows[1]?.operations).toBe("");
});

test("nested same-name scopes stay active until the final scope finishes", () => {
  let at = 0;
  const ops = createLoopOperations(() => at);
  const outer = ops.begin("log.scan");
  at = 1;
  const inner = ops.begin("log.scan");
  outer(); outer();
  at = 1000;
  expect(ops.during(500, at)).toBe("log.scan");
  inner();
  expect(ops.during(1001, 2000)).toBe("");
});

test("traced failures preserve the exception and finish their operation", () => {
  const started = performance.now();
  const failure = new Error("synthetic");
  expect(() => traceLoopOperation("share.records", () => { throw failure; })).toThrow(failure);
  expect(loopOperations.during(started, performance.now())).toContain("share.records");
});

test("host and sink failures stay best effort and rate-limited", () => {
  let at = 0;
  let calls = 0;
  const monitor = createLoopStallMonitor(() => { calls++; throw new Error("synthetic"); }, { now: () => at, host });
  at = 2000; expect(() => monitor.check()).not.toThrow();
  at = 4000; monitor.check(); expect(calls).toBe(1);
  const unavailable = createLoopStallMonitor(() => { throw new Error("not reached"); }, {
    now: () => at, host: () => { throw new Error("synthetic"); },
  });
  at += 2000; expect(() => unavailable.check()).not.toThrow();
});

test("stall JSON survives the cap and contains only numeric host metadata and fixed operation names", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-stall-")); dirs.push(root);
  const log = createToolLog({ root, now: () => Date.parse("2026-11-20T12:00:00Z"), capBytes: 1 });
  log.write({ component: "fixture", kind: "event", name: "fixture" });
  log.write({ component: "process", kind: "event", name: "bridge-loop-stall", ids: { chat: "PRIVATE_HANDLE" },
    props: { ...host(), stallMs: 4000, operations: "inbound.pending,share.records", text: "PRIVATE_TEXT", token: "PRIVATE_TOKEN", source: "PRIVATE_SOURCE" } });
  const raw = readFileSync(join(root, "2026-11-20.ndjson"), "utf8");
  const row = raw.trim().split("\n").map(line => JSON.parse(line)).find(line => line.name === "bridge-loop-stall");
  expect(row.props).toEqual({ ...host(), stallMs: 4000, operations: "inbound.pending,share.records" });
  expect(Object.keys(row.ids)).toEqual(["runId"]);
  expect(raw).not.toContain("PRIVATE_");
  log.write({ component: "process", kind: "event", name: "bridge-loop-stall", props: {
    operations: "PRIVATE_HANDLE", stallMs: Infinity, loadAvg1: -1, freeMemoryBytes: NaN, rssBytes: "PRIVATE_TOKEN",
  } });
  const last = JSON.parse(readFileSync(join(root, "2026-11-20.ndjson"), "utf8").trim().split("\n").at(-1)!);
  expect(last.props).toBeUndefined();
});
