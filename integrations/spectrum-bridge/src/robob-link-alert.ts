import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LogLine } from "./toollog.ts";
import { cleanRobobLink, LINK_CAUSES, type LinkCause, type RobobLink } from "./log-robob-link.ts";
import type { Post } from "./telegram-fallback.ts";

type Outage = {
  outageId: string; firstFailureAt: string; cause?: LinkCause; snapshot?: RobobLink;
  downText?: string; upText?: string;
  downAttemptedAt?: string; downAlertSentAt?: string; recoveredAt?: string; upAlertSentAt?: string;
};
type State = Outage & { pending?: Outage[] };
export type LinkAlertOptions = { root: string; post: Post; holdPath?: string };
type Log = (entry: Omit<LogLine, "ts" | "tool">) => void;
const iso = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
function valid(value: unknown): value is Outage {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.outageId === "string" && /^[a-f0-9-]{36}$/i.test(row.outageId) && iso(row.firstFailureAt)
    && (row.cause === undefined || LINK_CAUSES.includes(row.cause as LinkCause))
    && ["downText", "upText"].every(key => row[key] === undefined || typeof row[key] === "string" && row[key].length > 0 && row[key].length <= 12_000)
    && (row.snapshot === undefined || !!cleanRobobLink(row.snapshot as RobobLink)
      && (row.snapshot as RobobLink).outageId === row.outageId && (row.snapshot as RobobLink).firstFailureAt === row.firstFailureAt)
    && ["downAttemptedAt", "downAlertSentAt", "recoveredAt", "upAlertSentAt"].every(key => row[key] === undefined || iso(row[key]));
}
const minutes = (start: string, end: number) => Math.max(1, Math.round((end - Date.parse(start)) / 60_000));
const clock = (start: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(start));

