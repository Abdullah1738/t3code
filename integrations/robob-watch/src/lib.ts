import type { OwnerAlertEpisode } from "./owner-alerts.ts";
import { assertMacWatcher } from "./person-box.ts";
import { toolLog, toolError } from "./toollog.ts";
import { StderrCause, stderrCause, type DependencyBusy } from "./cause.ts";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { CheckGroups, type CheckGroup } from "./check-groups.ts";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const HOME = homedir();
export const ROOT = process.env.ROBOB_WATCH_ROOT ?? join(HOME, ".local/share/robob-watch");
export const WATCHERS = join(ROOT, "watchers");
export const MAINTENANCE_FILE = join(ROOT, "maintenance.json");
export const ARCHIVE = join(ROOT, "archive");
export const HELPERS = join(ROOT, "helpers");
export const WA_LOCK = join(ROOT, "wa.lock");
/** wacli's store (kept live by `wacli sync --follow`); its WAL grows/changes whenever a message is stored. */
export const WACLI_STORE = process.env.WACLI_STORE_DIR ?? join(homedir(), ".wacli");
export const WA_TRIGGERS = [join(WACLI_STORE, "wacli.db-wal"), join(WACLI_STORE, "wacli.db")];
function resolveBun(): string {
  if (process.env.ROBOB_WATCH_BUN) return process.env.ROBOB_WATCH_BUN;
  const installed = join(HOME, ".bun/bin/bun");
  if (existsSync(installed)) return installed;
  if (process.versions.bun) return process.execPath;
  const found = Bun.which("bun");
  if (found) return found;
  throw new Error("Could not locate Bun; set ROBOB_WATCH_BUN to its executable path");
}
export const BUN = resolveBun();
export const SPECTRUM_CLI = process.env.ROBOB_WATCH_SPECTRUM_CLI ?? join(HOME, ".local/share/spectrum-bridge/src/cli.ts");
export const TELEGRAM_CLI = process.env.ROBOB_WATCH_TELEGRAM_CLI ?? join(HOME, ".local/share/telegram-bridge/src/cli.ts");
export const BRIDGE_DB = process.env.ROBOB_WATCH_BRIDGE_DB ?? join(HOME, ".config/spectrum-bridge/state.sqlite");
export const PATH = [HELPERS, join(HOME, ".local/bin"), dirname(BUN), "/opt/homebrew/bin", "/usr/local/bin",
  "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");

export const MIN_INTERVAL = 5;
export const DEFAULT_INTERVAL = 15;
export const CHECK_TIMEOUT_MS = Number(process.env.ROBOB_WATCH_CHECK_TIMEOUT_MS ?? 60_000);
/** After SIGKILL, stop waiting for the process to report exit (a throttled process can take minutes to be reaped). */
export const KILL_GRACE_MS = 5_000;
export const FAILURE_ALERT_AFTER = 5;
/** One failed tick that recovers is noise; the second in a row notifies. */
export const FAILURE_NOTICE_AFTER = 2;
/** Timeouts are transient (load spikes): no alert until the watcher has been failing at least this long. */
export const TIMEOUT_ALERT_AFTER_MS = 10 * 60_000;
export const BUSY_ALERT_AFTER_MS = Number(process.env.ROBOB_WATCH_BUSY_ALERT_AFTER_MS ?? 20 * 60_000);
/** Timeouts retry at most this far apart, so a watcher catches up soon after a load spike. */
export const TIMEOUT_BACKOFF_CAP_S = 120;
/** Runs slower than this are logged with their duration. */
export const SLOW_RUN_MS = 15_000;
/** Holds the WATCH_RUN id of the last run whose output the runner recorded (see whatsapp-new-message's outbox). */
export const RUN_OK_FILE = ".run-ok";
/** Third parties hear about an ETA again only once it moved 15+ min, at most hourly unless it moved an hour or more. */
export const RELAY_ETA_MOVE_MS = 15 * 60_000;
export const RELAY_GAP_MS = 60 * 60_000;
const MAX_EVENT = 6_000;
export const MAX_WAKE = 12_000;
const MAX_LOG = 512 * 1024;

export type Dependency = "ssd" | "phone";
export type Maintenance = { until: string; reason: string; depends: Dependency[] };

export function validDepends(value: unknown): value is Dependency[] {
  return Array.isArray(value) && value.every(item => item === "ssd" || item === "phone");
}

export function loadMaintenance(t = now()): Maintenance | undefined {
  const value = readJson<Maintenance>(MAINTENANCE_FILE);
  if (!value || typeof value.until !== "string" || !(Date.parse(value.until) > t)
    || typeof value.reason !== "string" || !validDepends(value.depends)) return undefined;
  return value;
}

export function heldByMaintenance(watcher: Watcher, maintenance?: Maintenance): boolean {
  return !!maintenance && !!watcher.depends?.some(dep => maintenance.depends.includes(dep));
}

export type Mode = "wake" | "notify";
/** From start (inclusive) to end (exclusive), whole hours in time_zone; start > end wraps past midnight. */
export type Quiet = { start: number; end: number; time_zone: string };
/** One third party, with the owner's own words allowing updates. */
export type Relay = { to: string; name: string; quote: string; at: string };
/**
 * The owner stopping updates to one person (key, from `to`) or to everyone, on a trip or on the listed watchers.
 * Kept in its own file so no replace, removal or pause of a watcher can undo it; only a grant dated after it does.
 */
export type Stop = { trip?: string; watchers: string[]; to?: string; key?: string; at: string; quote: string };
export type Watcher = {
  id: string;
  title: string;
  check: string;
  /** Read-only poll for replies to existing outreach; the only check allowed during removal grace. */
  inflight_check?: string;
  /** Side-effect-only check after a committed run or while delivery is pending; it must not consume ordinary events. */
  pending_check?: string;
  interval_s: number;
  timeout_s?: number;
  mode: Mode;
  context: string;
  expires_at: string | null;
  /** 0 means unlimited. */
  max_fires: number;
  /** Serialize with every other serial check and all wa usage (the WhatsApp TUI cannot be driven concurrently). */
  serial: boolean;
  paused: boolean;
  /** 0 keeps retrying with backoff; otherwise pause after this many failures (default 5). */
  max_consecutive_failures?: number;
  /** Failures in a row before the per-run failure notice; default 2, 1 = every failure. */
  failure_notice_after?: number;
  /** False keeps a failure pause manual-only; otherwise probe after 15m, 30m, then hourly. */
  failure_pause_probe?: boolean;
  depends?: Dependency[];
  /** Opt-in: text the owner a short heads-up when a wake sits queued behind a busy turn. Off by default. */
  headsup?: boolean;
  /** Opt-in owner-chat notices for a failure pause/escalation and its recovery. */
  owner_imessage_alerts?: boolean;
  /**
   * Files whose change (mtime/size) runs the check on the next 1s tick instead of waiting for interval_s,
   * e.g. ~/Library/Messages/chat.db-wal. interval_s stays as the fallback cadence.
   */
  triggers?: string[];
  /** Minimum seconds between trigger-driven runs (default 2); raise it for expensive checks on busy files. */
  trigger_gap_s?: number;
  /** Hours in which events, new or retried, wait instead of being delivered; the check itself still runs. */
  quiet?: Quiet;
  /** Watchers of one trip or job share a tag, so "stop updating X" reaches all of them. */
  trip?: string;
  /** People other than the owner a fire may message. Nobody else hears from a fire (23 Oct: ETA flips reached a group 5-7 times). */
  relays?: Relay[];
  /**
   * Bridge chat slug (e.g. "moni") whose agent a fire wakes instead of the owner's. For watchers on someone else's
   * data (her own WhatsApp on her offbox): the event never goes to the owner's chat; no plain-text fallback.
   */
  chat?: string;
  created_at: string;
  created_by_session: string | null;
};
export type State = {
  status: "active" | "closing" | "done" | "expired";
  closing_until?: number;
  closing_relays?: number;
  closing_from?: "active" | "done" | "expired";
  closing_watcher?: Watcher;
  admitted_run?: { run: string; attempt: string; watcher: Watcher; accepted?: true };
  reply_handoff?: { run: string; watcher: Watcher; accepted_run?: string };
  discarded_run?: string;
  closing_final_started?: boolean;
  closing_final_check?: boolean;
  batch?: { at: number; events: string[]; watcher?: Watcher; frozen_context?: true; healthRuns?: string[] };
  fires: number;
  last_run_at?: string;
  last_fire_at?: string;
  next_at?: number;
  consecutive_failures: number;
  failure_alerted: boolean;
  load_timeouts?: number;
  load_timeout_since?: string;
  failure_paused_at?: string;
  failure_probe_attempts?: number;
  failure_probe_next_at?: string;
  failure_pause_notice?: string;
  failure_pause_escalation?: string;
  failure_pause_escalation_fallback?: string;
  failure_escalation_key?: string;
  failure_escalation_source?: string;
  failure_escalation_attempts?: number;
  failure_escalation_next_at?: string;
  failure_escalation_notice?: string;
  failure_escalation_notice_sent?: boolean;
  failure_escalation_pending?: { channel: "wake" | "imessage"; key: string };
  failure_recovery_notices?: { key: string; text: string; retry_at?: number }[];
  /** Separate from Telegram flags; retained through resume until bridge acceptance. */
  owner_imessage_episodes?: OwnerAlertEpisode[];
  last_error?: string;
  dependency_busy?: { dependency: string; since: string };
  /** A changed failure kind needs a fresh bridge key without resetting backoff or grace periods. */
  failure_episode?: string;
  /** Source names parsed before stderr is clipped for storage. */
  last_error_sources?: string[];
  /** When the current run of consecutive failures started. */
  failing_since?: string;
  /** The agent was woken about the current run of failures (see shouldEscalate). */
  failure_escalated?: boolean;
  /** Wall time of the last check run, in ms. */
  last_run_ms?: number;
  recent_check_ms?: number[];
  /** An event whose delivery has not succeeded yet; retried verbatim with the same key. */
  pending?: { key: string; event: string; at: string; count?: number; urgent?: boolean; route?: WakeRoute; watcher?: Watcher; creatorSend?: { thread: string; sentAt: number }; context_file?: string; healthRun?: string; healthRuns?: string[] };
  last_delivery?: string;
  confirm?: WakeConfirmation;
  /** Later fires must not replace an older wake that is still awaiting confirmation. */
  confirmations?: WakeConfirmation[];
  /** Delivered wakes whose bridge inbound row may still be queued behind a busy agent turn. */
  wakes?: TrackedWake[];
  /** Trigger-file signature seen at the start of the last run. */
  trigger_sig?: string;
  /** Persisted repeat window for one failing trigger; never stores the path. */
  trigger_error?: { triggerPathHash: string; triggerKind: "file" | "wal"; errnoCode: string; missingSince: string; loggedAt: number; count: number };
  /** Missing triggers use the interval; only hashes survive runner restarts. */
  trigger_missing?: { paths: (MissingTrigger & { missingSince: string })[]; loggedAt: number };
};
export type TrackedWake = { inbound: string; key: string; event: string; delivered_at: number; attempts?: number };
export type WakeConfirmation = {
  key: string; thread?: string; sentAt: number; attempts: number; event: string; text: string;
  nextAt?: number; escalated?: boolean; ownerFallback?: boolean; nativeSession?: string;
  deadlineAt?: number; unconfirmedAt?: number; alertDone?: boolean; fallbackDone?: boolean; fallbackText?: string;
  sendPending?: boolean; sendAttempts?: number; deferredAt?: number;
};
export const WAKE_CONFIRM_MS = Number(process.env.ROBOB_WATCH_CONFIRM_MS ?? 10 * 60_000);
const CONFIRM_POLL_MS = 30_000;
export function wakeSendBackoff(attempt: number): number {
  const base = Number(process.env.ROBOB_WATCH_SEND_RETRY_MS ?? 30_000);
  return Math.min(5 * 60_000, (Number.isFinite(base) && base > 0 ? base : 30_000) * 2 ** Math.min(attempt, 20));
}

export const PERSON_BATCH_MS = 150_000;
export const REMOVAL_GRACE_MS = 15 * 60_000;
export type WakeRoute = "person" | "owner" | "group" | "creator" | "other";
function chatRoute(watcher: Watcher): WakeRoute {
  if (!watcher.chat) return "owner";
  if (watcher.mode !== "wake") return "other";
  let db: Database | undefined;
  try {
    // The bridge registry owns chat identity; names and slug prefixes cannot distinguish a DM from a group.
    // A busy or unavailable registry keeps existing immediate timing rather than delaying an unknown target.
    db = new Database(BRIDGE_DB, { readonly: true });
    db.exec("PRAGMA busy_timeout = 0");
    const row = db.query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?").get("sbChats");
    const saved: unknown = row ? JSON.parse(row.value) : undefined;
    if (!jsonObject(saved)) return "other";
    const matches = Object.entries(saved).filter(([, entry]) => jsonObject(entry) && entry.slug === watcher.chat);
    if (matches.length > 0 && matches.every(([key]) => key.startsWith("dm:"))) return "person";
    if (matches.length > 0 && matches.every(([key]) => key.startsWith("group:"))) return "group";
    return "other";
  } catch {
    return "other";
  } finally {
    db?.close();
  }
}
export const personChat = (watcher: Watcher) => chatRoute(watcher) === "person";
export const sameDestination = (a: Watcher, b: Watcher) => a.mode === b.mode && a.chat === b.chat
  && (a.mode !== "wake" || !!a.chat || a.created_by_session === b.created_by_session);
export const checking = (state: State) => state.status === "active" || (state.status === "closing" && !!state.closing_watcher);
export function pollingWatcher(watcher: Watcher, state: State) {
  const admitted = state.reply_handoff?.watcher ?? (state.status === "closing" ? state.closing_watcher
    : state.admitted_run && !state.admitted_run.accepted ? state.admitted_run.watcher : watcher);
  if (!admitted || admitted === watcher) return admitted;
  // Repairs change how checks run; their unaccepted output keeps its original destination and authority.
  return { ...watcher, id: admitted.id, title: admitted.title, check: admitted.check,
    inflight_check: admitted.inflight_check, mode: admitted.mode, context: admitted.context,
    chat: admitted.chat, trip: admitted.trip, relays: admitted.relays,
    created_at: admitted.created_at, created_by_session: admitted.created_by_session };
}

export function watcherInstance(id: string): string | undefined {
  try {
    // Removal renames this directory into archive; reusing the ID creates a different directory.
    const stat = statSync(watcherDir(id));
    return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  } catch { return undefined; }
}

export function retiredWatcher(id: string): boolean {
  return existsSync(join(ARCHIVE, "retired", `${id}.json`));
}

export function archiveWatcher(id: string, reason?: "expired" | "now" | "paused" | "no_inflight_check"): string {
  const target = join(ARCHIVE, `${id}-${now()}`);
  const retired = join(ARCHIVE, "retired");
  mkdirSync(retired, { recursive: true, mode: 0o700 });
  writeJson(join(retired, `${id}.json`), { archived: target, at: iso() });
  log(id, "removed");
  const state = loadState(id);
  const closing = state.status === "closing";
  const relays = state.closing_relays ?? 0;
  if (state.status === "closing" && state.closing_from) {
    state.status = state.closing_from;
    delete state.closing_from;
    delete state.closing_until;
    delete state.closing_watcher;
    delete state.admitted_run;
    delete state.reply_handoff;
    delete state.closing_final_started;
    delete state.closing_final_check;
    saveState(id, state);
  }
  renameSync(watcherDir(id), target);
  if (reason) {
    if (closing) toolLog({ component: reason === "expired" ? "runner" : "cli", kind: "event", name: "watch.grace_ended", ids: { watcher: id }, props: { reason: reason === "expired" ? "expired" : "now", relays } });
    if (reason !== "expired") toolLog({ component: "cli", kind: "event", name: "watch.removed", ids: { watcher: id }, props: { grace: false, reason } });
  }
  return target;
}

