/**
 * Read-only lookups for scoped third parties: the owner's own outgoing messages to a person
 * (from the msgs archive) and whether they are in his Contacts. Both fail closed: a lookup
 * that can't run returns "unavailable" and nobody gets allowed on it.
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EvidenceCandidate } from "./guests.ts";

export const ARCHIVE_DB = process.env.MSGS_INDEX_DB ?? "/Volumes/ExternalSSD/message-archive/index.db";
export const ADDRESSBOOK = join(homedir(), "Library/Application Support/AddressBook");
const LOOKBACK_S = 30 * 24 * 60 * 60;

type Row = { id: number; source: string; conv: string | null; conv_name: string | null; ts: number; from_me: number; body: string | null; recipients: string | null };

const digitsOf = (value: string) => value.replace(/[^\d]/g, "");

/**
 * A pure read-only open of the archive fails whenever its WAL is empty and the daemon holds the
 * shm, so the archive opens read-write without create and is locked to reads with query_only
 * (SQLite refuses every write on that handle). The AddressBook stays strictly read-only.
 */
function open(path: string, shared = false): Database {
  const db = shared ? new Database(path, { readwrite: true, create: false }) : new Database(path, { readonly: true });
  db.exec(`${shared ? "PRAGMA query_only = 1; " : ""}PRAGMA temp_store = MEMORY; PRAGMA busy_timeout = 3000;`);
  return db;
}

/**
 * Retries a failed open or read a few times with a short pause (busy daemon, sleeping disk).
 */
function withDb<T>(path: string, work: (db: Database) => T, shared = false, attempts = 3): T {
  for (let attempt = 1; ; attempt++) {
    let db: Database | undefined;
    try {
      db = open(path, shared);
      return work(db);
    } catch (error) {
      if (attempt >= attempts) throw error;
      Bun.sleepSync(300 * attempt);
    } finally { db?.close(); }
  }
}

/** Where a message to this address can live in the archive: its 1:1 iMessage / WhatsApp chats, or email to it. */
function conversationClause(address: string): { sql: string; params: string[] } | undefined {
  if (address.includes("@")) return { sql: "(source = 'email' AND recipients LIKE ?) OR (source = 'imessage' AND conv_name LIKE ?)", params: [`%${address}%`, `%${address}%`] };
  const digits = digitsOf(address);
  if (digits.length < 7) return undefined;
  // 1:1 iMessage chats are named "Name (+number)" or "+number"; group chats never carry a number.
  return {
    sql: "(source = 'imessage' AND conv_name LIKE ?) OR (source = 'whatsapp' AND conv = ?)",
    params: [`%+${digits}%`, `${digits}@s.whatsapp.net`],
  };
}

/** True when the text points at this line (its number in any spacing) or names the assistant. */
export function namesLine(text: string, lineNumber: string): "strong" | "weak" | undefined {
  const lineDigits = digitsOf(lineNumber).slice(-10);
  if (lineDigits && digitsOf(text).includes(lineDigits)) return "strong";
  if (/\brobob\b/i.test(text)) return "strong";
  if (/\b(assistant|my bot|\bai\b|text this number|message this number)\b/i.test(text)) return "weak";
  return undefined;
}