export function createRobobLinkAlert(options: LinkAlertOptions & { now?: () => number; log: Log }) {
  const now = options.now ?? Date.now;
  const path = join(options.root, "robob-link-alert.json");
  let state: State | undefined;
  let dirty = false;
  let running: Promise<void> | undefined;
  const error = (tag: string) => options.log({ component: "robob", kind: "error", name: "robob.link_alert_error", ok: false, error: { tag, name: "Error", message: "[redacted]" } });
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (value !== null) {
      if (!valid(value)) throw new Error("invalid state");
      const saved = value as State;
      if (saved.pending !== undefined && (!Array.isArray(saved.pending) || !saved.pending.every(valid))) throw new Error("invalid pending state");
      state = saved;
    }
    chmodSync(path, 0o600);
  } catch (cause) {
    if (!(cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT")) error("robob.link_alert.read");
    dirty = true;
  }
  function save(): boolean {
    if (!dirty) return true;
    const temporary = join(options.root, `.robob-link-alert-${randomUUID()}.tmp`);
    try {
      mkdirSync(options.root, { recursive: true, mode: 0o700 });
      writeFileSync(temporary, JSON.stringify(state ?? null) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
      dirty = false;
      return true;
    } catch { error("robob.link_alert.write"); return false; }
    finally { try { unlinkSync(temporary); } catch { /* Renamed or never created. */ } }
  }
  save();
  options.log({ component: "robob", kind: "event", name: "robob.link_alert_loaded" });
  const all = (): Outage[] => state ? [state, ...state.pending ?? []] : [];
  const open = () => all().reverse().find(item => !item.recoveredAt && !item.upAlertSentAt);
  function identity(outageId?: string) {
    const item = outageId ? all().find(item => item.outageId === outageId) : open();
    return item ? { outageId: item.outageId, firstFailureAt: item.firstFailureAt, snapshot: item.snapshot, recoveredAt: item.recoveredAt } : undefined;
  }
  function recovery() {
    const item = all().reverse().find(item => item.recoveredAt);
    return item ? identity(item.outageId) : undefined;
  }
  function accept(line: LogLine) {
    if (line.component !== "robob") return;
    if (["robob.link_down", "robob.link_state", "robob.link_down_summary", "robob.link_up"].includes(line.name) && line.link && line.link.failedCalls >= 3) {
      if (!all().some(item => item.outageId === line.link!.outageId)) {
        const next: Outage = { outageId: line.link.outageId, firstFailureAt: line.link.firstFailureAt, cause: line.link.cause, snapshot: cleanRobobLink(line.link) };
        // Retain a later outage while Telegram is still retrying the previous recovery.
        if (state && (!state.upAlertSentAt || state.pending?.length)) (state.pending ??= []).push(next);
        else state = next;
        dirty = true;
      } else {
        const item = all().find(item => item.outageId === line.link!.outageId)!;
        item.snapshot = cleanRobobLink(line.link);
        dirty = true;
      }
    }
    if (line.name === "robob.link_up" && line.link || line.name === "turn.robob_call" && line.ok === true
      && (line.props?.linkGated !== true || line.props.linkProbe === true || line.props.linkGateDown === false)) {
      const item = line.link ? all().find(item => item.outageId === line.link!.outageId) : open();
      if (item && !item.recoveredAt) {
        item.recoveredAt = line.link?.recoveredAt ?? line.ts;
        dirty = true;
      }
    }
    save();
  }
  function hold(): string {
    if (!options.holdPath) return "";
    try {
      const value = JSON.parse(readFileSync(options.holdPath, "utf8"));
      const age = now() / 1000 - value.startedAt;
      const beatAge = now() / 1000 - value.beatAt;
      if (typeof value.by !== "string" || !/^[A-Za-z0-9 ._-]{1,100}$/.test(value.by)
        || !Number.isInteger(value.pid) || value.pid <= 0 || !(age >= 0 && age < 1800) || !(beatAge >= 0 && beatAge < 90)) return "";
      process.kill(value.pid, 0);
      return ` Restart/install hold: ${value.by}.`;
    } catch { return ""; }
  }
  async function send(item: Outage, kind: "down" | "up"): Promise<boolean> {
    const at = new Date(now()).toISOString();
    const field = kind === "down" ? "downText" : "upText";
    if (!item[field]) {
      item[field] = kind === "down"
        ? `Robob is down: the iMessage bridge can't reach it since ${clock(item.firstFailureAt)} Dubai (${minutes(item.firstFailureAt, item.recoveredAt ? Date.parse(item.recoveredAt) : now())} min, ${item.cause ?? "transport"}). iMessage replies and board threads are stalled.${hold()}`
        : `Robob is up again after ${minutes(item.firstFailureAt, Date.parse(item.recoveredAt!))} min (down since ${clock(item.firstFailureAt)} Dubai).`;
      dirty = true;
    }
    if (kind === "down") { item.downAttemptedAt ??= at; dirty = true; }
    // Telegram dedupes both key and content. Persist the exact text before sending, including duration and hold status.
    if (!save()) return false;
    const text = item[field]!;
    let status: number | undefined;
    try { status = await options.post("/notify", { source: "iMessage bridge", severity: kind === "down" ? "error" : "info", dedupeKey: `robob-link-${kind}:${item.outageId}`, text }); }
    catch { /* Injected transports can reject too. Retry with the same key. */ }
    const ok = status !== undefined && status >= 200 && status < 300;
    options.log({ component: "robob", kind: "event", name: "robob.link_alert", ok,
      ids: { outageId: item.outageId }, props: { kind, status: status ?? 0, ok } });
    if (ok) {
      if (kind === "down") item.downAlertSentAt = at;
      else item.upAlertSentAt = at;
      dirty = true;
      save();
    }
    return ok;
  }
  async function run() {
    if (!save()) return;
    while (state) {
      const item = state;
      if (item.upAlertSentAt) {
        if (!item.pending?.length) return;
        const [next, ...pending] = item.pending;
        state = { ...next!, ...(pending.length ? { pending } : {}) };
        dirty = true;
        if (!save()) return;
        continue;
      }
      // Recovery retains a queued outage's duration even if the previous notification is still retrying.
      const observedAt = item.recoveredAt ? Date.parse(item.recoveredAt) : now();
      if (!item.downAlertSentAt && (observedAt - Date.parse(item.firstFailureAt) >= 120_000 || item.downAttemptedAt)) {
        if (!await send(item, "down")) return;
      }
      if (!item.recoveredAt) return;
      if (item.downAlertSentAt && !await send(item, "up")) return;
      if (!item.downAlertSentAt) {
        // Retain quiet recovery too: the log checkpoint may still precede its recovery row.
        if (!item.pending?.length) return;
        const [next, ...pending] = item.pending;
        state = { ...next!, ...(pending.length ? { pending } : {}) };
        dirty = true;
        if (!save()) return;
      }
    }
  }
  function tick(): Promise<void> {
    return running ??= Promise.resolve().then(run).catch(() => error("robob.link_alert.run")).finally(() => { running = undefined; });
  }
  return { accept, identity, recovery, tick, settled: () => running ?? Promise.resolve() };
}