export function finalizeClosing(id: string): boolean {
  return withRelayLock(() => {
    const state = loadState(id);
    const watcher = loadWatcher(id);
    if (!watcher || state.status !== "closing" || now() < state.closing_until!
      || (!watcher.paused && (!state.closing_final_check || state.pending || state.batch))) return false;
    archiveWatcher(id, "expired");
    return true;
  });
}

export function removeWatcher(id: string, immediately = false): { archived?: string; closing_until?: number } {
  return withRelayLock(() => {
    if (immediately) return { archived: archiveWatcher(id, "now") };
    const watcher = loadWatcher(id);
    if (!watcher) throw new Error(`Unknown watcher ${id}`);
    if (!watcher.inflight_check || watcher.paused) return { archived: archiveWatcher(id, watcher.paused ? "paused" : "no_inflight_check") };
    const state = loadState(id);
    const started = state.status !== "closing";
    if (state.status !== "closing") {
      state.closing_relays = 0;
      state.closing_from = state.status;
      state.closing_until = now() + REMOVAL_GRACE_MS;
      state.closing_watcher = { ...watcher, check: watcher.inflight_check };
      delete state.closing_final_started;
      delete state.closing_final_check;
    }
    state.status = "closing";
    state.next_at = 0;
    delete state.failure_paused_at;
    clearFailureProbe(state);
    saveState(id, state);
    if (started) toolLog({ component: "cli", kind: "event", name: "watch.grace_started", ids: { watcher: id }, props: { graceMs: REMOVAL_GRACE_MS } });
    log(id, `closing until ${iso(state.closing_until!)}`);
    return { closing_until: state.closing_until };
  });
}

export function editWatcher(id: string, change: (watcher: Watcher) => Watcher): Watcher {
  return withRelayLock(() => {
    const watcher = loadWatcher(id);
    if (!watcher) throw new Error(`Unknown watcher ${id}`);
    const next = normalize(change(watcher));
    writeJson(join(watcherDir(id), "watcher.json"), next);
    return next;
  });
}

export function checkEvent(output: string): { event: string; urgent: boolean } {
  const event = output.trim();
  try {
    const value = JSON.parse(event);
    return { event, urgent: value?.urgent === true };
  } catch { return { event, urgent: false }; }
}

function contextSnapshot(context: string): string {
  const dir = join(ARCHIVE, "contexts");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${hash(context)}.json`);
  if (!existsSync(file)) writeJson(file, { context });
  return file;
}

export function queueEvent(watcher: Watcher, state: State, event: string, urgent: boolean, preserveContext = false): void {
  const route = chatRoute(watcher);
  if (route === "person" && !urgent) {
    if (!state.batch) {
      state.batch = { at: now(), events: [], watcher };
      toolLog({ component: "wakes", kind: "event", name: "wake.batch_opened", ids: { watcher: watcher.id } });
    }
    state.batch.events.push(event);
    if (preserveContext) {
      state.batch.watcher = watcher;
      state.batch.frozen_context = true;
    }
  } else {
    if (route === "person" && urgent) toolLog({ component: "wakes", kind: "event", name: "wake.urgent", ids: { watcher: watcher.id }, props: { batchOpen: !!state.batch } });
    state.pending = { urgent, route, key: `robob-watch:${watcher.id}:${state.fires + 1}:${hash(event).slice(0, 16)}`, event, at: iso(), watcher, context_file: watcher.mode === "wake" ? contextSnapshot(watcher.context) : undefined };
  }
}

export function sealBatch(watcher: Watcher, state: State): void {
  const batch = state.batch!;
  const accepted = batch.watcher ?? watcher;
  const destination = !batch.frozen_context && sameDestination(accepted, watcher) ? { ...accepted, context: watcher.context } : accepted;
  const key = `robob-watch:${watcher.id}:batch:${hash(JSON.stringify(batch)).slice(0, 32)}`;
  const events = batch.events.length === 1 ? batch.events[0]! : batch.events.map((event, i) => `${i + 1}. ${event}`).join("\n\n");
  // A large burst must survive the bridge's text cap. Keep the complete batch for the woken agent to read.
  const file = join(ARCHIVE, "batches", `${watcher.id}-${hash(key).slice(0, 32)}.json`);
  if (events.length > MAX_EVENT) {
    mkdirSync(join(ARCHIVE, "batches"), { recursive: true, mode: 0o700 });
    writeJson(file, { ...batch, context: destination.context });
  }
  const event = events.length <= MAX_EVENT ? events : `${batch.events.length} events, oldest first. Read the complete batch before replying: ${file}`;
  state.pending = { key, event, route: "person", count: batch.events.length, at: iso(batch.at), watcher: destination, context_file: contextSnapshot(destination.context), ...(batch.healthRuns ? { healthRuns: batch.healthRuns } : {}) };
  delete state.batch;
  toolLog({ component: "wakes", kind: "event", name: "wake.batch_sealed", ids: { watcher: watcher.id }, props: { events: batch.events.length, spanMs: now() - batch.at, archived: events.length > MAX_EVENT, frozenContext: !!batch.frozen_context } });
}

function jsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeContext(previous: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...previous };
  for (const [key, value] of Object.entries(patch)) {
    const old = previous[key];
    Object.defineProperty(result, key, { enumerable: true, configurable: true, writable: true,
      value: Array.isArray(old) && Array.isArray(value) ? [...old, ...value]
        : jsonObject(old) && jsonObject(value) ? mergeContext(old, value) : value });
  }
  return result;
}

export function editContext(id: string, patch: string, replace = false): string {
  return withRelayLock(() => {
    const watcher = loadWatcher(id);
    if (!watcher) throw new Error(`Unknown watcher ${id}`);
    let context = patch;
    if (!replace) {
      let before: unknown, after: unknown;
      try { before = JSON.parse(watcher.context); } catch { /* legacy prose */ }
      try { after = JSON.parse(patch); } catch { /* prose append */ }
      if (jsonObject(after)) {
        context = JSON.stringify(mergeContext(jsonObject(before) ? before : { instructions: watcher.context }, after));
      } else if (jsonObject(before)) {
        context = JSON.stringify({ ...before, notes: [...(Array.isArray(before.notes) ? before.notes : before.notes === undefined ? [] : [before.notes]), patch] });
      } else context = [watcher.context, patch].filter(Boolean).join("\n");
    }
    const next = normalize({ ...watcher, context });
    writeJson(join(watcherDir(id), "watcher.json"), next);
    return next.context;
  });
}

export const HEADSUP_MS = Number(process.env.ROBOB_WATCH_HEADSUP_MS ?? 120_000);
/** Tracking is dropped after this long even if the row state could never be read. */
export const HEADSUP_GIVE_UP_MS = 6 * 3_600_000;

export const validId = (id: unknown): id is string => typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,47}$/.test(id);
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const now = () => Date.now();
export const iso = (ms = now()) => new Date(ms).toISOString();

export function inQuiet(quiet: Quiet | undefined, ms = now()): boolean {
  if (!quiet) return false;
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: quiet.time_zone }).format(ms));
  return quiet.start < quiet.end ? hour >= quiet.start && hour < quiet.end : hour >= quiet.start || hour < quiet.end;
}

function validQuiet(value: unknown): value is Quiet {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { start, end, time_zone } = value as Record<string, unknown>;
  const hour = (h: unknown) => Number.isInteger(h) && (h as number) >= 0 && (h as number) <= 23;
  if (!hour(start) || !hour(end) || start === end || typeof time_zone !== "string" || !time_zone) return false;
  try { new Intl.DateTimeFormat("en-GB", { timeZone: time_zone }); return true; } catch { toolError("runner", "watch.timezone_invalid"); return false; }
}

const oneLine = (value: unknown, max: number) => typeof value === "string" && !!value.trim() && value.length <= max && !/[\x00-\x1f]/.test(value);
const words = (value: unknown) => typeof value === "string" && !!value.trim() && value.length <= 500;
const isoDate = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value));

/** The phone number behind a WhatsApp @lid, from wacli's session store (the map wa-db resolve reads). */
function lidPhone(lid: string): string | undefined {
  try {
    const db = new Database(join(WACLI_STORE, "session.db"), { readonly: true });
    try {
      const row = db.query("select pn from whatsmeow_lid_map where lid = ?").get(lid) as { pn?: unknown } | null;
      return typeof row?.pn === "string" && row.pn ? row.pn : undefined;
    } finally { db.close(); }
  } catch { toolError("runner", "watch.contact_lookup_failed"); return undefined; }
}

/** One key per person: a phone jid, its mapped @lid, a +phone and a bare number match. Groups match by jid. */
export function contactKey(value: string): string {
  const text = value.trim().toLowerCase();
  const [local = "", server] = text.split("@");
  if (server === "lid") return lidPhone(local)?.replace(/\D/g, "") ?? text;
  const phone = server === undefined || server === "s.whatsapp.net" || server === "c.us";
  return phone && /^\+?[\d\s()-]{7,}$/.test(local) ? local.replace(/\D/g, "") : text;
}

export function sameContact(a: string, b: string): boolean {
  return contactKey(a) === contactKey(b);
}

function validRelays(value: unknown): value is Relay[] {
  if (!Array.isArray(value) || value.length > 8) return false;
  // Grants name a phone or group, so a stop or throttle given under either of a person's ids finds them.
  return value.every((relay, index) => !!relay && typeof relay === "object"
    && oneLine(relay.to, 120) && !/@lid\s*$/i.test(relay.to) && oneLine(relay.name, 80) && words(relay.quote) && isoDate(relay.at)
    // A grant dated ahead would outrank every stop until then.
    && Date.parse(relay.at) <= now() + 60_000
    && value.findIndex(other => sameContact(String(other?.to ?? ""), relay.to)) === index);
}

export const watcherDir = (id: string) => join(WATCHERS, id);

export type MissingTrigger = { triggerPathHash: string; triggerKind: "file" | "wal" };

export class TriggerError extends Error {
  readonly triggerPathHash: string;
  readonly triggerKind: "file" | "wal";
  readonly errnoCode: string;
  constructor(path: string, error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    const errnoCode = typeof code === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(code) ? code : "UNKNOWN";
    const triggerPathHash = hash(path).slice(0, 16);
    super(`trigger ${triggerPathHash}: ${errnoCode}`);
    this.triggerPathHash = triggerPathHash;
    this.triggerKind = path.endsWith("-wal") ? "wal" : "file";
    this.errnoCode = errnoCode;
  }
}

/** Cheap change signature of a watcher's trigger files (a stat per file). */
export function triggerSig(watcher: Watcher, onMissing?: (trigger: MissingTrigger) => void): string | undefined {
  if (!watcher.triggers?.length) return undefined;
  return watcher.triggers.map(path => {
    try { const st = statSync(path); return `${st.mtimeMs}:${st.size}`; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // A dangling symlink is broken, while a file (or parent directory) that appears later is normal.
        try { lstatSync(path); }
        catch (linkError) {
          if ((linkError as NodeJS.ErrnoException).code !== "ENOENT") throw new TriggerError(path, linkError);
          onMissing?.({ triggerPathHash: hash(path).slice(0, 16), triggerKind: path.endsWith("-wal") ? "wal" : "file" });
          return "missing";
        }
      }
      throw new TriggerError(path, error);
    }
  }).join("|");
}

export function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { toolError("runner", "watch.json_read_failed"); return undefined; }
}

export function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function normalize(input: Partial<Watcher> & Record<string, unknown>): Watcher {
  const errors: string[] = [];
  if (!validId(input.id)) errors.push("id must be 1-48 chars of a-z, 0-9, - (starting alphanumeric)");
  if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 200 || /[\x00-\x1f]/.test(input.title)) errors.push("title must be one line, 1-200 chars");
  if (typeof input.check !== "string" || !input.check.trim()) errors.push("check command is required");
  if (input.inflight_check !== undefined && (typeof input.inflight_check !== "string" || !input.inflight_check.trim())) errors.push("inflight_check must be a nonempty read-only reply check command");
  if (input.pending_check !== undefined && (typeof input.pending_check !== "string" || !input.pending_check.trim())) errors.push("pending_check must be a nonempty command");
  const interval = input.interval_s === undefined ? DEFAULT_INTERVAL : Number(input.interval_s);
  if (!Number.isInteger(interval) || interval < MIN_INTERVAL) errors.push(`interval_s must be an integer >= ${MIN_INTERVAL}`);
  const timeout = input.timeout_s;
  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1 || timeout > 600)) errors.push("timeout_s must be an integer from 1 to 600");
  const mode = input.mode ?? "wake";
  if (mode !== "wake" && mode !== "notify") errors.push("mode must be wake or notify");
  let triggers = input.triggers === undefined ? [] : input.triggers;
  // whatsapp-new-message reads wacli's store; its WAL changes on every stored message, so trigger on it.
  // The old whatscli session.db trigger is replaced (it no longer means anything to these checks).
  if (Array.isArray(triggers) && typeof input.check === "string" && /\bwhatsapp-new-message\b/.test(input.check)) {
    triggers = [...triggers.filter(t => typeof t !== "string" || !t.includes("whatscli/session.db")), ...WA_TRIGGERS]
      .filter((t, i, all) => all.indexOf(t) === i);
  }
  if (!Array.isArray(triggers) || triggers.some(t => typeof t !== "string" || !t.trim()) || triggers.length > 8) errors.push("triggers must be up to 8 file paths");
  if (typeof (input.context ?? "") !== "string" || String(input.context ?? "").length > 6_000) errors.push("context must be text up to 6000 chars");
  if (mode === "wake" && !String(input.context ?? "").trim()) errors.push("wake watchers need context (owner intent, background, what to do on fire)");
  const expires = input.expires_at ?? null;
  if (expires !== null && (typeof expires !== "string" || Number.isNaN(Date.parse(expires)))) errors.push("expires_at must be an ISO date");
  const maxFires = input.max_fires === undefined ? 1 : Number(input.max_fires);
  if (!Number.isInteger(maxFires) || maxFires < 0) errors.push("max_fires must be an integer >= 0 (0 = unlimited)");
  const maxFailures = input.max_consecutive_failures;
  if (maxFailures !== undefined && (!Number.isInteger(maxFailures) || maxFailures < 0)) errors.push("max_consecutive_failures must be an integer >= 0 (0 = never pause)");
  if (input.owner_imessage_alerts !== undefined && typeof input.owner_imessage_alerts !== "boolean") errors.push("owner_imessage_alerts must be boolean");
  if (input.owner_imessage_alerts === true && input.chat !== undefined) errors.push("owner_imessage_alerts requires an owner watcher");
  if (input.failure_pause_probe !== undefined && typeof input.failure_pause_probe !== "boolean") errors.push("failure_pause_probe must be boolean");
  const noticeAfter = input.failure_notice_after;
  if (noticeAfter !== undefined && (!Number.isInteger(noticeAfter) || noticeAfter < 1)) errors.push("failure_notice_after must be an integer >= 1 (1 = every failure)");
  const depends = input.depends;
  if (depends !== undefined && !validDepends(depends)) errors.push('depends must be an array of "ssd" or "phone"');
  const quiet = input.quiet;
  if (quiet !== undefined && !validQuiet(quiet)) errors.push("quiet must be {start, end, time_zone}: different whole hours 0-23 and an IANA time zone");
  const trip = input.trip;
  if (trip !== undefined && !validId(trip)) errors.push("trip must be a tag like an id (a-z, 0-9, -)");
  const relays = input.relays;
  if (relays !== undefined && !validRelays(relays)) {
    errors.push("relays must be up to 8 distinct {to, name, quote, at}: to a phone number or phone/group jid (not an @lid), quote the owner's own words allowing it, at the ISO time he said it (not in the future)");
  }
  const chat = input.chat;
  if (chat !== undefined && (typeof chat !== "string" || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(chat) || chat === "owner")) {
    errors.push("chat must be a bridge chat slug like moni");
  }
  if (chat !== undefined && mode !== "wake") errors.push("chat watchers must use mode wake");
  if (errors.length) throw new Error(errors.join("; "));
  return {
    id: input.id!, title: input.title!.trim(), check: input.check!, interval_s: interval, mode: mode as Mode,
    context: String(input.context ?? "").trim(), expires_at: expires === null ? null : new Date(expires).toISOString(),
    // Only checks that drive the old whatscli TUI need the shared lock; whatsapp-new-message reads a DB now.
    max_fires: maxFires, serial: input.serial === true || /(^|[\s;|&(`$])wa\s+(tui|screen)\b/.test(input.check!),
    paused: input.paused === true,
    ...(input.inflight_check !== undefined ? { inflight_check: input.inflight_check.trim() } : {}),
    ...(input.pending_check !== undefined ? { pending_check: input.pending_check } : {}),
    ...(timeout !== undefined ? { timeout_s: timeout } : {}),
    ...(maxFailures !== undefined ? { max_consecutive_failures: maxFailures } : {}),
    ...(noticeAfter !== undefined ? { failure_notice_after: noticeAfter } : {}),
    ...(input.failure_pause_probe !== undefined ? { failure_pause_probe: input.failure_pause_probe } : {}),
    ...(depends !== undefined ? { depends: [...new Set(depends)] } : {}),
    ...(triggers.length ? { triggers: (triggers as string[]).map(t => t.trim().replace(/^~(?=\/)/, HOME)) } : {}),
    ...(input.headsup === true ? { headsup: true } : {}),
    ...(input.owner_imessage_alerts === true ? { owner_imessage_alerts: true } : {}),
    ...(Number.isFinite(Number(input.trigger_gap_s)) && Number(input.trigger_gap_s) > 0 ? { trigger_gap_s: Number(input.trigger_gap_s) } : {}),
    ...(quiet !== undefined ? { quiet: { start: quiet.start, end: quiet.end, time_zone: quiet.time_zone } } : {}),
    ...(trip !== undefined ? { trip } : {}),
    ...(chat !== undefined ? { chat: chat as string } : {}),
    ...(relays !== undefined ? {
      relays: (relays as Relay[]).map(relay => ({
        to: relay.to.trim(), name: relay.name.trim(), quote: relay.quote.trim(), at: iso(Date.parse(relay.at)),
      })),
    } : {}),
    created_at: typeof input.created_at === "string" ? input.created_at : iso(),
    created_by_session: typeof input.created_by_session === "string" && input.created_by_session ? input.created_by_session : null,
  };
}

