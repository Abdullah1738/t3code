import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { BoxRunner } from "../src/runner.ts";
import { BoxWatchers } from "../src/watchers.ts";
const clean: (() => void)[] = [];
afterEach(() => clean.splice(0).reverse().forEach(f => f()));
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

test("real wa-db outbox replays after a failed check without losing or duplicating the reply", async () => {
  const root = mkdtempSync(join(tmpdir(), "box-wa-replay-")); clean.push(() => rmSync(root, { recursive: true, force: true }));
  const store = join(root, "wa"); mkdirSync(store);
  const db = new Database(join(store, "wacli.db")); clean.push(() => db.close());
  db.exec(`CREATE TABLE contacts(jid TEXT, phone TEXT,push_name TEXT,full_name TEXT,first_name TEXT,business_name TEXT,system_name TEXT,updated_at INT);
    CREATE TABLE chats(jid TEXT,kind TEXT,name TEXT,last_message_ts INT,unread_count INT);
    CREATE TABLE contact_aliases(jid TEXT,alias TEXT,notes TEXT,updated_at INT);
    CREATE TABLE messages(rowid INTEGER PRIMARY KEY,chat_jid TEXT,chat_name TEXT,msg_id TEXT,sender_jid TEXT,sender_name TEXT,ts INT,from_me INT,text TEXT,display_text TEXT,media_type TEXT,media_caption TEXT,filename TEXT,reaction_emoji TEXT,edited INT,edited_ts INT,revoked INT,deleted_at INT);`);
  const sessionDb = new Database(join(store, "session.db")); sessionDb.exec("CREATE TABLE whatsmeow_lid_map(lid TEXT,pn TEXT)"); sessionDb.close();
  const canary = randomUUID();
  db.query("INSERT INTO messages(rowid,chat_jid,msg_id,sender_jid,ts,from_me,text,display_text,edited,edited_ts,revoked) VALUES (1,?,?,?, ?,0,?,?,0,0,0)")
    .run("971500000001@s.whatsapp.net", "message", "971500000001@s.whatsapp.net", Math.floor(Date.now()/1000), canary, canary);
  let now = Date.now();
  const runner = new BoxRunner({ root, boxId: "bx_test", epoch: "test", token: "a".repeat(40), callbackToken: "b".repeat(40), privateKey: "unused", callbackUrl: "unused", system: "system" },
    { run: async () => "NO_REPLY" }, { now: () => now, callbackReady: async () => true }); clean.push(() => runner.db.close());
  const renew = () => runner.handle(new Request("http://box/lease", { method: "POST", headers: { authorization: `Bearer ${"a".repeat(40)}` }, body: JSON.stringify({ boxId: "bx_test", epoch: "test" }) }));
  const helper = resolve(import.meta.dir, "../../robob-watch/helpers/wa-db");
  const flag = join(root, "allow-success");
  const watches = new BoxWatchers(runner);
  watches.add({ id: "wa-reply", check: `WACLI_STORE_DIR=${quote(store)} /usr/bin/python3 ${quote(helper)} new 971500000001; test -f ${quote(flag)}`,
    interval: 5, context: "notify", expiresAt: now + 86400000, maxFires: 0 });
  const dir = join(root, "watchers/wa-reply");
  writeFileSync(join(dir, "wadb-971500000001.json"), JSON.stringify({ rowid: 0, edits: {}, at: Math.floor(now/1000) }));
  await renew(); await watches.tick();
  expect(runner.db.query<{ n: number }, []>("SELECT count(*) n FROM inbox").get()!.n).toBe(0);
  expect(readFileSync(join(dir, "wadb-971500000001.json.outbox"), "utf8")).toContain(canary);
  writeFileSync(flag, "ok"); now += 61000; await renew(); await watches.tick();
  expect(runner.db.query<{ payload: string }, []>("SELECT payload FROM inbox").get()!.payload).toContain(canary);
  now += 61000; await renew(); await watches.tick();
  expect(runner.db.query<{ n: number }, []>("SELECT count(*) n FROM inbox").get()!.n).toBe(1);
});