export function findEvidence(address: string, lineNumber: string, now = Date.now(), path = ARCHIVE_DB): EvidenceCandidate[] | "unavailable" {
  const clause = conversationClause(address);
  if (!clause) return [];
  if (!existsSync(path)) return "unavailable";
  try {
    return withDb(path, db => {
      // Pre-filter in SQL so a long chat can't push an older instruction past the limit.
      const squashed = "replace(replace(replace(replace(replace(replace(body, ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), char(160), '')";
      const rows = db.query<Row, (string | number)[]>(
        `SELECT id, source, conv, conv_name, ts, from_me, body, recipients FROM items
         WHERE from_me = 1 AND ts >= ? AND (${clause.sql})
           AND (body LIKE '%robob%' OR body LIKE '%assistant%' OR body LIKE '%my bot%' OR body LIKE '%this number%' OR body LIKE '% ai %' OR ${squashed} LIKE ?)
         ORDER BY ts DESC LIMIT 50`,
      ).all(Math.floor(now / 1000) - LOOKBACK_S, ...clause.params, `%${digitsOf(lineNumber).slice(-10)}%`);
      const found: EvidenceCandidate[] = [];
      for (const row of rows) {
        const body = row.body ?? "";
        const strength = namesLine(body, lineNumber);
        if (!strength) continue;
        found.push({
          ref: `msgs:${row.id}`, source: row.source, at: row.ts * 1000, snippet: body.slice(0, 600),
          strong: strength === "strong", ...(row.conv_name ? { conversation: row.conv_name } : {}),
        });
      }
      return [...found.filter(entry => entry.strong), ...found.filter(entry => !entry.strong)].slice(0, 5);
    }, true);
  } catch { return "unavailable"; }
}

/**
 * Checks, in code, that an evidence ref the owner's agent cites really is an outgoing message
 * from the owner in a conversation with this exact address. Returns the stored snippet.
 */
export function verifyArchiveEvidence(ref: string, address: string, path = ARCHIVE_DB): { source: string; at: number; snippet: string } | undefined {
  const match = /^msgs:(\d{1,12})$/.exec(ref);
  const clause = conversationClause(address);
  if (!match || !clause || !existsSync(path)) return undefined;
  try {
    return withDb(path, db => {
      const row = db.query<Row, (string | number)[]>(
        `SELECT id, source, conv, conv_name, ts, from_me, body, recipients FROM items WHERE id = ? AND from_me = 1 AND (${clause.sql})`,
      ).get(Number(match[1]), ...clause.params);
      return row ? { source: row.source, at: row.ts * 1000, snippet: (row.body ?? "").slice(0, 600) } : undefined;
    }, true);
  } catch { return undefined; }
}

/** Contact name for an address, undefined when not found, "unavailable" when Contacts can't be read. */
export function contactName(address: string, root = ADDRESSBOOK): string | undefined | "unavailable" {
  const sources = join(root, "Sources");
  let dbs: string[];
  try {
    dbs = readdirSync(sources).map(dir => join(sources, dir, "AddressBook-v22.abcddb")).filter(file => existsSync(file));
  } catch { return "unavailable"; }
  if (!dbs.length) return "unavailable";
  const email = address.includes("@") ? address.trim().toLowerCase() : undefined;
  const tail = email ? "" : digitsOf(address).slice(-9);
  if (!email && tail.length < 7) return undefined;
  let readable = false;
  for (const file of dbs) {
    try {
      const name = withDb(file, db => {
        readable = true;
        const rows = email
          ? db.query<{ f: string | null; l: string | null; o: string | null }, [string]>(
            "SELECT r.ZFIRSTNAME f, r.ZLASTNAME l, r.ZORGANIZATION o FROM ZABCDEMAILADDRESS e JOIN ZABCDRECORD r ON r.Z_PK = e.ZOWNER WHERE lower(e.ZADDRESS) = ?").all(email)
          : db.query<{ f: string | null; l: string | null; o: string | null; n: string | null }, []>(
            "SELECT r.ZFIRSTNAME f, r.ZLASTNAME l, r.ZORGANIZATION o, p.ZFULLNUMBER n FROM ZABCDPHONENUMBER p JOIN ZABCDRECORD r ON r.Z_PK = p.ZOWNER").all()
            .filter(row => digitsOf((row as { n: string | null }).n ?? "").endsWith(tail));
        const row = rows[0];
        return row ? [row.f, row.l].filter(Boolean).join(" ") || row.o || "(unnamed contact)" : undefined;
      });
      if (name) return name;
    } catch { /* try the next source */ }
  }
  return readable ? undefined : "unavailable";
}