export function loadWatcher(id: string): Watcher | undefined {
  if (retiredWatcher(id)) return undefined;
  return readJson<Watcher>(join(watcherDir(id), "watcher.json"));
}

export function loadState(id: string): State {
  return readJson<State>(join(watcherDir(id), "state.json")) ?? { status: "active", fires: 0, consecutive_failures: 0, failure_alerted: false };
}

export function saveState(id: string, state: State): void {
  writeJson(join(watcherDir(id), "state.json"), state);
}

export function listIds(): string[] {
  if (!existsSync(WATCHERS)) return [];
  return readdirSync(WATCHERS).filter(name => validId(name) && !!loadWatcher(name)).sort();
}

export function log(id: string | null, message: string): void {
  const line = `${iso()} ${message.replace(/\n/g, "\\n")}\n`;
  if (!id) { process.stdout.write(line); return; }
  const path = join(watcherDir(id), "log");
  try {
    if (existsSync(path) && statSync(path).size > MAX_LOG) {
      const text = readFileSync(path, "utf8");
      writeFileSync(path, text.slice(text.length / 2));
    }
    appendFileSync(path, line);
  } catch { toolError("runner", "watch.legacy_log_failed", { watcher: id }); }
}

export const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max - 20)}\n...[truncated]`;

export type CheckResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean; ms: number; busy?: DependencyBusy };
export const checkGroups = new CheckGroups(log, (name, group, diagnostic) => {
  toolLog({ component: "runner", kind: "event", name, ids: { watcher: group.watcher.id },
    props: { pgid: group.pgid, pid: group.pid, killedAt: group.killedAt, diagnostic } });
});
const liveCheckGroups = checkGroups.groups;
export class CheckStuckError extends Error {
  constructor(readonly group: CheckGroup) { super(`Previous check group ${group.pgid} is still alive`); }
}
let stoppingChecks = false;
let shutdownInstalled = false;
let shutdownStarted = false;
let beforeCheckShutdown: (() => void) | undefined;

export const checkGroupExit = (pgid: number): Promise<void> | undefined => liveCheckGroups.get(pgid)?.closed;
export const checkProcessTag = (id: string, run: string = randomUUID()): string => `${id}:${run}:${process.pid}`;

export function installCheckShutdown(beforeShutdown?: () => void): void {
  if (beforeShutdown) beforeCheckShutdown = beforeShutdown;
  if (shutdownInstalled) return;
  shutdownInstalled = true;
  const stop = () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    beforeCheckShutdown?.();
    void killRunningChecks().finally(() => process.exit(0));
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, stop);
  // Exit callbacks cannot await, including an imported runner's unexpected normal exit.
  process.on("exit", () => { void killRunningChecks("SIGKILL"); });
}

function signalCheckGroup(pgid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pgid, signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") toolError("runner", "watch.kill_failed");
  }
}

async function waitForChecks(closed: Promise<void>[], timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.all(closed), new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
  } finally { clearTimeout(timer); }
}

function trackCheckGroup(group: CheckGroup, child: ReturnType<typeof spawn>): void {
  let watching = false;
  const closed = () => {
    if (watching) return;
    watching = true;
    // Closing the shell's pipes does not mean its redirected descendants have exited.
    const reap = () => {
      if (checkGroups.reap(group)) return;
      // Stuck groups are probed on runner ticks, not forty times per second forever.
      if (!group.stuck) setTimeout(reap, 25).unref();
    };
    reap();
  };
  child.once("close", closed);
  child.once("error", closed);
}

export async function killRunningChecks(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  stoppingChecks = true;
  const groups = [...liveCheckGroups];
  for (const [pgid] of groups) signalCheckGroup(pgid, signal);
  if (!groups.length || signal === "SIGKILL") return;
  await waitForChecks(groups.map(([, group]) => group.closed), 500);
  for (const [pgid] of groups) if (liveCheckGroups.has(pgid)) signalCheckGroup(pgid, "SIGKILL");
  // Let the runner reap direct children before it exits, including TERM-resistant checks.
  await waitForChecks(groups.map(([, group]) => group.closed), 250);
}

/**
 * Runs a check in its own process group so a timeout kills everything it started. The result never waits more
 * than KILL_GRACE_MS past the timeout: a SIGKILLed process that the scheduler has not reaped yet must not keep
 * the shared check pool blocked. Its watcher resumes once that group exits (3 Oct 2026: reaping took 9+ minutes).
 */
export function runCheck(watcher: Watcher, dir: string, extraEnv: Record<string, string> = {}, timeoutMs = watcher.timeout_s === undefined ? CHECK_TIMEOUT_MS : watcher.timeout_s * 1_000, instance?: string): Promise<CheckResult> {
  if (stoppingChecks) return Promise.reject(new Error("Runner is shutting down"));
  const previous = checkGroups.previous(watcher.id);
  if (previous) return Promise.reject(new CheckStuckError(previous));
  installCheckShutdown();
  const run = () => {
    const previous = checkGroups.previous(watcher.id);
    if (previous) throw new CheckStuckError(previous);
    return spawnCheck(watcher, dir, extraEnv, timeoutMs, instance ?? watcherInstance(watcher.id));
  };
  return dir === watcherDir(watcher.id) ? withRelayLockAsync(run) : run();
}

function spawnCheck(watcher: Watcher, dir: string, extraEnv: Record<string, string>, timeoutMs: number, instance: string | undefined): Promise<CheckResult> {
  const shell = watcher.serial ? ["/usr/bin/lockf", "-k", "-t", "120", WA_LOCK, "/bin/zsh", "-c", watcher.check] : ["/bin/zsh", "-c", watcher.check];
  assertMacWatcher(watcher.chat);
  const started = now();
  return new Promise(resolve => {
    let done = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cause = new StderrCause();
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null, signal: NodeJS.Signals | null, extra = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!timedOut || !group || checkGroups.reap(group)) clearTimeout(grace);
      const ms = now() - started;
      cause.add(extra);
      const busy = cause.busy(code);
      toolLog({ component: "helpers", kind: code === 0 && !timedOut ? "perf" : "error", name: "helper.run", durationMs: ms, ok: code === 0 && !timedOut, ids: { watcher: watcher.id, helper: watcher.id }, props: { exitCode: code, signal, timedOut, ...(code === 0 && !timedOut ? {} : cause.props(timedOut, code)) }, ...(code === 0 && !timedOut ? {} : { error: { tag: busy ? "helper.dependency_busy" : timedOut ? "helper.timeout" : "helper.exit_failed" } }) });
      resolve({ code, signal, stdout, stderr: stderr + extra, timedOut, ms, ...(busy ? { busy } : {}) });
    };
    const spawnChild = (closing = extraEnv.WATCH_CLOSING ?? (loadState(watcher.id).status === "closing" ? "1" : "0")) => spawn(shell[0]!, shell.slice(1), {
      cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { HOME, PATH, ...(process.env.TOOLLOG_DIR ? { TOOLLOG_DIR: process.env.TOOLLOG_DIR } : {}), ...(process.env.HEALTH_TOOLLOG_DIR ? { HEALTH_TOOLLOG_DIR: process.env.HEALTH_TOOLLOG_DIR } : {}), LANG: "en_US.UTF-8", WATCH_DIR: dir, WATCH_ID: watcher.id, ...testEnv(), ...(watcher.serial ? { WA_LOCKED: "1" } : {}), ...extraEnv,
        ROBOB_WATCH_CHECK: checkProcessTag(watcher.id, extraEnv.WATCH_RUN || undefined), WATCH_CLOSING: closing },
    });
    // Admission shares the removal lock; a stale callback must never start canceled outreach.
    const child = dir === watcherDir(watcher.id) ? withRelayLock(() => {
      if (retiredWatcher(watcher.id) || !instance || watcherInstance(watcher.id) !== instance) throw new Error("Watcher removed before check admission");
      const state = loadState(watcher.id);
      const definition = loadWatcher(watcher.id);
      const current = definition && pollingWatcher(definition, state);
      const pending = extraEnv.WATCH_PENDING === "1" && state.status !== "closing" && !state.reply_handoff
        && definition?.pending_check === watcher.check;
      if (!current || current.paused || (extraEnv.WATCH_PENDING === "1" ? !pending : !checking(state) || current.check !== watcher.check)) throw new Error("Watcher check changed before admission");
      return spawnChild(state.status === "closing" || state.reply_handoff ? "1" : "0");
    }) : spawnChild();
    const group = child.pid ? checkGroups.track(watcher, child.pid) : undefined;
    if (group) trackCheckGroup(group, child);
    child.stdout!.on("data", chunk => { if (stdout.length < 200_000) stdout += chunk; });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => { cause.add(chunk); if (stderr.length < 20_000) stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      if (group) group.killedAt = now();
      try { process.kill(-child.pid!, "SIGKILL"); } catch { toolError("runner", "watch.kill_failed", { watcher: watcher.id }); }
      grace = setTimeout(() => {
        if (group) checkGroups.markStuck(group);
        try { child.stdout!.destroy(); child.stderr!.destroy(); child.unref(); } catch { toolError("runner", "watch.pipe_cleanup_failed", { watcher: watcher.id }); }
        finish(child.exitCode, child.signalCode, `\n[robob-watch] process group ${child.pid} not reaped ${KILL_GRACE_MS / 1000}s after SIGKILL`);
      }, KILL_GRACE_MS);
    }, timeoutMs);
    child.on("close", (code, signal) => finish(code, signal));
    child.on("error", error => finish(127, null, String(error)));
  });
}

async function run(args: string[], timeoutMs = 20_000, maxOutput = 500, ctx?: { watcher?: string; op?: string }): Promise<{ ok: boolean; out: string; stderr: string; code: number; signal: NodeJS.Signals | null }> {
  const started = now();
  const ids = { helper: args[1]?.endsWith(".ts") ? args[1]!.split("/").at(-2) : args[0]?.split("/").at(-1), watcher: ctx?.watcher };
  const op = ctx?.op ?? (args[0] === t3ctlCli() ? args[1] : undefined);
  let timedOut = false;
  try {
    const child = Bun.spawn(args, { env: { HOME, PATH, ...testEnv() }, stdout: "pipe", stderr: "pipe" });
    // Own the same SIGKILL deadline so an external kill is not reported as our timeout.
    const timer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    // A pipe read can fail while the child is alive; its deadline still applies.
    const exited = child.exited.finally(() => clearTimeout(timer));
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), exited]);
    toolLog({ component: "helpers", kind: code === 0 ? "perf" : "error", name: "helper.run", durationMs: now() - started, ok: code === 0, ids, props: { op, timeoutMs, timedOut, exitCode: code, ...(code === 0 ? {} : stderrCause(stderr)) }, ...(code === 0 ? {} : { error: { tag: "helper.exit_failed" } }) });
    return { ok: code === 0, out: `${stdout}${stderr}`.trim().slice(0, maxOutput), stderr: stderr.trim().slice(0, 300), code, signal: child.signalCode };
  } catch (error) {
    toolLog({ component: "helpers", kind: "error", name: "helper.run", durationMs: now() - started, ok: false, ids, props: { op, timeoutMs, timedOut, ...stderrCause(error instanceof Error ? error.message : "") }, error: { tag: "helper.spawn_failed" } });
    throw error;
  }
}

/** Async on purpose: a blocking spawnSync here would freeze every watcher's timers for up to 10s. */
export async function liveSession(watcher?: string): Promise<string | undefined> {
  const result = await run(["/usr/bin/sqlite3", "-readonly", BRIDGE_DB, "select json_extract(value,'$.id') from kv where key='route'"], 10_000, undefined, { watcher });
  const id = result.out.trim();
  // Robob routes are thread ids ("ardud-control:thread:<uuid>"); older OpenCode routes were "ses_...".
  return result.ok && id && /^[A-Za-z0-9_][A-Za-z0-9_%:.-]{0,199}$/.test(id) ? id : undefined;
}

/** The bridge names a wake's inbound row after the sha256 of its dedupe key (api.ts /wake). */
export const wakeInboundId = (key: string) => `wake:${hash(key)}`;

/**
 * State of a bridge inbound row: "pending" means still queued (the agent has not started on it);
 * processing/batched/done/cancelled/failed/unknown all mean the router has taken it. "missing" if absent,
 * undefined if the database could not be read.
 */
export async function inboundState(id: string, watcher?: string): Promise<string | undefined> {
  if (!/^wake:[a-f0-9]{64}$/.test(id)) return undefined;
  const result = await run(["/usr/bin/sqlite3", "-readonly", BRIDGE_DB, `select state from inbound where id='${id}'`], 10_000, undefined, { watcher });
  if (!result.ok) return undefined;
  return result.out.trim() || "missing";
}

export function headsUpText(watcher: Watcher, event: string): string {
  const line = event.trim().replace(/\s+/g, " ");
  const short = line.length <= 160 ? `${line.replace(/[.!?]+$/, "")}.` : `${line.slice(0, 157).trimEnd()}...`;
  return `Heads-up from watcher ${watcher.title}: ${short} I'll follow up properly when I'm free.`;
}

/** Telegram accepts only a short plain source label. */
const telegramSource = (text: string) => (text.replace(/[^A-Za-z0-9 ._-]/g, " ").replace(/\s+/g, " ").trim() || "Watcher").slice(0, 40);

/** Card #14: under a test run a real iMessage/Telegram send is refused unless the test overrode its CLI path.
 * The CLI path and the refusal are both read at call time, so an override set after import still counts. */
export function underTest(): boolean {
  return Boolean(process.env.ROBOB_TEST) || process.env.NODE_ENV === "test" || Boolean(process.env.PYTEST_CURRENT_TEST);
}
const refused = (what: string) => ({ ok: false, out: `refused: test run; ${what} would reach a real app` });
const spectrumCli = () => process.env.ROBOB_WATCH_SPECTRUM_CLI ?? join(HOME, ".local/share/spectrum-bridge/src/cli.ts");
const telegramCli = () => process.env.ROBOB_WATCH_TELEGRAM_CLI ?? join(HOME, ".local/share/telegram-bridge/src/cli.ts");
const t3ctlCli = () => process.env.ROBOB_WATCH_T3CTL ?? join(HOME, ".local/bin/t3ctl");

type CreatorRoute = { kind: "owner"; reason?: string } | { kind: "native_failed"; transient?: boolean; failure?: string; reason?: string } | { kind: "thread"; thread: string; title?: string; unverified?: boolean; reason?: string }
  | { kind: "unreachable"; thread: string; reason: string; failure: string } | { kind: "refused"; reason: string };
const creatorRoutes = new Map<string, { session: string; cli: string; until: number; route: Promise<CreatorRoute> }>();
const CREATOR_CACHE_MS = 3 * 60_000;
const CREATOR_FAILURE_CACHE_MS = 30_000;
const shortThread = (id: string) => id.split(":").at(-1)!.slice(0, 8);
const exitReason = (result: { code: number; signal: NodeJS.Signals | null }) => result.signal === "SIGKILL" ? "timeout" : `exit:${result.code}`;

function probeDetail(step: string, result: { code: number; signal: NodeJS.Signals | null; out: string; stderr?: string }, started: number): string {
  const detail = (result.stderr || result.out).slice(0, 300);
  return `${step} ${exitReason(result)} after ${((now() - started) / 1000).toFixed(1)}s${detail ? `: ${detail}` : ""}`;
}

function creatorFallback(watcher: Watcher, step: "native" | "status" | "send", reason: string, started: number): void {
  const durationMs = Math.max(0, now() - started);
  toolLog({ component: "wakes", kind: "error", name: "wake.creator_fallback", ok: false, ids: { watcher: watcher.id },
    durationMs, props: { step, reason, durationMs } });
}

function creatorTimeout(retry = false): number {
  const override = Number(process.env.ROBOB_WATCH_TEST_CREATOR_TIMEOUT_MS);
  return underTest() && process.env.ROBOB_WATCH_T3CTL && Number.isInteger(override) && override > 0 && override < 10_000 ? override : retry ? 30_000 : 10_000;
}

function creatorSendTimeout(): number {
  const override = Number(process.env.ROBOB_WATCH_TEST_CREATOR_SEND_TIMEOUT_MS);
  return underTest() && process.env.ROBOB_WATCH_T3CTL && Number.isInteger(override) && override > 0 && override < 20_000 ? override : 20_000;
}

const definiteRouteFailure = (out: string) => {
  // t3ctl prints <code>: <message>; the message can quote a thread title containing route-error words.
  const code = /^\s*([a-z][a-z0-9_]*|invalid (?:id|thread|session)):/i.exec(out)?.[1];
  return /\b(not_found|archived|invalid[_ ](?:id|thread|session))\b/i.exec(code ?? out)?.[1]?.toLowerCase().replaceAll(" ", "_");
};

async function creatorRoute(watcher: Watcher, session: string, cli: string, diagnostics = true): Promise<CreatorRoute> {
  const routeLog = (id: string | null, message: string) => { if (diagnostics) log(id, message); };
  const failed = (step: "native" | "status", reason: string, started: number) => {
    routeLog(null, `creator lookup failed watcher=${watcher.id} session=${session.slice(0, 12)} reason=${reason}`);
    if (diagnostics) creatorFallback(watcher, step, reason, started);
  };
  const ownerSession = await liveSession(watcher.id).catch(() => undefined);
  if (session === ownerSession) return { kind: "owner", reason: "live owner session" };
  let thread = session;
  if (session.startsWith("ses_")) {
    const started = now();
    let nativeTimedOut = false;
    try {
      let result = await run([cli, "native", session], creatorTimeout(), 100_000, { watcher: watcher.id, op: "native" });
      const diagnostics = [probeDetail("native", result, started)];
      const timedOut = !result.ok && result.signal === "SIGKILL";
      nativeTimedOut = timedOut;
      if (!result.ok && result.signal === "SIGKILL") {
        const retryStarted = now();
        result = await run([cli, "native", session], creatorTimeout(true), 100_000, { watcher: watcher.id, op: "native_retry" });
        diagnostics.push(probeDetail("retry", result, retryStarted));
      }
      if (!result.ok) {
        failed("native", exitReason(result), started);
        routeLog(watcher.id, `creator native lookup failed ${diagnostics.join(", ")}`);
        if (timedOut) routeLog(null, `creator native lookup failed watcher=${watcher.id} ${diagnostics.join(", ")}`);
        return { kind: "native_failed", transient: timedOut && !definiteRouteFailure(result.out), failure: definiteRouteFailure(result.out), reason: diagnostics.join(", ") };
      }
      try {
        const value: unknown = JSON.parse(result.out);
        if (!jsonObject(value) || !jsonObject(value.thread) || typeof value.thread.threadId !== "string" || !value.thread.threadId.trim()) throw new Error("invalid native thread");
        thread = value.thread.threadId;
      } catch {
        failed("native", "invalid", started);
        return { kind: "native_failed", transient: timedOut, reason: "invalid native response" };
      }
    } catch {
      failed("native", "exit:127", started);
      return { kind: "native_failed", transient: nativeTimedOut, reason: "native lookup unavailable" };
    }
  }
  let started = now();
  const unreachable = (reason: string, detail: string, failure = reason): CreatorRoute => {
    failed("status", reason, started);
    routeLog(null, `creator wake fallback watcher=${watcher.id} thread=${thread} ${detail}`);
    return { kind: "unreachable", thread, reason: detail, failure };
  };
  try {
    if (thread === ownerSession) return { kind: "owner", reason: "live owner session" };
    started = now();
    const diagnostics: string[] = [];
    let result = await run([cli, "status", thread], creatorTimeout(), 100_000, { watcher: watcher.id, op: "status" });
    diagnostics.push(probeDetail("status", result, started));
    if (!result.ok && (result.signal === "SIGKILL" || !result.out.trim())) {
      const retryStarted = now();
      result = await run([cli, "status", thread], creatorTimeout(true), 100_000, { watcher: watcher.id, op: "status_retry" });
      diagnostics.push(probeDetail("retry", result, retryStarted));
    }
    const detail = diagnostics.join(", ");
    if (!result.ok && definiteRouteFailure(result.out)) {
      return unreachable(exitReason(result), detail, definiteRouteFailure(result.out)!);
    }
    let value: unknown;
    try { value = JSON.parse(result.out); } catch { /* An unavailable/malformed probe cannot prove absence. */ }
    if (result.ok && jsonObject(value) && jsonObject(value.thread) && value.thread.threadId === thread
      && typeof value.thread.archived === "boolean") {
      const status = value.thread;
      const project = typeof status.projectId === "string" ? status.projectId : "";
      if (status.origin === "imessage" || /(?:^|[/:])imessage\/?$/i.test(project)) return { kind: "owner", reason: "iMessage thread" };
      return status.archived ? unreachable("archived", `thread is archived after ${((now() - started) / 1000).toFixed(1)}s`) : { kind: "thread", thread, ...(typeof status.title === "string" ? { title: status.title } : {}) };
    }
    failed("status", result.ok ? "invalid" : exitReason(result), started);
    routeLog(watcher.id, `creator status unverified thread=${thread} ${detail}`);
    // Without a successful probe an iMessage origin cannot be identified. Prefer the known
    // thread ID (including ardud-control:thread:) over silently routing a transient failure to the owner.
    return { kind: "thread", thread, unverified: true, reason: detail };
  } catch (error) {
    failed("status", "exit:127", started);
    routeLog(watcher.id, `creator status unverified thread=${thread} status error after ${((now() - started) / 1000).toFixed(1)}s: ${String(error).slice(0, 300)}`);
    return { kind: "thread", thread, unverified: true, reason: "status lookup unavailable" };
  }
}

export type WakeRouteCheck = {
  route: "thread" | "owner" | "unverified" | "refused";
  reason: string;
  durationMs: number;
  thread?: string;
  title?: string;
  note: string;
};

/** Uses the delivery classifier without filling its watcher-id cache or writing delivery diagnostics. */
export async function checkWakeRoute(watcher: Watcher): Promise<WakeRouteCheck | undefined> {
  if (watcher.mode !== "wake" || watcher.chat) return undefined;
  const started = now();
  const session = watcher.created_by_session?.trim();
  const result: CreatorRoute = !session ? { kind: "owner", reason: "no --session" }
    : underTest() && !process.env.ROBOB_WATCH_T3CTL ? { kind: "thread", thread: session, unverified: true, reason: "lookup unavailable" }
    : await creatorRoute(watcher, session, t3ctlCli(), false);
  const durationMs = Math.max(0, now() - started);
  let check: WakeRouteCheck;
  if (result.kind === "owner") {
    const reason = result.reason ?? "no --session";
    check = { route: "owner", reason, durationMs, note: `wakes go to the owner chat (${reason})` };
  } else if (result.kind === "thread" && !result.unverified) {
    check = { route: "thread", reason: "live thread", durationMs, thread: result.thread, title: result.title,
      note: `wakes go to thread ${result.thread}${result.title === undefined ? "" : ` (${JSON.stringify(result.title)})`}` };
  } else if (result.kind === "unreachable" || result.kind === "native_failed" && result.failure) {
    const reason = result.kind === "unreachable" ? result.failure : result.failure!;
    check = { route: "refused", reason, durationMs,
      note: `--session ${session} is not a live thread (${reason}); wakes would go to the owner chat. Pass the thread id from t3ctl, or omit --session for owner wakes.` };
  } else {
    const reason = result.kind === "refused" ? result.reason : result.reason ?? "lookup unavailable";
    const fallback = result.kind === "native_failed"
      ? `if the native lookup cannot resolve a thread or on a definite delivery failure`
      : `on a definite delivery failure; a down or slow server keeps the wake on its thread`;
    check = { route: "unverified", reason, durationMs, thread: result.kind === "thread" ? result.thread : session,
      note: `could not check thread ${shortThread(session!)} (${reason} after ${durationMs}ms); wakes will try it first and fall back to the owner chat ${fallback}.` };
  }
  toolLog({ component: "cli", kind: "event", name: "watch.route_checked", ok: check.route !== "refused", ids: { watcher: watcher.id },
    durationMs, props: { route: check.route, reason: check.route === "unverified" ? "lookup unavailable" : check.reason, durationMs } });
  return check;
}

function resolveCreator(watcher: Watcher, cli: string): Promise<CreatorRoute> {
  const session = watcher.created_by_session?.trim();
  if (!session) return Promise.resolve({ kind: "owner" });
  if (underTest() && !process.env.ROBOB_WATCH_T3CTL) return Promise.resolve({ kind: "refused", reason: refused("t3ctl").out });
  const at = now();
  for (const [id, entry] of creatorRoutes) if (entry.until <= at) creatorRoutes.delete(id);
  const cached = creatorRoutes.get(watcher.id);
  if (cached?.session === session && cached.cli === cli) return cached.route;
  const entry = { session, cli, until: at + CREATOR_CACHE_MS, route: creatorRoute(watcher, session, cli) };
  // Log once per lookup; deliveries sharing a cached failure do not repeat the diagnostic.
  entry.route = entry.route.then(route => {
    if (route.kind === "native_failed" && route.transient || route.kind === "thread" && route.unverified) entry.until = 0;
    else if (route.kind === "native_failed" || route.kind === "unreachable") entry.until = now() + CREATOR_FAILURE_CACHE_MS;
    return route;
  });
  creatorRoutes.set(watcher.id, entry);
  return entry.route;
}

const ambiguousSend = (result: { code: number; signal: NodeJS.Signals | null }) => result.signal === "SIGKILL" || result.code === 4;

type SendResult = { ok: boolean; code: number; signal: NodeJS.Signals | null; out: string; stderr?: string };
// t3ctl's transport retry hint echoes the full message, which may itself mention an archived or invalid thread.
const sendDiagnostic = (result: SendResult) => [result.stderr ?? "", result.out]
  .map(output => output.split("Retry safely with:", 1)[0]).join("\n");
const controlApiUnavailable = (diagnostic: string) => /\b(?:fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|EPIPE|server_restart|HTTP\s+(?:502|503|504)|connection dropped)\b/i.test(diagnostic);
function sendFailureClass(result: SendResult): "control_api_unavailable" | "timeout" | "definite" | "other" {
  const diagnostic = sendDiagnostic(result);
  if (!ambiguousSend(result) && definiteRouteFailure(diagnostic)) return "definite";
  if (result.signal === "SIGKILL" || /(?:^|\n)unavailable:/i.test(diagnostic)
    || /\b(?:timed? out|timeout|TimeoutError)\b/i.test(diagnostic)) return "timeout";
  return controlApiUnavailable(diagnostic) ? "control_api_unavailable" : "other";
}
const transientSend = (result: SendResult) => {
  const failure = sendFailureClass(result);
  return failure !== "definite" && (ambiguousSend(result) || ["timeout", "control_api_unavailable"].includes(failure));
};
const queuedThreadSend = (result: SendResult) => {
  if (!result.ok) return false;
  try { const value = JSON.parse(result.out); return value?.ok === true && value.delivery === "queued"; } catch { return false; }
};

function wakeThread(cli: string, thread: string, text: string, key: string, watcher: string) {
  if (underTest() && !process.env.ROBOB_WATCH_T3CTL) return Promise.resolve({ ...refused("t3ctl send"), code: 127, signal: null });
  return run([cli, "send", thread, clip(text, MAX_WAKE), "--request-id", key, "--mode", "queue"], creatorSendTimeout(), undefined, { watcher, op: "send" });
}

function creatorSendAt(watcher: Watcher, key: string, thread: string): number {
  const fresh = loadState(watcher.id);
  if (fresh.pending?.key !== key) return now();
  const attempt = fresh.pending.creatorSend;
  if (attempt?.thread === thread) return attempt.sentAt;
  const sentAt = now();
  // Commit the first attempt before dispatch: a same-key replay after a crash can
  // return a run that already finished, earlier than the replay's own start time.
  fresh.pending.creatorSend = { thread, sentAt };
  saveState(watcher.id, fresh);
  return sentAt;
}

function clearCreatorSend(watcher: Watcher, key: string): void {
  const fresh = loadState(watcher.id);
  if (fresh.pending?.key !== key || !fresh.pending.creatorSend) return;
  delete fresh.pending.creatorSend;
  saveState(watcher.id, fresh);
}

const bridgeHttpStatus = (result: { out: string }) => {
  const match = result.out.match(/\bHTTP ([1-5][0-9]{2})\b/);
  return match ? Number(match[1]) : undefined;
};

export async function wake(source: string, text: string, key: string, watcher?: string): Promise<{ ok: boolean; out: string; httpStatus?: number }> {
  if (underTest() && !process.env.ROBOB_WATCH_SPECTRUM_CLI) return Promise.resolve(refused("wake"));
  const result = await run([BUN, spectrumCli(), "wake", `--source=${source.slice(0, 100)}`, `--text=${clip(text, MAX_WAKE)}`, `--key=${key}`], undefined, undefined, { watcher });
  return { ...result, httpStatus: bridgeHttpStatus(result) };
}

/**
 * Wakes another chat's agent (`wake --chat`). The bridge only takes this from the owner's chat, so the owner's live
 * route id is the caller; the event itself lands only in the target chat.
 */
export async function wakeChat(chat: string, source: string, text: string, key: string, watcher?: string): Promise<{ ok: boolean; out: string }> {
  const cli = spectrumCli();
  if (underTest() && !process.env.ROBOB_WATCH_SPECTRUM_CLI) return refused("wake --chat");
  const session = await liveSession(watcher);
  if (!session) return { ok: false, out: "no live route session" };
  return run([BUN, cli, "wake", `--chat=${chat}`, `--source=${source.slice(0, 100)}`, `--text=${clip(text, MAX_WAKE)}`, `--session=${session}`, `--key=${key}`], undefined, undefined, { watcher });
}

type ImessageResult = { ok: boolean; out: string; pending?: boolean; retryKey?: string };

async function imessageReceipt(text: string, key: string, watcher?: string): Promise<ImessageResult | undefined> {
  const id = `send:${hash(key)}`;
  // Read acceptance, its actual operation (including early-reply aliases), and
  // transport evidence in one snapshot. /send's 202 only means queued.
  const receipt = await run(["/usr/bin/sqlite3", "-readonly", BRIDGE_DB, `
    with acceptance as (select value from kv where key='api:send:${id}'),
    identity as (select coalesce((select json_extract(value,'$.operationId') from acceptance),'${id}') as id)
    select json_object('saved',(select value from acceptance),
      'operationId',identity.id,'payload',outbox.payload,'state',outbox.state,'attempts',outbox.attempts,'providerId',outbox.providerId,
      'checkpoints',(select json_group_object(key,value) from kv
        where key >= 'chunk:'||identity.id||':' and key < 'chunk:'||identity.id||';'),
      'route',(select value from kv where key='route'),
      'fenced',exists(select 1 from kv where key in ('cancelledSend:${id}','cancelledSend:'||identity.id)),
      'attempted',exists(select 1 from kv where key in ('firstAttempt:'||identity.id,'sendAmbiguous:'||identity.id,'sent-at:'||identity.id))
        or exists(select 1 from kv where key >= 'chunk:'||identity.id||':' and key < 'chunk:'||identity.id||';'))
      from identity left join outbox on outbox.id=identity.id`], 10_000, 100_000, { watcher });
  if (!receipt.ok) return { ok: false, out: "bridge delivery lookup failed" };
  try {
    const row = JSON.parse(receipt.out) as { saved: string | null;
      operationId: string; payload: string | null; state: string | null; attempts: number | null; providerId: string | null;
      checkpoints: string | Record<string, string>;
      route: string | null; fenced: number; attempted: number };
    if (!row.saved) return;
    const saved = JSON.parse(row.saved) as { spec?: string };
    const spec = JSON.parse(saved.spec ?? "null") as { kind?: string; text?: string; sessionId?: string; generation?: number } | null;
    if (spec?.kind !== "conversation" || spec.text !== clip(text, MAX_WAKE)) {
      return { ok: false, out: "bridge acceptance content mismatch" };
    }
    if (!row.payload) return { ok: false, out: "bridge accepted operation missing" };
    const payload = JSON.parse(row.payload) as { kind?: string; sessionId?: string; generation?: number; text?: string;
      attachment?: unknown; poll?: unknown; app?: unknown };
    if (payload.kind !== "conversation" || payload.sessionId !== spec.sessionId || payload.generation !== spec.generation) {
      return { ok: false, out: "bridge accepted operation mismatch" };
    }
    if (row.state === "sent") return { ok: true, out: "bridge delivery confirmed" };
    if (row.state === "cancelled" && typeof payload.text === "string" && !payload.attachment && !payload.poll && !payload.app) {
      // Rotation can cancel after transport acceptance but before markSent. Use
      // Delivery's exact formatter: a folded or multipart text needs every chunk.
      const { BUBBLE_CHARS, formatText, splitFormatted } = await import("../../spectrum-bridge/src/formatting.ts");
      const chunks = splitFormatted(formatText(payload.text.trim() ? payload.text : ""), BUBBLE_CHARS);
      const checkpoints = typeof row.checkpoints === "string" ? JSON.parse(row.checkpoints) as Record<string, string> : row.checkpoints;
      if (chunks.length && chunks.every((_, index) => {
        const saved = checkpoints[`chunk:${row.operationId}:${index}`];
        return saved !== undefined && (JSON.parse(saved) as { accepted?: unknown } | null)?.accepted === true;
      })) return { ok: true, out: "bridge delivery checkpoints confirmed" };
    }
    const route = row.route ? JSON.parse(row.route) as { id?: string; generation?: number } | null : null;
    if (row.state === "cancelled" && row.attempts === 0 && row.providerId === null && !row.fenced && !row.attempted
      && typeof payload.generation === "number" && typeof payload.sessionId === "string"
      && (route?.id !== payload.sessionId || route?.generation !== payload.generation)) {
      // The cancelled operation is terminal and conclusively unsent. A deterministic
      // successor survives a crash before the watcher's new key is persisted.
      return { ok: false, out: "bridge cancelled an unattempted stale route", retryKey: `robob-watch:owner-alert:retry:${hash(key)}` };
    }
    return { ok: false, out: `bridge delivery ${row.state}`,
      ...(["pending", "sending", "uncertain"].includes(row.state ?? "") ? { pending: true } : {}) };
  } catch { return { ok: false, out: "bridge delivery receipt unreadable" }; }
}

export async function imessage(text: string, key: string, options: { reconcile?: boolean; watcher?: string } = {}): Promise<ImessageResult> {
  // Decide the CLI before the await: an override removed while liveSession() is pending must not reopen the live path.
  const cli = spectrumCli();
  if (underTest() && !process.env.ROBOB_WATCH_SPECTRUM_CLI) return refused("imessage send");
  if (options.reconcile) {
    const receipt = await imessageReceipt(text, key, options.watcher);
    if (receipt) return receipt;
  }
  const session = await liveSession(options.watcher);
  if (!session) return { ok: false, out: "no live route session" };
  const sent = await run([BUN, cli, "send", `--text=${clip(text, MAX_WAKE)}`, `--session=${session}`, `--key=${key}`], undefined, undefined, { watcher: options.watcher });
  if (!options.reconcile || !sent.ok) return sent;
  return await imessageReceipt(text, key, options.watcher) ?? { ok: false, pending: true, out: "bridge acceptance awaiting receipt" };
}

export function telegram(source: string, text: string, key: string, severity = "info", burstKey?: string, watcher?: string): Promise<{ ok: boolean; out: string }> {
  if (underTest() && !process.env.ROBOB_WATCH_TELEGRAM_CLI) return Promise.resolve(refused("telegram notify"));
  return run([BUN, telegramCli(), "notify", `--source=${telegramSource(source)}`, `--severity=${severity}`, `--text=${clip(text, MAX_WAKE)}`, `--key=${key}`, ...(burstKey ? [`--burst-key=${burstKey}`] : [])], undefined, undefined, { watcher });
}

/** Env a check child gets: its own inputs plus, under a test run, the test markers and every stub override,
 * so a check that runs a helper (wa, mailsend, the bridge CLIs) hits the same guard the test set up. */
const TEST_ENV_KEYS = ["ROBOB_TEST", "ROBOB_WATCH_TEST", "NODE_ENV", "PYTEST_CURRENT_TEST", "WA_WACLI", "WA_DRAFT_DIR", "MAILSEND_HIMALAYA",
  "MAILSEND_DRAFT_DIR", "MAILSEND_SEND_APPROVAL", "RIDE_CARD_BRIDGE", "CONVO_CARD_BRIDGE", "ROBOB_WATCH_SPECTRUM_CLI", "SPECTRUM_BRIDGE_CONFIG",
  "ROBOB_WATCH_TELEGRAM_CLI", "ROBOB_WATCH_T3CTL", "WACLI_STORE_DIR", "SEND_APPROVAL_BRIDGE_DIR", "SEND_APPROVAL_STATE_DB",
  "ROBOB_READONLY_DB", "MONEY_CASES_STATE_DB", "TOOLLOG_DIR", "HEALTH_TOOLLOG_DIR", "ROBOB_HOME", "T3CODE_HOME", "XDG_DATA_HOME"];
export function testEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of TEST_ENV_KEYS) if (process.env[k] !== undefined) out[k] = process.env[k]!;
  if (resolve(ROOT) !== join(HOME, ".local/share/robob-watch")) out.ROBOB_WATCH_TEST = "1";
  return out;
}

const WA_SENDS = /\bwa\s+(draft|send|sendfile)\b/;
export const mentionsWhatsAppSend = (watcher: { check?: unknown; context?: unknown }) =>
  WA_SENDS.test(`${watcher.check ?? ""}\n${watcher.context ?? ""}`);

/**
 * One-line notes printed when a watcher is added, for a watcher whose text or check sends WhatsApp. Nothing is
 * refused: relays (his words per person) are optional, and a check that sends runs on every change.
 */
export function sendNotes(watcher: { check?: unknown; context?: unknown; relays?: unknown }): string[] {
  const notes: string[] = [];
  if (watcher.relays === undefined && mentionsWhatsAppSend(watcher)) {
    notes.push("its text mentions WhatsApp sends: relays, with his words, are optional and give the fire his stops and the ETA throttle");
  }
  if (WA_SENDS.test(String(watcher.check ?? ""))) {
    notes.push("its check sends WhatsApp by itself on every change, with no agent reading it first");
  }
  return notes;
}

/** Set up before relays existed and its text talks about WhatsApp sends: it lists nobody but the owner. */
export const unscopedSender = (watcher: Watcher) => watcher.relays === undefined && mentionsWhatsAppSend(watcher);

function relayLines(watcher: Watcher): string[] {
  if (watcher.relays === undefined && watcher.trip === undefined) return [];
  const stops = readStops();
  const relays = (watcher.relays ?? []).map(relay => ({ relay, stop: stopFor(stops, watcher, relay) }));
  const live = relays.filter(entry => !entry.stop).map(entry => entry.relay);
  return [
    "",
    live.length
      ? `People besides the owner this may update (he allowed each one; nobody else hears from this watcher). Before each message run \`robob-watch relay-ok ${watcher.id} --to <to>\` (add --eta ISO for an ETA change) and send only on "ok":`
      : "No third-party relays: tell only the owner.",
    ...live.map(relay => `- ${relay.name} (${relay.to}), allowed ${relay.at.slice(0, 10)}: ${JSON.stringify(relay.quote)}`),
    ...relays.flatMap(({ relay, stop }) => stop
      ? [`- ${relay.name} (${relay.to}): the owner stopped these on ${stop.at.slice(0, 10)} (${JSON.stringify(stop.quote)}). Don't message them.`]
      : []),
  ];
}

