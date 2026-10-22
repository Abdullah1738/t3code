import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeMessageId, opencodeFinishes } from "../src/opencode-steps.ts";

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
