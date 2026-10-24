import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

/** The message an iMessage swipe reply points at, as this Mac's Messages store has it. */
export type SwipeTarget = { guid: string; fromMe: boolean; sender: string; text: string; at: number; files?: string[] };

/**
 * Looks up what a swipe reply points at by the reply's own guid.
 * undefined: this Mac has not seen the reply or its target yet (still syncing,
 * or a chat this Apple ID is not in). null: the reply is not a swipe here.
 */
export type Swipes = (guid: string) => SwipeTarget | null | undefined;

type Row = {
  origin: string | null; guid: string | null; fromMe: number | null; sender: string | null;
  text: string | null; body: Uint8Array | null; date: number | null;
};

const APPLE_EPOCH_MS = 978_307_200_000;
// thread_originator_guid is the swiped message. Sendblue's reply_to reads reply_to_guid, which is just the message before.
const QUERY = "SELECT m.thread_originator_guid AS origin, o.guid AS guid, o.is_from_me AS fromMe, h.id AS sender, "
  + "o.text AS text, o.attributedBody AS body, o.date AS date FROM message m "
  + "LEFT JOIN message o ON o.guid = m.thread_originator_guid LEFT JOIN handle h ON h.ROWID = o.handle_id WHERE m.guid = ?";
const FILES = "SELECT a.transfer_name AS name FROM message o JOIN message_attachment_join j ON j.message_id = o.ROWID "
  + "JOIN attachment a ON a.ROWID = j.attachment_id WHERE o.guid = ? AND a.transfer_name IS NOT NULL ORDER BY a.ROWID";

export function chatDbSwipes(path = join(homedir(), "Library/Messages/chat.db")): Swipes {
  let db: Database | undefined;
  return guid => {
    try {
      db ??= new Database(path, { readonly: true });
      const row = db.query<Row, [string]>(QUERY).get(guid);
      if (!row) return undefined;
      if (!row.origin) return null;
      if (!row.guid) return undefined;
      const text = (row.text?.trim() ? row.text : row.body ? attributedText(row.body) : "").replace(/\uFFFC/g, "").trim();
      const files = db.query<{ name: string }, [string]>(FILES).all(row.guid).map(file => file.name);
      return { guid: row.guid, fromMe: row.fromMe === 1, sender: row.fromMe === 1 ? "" : row.sender ?? "", text, at: appleTime(row.date ?? 0),
        ...(files.length ? { files } : {}) };
    } catch (error) {
      db?.close();
      db = undefined;
      throw error;
    }
  };
}

/** Messages stores dates as nanoseconds since 2001 (seconds on old rows). */
function appleTime(date: number): number {
  return APPLE_EPOCH_MS + (date > 1e12 ? date / 1e6 : date * 1000);
}

const NSSTRING = new TextEncoder().encode("NSString");

/** The plain text in a typedstream attributedBody, which newer macOS writes instead of `text`. */
export function attributedText(blob: Uint8Array): string {
  const at = indexOf(blob, NSSTRING);
  if (at < 0) return "";
  const plus = blob.indexOf(0x2b, at + 8);
  if (plus < 0 || plus >= at + 16) return "";
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  let length = blob[plus + 1] ?? 0;
  let start = plus + 2;
  try {
    if (length === 0x81) [length, start] = [view.getUint16(plus + 2, true), plus + 4];
    else if (length === 0x82) [length, start] = [view.getUint32(plus + 2, true), plus + 6];
    else if (length === 0x83) [length, start] = [Number(view.getBigUint64(plus + 2, true)), plus + 10];
  } catch {
    return "";
  }
  return new TextDecoder().decode(blob.subarray(start, start + length));
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
