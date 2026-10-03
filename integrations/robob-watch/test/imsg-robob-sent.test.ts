import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// imsg_robob_sent.py against a fake OpenCode DB: outgoing iMessages are attributed to robob only
// when the assistant made a matching send tool call; reply_to_guid alone is never a signal.
const box = mkdtempSync(join(tmpdir(), "imsg-robob-sent-test-"));
const db = join(box, "opencode.db");
const helper = join(import.meta.dir, "../helpers/imsg_robob_sent.py");
const T = Date.parse("2026-10-03T13:20:00Z");

const sql = (q: string) => {
  const r = Bun.spawnSync(["/usr/bin/sqlite3", db, q]);
  if (r.exitCode) throw new Error(r.stderr.toString());
};
const esc = (s: string) => s.replaceAll("'", "''");
let n = 0;
const toolCall = (at: number, input: Record<string, unknown>) => {
  const data = JSON.stringify({ content: [{ type: "tool", name: "shell", state: { status: "completed", input }, time: { created: at } }] });
  sql(`insert into session_message values ('m${++n}', 's1', 'assistant', ${n}, ${at}, ${at}, '${esc(data)}')`);
};
sql("create table session_message (id text primary key, session_id text, type text, seq int, time_created int, time_updated int, data text)");

toolCall(T - 60_000, { command: `imsg send --chat-id 45 --text "Hey Moni, I'm back now. Still want that coffee?" 2>&1 | tail -1` });
toolCall(T + 60_000, { command: `( osascript -e 'tell application "Messages" to send "found some! Cinnabon does a roll latte, it'"'"'s about AED 24" to participant "+971585933213" of (1st account whose service type = iMessage)' ) & sleep 30` });
toolCall(T + 120_000, { command: "cat > /tmp/m.txt <<'EOF'\nhere are the options! no turkey mince on noon or talabat today\nEOF\nimsg send --chat-id 45 --text \"$(cat /tmp/m.txt)\"" });
toolCall(T - 3_600_000, { command: `imsg send --chat-id 45 --text "Might get pizza been a few days"` }); // an hour early: out of window

const iso = (ms: number) => new Date(ms).toISOString();
const msgs = [
  { id: 1, is_from_me: true, reply_to_guid: "x", created_at: iso(T), text: "Hey Moni, I’m back now. Still want that coffee?" },
  { id: 2, is_from_me: true, reply_to_guid: "x", created_at: iso(T + 70_000), text: "found some! Cinnabon does a roll latte, it’s about AED 24" },
  { id: 3, is_from_me: true, reply_to_guid: "x", created_at: iso(T + 125_000), text: "here are the options! no turkey mince on noon or talabat today" },
  { id: 4, is_from_me: true, reply_to_guid: "x", created_at: iso(T + 130_000), text: "Might get pizza been a few days" },
  { id: 5, is_from_me: true, reply_to_guid: "x", created_at: iso(T + 140_000), text: "Kk" },
  { id: 6, is_from_me: true, created_at: iso(T + 150_000), text: "\ufffc",
    attachments: [{ original_path: "/Users/x/Library/Messages/Attachments/imsg/AB/card.png", transfer_name: "card.png" }] },
  { id: 7, is_from_me: false, created_at: iso(T + 160_000), text: "Yayayay get me one too" },
];

const run = (env: Record<string, string> = {}) => {
  const r = Bun.spawnSync(["/usr/bin/python3", helper], {
    stdin: new TextEncoder().encode(msgs.map((m) => JSON.stringify(m)).join("\n")),
    env: { PATH: "/usr/bin:/bin", ROBOB_OPENCODE_DB: db, ...env },
  });
  if (r.exitCode) throw new Error(r.stderr.toString());
  return JSON.parse(r.stdout.toString());
};

afterAll(() => rmSync(box, { recursive: true, force: true }));

test("attributes outgoing messages by the assistant's send tool calls, not reply_to_guid", () => {
  expect(run()).toEqual({ "1": "robob", "2": "robob", "3": "robob", "4": "abdullah", "5": "abdullah", "6": "robob" });
});

test("unreadable OpenCode DB gives unknown, never abdullah", () => {
  const out = run({ ROBOB_OPENCODE_DB: join(box, "missing.db") });
  expect(out["4"]).toBe("unknown");
  expect(out["6"]).toBe("robob");
});