// Next to the watchers (runtime state deploys never touch), not inside any one of them.
const stopsPath = () => join(WATCHERS, ".relay-stops.json");

export function readStops(): Stop[] {
  return readJson<Stop[]>(stopsPath()) ?? [];
}

/** Record a stop. Call under withRelayLock. */
export function addStop(stop: Stop): void {
  mkdirSync(WATCHERS, { recursive: true, mode: 0o700 });
  writeJson(stopsPath(), [...readStops(), stop]);
}

/** The stop covering this grant: same trip or watcher, same person or everyone, and not older than the grant. */
export function stopFor(stops: Stop[], watcher: Watcher, relay: Relay): Stop | undefined {
  const key = contactKey(relay.to);
  return stops.find(stop => (stop.watchers.includes(watcher.id) || (stop.trip !== undefined && stop.trip === watcher.trip))
    && (stop.key === undefined || stop.key === key) && Date.parse(stop.at) >= Date.parse(relay.at));
}

/** Watchers that share this one's trip, itself included. */
export function family(watcher: Watcher): Watcher[] {
  if (!watcher.trip) return [watcher];
  const others = listIds().filter(id => id !== watcher.id).map(loadWatcher).filter((w): w is Watcher => w?.trip === watcher.trip);
  return [watcher, ...others];
}

