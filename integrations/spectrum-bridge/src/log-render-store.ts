import { Database } from "bun:sqlite";
import { closeSync, constants, fchmodSync, fstatSync, openSync } from "node:fs";
import { join } from "node:path";
import { cleanRenders, renderChat } from "./log-renders.ts";
import type { LogLine } from "./toollog.ts";

const COMPONENTS = new Set(["cards", "card-file", "quick-renderer", "delivery-renderer", "ride-renderer", "nutrition-renderer"]);
const KINDS = new Set(["quick", "delivery", "ride", "nutrition", "secure_form", "other"]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function openCounters(root: string, day: string, write: boolean): Database {
  if (!DAY.test(day)) throw new Error("Invalid render counter day");
  const path = join(root, `renders-${day}.sqlite`);
  // SQLite opens by filename. Check the private, regular file before giving it that path.
  const fd = openSync(path, (write ? constants.O_RDWR | constants.O_CREAT : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1) throw new Error("Unsafe render counter file");
    if (write && (info.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
    return new Database(path, { readonly: !write, strict: true });
  } finally { closeSync(fd); }
}

export function recordRenderCounts(root: string, line: LogLine): void {
  const stats = cleanRenders(line.renders);
  const kind = line.props?.cardKind;
  if (!stats || !COMPONENTS.has(line.component) || typeof kind !== "string" || !KINDS.has(kind)) return;
  const db = openCounters(root, line.ts.slice(0, 10), true);
  try {
    db.exec("PRAGMA busy_timeout = 1000");
    db.exec(`CREATE TABLE IF NOT EXISTS bins (
      component TEXT NOT NULL, cardKind TEXT NOT NULL, chat TEXT NOT NULL,
      ms INTEGER NOT NULL, count INTEGER NOT NULL,
      PRIMARY KEY (component, cardKind, chat, ms)
    ) WITHOUT ROWID`);
    const add = db.query(`INSERT INTO bins VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (component, cardKind, chat, ms) DO UPDATE SET count = count + excluded.count`);
    db.transaction(() => {
      for (const [ms, count] of stats.histogram) add.run(line.component, kind, renderChat(line.ids?.chat), ms, count);
    }).immediate();
  } finally { db.close(); }
}

export function renderCounts(root: string, day: string): { count: number; lines: LogLine[] } {
  let db: Database;
  try {
    db = openCounters(root, day, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { count: 0, lines: [] };
    throw error;
  }
  try {
    db.exec("PRAGMA busy_timeout = 1000");
    const rows = db.query<{ component: string; cardKind: string; chat: string; ms: number; count: number }, []>(
      "SELECT component, cardKind, chat, ms, count FROM bins ORDER BY component, cardKind, chat, ms").all();
    const groups = new Map<string, LogLine>();
    let count = 0;
    for (const row of rows) {
      if (!COMPONENTS.has(row.component) || !KINDS.has(row.cardKind) || renderChat(row.chat) !== row.chat
        || !Number.isSafeInteger(row.ms) || row.ms < 0 || row.ms > 1000 || !Number.isSafeInteger(row.count) || row.count < 1) continue;
      const key = `${row.component}\0${row.cardKind}\0${row.chat}`;
      const line = groups.get(key) ?? { ts: `${day}T00:00:00.000Z`, tool: "imessage", component: row.component,
        kind: "perf", name: "card.renders", ok: true, ids: { chat: row.chat }, props: { cardKind: row.cardKind },
        renders: { count: 0, histogram: [] } } satisfies LogLine;
      line.renders!.count += row.count;
      line.renders!.histogram.push([row.ms, row.count]);
      groups.set(key, line);
      count += row.count;
    }
    return { count, lines: [...groups.values()] };
  } finally { db.close(); }
}
