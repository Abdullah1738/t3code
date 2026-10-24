import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attributedText, chatDbSwipes } from "../src/swipe.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** The typedstream shape newer macOS writes: NSString, a few class bytes, then '+' and a length. */
function body(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  const length = bytes.length < 0x81 ? [bytes.length] : [0x81, bytes.length & 0xff, bytes.length >> 8];
  return new Uint8Array([0x04, 0x0b, ...new TextEncoder().encode("streamtyped"), 0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84,
    ...new TextEncoder().encode("NSString"), 0x01, 0x95, 0x84, 0x01, 0x2b, ...length, ...bytes, 0x86, 0x84]);
}

// 2026-10-23 10:00:32 UTC, in Messages' nanoseconds since 2001.
const AT = 814_442_432_000_000_000;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "swipe-"));
  dirs.push(dir);
  const path = join(dir, "chat.db");
  const db = new Database(path);
  db.run("CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT)");
  db.run("CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT UNIQUE, text TEXT, attributedBody BLOB, date INTEGER, is_from_me INTEGER, handle_id INTEGER, reply_to_guid TEXT, thread_originator_guid TEXT)");
  db.run("CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, transfer_name TEXT)");
  db.run("CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER)");
  db.run("INSERT INTO handle VALUES (1, '+19362300565'), (2, '+971585933213')");
  const add = db.query("INSERT INTO message (guid, text, attributedBody, date, is_from_me, handle_id, reply_to_guid, thread_originator_guid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  // Robob's message, then the owner's own text, then his swipe on Robob's message.
  add.run("ROBOB", null, body("OpenTable wants you to confirm Yoshi by Nagaya\u2019s table for 3"), AT, 0, 1, null, null);
  add.run("OWN", "Share with the mission to fix the card tool", null, AT + 10e9, 1, 0, null, null);
  add.run("SWIPE", "Yeah please confirm", null, AT + 20e9, 1, 0, "OWN", "ROBOB");
  add.run("PLAIN", "hi", null, AT + 30e9, 1, 0, null, null);
  add.run("LOST", "that one", null, AT + 40e9, 1, 0, "PLAIN", "NOT-HERE");
  add.run("MONI", "lol", null, AT + 50e9, 0, 2, null, null);
  add.run("ON-MONI", "same", null, AT + 60e9, 1, 0, "MONI", "MONI");
  add.run("ON-OWN", "ignore this", null, AT + 70e9, 1, 0, "ON-MONI", "OWN");
  add.run("PHOTO", null, null, AT + 80e9, 0, 1, null, null);
  db.run("INSERT INTO attachment VALUES (1, 'MCJhzYKT_card-previews-audit.png')");
  db.run("INSERT INTO message_attachment_join VALUES ((SELECT ROWID FROM message WHERE guid = 'PHOTO'), 1)");
  add.run("ON-PHOTO", "Great work. Love it", null, AT + 90e9, 1, 0, "PHOTO", "PHOTO");
  db.close();
  return path;
}

test("a swipe resolves to the message it points at, not the one before it", () => {
  const find = chatDbSwipes(fixture());
  expect(find("SWIPE")).toEqual({
    guid: "ROBOB", fromMe: false, sender: "+19362300565",
    text: "OpenTable wants you to confirm Yoshi by Nagaya\u2019s table for 3",
    at: Date.parse("2026-10-23T10:00:32Z"),
  });
  expect(find("ON-OWN")).toMatchObject({ guid: "OWN", fromMe: true, sender: "", text: "Share with the mission to fix the card tool" });
  expect(find("ON-MONI")).toMatchObject({ guid: "MONI", fromMe: false, sender: "+971585933213", text: "lol" });
  expect(find("ON-PHOTO")).toMatchObject({ guid: "PHOTO", fromMe: false, sender: "+19362300565", text: "", files: ["MCJhzYKT_card-previews-audit.png"] });
});

test("not a swipe is null; a reply or target not synced yet is undefined, so it is looked up again", () => {
  const find = chatDbSwipes(fixture());
  expect(find("PLAIN")).toBeNull();
  expect(find("LOST")).toBeUndefined();
  expect(find("NOT-SYNCED-YET")).toBeUndefined();
});

test("an unreadable store throws, so the caller can treat the target as unknown", () => {
  const find = chatDbSwipes(join(tmpdir(), "no-such-dir-for-swipes", "chat.db"));
  expect(() => find("SWIPE")).toThrow();
});

test("attributedBody text decodes short, long and broken bodies", () => {
  expect(attributedText(body("Yeah send it"))).toBe("Yeah send it");
  const long = "x".repeat(300) + " \u2019done\u2019";
  expect(attributedText(body(long))).toBe(long);
  expect(attributedText(new Uint8Array([1, 2, 3]))).toBe("");
  expect(attributedText(body("ok").slice(0, 30))).toBe("");
});