type Sent = { watcher: string; trip?: string; key: string; at: string; eta?: string };
// One log for every watcher, so archiving a finished one doesn't forget what its people were already told.
const sentPath = () => join(WATCHERS, ".relay-sent.json");
const SENT_KEEP_MS = 7 * 24 * 60 * 60_000;

/**
 * May a fire message `to` now? Counts an ok, so ask right before sending. An ETA change waits until it moved
 * 15+ min since the last ETA that person got, and an hour since then unless it moved an hour or more.
 */
export function relayCheck(given: Watcher, to: string, eta?: number, at = now()): { ok: boolean; reason: string } {
  return withRelayLock(() => {
    // Reread under the lock: a stop or another fire's send may have landed since the caller loaded it.
    const watcher = loadWatcher(given.id) ?? given;
    return relayVerdict(watcher, to, eta, at);
  });
}

/**
 * Relay checks, stops and replacements run one at a time across processes, so two fires can't both take one ETA
 * slot or miss a stop written meanwhile. A SQLite write lock: the OS drops it if the holder dies.
 */
// Runner admission calls the library's spawn guard while holding the same process's lock.
let relayLockDepth = 0;
export class CheckShutdownError extends Error {
  constructor() { super("Runner is shutting down"); }
}

/** Yield only while acquiring: nested admission/spawn guards must finish before releasing the mutex. */
export function withRelayLockAsync<T>(fn: () => T): Promise<Awaited<T>> {
  const attempt = (): Promise<Awaited<T>> => {
    if (stoppingChecks || shutdownStarted) return Promise.reject(new CheckShutdownError());
    if (relayLockDepth) {
      try { return Promise.resolve(fn()); } catch (error) { return Promise.reject(error); }
    }
    mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    const db = new Database(join(ROOT, "relay-lock.sqlite"));
    try {
      db.exec("PRAGMA busy_timeout = 0");
      db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      db.close();
      if ((error as { code?: string }).code !== "SQLITE_BUSY") return Promise.reject(error);
      return new Promise<void>(resolve => setTimeout(resolve, 20)).then(attempt);
    }
    relayLockDepth++;
    try { return Promise.resolve(fn()); }
    catch (error) { return Promise.reject(error); }
    finally {
      relayLockDepth--;
      // This database is only a mutex; committing would needlessly upgrade past concurrent readers.
      try { db.exec("ROLLBACK"); } finally { db.close(); }
    }
  };
  return attempt();
}

