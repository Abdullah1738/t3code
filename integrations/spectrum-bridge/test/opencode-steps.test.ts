import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeMessageId, opencodeFinishes, opencodeRunEvidence } from "../src/opencode-steps.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const control = (native: string, part = 0) => `message:provider:opencode:native-item:${encodeURIComponent(`${native}:text:${part}`)}`;

function opencodeDb(rows: [string, unknown][]) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-steps-"));
  dirs.push(dir);
  const path = join(dir, "opencode.db");
  const db = new Database(path);
  db.run("CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, data TEXT)");
  for (const [id, data] of rows) db.query("INSERT INTO session_message VALUES (?, 's', 'assistant', ?)").run(id, JSON.stringify(data));
  db.close();
  return { dir, path };
}

function runDb(rows: { seq: number; time: number; data: unknown }[]) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-run-"));
  dirs.push(dir);
  const path = join(dir, "opencode.db");
  const db = new Database(path);
  db.run("CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)");
  rows.forEach((row, index) => db.query("INSERT INTO session_message VALUES (?, 'ses_run', 'assistant', ?, ?, ?)").run(`msg_${index}`, row.seq, row.time, JSON.stringify(row.data)));
  db.close();
  return path;
}

test("native run evidence: truncated scans are unknown, a complete stop-only run is none, a tool row anywhere is ran", () => {
  const stop = { finish: "stop", content: [{ type: "text", text: "ok" }] };
  // 200 stop steps, then a tool step past the old cap: never `none`.
  const long: { seq: number; time: number; data: unknown }[] = Array.from({ length: 200 }, (_, i) => ({ seq: i, time: 1000 + i, data: stop }));
  long.push({ seq: 200, time: 1300, data: { finish: "tool-calls", content: [{ type: "tool", id: "t", name: "bash", state: { status: "completed" } }] } });
  const evidence = opencodeRunEvidence(runDb(long), 200);
  expect(evidence("ses_run", 0)).toBe("ran");
  // Same stop steps only but more than the cap: the scan is truncated, so unknown.
  const capped = Array.from({ length: 250 }, (_, i) => ({ seq: i, time: 1000 + i, data: stop }));
  expect(opencodeRunEvidence(runDb(capped), 200)("ses_run", 0)).toBe("unknown");
  // A complete, all-stop run is proven tool-free.
  expect(opencodeRunEvidence(runDb([{ seq: 0, time: 1000, data: stop }]))("ses_run", 0)).toBe("none");
  // A first-call provider error: a failed step with no content (finish error) proves nothing ran.
  expect(opencodeRunEvidence(runDb([{ seq: 0, time: 1000, data: { finish: "error", content: [], error: { type: "aborted" } } }]))("ses_run", 0)).toBe("none");
  // An errored step that carried a tool part did run a tool.
  expect(opencodeRunEvidence(runDb([{ seq: 0, time: 1000, data: { finish: "error", content: [{ type: "tool", id: "t", name: "patch", state: { status: "error" } }] } }]))("ses_run", 0)).toBe("ran");
  // An unfinished step may still be executing (no finish yet), so it is never proven tool-free.
  expect(opencodeRunEvidence(runDb([{ seq: 0, time: 1000, data: { content: [] } }]))("ses_run", 0)).toBe("unknown");
  // A terminal error that emitted text or reasoning but no tool is proven tool-free.
  expect(opencodeRunEvidence(runDb([{ seq: 0, time: 1000, data: { finish: "error", content: [{ type: "text", text: "partial" }], error: { type: "aborted" } } }]))("ses_run", 0)).toBe("none");
  expect(opencodeRunEvidence(runDb([{ seq: 0, time: 1000, data: { finish: "error", content: [{ type: "reasoning", text: "thinking" }], error: { type: "aborted" } } }]))("ses_run", 0)).toBe("none");
  // OpenCode can record a pending native retry on an error step and keep executing: not settled.
  expect(opencodeRunEvidence(runDb([{ seq: 0, time: 1000, data: { finish: "error", content: [{ type: "text", text: "partial" }], retry: { attempt: 2, at: 2000 }, error: { type: "provider.internal" } } }]))("ses_run", 0)).toBe("unknown");
  // A content part the reader does not know is not proven tool-free.
  expect(opencodeRunEvidence(runDb([{ seq: 0, time: 1000, data: { finish: "error", content: [{ type: "file", url: "x" }] } }]))("ses_run", 0)).toBe("unknown");
  // No rows in the window: nothing to prove.
  expect(opencodeRunEvidence(runDb([{ seq: 0, time: 1000, data: stop }]))("ses_run", 5000)).toBe("unknown");
});

test("control message ids map to OpenCode message ids; anything else is not OpenCode's", () => {
  expect(nativeMessageId(control("msg_1631c3533001gglKYKx3h1Eo1y"))).toBe("msg_1631c3533001gglKYKx3h1Eo1y");
  expect(nativeMessageId("assistant-3")).toBeUndefined();
  expect(nativeMessageId("message:provider:opencode:native-item:%E0%A4%A")).toBeUndefined();
  expect(nativeMessageId(`message:provider:opencode:native-item:${encodeURIComponent("toolu_1:x")}`)).toBeUndefined();
});

test("finishes come from OpenCode's messages, read-only; unknown ids and a missing database stay unknown", () => {
  const { dir, path } = opencodeDb([["msg_a", { finish: "stop" }], ["msg_b", { finish: "tool-calls" }], ["msg_c", {}]]);
  const finishes = opencodeFinishes(path);
  const ids = [control("msg_a"), control("msg_b"), control("msg_c"), control("msg_gone"), "assistant-1"];
  expect([...finishes(ids)]).toEqual([[control("msg_a"), "stop"], [control("msg_b"), "tool-calls"]]);
  // A compaction swaps the file: the next read opens the new one.
  const swapped = opencodeDb([["msg_a", { finish: "tool-calls" }]]);
  renameSync(swapped.path, path);
  expect([...finishes([control("msg_a")])]).toEqual([[control("msg_a"), "tool-calls"]]);
  rmSync(dir, { recursive: true, force: true });
  expect(finishes([control("msg_a")]).size).toBe(0);
  expect(opencodeFinishes(join(dir, "nope.db"))([control("msg_a")]).size).toBe(0);
});

test("every text block of one OpenCode message gets that message's finish", () => {
  const { path } = opencodeDb([["msg_a", { finish: "stop" }]]);
  const ids = [control("msg_a"), control("msg_a", 1), control("msg_a", 2)];
  expect([...opencodeFinishes(path)(ids)]).toEqual(ids.map(id => [id, "stop"]));
});
