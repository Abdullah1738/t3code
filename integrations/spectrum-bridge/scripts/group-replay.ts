#!/usr/bin/env bun
/**
 * Replays the group gate over a group chat's stored history, read-only, and
 * prints what it would decide for each person-typed row now: fast path or Jev
 * with its probability, next to what the live gate did and an optional label.
 *
 *   bun scripts/group-replay.ts [--chat group-sb_gro] [--since 2026-10-22T09:00Z] [--labels labels.json] [--no-jev]
 *
 * labels.json maps an inbound row id (or rowid) to "wake" or "observe". Message
 * text is printed to the terminal only; nothing is written.
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadAccess, roleOf } from "../src/access.ts";
import { isTapback, mentionsRobob } from "../src/group-gate.ts";
import { groupLines, inboundTime, inboundWords, JEV_CHUNK, JEV_THRESHOLD, jevJudge, judgeState, replyTarget, speakerName, type GroupLine } from "../src/group-judge.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const root = join(homedir(), ".config/spectrum-bridge");
const chat = flag("--chat") ?? "group-sb_gro";
const since = flag("--since") ? Date.parse(flag("--since")!) : 0;
const labels: Record<string, string> = flag("--labels") ? JSON.parse(readFileSync(flag("--labels")!, "utf8")) : {};
const useJev = !args.includes("--no-jev");

const owner = (JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as { owner: string }).owner;
const access = await loadAccess(join(root, "access.json"));
const nameOf = (address: string) => speakerName(roleOf(access, owner, address), address);
const db = new Database(join(root, "chats", chat, "state.sqlite"), { readonly: true });

type Row = { rowid: number; id: string; payload: string; state: string; gate: string | null };
const rows = db.query<Row, []>(
  "SELECT i.rowid, i.id, i.payload, i.state, (SELECT value FROM kv WHERE key = 'group-gate:' || i.id) AS gate FROM inbound i ORDER BY i.rowid",
).all();
const toRobob = (replyTo: string | undefined) => !!replyTo && (
  !!db.query("SELECT 1 FROM outbox WHERE providerId = ? AND json_extract(payload, '$.kind') = 'conversation'").get(replyTo)
  || !!db.query("SELECT 1 FROM kv WHERE key = ?").get(`provider-operation:${replyTo}`));

type Result = { row: Row; line: GroupLine; replyTo?: string; verdict?: string; reason?: string };
const results: Result[] = [];
for (const row of rows) {
  const input = JSON.parse(row.payload);
  if (/^(secret|wake|reset):/.test(row.id) || input.poll || String(input.text ?? "").trimStart().startsWith("/")) continue;
  const at = inboundTime(input);
  if (at === undefined || at < since) continue;
  const text = String(input.text ?? "").trim();
  const line: GroupLine = { id: row.id, at, who: input.sender ? nameOf(input.sender) : "Someone", robob: false, sender: input.sender, text: inboundWords(input) };
  const result: Result = { row, line, replyTo: input.replyTo };
  if (isTapback(text)) Object.assign(result, { verdict: "observe", reason: "tapback" });
  else if (mentionsRobob(text)) Object.assign(result, { verdict: "wake", reason: "named" });
  else if (toRobob(input.replyTo)) Object.assign(result, { verdict: "wake", reason: "reply" });
  results.push(result);
}

const addressed = (id: string) => {
  const known = results.find(result => result.row.id === id);
  if (known?.verdict) return known.verdict === "wake";
  const gate = rows.find(row => row.id === id)?.gate;
  return gate === '"explicit"' || gate === '"followup"';
};
const ask = results.filter(result => !result.verdict);
const judge = jevJudge();

for (let at = 0; at < ask.length && useJev; at += JEV_CHUNK) {
  const chunk = ask.slice(at, at + JEV_CHUNK);
  const states = chunk.map(result => {
    const lines = groupLines(db, nameOf, [result.row.id]);
    const replyTo = result.replyTo ? replyTarget(db, lines, result.replyTo, nameOf) : undefined;
    return judgeState(lines, result.line, { timezone: "Asia/Dubai", replyTo, working: false, addressed });
  });
  const scores = await judge(states);

  chunk.forEach((result, index) => {
    const p = scores[index]!;
    result.verdict = p >= JEV_THRESHOLD ? "wake" : "observe";
    result.reason = `jev ${p.toFixed(2)}`;
  });
}

const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const was = (row: Row) => row.state === "observed" ? "observe" : row.gate ? "wake" : row.state;
let agree = 0, labelled = 0;
console.log(["row", "time (Dubai)", "who", "message", "replay", "why", "live", "expected"].join(" | "));
for (const result of results) {
  const expected = labels[result.row.id] ?? labels[String(result.row.rowid)] ?? "";
  if (expected) { labelled += 1; if (expected === result.verdict) agree += 1; }
  const text = result.line.text.replace(/\s+/g, " ");
  console.log([result.row.rowid, time.format(result.line.at), result.line.who, text.length > 60 ? `${text.slice(0, 59)}…` : text,
    result.verdict ?? "-", result.reason ?? "skipped", was(result.row), expected ? `${expected}${expected === result.verdict ? "" : " ✗"}` : ""].join(" | "));
}
console.log(`\n${results.length} rows, ${ask.length} judged by Jev${useJev ? "" : " (skipped)"}${labelled ? `, ${agree}/${labelled} match the labels` : ""}.`);
db.close();