export function withRelayLock<T>(fn: () => T): T {
  if (relayLockDepth) return fn();
  mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const db = new Database(join(ROOT, "relay-lock.sqlite"));
  try {
    // SQLite's synchronous wait prevents signal handlers from cleaning up owned check groups.
    db.exec(`PRAGMA busy_timeout = ${shutdownInstalled ? 0 : 15000}`);
    db.exec("BEGIN IMMEDIATE");
    relayLockDepth++;
    try { return fn(); } finally { relayLockDepth--; db.exec("COMMIT"); }
  } finally { db.close(); }
}

function relayVerdict(watcher: Watcher, to: string, eta: number | undefined, at: number): { ok: boolean; reason: string } {
  const relay = watcher.relays?.find(entry => sameContact(entry.to, to));
  if (!relay) return { ok: false, reason: `${to} is not one of this watcher's relays; only the owner hears about this` };
  const stopped = stopFor(readStops(), watcher, relay);
  if (stopped) return { ok: false, reason: `the owner stopped updates to ${relay.name} on ${stopped.at.slice(0, 10)}` };
  const key = contactKey(relay.to);
  const history = (readJson<Sent[]>(sentPath()) ?? []).filter(entry => at - Date.parse(entry.at) < SENT_KEEP_MS);
  const etas = history.filter(entry => entry.key === key && entry.eta).sort((a, b) => a.at.localeCompare(b.at));
  if (eta !== undefined) {
    // Movement is measured on this watcher's own last ETA, since a sibling may track another flight; the hourly gap
    // is per person. Before its first one, the closest ETA a sibling sent this hour stands in (same flight, likely).
    // Siblings are matched by the trip recorded with each send, so a removed one still counts.
    const recent = etas.filter(entry => at - Date.parse(entry.at) < RELAY_GAP_MS
      && (entry.watcher === watcher.id || (watcher.trip !== undefined && entry.trip === watcher.trip)));
    const distance = (entry: { eta?: string }) => Math.abs(eta - Date.parse(entry.eta!));
    const own = etas.filter(entry => entry.watcher === watcher.id).at(-1)
      ?? [...recent].sort((a, b) => distance(a) - distance(b))[0];
    if (own) {
      const moved = Math.abs(eta - Date.parse(own.eta!));
      if (moved < RELAY_ETA_MOVE_MS) return { ok: false, reason: `the ETA moved ${Math.round(moved / 60_000)} min since the last one ${relay.name} got; wait for a 15+ min change` };
      const last = recent.at(-1);
      if (last && moved < RELAY_GAP_MS) {
        return { ok: false, reason: `${relay.name} got an ETA ${Math.round((at - Date.parse(last.at)) / 60_000)} min ago; at most one an hour unless it moved an hour or more` };
      }
    }
  }
  mkdirSync(WATCHERS, { recursive: true, mode: 0o700 });
  writeJson(sentPath(), [...history, {
    watcher: watcher.id, ...(watcher.trip ? { trip: watcher.trip } : {}), key, at: iso(at), ...(eta !== undefined ? { eta: iso(eta) } : {}),
  }]);
  return { ok: true, reason: `send to ${relay.name}; counted at ${iso(at)}` };
}

/** Wakes repeat the saved context on every fire; this is the start that carries the action, the rest is a pointer. */
export const CONTEXT_PREVIEW = 280;

export function contextPreview(w: Watcher, snapshot?: string): string {
  const context = w.context || "";
  if (!context) return "(none)";
  if (context.length <= CONTEXT_PREVIEW) return context;
  const head = context.slice(0, CONTEXT_PREVIEW);
  const cut = Math.max(head.lastIndexOf(" "), head.lastIndexOf("\n"));
  const pointer = snapshot ? `read saved context at \`${snapshot}\`` : `\`robob-watch context ${w.id}\``;
  return `${(cut > 0 ? head.slice(0, cut) : head).trimEnd()}…\nFull rules: ${pointer} (read them before acting on anything beyond the lines above).`;
}

/** The first fire of each Dubai day (or of the watcher's quiet-hours zone) carries the whole context; decided from state so a retried key keeps its text. */
function firstFireToday(watcher: Watcher, state: State): boolean {
  if (!state.last_fire_at) return true;
  const zone = watcher.quiet?.time_zone ?? "Asia/Dubai";
  const day = (at: string) => new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date(at));
  return day(state.last_fire_at) !== day(state.pending?.at ?? iso());
}

export function wakeText(watcher: Watcher, event: string, state: State, test = false): string {
  const count = state.pending?.count ?? 1;
  const label = count === 1 ? `fire ${state.fires + 1}` : `fires ${state.fires + 1}–${state.fires + count}`;
  const fires = watcher.max_fires === 0 ? `${label}, unlimited` : `${label} of ${watcher.max_fires}`;
  const after = watcher.max_fires !== 0 && state.fires + count >= watcher.max_fires
    ? "This watcher is now finished and disabled. If the owner still wants it watched, add a fresh one."
    : "The watcher keeps running; manage it with robob-watch show/pause/remove " + watcher.id + ".";
  return [
    `${test ? "[TEST FIRE, not a real event: acknowledge briefly and do nothing else] " : ""}${watcher.title}`,
    "",
    // Ahead of the event and context: the wake is clipped at the end, and who may be messaged must survive that.
    ...relayLines(watcher),
    "",
    "Event:",
    clip(event.trim(), MAX_EVENT),
    "",
    `Context saved when this watcher was set up (written by the agent that set it up; the owner's instructions for this event)${firstFireToday(watcher, state) && state.pending?.context_file ? `; full snapshot: ${state.pending.context_file}` : ""}:`,
    firstFireToday(watcher, state) ? watcher.context || "(none)" : contextPreview(watcher, state.pending?.context_file),
    "",
    `Watcher ${watcher.id} (${fires}). ${after}`,
  ].join("\n");
}

export type Delivery = { ok: boolean; accepted?: boolean; via: string; detail: string; route?: WakeRoute;
  confirmed?: "pending" | "n/a"; confirmation?: WakeConfirmation; meantFor?: string; sendDeferred?: boolean;
  failureClass?: ReturnType<typeof sendFailureClass> };

export function trackConfirmation(state: State, delivery: Delivery): void {
  const entry = delivery.confirmation;
  if (!entry) return;
  if (!state.confirm) state.confirm = entry;
  else if (state.confirm.key !== entry.key && !state.confirmations?.some(item => item.key === entry.key)) {
    state.confirmations = [...(state.confirmations ?? []), entry];
  }
}

/** Delivers one event; each channel is idempotent under the same key. */
export async function deliver(watcher: Watcher, event: string, key: string, state: State, test = false): Promise<Delivery> {
  const started = now();
  const pending = state.pending?.key === key ? state.pending : undefined;
  // queueEvent already read the registry; legacy/direct calls have no recorded chat classification.
  let route: WakeRoute = watcher.chat ? pending?.route ?? "other" : "owner";
  let delivery: Delivery | undefined;
  let failureClass: Delivery["failureClass"];
  const finish = (result: Delivery) => delivery = { confirmed: "n/a", ...result, route };
  const queued = (via: string, detail: string, confirmation: WakeConfirmation, meantFor?: string) =>
    finish({ ok: false, accepted: true, via, detail, confirmed: "pending", confirmation, meantFor });
  try {
    const tried: string[] = [];
    const plain = `${test ? "[Watcher test] " : ""}${watcher.title}\n${clip(event.trim(), MAX_EVENT)}`;
    if (watcher.chat) {
      // Someone else's data: only her chat may see it. A failed wake stays pending and is retried with the same key.
      const text = `[Watcher event from robob-watch ${watcher.id}, not typed by anyone in this chat.]\n${wakeText(watcher, event, state, test)}`;
      const result = await wakeChat(watcher.chat, `robob-watch ${watcher.id}`, text, key, watcher.id);
      return finish(result.ok ? { ok: true, via: `wake:${watcher.chat}`, detail: result.out } : { ok: false, via: "none", detail: `wake --chat ${watcher.chat}: ${result.out}` });
    }
    if (watcher.mode === "wake") {
      // Capture the override before awaiting resolution, so a removed test stub cannot open the live path.
      const cli = t3ctlCli();
      const creator = await resolveCreator(watcher, cli);
      if (creator.kind === "refused") return finish({ ok: false, via: "none", detail: creator.reason });
      let text = wakeText(watcher, event, state, test);
      let missed: { thread: string; reason: string } | undefined;
      const confirmation = (): WakeConfirmation => ({ key, sentAt: now(), attempts: 0, event, text: clip(text, MAX_WAKE) });
      if (creator.kind === "native_failed" && creator.transient) {
        return queued("native:pending", "native lookup timed out twice; awaiting resolution", { ...confirmation(), nativeSession: watcher.created_by_session! });
      }
      if (creator.kind === "thread") {
        const prefix = `[Watcher event from robob-watch ${watcher.id}, not typed by anyone in this thread.]`;
        const firstSentAt = creatorSendAt(watcher, key, creator.thread);
        const sendStarted = now();
        let reason = "error";
        try {
          const result = await wakeThread(cli, creator.thread, `${prefix}\n${text}`, key, watcher.id);
          if (queuedThreadSend(result)) { route = "creator"; return finish({ ok: true, via: `thread:${shortThread(creator.thread)}`, detail: result.out }); }
          if (result.ok) { route = "creator"; return queued(`thread:${shortThread(creator.thread)}`, result.out,
            { ...confirmation(), sentAt: firstSentAt, thread: creator.thread }); }
          reason = exitReason(result);
          failureClass = sendFailureClass(result);
          if (transientSend(result) && !ambiguousSend(result)) {
            route = "creator";
            const detail = probeDetail("send", result, sendStarted);
            log(watcher.id, `creator send deferred thread=${creator.thread} ${detail}`);
            return finish({ ...queued(`thread:${shortThread(creator.thread)}`, detail,
              { ...confirmation(), sentAt: firstSentAt, thread: creator.thread, sendPending: true, sendAttempts: 0,
                deferredAt: firstSentAt, nextAt: now() + wakeSendBackoff(0) }), sendDeferred: true });
          }
          if (transientSend(result)) {
            route = "creator";
            log(watcher.id, `creator send unconfirmed thread=${creator.thread} ${probeDetail("send", result, sendStarted)}`);
            return queued(`thread:${shortThread(creator.thread)}`, probeDetail("send", result, sendStarted),
              { ...confirmation(), sentAt: firstSentAt, thread: creator.thread });
          }
          missed = { thread: creator.thread, reason: [creator.reason, probeDetail("send", result, sendStarted)].filter(Boolean).join(", ") };
        } catch (error) { failureClass = "other"; missed = { thread: creator.thread, reason: [creator.reason, `send error after ${((now() - sendStarted) / 1000).toFixed(1)}s: ${String(error).slice(0, 300)}`].filter(Boolean).join(", ") }; }
        clearCreatorSend(watcher, key);
        creatorFallback(watcher, "send", reason, sendStarted);
        // log(watcher.id, ...) below stays in the watcher archive; stdout reaches runner.log.
        log(null, `creator wake fallback watcher=${watcher.id} thread=${creator.thread} reason=${reason}`);
      } else if (creator.kind === "unreachable") { missed = creator; failureClass = "definite"; }
      if (missed) {
        text = `(meant for thread ${shortThread(missed.thread)}, which could not be reached)\n${text}`;
        log(watcher.id, `creator wake fallback thread=${missed.thread} ${missed.reason}`);
        tried.push(`thread:${shortThread(missed.thread)}: ${missed.reason}`);
      }
      const result = await wake(`robob-watch ${watcher.id}`, text, key, watcher.id);
      if (result.ok) return queued(missed ? "wake:owner-fallback" : "wake", result.out,
        { ...confirmation(), thread: missed?.thread, ownerFallback: !!missed }, missed?.thread);
      tried.push(`wake: ${result.out}`);
    }
    const sent = await imessage(plain, key, { watcher: watcher.id });
    if (sent.ok) return finish({ ok: true, via: "imessage-send", detail: [...tried, sent.out].join(" | ") });
    tried.push(`send: ${sent.out}`);
    const notified = await telegram(`Watcher ${watcher.id}`, plain, key, undefined, undefined, watcher.id);
    if (notified.ok) return finish({ ok: true, via: "telegram", detail: [...tried, notified.out].join(" | ") });
    tried.push(`telegram: ${notified.out}`);
    return finish({ ok: false, via: "none", detail: tried.join(" | ") });
  } finally {
    const via = delivery?.via ?? "none";
    const accepted = delivery?.accepted || delivery?.ok;
    toolLog({ component: "wakes", kind: delivery?.accepted ? "event" : delivery?.ok ? "perf" : "error", name: "wake.sent", ok: delivery?.ok ?? false,
      durationMs: Math.max(0, now() - started), ids: { watcher: watcher.id, chat: route, key: wakeInboundId(key),
        ...(delivery?.meantFor ? { meantFor: delivery.meantFor } : {}), ...(delivery?.confirmation?.thread ? { thread: delivery.confirmation.thread } : {}) },
      props: { via: watcher.chat && via.startsWith("wake:") ? "wake" : via,
        ...(delivery?.meantFor ? { meant_for: shortThread(delivery.meantFor) } : {}),
        confirmed: delivery?.confirmed ?? "n/a", accepted: !!accepted, events: pending?.count ?? 1,
        ...(delivery?.sendDeferred ? { sendDeferred: true } : {}), ...(failureClass ? { failureClass } : {}) },
      ...(accepted ? {} : { error: { tag: "wake.delivery_failed" } }) });
  }
}

async function deliverToOwner(watcher: Watcher, event: string, text: string, key: string): Promise<Delivery> {
  const result = await wake(`robob-watch ${watcher.id}`, text, key, watcher.id);
  if (result.ok) return { ok: true, via: "wake", detail: result.out };
  const plain = `${watcher.title}\n${clip(event.trim(), MAX_EVENT)}`;
  const sent = await imessage(plain, key, { watcher: watcher.id });
  if (sent.ok) return { ok: true, via: "imessage-send", detail: sent.out };
  const notified = await telegram(`Watcher ${watcher.id}`, plain, key, undefined, undefined, watcher.id);
  return { ok: notified.ok, via: notified.ok ? "telegram" : "none", detail: notified.out };
}

