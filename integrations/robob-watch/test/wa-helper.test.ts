import { afterAll, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(30_000);
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// whatsapp-new-message (wacli-store backend) against a fake ~/.wacli; no WhatsApp involved.
const box = mkdtempSync(join(tmpdir(), "wa-helper-test-"));
const store = join(box, "wacli");
const dir = join(box, "watch");
for (const d of [store, dir]) mkdirSync(d, { recursive: true });
const db = join(store, "wacli.db");
const sql = (q: string, path = db) => { const r = Bun.spawnSync(["/usr/bin/sqlite3", path, q]); if (r.exitCode) throw new Error(r.stderr.toString()); };
sql(`create table chats (jid text primary key, kind text, name text, last_message_ts int, unread_count int default 0);
  create table contacts (jid text primary key, phone text, push_name text, full_name text, first_name text, business_name text, system_name text, updated_at int);
  create table contact_aliases (jid text primary key, alias text, notes text, updated_at int);
  create table messages (rowid integer primary key autoincrement, chat_jid text, chat_name text, msg_id text, sender_jid text, sender_name text,
    ts int, from_me int, text text, display_text text, media_type text, media_caption text, filename text, reaction_emoji text,
    edited int default 0, edited_ts int default 0, revoked int default 0, deleted_at int, unique(chat_jid, msg_id));
  insert into contacts values ('971500000001@s.whatsapp.net','971500000001','Bob','','','','',0);`);
sql(`create table whatsmeow_lid_map (lid text primary key, pn text unique not null); insert into whatsmeow_lid_map values ('111','971500000001');`, join(store, "session.db"));
writeFileSync(join(store, "LOCK"), `pid=${process.pid}\nacquired_at=now\n`);

const helpers = join(import.meta.dir, "../helpers");
let n = 0;
const add = (chat: string, text: string, ts: number, fromMe = 0) =>
  sql(`insert into messages (chat_jid, msg_id, sender_jid, ts, from_me, text, display_text) values ('${chat}', 'm${++n}', '${chat}', ${ts}, ${fromMe}, '${text}', '${text}')`);
const run = (jid: string, extra: Record<string, string> = {}) => {
  const r = Bun.spawnSync([join(helpers, "whatsapp-new-message"), jid], {
    env: { HOME: box, WACLI_STORE_DIR: store, PATH: [helpers, "/usr/bin", "/bin"].join(":"), WATCH_DIR: dir, LANG: "en_US.UTF-8", ...extra } });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};
process.env.TZ = "UTC";
const ack = (id: string) => writeFileSync(join(dir, ".run-ok"), `${id}\n`);
const now = () => Math.floor(Date.now() / 1000);

afterAll(() => rmSync(box, { recursive: true, force: true }));

test("phone JID and LID share one cursor; same-second and late messages fire exactly once", () => {
  add("971500000001@s.whatsapp.net", "old", now() - 3600);
  expect(run("971500000001@s.whatsapp.net", { WATCH_RUN: "r1" })).toMatchObject({ code: 0, out: "" });
  ack("r1");
  add("111@lid", "first", now());
  add("971500000001@s.whatsapp.net", "second", now());
  add("971500000001@s.whatsapp.net", "late", now() - 120);
  add("971500000001@s.whatsapp.net", "mine", now(), 1);
  // A check listing both JIDs in one run: the second call must not repeat what the first printed.
  const a = run("971500000001@s.whatsapp.net", { WATCH_RUN: "r2" });
  const b = run("111@lid", { WATCH_RUN: "r2" });
  expect(a.out.split("\n")).toHaveLength(3);
  expect(a.out).toContain("Bob: first");
  expect(a.out).toContain("Bob: late");
  expect(a.out).not.toContain("mine");
  expect(b.out).toBe("");
  ack("r2");
  expect(run("971500000001@s.whatsapp.net", { WATCH_RUN: "r3" }).out).toBe("");
  expect(run("111@lid", { WATCH_RUN: "r3" }).out).toBe("");
});

test("an unacked run is replayed once, then cleared by the next ack (never loops)", () => {
  ack("r3");
  add("971500000001@s.whatsapp.net", "needs replay", now());
  expect(run("971500000001@s.whatsapp.net", { WATCH_RUN: "r4" }).out).toContain("needs replay");
  // r4 never acked (check timed out): r5 replays it ...
  expect(run("971500000001@s.whatsapp.net", { WATCH_RUN: "r5" }).out).toContain("needs replay");
  ack("r5");
  // ... and once r5 is acked it is gone for good (the 1 Oct bug re-fired it forever).
  for (const r of ["r6", "r7", "r8"]) { expect(run("971500000001@s.whatsapp.net", { WATCH_RUN: r }).out).toBe(""); ack(r); }
  expect(readdirSync(dir).filter(f => f.endsWith(".outbox"))).toHaveLength(0);
});

test("replays stop after 3 tries even if nothing is ever acked", () => {
  add("971500000001@s.whatsapp.net", "stuck", now());
  const outs = ["s1", "s2", "s3", "s4", "s5", "s6"].map(r => run("971500000001@s.whatsapp.net", { WATCH_RUN: r }).out);
  expect(outs.filter(o => o.includes("stuck"))).toHaveLength(4); // original + 3 replays
});

test("migration from TUI state never re-reports old or already-seen messages", () => {
  const legacyDir = join(box, "legacy");
  mkdirSync(legacyDir);
  sql(`insert into whatsmeow_lid_map values ('222','971500000002')`, join(store, "session.db"));
  const old = now() - 2 * 86400;
  const seenTs = now() - 600;
  add("222@lid", "ancient greeting", old);
  add("971500000002@s.whatsapp.net", "already reported", seenTs);
  add("971500000002@s.whatsapp.net", "missed while migrating", now() - 60);
  const t = (s: number) => { const d = new Date(s * 1000); const p = (x: number) => String(x).padStart(2, "0");
    return `(${p(d.getDate())}-${p(d.getMonth() + 1)}-${String(d.getFullYear()).slice(2)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())})`; };
  // Empty phone-JID .seen (as the TUI helper left it) with an old birth time, plus the LID .seen with the seen line.
  writeFileSync(join(legacyDir, "wa-971500000002.seen"), "");
  utimesSync(join(legacyDir, "wa-971500000002.seen"), old - 86400, old - 86400);
  writeFileSync(join(legacyDir, "wa-222.seen"), `${t(seenTs)} 222@lid: already reported\n`);
  const r = (jid: string) => Bun.spawnSync([join(helpers, "whatsapp-new-message"), jid], {
    env: { HOME: box, WACLI_STORE_DIR: store, PATH: [helpers, "/usr/bin", "/bin"].join(":"), WATCH_DIR: legacyDir, WATCH_RUN: "m1", TZ: "UTC" } }).stdout.toString().trim();
  const first = r("971500000002@s.whatsapp.net") + r("222@lid");
  expect(first).toContain("missed while migrating");
  expect(first).not.toContain("ancient greeting");
  expect(first).not.toContain("already reported");
  writeFileSync(join(legacyDir, ".run-ok"), "m1\n");
  const again = Bun.spawnSync([join(helpers, "whatsapp-new-message"), "971500000002@s.whatsapp.net"], {
    env: { HOME: box, WACLI_STORE_DIR: store, PATH: [helpers, "/usr/bin", "/bin"].join(":"), WATCH_DIR: legacyDir, WATCH_RUN: "m2", TZ: "UTC" } }).stdout.toString().trim();
  expect(again).toBe("");
});

test("history backfill inserts (old timestamps) never fire; daemon down is a failure", () => {
  add("971500000001@s.whatsapp.net", "backfilled old message", now() - 3 * 86400);
  expect(run("971500000001@s.whatsapp.net", { WATCH_RUN: "h1" }).out).toBe("");
  writeFileSync(join(store, "LOCK"), "pid=999999\n");
  expect(run("971500000001@s.whatsapp.net").code).toBe(1);
  writeFileSync(join(store, "LOCK"), `pid=${process.pid}\n`);
});