/** Confirmation is separate from queue acceptance and remains active for capped/paused watchers. */
export async function confirmWakes(watcher: Watcher): Promise<void> {
  const instance = watcherInstance(watcher.id);
  const snapshot = loadState(watcher.id);
  const entries = [snapshot.confirm, ...(snapshot.confirmations ?? [])].filter((entry): entry is WakeConfirmation => !!entry);
  const update = (entry: WakeConfirmation, remove = false, via?: string) => {
    if (!loadWatcher(watcher.id) || watcherInstance(watcher.id) !== instance) return false;
    const fresh = loadState(watcher.id);
    const pending = [fresh.confirm, ...(fresh.confirmations ?? [])].filter((item): item is WakeConfirmation => !!item);
    if (!pending.some(item => item.key === entry.key)) return false;
    const next = pending.flatMap(item => item.key !== entry.key ? [item] : remove ? [] : [entry]);
    fresh.confirm = next.shift();
    if (!fresh.confirm) delete fresh.confirm;
    if (next.length) fresh.confirmations = next; else delete fresh.confirmations;
    if (via) fresh.last_delivery = via;
    saveState(watcher.id, fresh);
    return true;
  };
  const confirm = (entry: WakeConfirmation) => {
    if (!update(entry, true)) return;
    const durationMs = Math.max(0, now() - (entry.deferredAt ?? entry.sentAt));
    const message = `wake confirmed after ${(durationMs / 1000).toFixed(1)}s key=${entry.key}`;
    log(watcher.id, message); log(null, `${message} watcher=${watcher.id}`);
    toolLog({ component: "wakes", kind: "event", name: "wake.confirmed", ok: true, durationMs,
      ids: { watcher: watcher.id, key: wakeInboundId(entry.key), thread: entry.thread ?? entry.nativeSession ?? "owner" } });
  };
  const fallbackThread = async (entry: WakeConfirmation, missed = true) => {
    entry.ownerFallback = true;
    delete entry.sendPending;
    entry.fallbackText ??= missed ? `(meant for thread ${shortThread(entry.thread!)}, which could not be reached)\n${entry.text}` : entry.text;
    // Save the route before sending: a crash must never confirm this rejected wake from a thread run.
    if (!update(entry)) return;
    const result = await deliverToOwner(watcher, entry.event, entry.fallbackText, entry.key);
    const via = result.via === "wake" && missed ? "wake:owner-fallback" : result.via;
    entry.fallbackDone = result.ok;
    update(entry, result.ok && result.via !== "wake", via);
    log(watcher.id, `wake escalation key=${entry.key} via=${via} confirmed=pending`);
  };
  const retryThread = async (entry: WakeConfirmation, escalation = false) => {
    const cli = t3ctlCli();
    if (underTest() && !process.env.ROBOB_WATCH_T3CTL) return;
    const started = now();
    const wasPending = entry.sendPending;
    entry.sendAttempts = (entry.sendAttempts ?? 0) + 1;
    entry.nextAt = now() + wakeSendBackoff(entry.sendAttempts);
    if (!update(entry)) return;
    // Bypass the successful-route cache: a thread may have been archived since its first send.
    const route = await creatorRoute(watcher, entry.thread!, cli);
    const ids = { watcher: watcher.id, key: wakeInboundId(entry.key), thread: entry.thread! };
    const record = (outcome: string) => toolLog({ component: "wakes", kind: "event", name: "wake.send_retry",
      durationMs: Math.max(0, now() - started), ids, props: { op: "send", attempt: entry.sendAttempts, outcome } });
    if (route.kind === "unreachable") {
      record("definite");
      await fallbackThread(entry);
      return;
    }
    if (route.kind === "owner") {
      record("owner");
      await fallbackThread(entry, false);
      return;
    }
    const sendStarted = now();
    const result = await wakeThread(cli, entry.thread!,
      `[Watcher event from robob-watch ${watcher.id}, not typed by anyone in this thread.]\n${entry.text}`, entry.key, watcher.id)
      .catch(error => ({ ok: false, code: 127, signal: null, out: String(error).slice(0, 300) }));
    const failure = result.ok ? undefined : sendFailureClass(result);
    record(result.ok ? "accepted" : failure === "definite" ? "definite" : ambiguousSend(result) ? "ambiguous" : "deferred");
    if (failure === "definite") { await fallbackThread(entry); return; }
    if (result.ok || ambiguousSend(result)) {
      delete entry.sendPending;
      if (wasPending) {
        // A same-key replay can return an earlier receipt whose run already finished.
        // Keep the first possible send time so that run still confirms the wake.
        const totalDelayMs = Math.max(0, now() - (entry.deferredAt ?? started));
        log(watcher.id, `creator send delivered after ${entry.sendAttempts} retries thread=${entry.thread}`);
        toolLog({ component: "wakes", kind: "event", name: "wake.send_delivered_late", ok: true, ids,
          props: { op: "send", retries: entry.sendAttempts, totalDelayMs } });
      }
      entry.nextAt = now() + CONFIRM_POLL_MS;
      if (escalation) entry.fallbackDone = true;
    } else {
      entry.sendPending = true;
      entry.deferredAt ??= entry.sentAt;
      log(watcher.id, `creator send deferred thread=${entry.thread} ${probeDetail("send", result, sendStarted)}`);
    }
    // A native session already resolved to a thread follows the same rule. Unresolved native
    // sessions retain their existing escalation because there is no thread destination yet.
    if (!update(entry, false, `thread:${shortThread(entry.thread!)}`)) return;
    if (escalation) log(watcher.id, `wake escalation key=${entry.key} via=thread:${shortThread(entry.thread!)} confirmed=pending (target ${route.kind === "thread" && !route.unverified ? "live" : "unverified"})`);
    if (queuedThreadSend(result)) confirm(entry);
  };
  for (const entry of entries) {
    const retryDue = (entry.nextAt ?? 0) <= now();
    // Send backoff must not postpone the once-only ten-minute alert.
    if (!retryDue && !(entry.sendPending && !entry.escalated
      && now() - (entry.deadlineAt ?? entry.sentAt) >= WAKE_CONFIRM_MS)) continue;
    entry.attempts++;
    if (retryDue) entry.nextAt = now() + CONFIRM_POLL_MS;
    if (!update(entry)) return;
    let confirmed = false;
    let retried = false;
    if (retryDue && entry.sendPending && entry.thread && !entry.ownerFallback && !inQuiet(watcher.quiet)) {
      retried = true;
      await retryThread(entry);
      // A send is never proved by an unrelated running turn while it is still deferred.
      // Escalation/alert work below still runs, but cannot bypass this retry's backoff.
      const fresh = loadState(watcher.id);
      if (![fresh.confirm, ...(fresh.confirmations ?? [])].some(item => item?.key === entry.key)) continue;
    }
    if (entry.nativeSession && !entry.thread && !entry.escalated && !entry.ownerFallback && !inQuiet(watcher.quiet)) {
      const cli = t3ctlCli();
      const route = await resolveCreator({ ...watcher, created_by_session: entry.nativeSession }, cli);
      if (route.kind === "thread") {
        entry.thread = route.thread;
        entry.deadlineAt ??= entry.sentAt;
        entry.sentAt = now();
        if (!update(entry)) return;
        const sendStarted = now();
        const result = await wakeThread(cli, route.thread,
          `[Watcher event from robob-watch ${watcher.id}, not typed by anyone in this thread.]\n${entry.text}`, entry.key, watcher.id)
          .catch(error => ({ ok: false, code: 127, signal: null, out: String(error).slice(0, 300) }));
        log(watcher.id, `native wake resolved thread=${route.thread} accepted=${result.ok} ${result.out.slice(0, 300)}`);
        if (queuedThreadSend(result)) { confirm(entry); continue; }
        if (!result.ok && transientSend(result) && !ambiguousSend(result)) {
          entry.sendPending = true;
          entry.sendAttempts = 0;
          entry.deferredAt = entry.sentAt;
          entry.nextAt = now() + wakeSendBackoff(0);
          log(watcher.id, `creator send deferred thread=${route.thread} ${probeDetail("send", result, sendStarted)}`);
        } else if (!result.ok && !transientSend(result)) {
          creatorFallback(watcher, "send", exitReason(result), sendStarted);
          const detail = probeDetail("send", result, sendStarted);
          log(watcher.id, `creator wake fallback thread=${route.thread} ${detail}`);
          log(null, `creator wake fallback watcher=${watcher.id} thread=${route.thread} ${detail}`);
          // Persist the failed creator route before trying another channel, so a running
          // thread cannot confirm a rejected event on this tick or after a restart.
          entry.ownerFallback = true;
          entry.text = `(meant for thread ${shortThread(route.thread)}, which could not be reached)\n${entry.text}`;
          if (!update(entry)) return;
          const fallback = await deliverToOwner(watcher, entry.event, entry.text, entry.key);
          const via = fallback.via === "wake" ? "wake:owner-fallback" : fallback.via;
          log(watcher.id, `native wake fallback via=${via} meant_for=${shortThread(route.thread)} confirmed=${fallback.via === "wake" ? "pending" : "n/a"}`);
          const complete = fallback.ok && fallback.via !== "wake";
          if (!update(entry, complete, via)) return;
          if (complete) continue;
        }
      } else if (route.kind === "owner") {
        entry.deadlineAt ??= entry.sentAt;
        entry.sentAt = now();
        entry.ownerFallback = true;
        if (!update(entry)) return;
        await wake(`robob-watch ${watcher.id}`, entry.text, entry.key, watcher.id);
      }
      if (!update(entry)) return;
    }
    if (entry.thread && !entry.ownerFallback && !entry.sendPending && !(underTest() && !process.env.ROBOB_WATCH_T3CTL)) {
      try {
        const result = await run([t3ctlCli(), "status", entry.thread], creatorTimeout(), 100_000, { watcher: watcher.id, op: "confirm" });
        if (result.ok) {
          const value: unknown = JSON.parse(result.out);
          if (jsonObject(value) && jsonObject(value.thread) && value.thread.threadId === entry.thread) {
            const thread = value.thread;
            const runs = [thread.run, ...(Array.isArray(thread.recentRuns) ? thread.recentRuns : []),
              ...(Array.isArray(thread.runs) ? thread.runs : [])];
            confirmed = thread.state === "running" || thread.status === "running" || runs.some(run => jsonObject(run)
              && [run.requestedAt, run.startedAt].some(at => typeof at === "string" && Date.parse(at) >= entry.sentAt));
          }
        }
      } catch { /* A failed probe leaves the wake pending; its deadline still escalates below. */ }
    }
    if (!confirmed && ((!entry.thread && !entry.nativeSession) || entry.ownerFallback)) {
      const row = await inboundState(wakeInboundId(entry.key), watcher.id);
      confirmed = row !== undefined && row !== "pending" && row !== "missing";
    }
    if (!loadWatcher(watcher.id) || watcherInstance(watcher.id) !== instance) return;
    const durationMs = Math.max(0, now() - entry.sentAt);
    const ids = { watcher: watcher.id, key: wakeInboundId(entry.key), thread: entry.thread ?? entry.nativeSession ?? "owner" };
    if (confirmed) {
      confirm(entry);
    } else if (now() - (entry.deadlineAt ?? entry.sentAt) >= WAKE_CONFIRM_MS) {
      const target = entry.thread ?? entry.nativeSession ?? "owner chat";
      if (!entry.escalated) {
        entry.escalated = true;
        entry.unconfirmedAt = now();
        if (!update(entry)) return;
        const message = `wake unconfirmed watcher=${watcher.id} target=${target} key=${entry.key} after ${(durationMs / 1000).toFixed(1)}s`;
        log(watcher.id, message); log(null, message);
        toolLog({ component: "wakes", kind: "error", name: "wake.unconfirmed", ok: false, durationMs, ids,
          error: { tag: "wake.unconfirmed" } });
      }
      // Probes continue in quiet hours, but event delivery waits just like deliverPending.
      if (inQuiet(watcher.quiet)) continue;
      if (!entry.alertDone) {
        const waited = (entry.unconfirmedAt ?? now()) - (entry.deadlineAt ?? entry.sentAt);
        const result = await alert(watcher, `Watcher ${watcher.id}: wake to ${target} has not started after ${Math.round(waited / 1000)}s.\n${entry.event.split("\n")[0]}`,
          `${entry.key}:unconfirmed`, "attention");
        entry.alertDone = result.ok;
        if (!update(entry)) return;
      }
      if (entry.fallbackDone) continue;
      if (entry.thread && !entry.ownerFallback) {
        if (retried && !entry.sendPending) { entry.fallbackDone = true; if (!update(entry)) return; }
        else if (!entry.sendPending) await retryThread(entry, true);
        continue;
      }
      // An existing owner wake is immutable under its key. Retrying must preserve its payload.
      entry.fallbackText ??= entry.ownerFallback || !entry.thread && !entry.nativeSession ? entry.text
        : `(meant for thread ${shortThread(target)}; its wake is still unconfirmed)\n${entry.text}`;
      if (!update(entry)) return;
      const fallback = await deliverToOwner(watcher, entry.event, entry.fallbackText, entry.key);
      const via = fallback.via === "wake" && (entry.thread || entry.nativeSession) ? "wake:owner-fallback" : fallback.via;
      if (fallback.ok && fallback.via === "wake") entry.ownerFallback = true;
      entry.fallbackDone = via !== "none";
      if (!update(entry, false, via)) return;
      log(watcher.id, `wake escalation key=${entry.key} via=${via} confirmed=pending`);
    }
  }
}

/** Housekeeping notices (failures, expiry) go to the alert channel first, iMessage second. */
export async function alert(watcher: Watcher, text: string, key: string, severity = "attention", imessageFallback = true): Promise<Delivery> {
  const notified = await telegram(`Watcher ${watcher.id}`, text, key, severity,
    severity === "error" ? `watcher-failure:${watcher.id}` : undefined, watcher.id);
  if (notified.ok) return { ok: true, via: "telegram", detail: notified.out };
  if (!imessageFallback) return { ok: false, via: "none", detail: notified.out };
  const sent = await imessage(`${watcher.title}: ${text}`, key, { watcher: watcher.id });
  return sent.ok ? { ok: true, via: "imessage-send", detail: sent.out } : { ok: false, via: "none", detail: `${notified.out} | ${sent.out}` };
}

export function shouldNotifyFailure(watcher: Watcher, state: State, timedOut: boolean, t = now()): boolean {
  return state.consecutive_failures >= (watcher.failure_notice_after ?? FAILURE_NOTICE_AFTER)
    && (!state.dependency_busy || t - Date.parse(state.dependency_busy.since) >= BUSY_ALERT_AFTER_MS)
    && (!timedOut || t - Date.parse(state.failing_since ?? iso(t)) >= TIMEOUT_ALERT_AFTER_MS);
}

export function clearFailureProbe(state: State): void {
  delete state.failure_probe_attempts;
  delete state.failure_probe_next_at;
}

/** Shared by manual resume and a passing check; queued recovery receipts survive this reset. */
export function clearFailureState(state: State): void {
  clearFailureProbe(state);
  delete state.failure_paused_at;
  delete state.failure_pause_notice;
  clearFailureEscalation(state);
  delete state.trigger_error;
  delete state.load_timeouts;
  delete state.load_timeout_since;
  state.consecutive_failures = 0;
  state.failure_alerted = false;
  delete state.failure_escalated;
  delete state.failing_since;
  delete state.dependency_busy;
  delete state.failure_episode;
  delete state.last_error;
  delete state.last_error_sources;
}

export function clearFailureEscalation(state: State): void {
  delete state.failure_escalated;
  delete state.failure_pause_escalation;
  delete state.failure_pause_escalation_fallback;
  delete state.failure_escalation_key;
  delete state.failure_escalation_source;
  delete state.failure_escalation_attempts;
  delete state.failure_escalation_next_at;
  delete state.failure_escalation_notice;
  delete state.failure_escalation_notice_sent;
  delete state.failure_escalation_pending;
}

export function ensureFailureProbe(watcher: Watcher, state: State): boolean {
  if (!state.failure_paused_at || watcher.paused || watcher.failure_pause_probe === false || state.status !== "active"
    || state.failure_probe_next_at) return false;
  state.failure_probe_attempts = 0;
  state.failure_probe_next_at = iso(Date.parse(state.failure_paused_at) + 15 * 60_000);
  return true;
}

export function failureProbeDue(watcher: Watcher, state: State, t = now()): boolean {
  return state.status === "active" && !!state.failure_paused_at && !watcher.paused && watcher.failure_pause_probe !== false
    && !!state.failure_probe_next_at && Date.parse(state.failure_probe_next_at) <= t;
}

export const failureProbeDelay = (attempt: number) => (attempt < 1 ? 15 : attempt === 1 ? 30 : 60) * 60_000;
export const dubaiClock = (at: string) => new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Dubai",
}).format(Date.parse(at));
export function pausedDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60}m` : `${minutes}m`;
}
export function pauseRetryText(watcher: Watcher, state: State): string {
  return watcher.failure_pause_probe === false || watcher.paused
    ? `Fix it, then robob-watch resume ${watcher.id}.`
    : `It retries on its own in 15 min, 30 min, then hourly; or robob-watch resume ${watcher.id}. Next retry: ${dubaiClock(state.failure_probe_next_at ?? iso(Date.parse(state.failure_paused_at!) + 15 * 60_000))} Dubai.`;
}

export function shouldPause(watcher: Watcher, state: State, timedOut: boolean, t = now()): boolean {
  if (state.dependency_busy) return false;
  const threshold = watcher.max_consecutive_failures ?? FAILURE_ALERT_AFTER;
  return threshold > 0 && state.consecutive_failures >= threshold
    && (!timedOut || t - Date.parse(state.failing_since ?? iso(t)) >= TIMEOUT_ALERT_AFTER_MS);
}

/**
 * A Telegram alert alone went unanswered for 2.5h (4 Oct 2026,
 * wacli daemon booted out). After ESCALATE_AFTER_MS of failing, wake the agent (iMessage text as fallback) once
 * per failure run so it can repair the cause.
 */
export const ESCALATE_AFTER_MS = Number(process.env.ROBOB_WATCH_ESCALATE_AFTER_MS ?? 15 * 60_000);

export function shouldEscalate(watcher: Watcher, state: State, t = now()): boolean {
  if (watcher.mode !== "wake" || !state.failing_since) return false;
  if (state.failure_escalated && !state.failure_escalation_pending
    && (!state.failure_escalation_notice || state.failure_escalation_notice_sent)) return false;
  if (state.failure_escalation_next_at && Date.parse(state.failure_escalation_next_at) > t) return false;
  if (state.dependency_busy) return t - Date.parse(state.dependency_busy.since) >= BUSY_ALERT_AFTER_MS;
  return !!state.failure_paused_at || t - Date.parse(state.failing_since) >= ESCALATE_AFTER_MS;
}

export function escalationText(watcher: Watcher, state: State, mins: number): string {
  if (state.dependency_busy) return [
    `Dependency ${state.dependency_busy.dependency} has been busy for ${mins} min for watcher ${watcher.id} ("${watcher.title}").`,
    "Don't edit the watcher. It retries its check; nothing is lost.",
    ...(state.dependency_busy.dependency === "msgs" ? [
      "Check ~/.local/share/message-archive/logs/daemon.log. Kickstart com.ardud.message-archive only if that log has been silent for more than 30 min.",
    ] : ["Check the dependency's health before changing anything."]),
    `Then robob-watch resume ${watcher.id} and robob-watch show ${watcher.id} to confirm.`,
  ].join("\n");
  return [
    `Watcher ${watcher.id} ("${watcher.title}") has been FAILING for ${mins} min (${state.consecutive_failures} runs); ${failureSummary(state)}.`,
    ...(state.failure_paused_at ? [watcher.failure_pause_probe === false || watcher.paused
      ? "It is paused and will not check again until resumed."
      : `It is paused and retries on its own next at ${dubaiClock(state.failure_probe_next_at ?? iso(Date.parse(state.failure_paused_at) + 15 * 60_000))} Dubai.`] : []),
    `Last error: ${(state.last_error ?? "").slice(0, 500)}`,
    "",
    "Diagnose and repair the cause now (e.g. \"wacli sync daemon is not running\" -> `wa start`, then `wa status`; see the robob-watchers skill's Troubleshooting).",
    `Then \`robob-watch resume ${watcher.id}\` to re-run it at once and \`robob-watch show ${watcher.id}\` to confirm. Only text the owner if you cannot fix it or something was missed; otherwise log it and end with NO_REPLY.`,
    "",
    "The watcher's own context (do not act on it now; it is for when it fires):",
    contextPreview(watcher),
  ].join("\n");
}

export function failureSources(error = ""): string[] {
  const object = error.match(/\{[\s\S]*\}/)?.[0];
  if (object) {
    try {
      const parsed: unknown = JSON.parse(object);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const entries = Object.entries(parsed);
        if (entries.length && entries.every(([source, value]) => source.trim() && typeof value === "string")) {
          return entries.slice(0, 16).map(([source]) => source.trim().slice(0, 64));
        }
      }
    } catch { /* Truncated or non-JSON stderr still gets a useful generic summary. */ }
  }
  return [];
}

function failureSummary(state: State): string {
  if (state.dependency_busy) return `dependency ${state.dependency_busy.dependency} is busy`;
  const sources = state.last_error_sources ?? failureSources(state.last_error);
  return sources.length ? `failing sources: ${sources.join(", ")}` : "its check is failing";
}

export function escalationFallbackText(watcher: Watcher, state: State, mins: number): string {
  return state.dependency_busy ? `Dependency ${state.dependency_busy.dependency} has been busy for ${mins} min; watcher "${watcher.title}" keeps retrying; nothing is lost.`
    : `Watcher "${watcher.title}" has been failing for ${mins} min; ${failureSummary(state)}. Last error: ${(state.last_error ?? "").slice(0, 300)}`;
}

export async function escalate(watcher: Watcher, state: State, key: string, imessageFallback = true): Promise<Delivery> {
  const started = now();
  const instance = watcherInstance(watcher.id), since = state.failing_since, episode = state.failure_episode;
  const sameEpisode = (fresh: State) => !!loadWatcher(watcher.id) && watcherInstance(watcher.id) === instance
    && fresh.failing_since === since && fresh.failure_episode === episode;
  // Claim the retry window and freeze both bodies before any transport can accept them.
  const prepared = await withRelayLockAsync(() => {
    const fresh = loadState(watcher.id);
    if (!sameEpisode(fresh) || !shouldEscalate(watcher, fresh)) return;
    const mins = Math.round((Date.parse(fresh.failure_paused_at ?? iso()) - Date.parse(fresh.dependency_busy?.since ?? fresh.failing_since!)) / 60_000);
    fresh.failure_pause_escalation ??= escalationText(watcher, fresh, mins);
    fresh.failure_pause_escalation_fallback ??= escalationFallbackText(watcher, fresh, mins);
    // Missing key means an episode from before this release: retain its legacy wake identity.
    fresh.failure_escalation_key ??= key;
    fresh.failure_escalation_source ??= `robob-watch ${watcher.id} ${fresh.dependency_busy ? "dependency busy" : "failing"}`;
    const attempt = (fresh.failure_escalation_attempts ?? 0) + 1;
    fresh.failure_escalation_attempts = attempt;
    fresh.failure_escalation_next_at = iso(now() + ([1, 2, 5, 15, 30][attempt - 1] ?? 60) * 60_000);
    saveState(watcher.id, fresh);
    return fresh;
  });
  if (!prepared) return { ok: false, via: "deferred", detail: "escalation no longer due" };
  state = prepared;
  const wakeKey = state.failure_escalation_key!, sendKey = `${key}:imsg`;
  const update = (change: (fresh: State) => void) => withRelayLockAsync(() => {
    const fresh = loadState(watcher.id);
    if (!sameEpisode(fresh) || fresh.failure_escalation_key !== wakeKey
      || fresh.failure_escalation_attempts !== prepared.failure_escalation_attempts) return;
    change(fresh); saveState(watcher.id, fresh); return fresh;
  });
  let delivery: Delivery | undefined;
  let httpStatus: number | undefined;
  let reason: "dedupe_conflict_changed_content" | undefined;
  const conflictReason = (out: string) => {
    try {
      const value: unknown = JSON.parse(out);
      return jsonObject(value) && value.reason === "dedupe_conflict_changed_content" ? value.reason : undefined;
    } catch { return; }
  };
  let exists = false;
  let needsNotice = !!state.failure_escalation_notice;
  const noticeText = (fresh: State) => `Watcher "${watcher.title}" is ${fresh.failure_paused_at ? "paused" : "failing"}; the agent could not be woken. Last error: ${(fresh.last_error ?? "unknown").slice(0, 500)}. Log: ${join(watcherDir(watcher.id), "log")}`;
  // Persist acceptance before probing: a restart must only read receipts, never repost the key.
  const markAccepted = (pending: NonNullable<State["failure_escalation_pending"]>) => update(fresh => {
    fresh.failure_escalated = true;
    fresh.failure_escalation_pending = pending;
    if (exists) fresh.failure_escalation_notice ??= noticeText(fresh);
  });
  const attempt = async (send: () => Promise<{ ok: boolean; out: string; httpStatus?: number }>) => {
    try { return await send(); }
    catch (error) { return { ok: false, out: error instanceof Error ? error.message : "bridge helper failed", httpStatus: undefined }; }
  };
  let pending = state.failure_escalation_pending;
  let acceptedResponse: string | undefined;
  try {
    if (state.failure_escalated) delivery = { ok: true, via: pending?.channel === "imessage" ? "imessage-existing" : "wake-existing", detail: "accepted key; reconciling delivery" };
    else {
      const woke = await attempt(() => wake(state.failure_escalation_source!, state.failure_pause_escalation!, wakeKey, watcher.id));
      httpStatus = woke.httpStatus;
      if (woke.ok || httpStatus === 409) {
        exists = httpStatus === 409;
        if (exists) reason = conflictReason(woke.out);
        pending = { channel: "wake", key: wakeKey };
        delivery = { ok: true, via: exists ? "wake-existing" : "wake", detail: woke.out };
        if (!await markAccepted(pending)) return { ok: true, via: "wake-existing", detail: "episode ended during send" };
        if (exists) log(watcher.id, "failure escalation key already accepted (409); not resending");
        acceptedResponse = woke.ok ? woke.out : undefined;
      } else if (!imessageFallback) delivery = { ok: false, via: "none", detail: woke.out };
      else {
        // A legacy /send may already have accepted a different body under the old key.
        // Reconcile it before using the new channel key; never duplicate it during migration.
        if (wakeKey === key) {
          const prior = await attempt(() => run(["/usr/bin/sqlite3", "-readonly", BRIDGE_DB,
            `select exists(select 1 from kv where key='api:send:send:${hash(key)}')`], 10_000, undefined, { watcher: watcher.id }));
          if (!prior.ok || prior.out.trim() !== "0") {
            pending = { channel: "imessage", key };
            exists = true;
          }
        }
        if (!pending) {
          const sent = await attempt(() => imessage(state.failure_pause_escalation_fallback!, sendKey, { watcher: watcher.id }));
          if (sent.ok || bridgeHttpStatus(sent) === 409) {
            exists = bridgeHttpStatus(sent) === 409;
            if (exists) { httpStatus = 409; reason = conflictReason(sent.out); }
            pending = { channel: "imessage", key: sendKey };
            delivery = { ok: true, via: exists ? "imessage-existing" : "imessage-send", detail: sent.out };
          } else delivery = { ok: false, via: "none", detail: `${woke.out} | ${sent.out}` };
        } else delivery = { ok: true, via: "imessage-existing", detail: "legacy send acceptance" };
        if (pending && !await markAccepted(pending)) return { ok: true, via: "imessage-existing", detail: "episode ended during send" };
      }
    }
    let confirmed = false;
    let failed = false;
    if (pending) {
      if (pending.channel === "wake") {
        const pendingKey = pending.key;
        const receipt = await attempt(() => run([BUN, spectrumCli(), "wake-status", `--key=${pendingKey}`], undefined, 5_000, { watcher: watcher.id }));
        const readStatus = (out: string | undefined) => {
          try {
            const value: unknown = JSON.parse(out ?? "");
            return jsonObject(value) && value.id === wakeInboundId(pendingKey) && typeof value.state === "string" ? value.state : undefined;
          } catch { return; }
        };
        const status = (receipt.ok ? readStatus(receipt.out) : undefined) ?? readStatus(acceptedResponse);
        confirmed = status === "admitted";
        failed = status === "failed";
        delivery!.detail = `accepted wake delivery ${status ?? "unproven"}`;
      } else {
        const receipt = await imessageReceipt(state.failure_pause_escalation_fallback!, pending.key, watcher.id).catch(() => undefined);
        confirmed = receipt?.ok === true;
        failed = !!receipt && !receipt.ok && !receipt.pending;
        delivery!.detail = receipt?.out ?? "accepted send delivery unproven";
      }
      needsNotice = !confirmed && (needsNotice || exists || failed || state.failure_escalation_attempts! >= 3);
    } else needsNotice ||= !delivery!.ok && state.failure_escalation_attempts! >= 3;
    const saved = await update(fresh => {
      fresh.failure_escalated = delivery!.ok;
      if (confirmed) delete fresh.failure_escalation_pending;
      if (needsNotice) fresh.failure_escalation_notice ??= noticeText(fresh);
      else if (!fresh.failure_escalation_notice_sent) delete fresh.failure_escalation_notice;
    });
    if (saved?.failure_escalation_notice && !saved.failure_escalation_notice_sent) {
      const sent = await attempt(() => telegram(`Watcher ${watcher.id}`, saved.failure_escalation_notice!,
        `robob-watch:${watcher.id}:escalate-undelivered:${hash(episode ?? since ?? "").slice(0, 32)}`, "attention", undefined, watcher.id));
      await update(fresh => { fresh.failure_escalation_notice_sent = sent.ok; });
      toolLog({ component: "wakes", kind: "error", name: "failure_escalation.undelivered", ok: sent.ok,
        ids: { watcher: watcher.id, key: wakeInboundId(wakeKey) },
        props: { attempt: saved.failure_escalation_attempts, httpStatus, reason, failureClass: exists ? "other" : /timed out|timeout/i.test(delivery.detail) ? "timeout" : "other" },
        error: { tag: "wake.delivery_failed" } });
    }
    return delivery;
  } finally {
    log(watcher.id, `failure escalation ok=${delivery?.ok ?? false} via=${delivery?.via ?? "none"} attempt=${state.failure_escalation_attempts} next retry=${state.failure_escalation_next_at}${delivery?.ok ? "" : ` ${delivery?.detail ?? "helper failed"}`}`);
    toolLog({ component: "wakes", kind: httpStatus === 409 ? "event" : delivery?.ok ? "perf" : "error", name: "wake.sent", durationMs: Math.max(0, now() - started), ok: delivery?.ok ?? false,
      ids: { watcher: watcher.id, chat: "owner", key: wakeInboundId(wakeKey) }, props: { httpStatus, reason, attempt: state.failure_escalation_attempts }, ...(delivery?.ok ? {} : { error: { tag: "wake.delivery_failed" } }) });
  }
}

export function ensureDirs(): void {
  for (const dir of [ROOT, WATCHERS, ARCHIVE]) mkdirSync(dir, { recursive: true, mode: 0o700 });
}
