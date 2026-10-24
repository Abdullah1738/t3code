import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = homedir();
export const ROOT = process.env.ROBOB_WATCH_ROOT ?? join(HOME, ".local/share/robob-watch");
export const WATCHERS = join(ROOT, "watchers");
export const ARCHIVE = join(ROOT, "archive");
export const HELPERS = join(ROOT, "helpers");
export const WA_LOCK = join(ROOT, "wa.lock");
/** wacli's store (kept live by `wacli sync --follow`); its WAL grows/changes whenever a message is stored. */
export const WACLI_STORE = process.env.WACLI_STORE_DIR ?? join(homedir(), ".wacli");
export const WA_TRIGGERS = [join(WACLI_STORE, "wacli.db-wal"), join(WACLI_STORE, "wacli.db")];
export const BUN = join(HOME, ".bun/bin/bun");
export const SPECTRUM_CLI = process.env.ROBOB_WATCH_SPECTRUM_CLI ?? join(HOME, ".local/share/spectrum-bridge/src/cli.ts");
export const TELEGRAM_CLI = process.env.ROBOB_WATCH_TELEGRAM_CLI ?? join(HOME, ".local/share/telegram-bridge/src/cli.ts");
export const BRIDGE_DB = process.env.ROBOB_WATCH_BRIDGE_DB ?? join(HOME, ".config/spectrum-bridge/state.sqlite");
export const PATH = [HELPERS, join(HOME, ".local/bin"), join(HOME, ".bun/bin"), "/opt/homebrew/bin", "/usr/local/bin",
  "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");

export const MIN_INTERVAL = 5;
export const DEFAULT_INTERVAL = 15;
export const CHECK_TIMEOUT_MS = Number(process.env.ROBOB_WATCH_CHECK_TIMEOUT_MS ?? 60_000);
/** After SIGKILL, stop waiting for the process to report exit (a throttled process can take minutes to be reaped). */
export const KILL_GRACE_MS = 5_000;
export const FAILURE_ALERT_AFTER = 5;
/** Timeouts are transient (load spikes): no alert until the watcher has been failing at least this long. */
export const TIMEOUT_ALERT_AFTER_MS = 10 * 60_000;
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
  interval_s: number;
  mode: Mode;
  context: string;
  expires_at: string | null;
  /** 0 means unlimited. */
  max_fires: number;
  /** Serialize with every other serial check and all wa usage (the WhatsApp TUI cannot be driven concurrently). */
  serial: boolean;
  paused: boolean;
  /** Opt-in: text the owner a short heads-up when a wake sits queued behind a busy turn. Off by default. */
  headsup?: boolean;
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
  created_at: string;
  created_by_session: string | null;
};
export type State = {
  status: "active" | "done" | "expired";
  fires: number;
  last_run_at?: string;
  last_fire_at?: string;
  next_at?: number;
  consecutive_failures: number;
  failure_alerted: boolean;
  last_error?: string;
  /** When the current run of consecutive failures started. */
  failing_since?: string;
  /** The agent was woken about the current run of failures (see shouldEscalate). */
  failure_escalated?: boolean;
  /** Wall time of the last check run, in ms. */
  last_run_ms?: number;
  /** An event whose delivery has not succeeded yet; retried verbatim with the same key. */
  pending?: { key: string; event: string; at: string };
  last_delivery?: string;
  /** Delivered wakes whose bridge inbound row may still be queued behind a busy agent turn. */
  wakes?: TrackedWake[];
  /** Trigger-file signature seen at the start of the last run. */
  trigger_sig?: string;
};
export type TrackedWake = { inbound: string; key: string; event: string; delivered_at: number; attempts?: number };

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
  try { new Intl.DateTimeFormat("en-GB", { timeZone: time_zone }); return true; } catch { return false; }
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
  } catch { return undefined; }
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

/** Cheap change signature of a watcher's trigger files (a stat per file). */
export function triggerSig(watcher: Watcher): string | undefined {
  if (!watcher.triggers?.length) return undefined;
  return watcher.triggers.map(path => {
    try { const st = statSync(path); return `${st.mtimeMs}:${st.size}`; } catch { return "missing"; }
  }).join("|");
}

export function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
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
  const interval = input.interval_s === undefined ? DEFAULT_INTERVAL : Number(input.interval_s);
  if (!Number.isInteger(interval) || interval < MIN_INTERVAL) errors.push(`interval_s must be an integer >= ${MIN_INTERVAL}`);
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
  const quiet = input.quiet;
  if (quiet !== undefined && !validQuiet(quiet)) errors.push("quiet must be {start, end, time_zone}: different whole hours 0-23 and an IANA time zone");
  const trip = input.trip;
  if (trip !== undefined && !validId(trip)) errors.push("trip must be a tag like an id (a-z, 0-9, -)");
  const relays = input.relays;
  if (relays !== undefined && !validRelays(relays)) {
    errors.push("relays must be up to 8 distinct {to, name, quote, at}: to a phone number or phone/group jid (not an @lid), quote the owner's own words allowing it, at the ISO time he said it (not in the future)");
  }
  // 23 Oct: an ETA watcher's standing OK in its context let it text a group 5-7 times; who may hear from a fire is now a field.
  if (relays === undefined && /\bwa\s+(draft|send|sendfile)\b/.test(`${input.check ?? ""}\n${input.context ?? ""}`)) {
    errors.push("this watcher may send WhatsApp messages: list who it may message in relays (with the owner's words allowing each), or pass --owner-only (relays: []) so it tells only the owner");
  }
  if (errors.length) throw new Error(errors.join("; "));
  return {
    id: input.id!, title: input.title!.trim(), check: input.check!, interval_s: interval, mode: mode as Mode,
    context: String(input.context ?? "").trim(), expires_at: expires === null ? null : new Date(expires).toISOString(),
    // Only checks that drive the old whatscli TUI need the shared lock; whatsapp-new-message reads a DB now.
    max_fires: maxFires, serial: input.serial === true || /(^|[\s;|&(`$])wa\s+(tui|screen)\b/.test(input.check!),
    paused: input.paused === true,
    ...(triggers.length ? { triggers: (triggers as string[]).map(t => t.trim().replace(/^~(?=\/)/, HOME)) } : {}),
    ...(input.headsup === true ? { headsup: true } : {}),
    ...(Number.isFinite(Number(input.trigger_gap_s)) && Number(input.trigger_gap_s) > 0 ? { trigger_gap_s: Number(input.trigger_gap_s) } : {}),
    ...(quiet !== undefined ? { quiet: { start: quiet.start, end: quiet.end, time_zone: quiet.time_zone } } : {}),
    ...(trip !== undefined ? { trip } : {}),
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
  return readdirSync(WATCHERS).filter(name => validId(name) && existsSync(join(WATCHERS, name, "watcher.json"))).sort();
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
  } catch { /* A missing dir (removed mid-run) is fine. */ }
}

export const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max - 20)}\n...[truncated]`;

export type CheckResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; ms: number };

/**
 * Runs a check in its own process group so a timeout kills everything it started. The result never waits more
 * than KILL_GRACE_MS past the timeout: a SIGKILLed process that the scheduler has not reaped yet must not keep
 * its watcher blocked (3 Oct 2026: killed checks lingered 9+ minutes and their watchers never re-ran).
 */
export function runCheck(watcher: Watcher, dir: string, extraEnv: Record<string, string> = {}, timeoutMs = CHECK_TIMEOUT_MS): Promise<CheckResult> {
  const shell = watcher.serial ? ["/usr/bin/lockf", "-k", "-t", "120", WA_LOCK, "/bin/zsh", "-c", watcher.check] : ["/bin/zsh", "-c", watcher.check];
  const started = now();
  return new Promise(resolve => {
    let done = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null, extra = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve({ code, stdout, stderr: stderr + extra, timedOut, ms: now() - started });
    };
    const child = spawn(shell[0]!, shell.slice(1), {
      cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { HOME, PATH, LANG: "en_US.UTF-8", WATCH_DIR: dir, WATCH_ID: watcher.id, ...(watcher.serial ? { WA_LOCKED: "1" } : {}), ...extraEnv },
    });
    child.stdout!.on("data", chunk => { if (stdout.length < 200_000) stdout += chunk; });
    child.stderr!.on("data", chunk => { if (stderr.length < 20_000) stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
      grace = setTimeout(() => {
        try { child.stdout!.destroy(); child.stderr!.destroy(); child.unref(); } catch { /* ignore */ }
        finish(null, `\n[robob-watch] process group ${child.pid} not reaped ${KILL_GRACE_MS / 1000}s after SIGKILL`);
      }, KILL_GRACE_MS);
    }, timeoutMs);
    child.on("close", code => finish(code));
    child.on("error", error => finish(127, String(error)));
  });
}

async function run(args: string[], timeoutMs = 20_000): Promise<{ ok: boolean; out: string }> {
  const child = Bun.spawn(args, { env: { HOME, PATH }, stdout: "pipe", stderr: "pipe", timeout: timeoutMs, killSignal: "SIGKILL" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { ok: code === 0, out: `${stdout}${stderr}`.trim().slice(0, 500) };
}

/** Async on purpose: a blocking spawnSync here would freeze every watcher's timers for up to 10s. */
export async function liveSession(): Promise<string | undefined> {
  const result = await run(["/usr/bin/sqlite3", "-readonly", BRIDGE_DB, "select json_extract(value,'$.id') from kv where key='route'"], 10_000);
  const id = result.out.trim();
  // Robob routes are thread ids ("ardud-control:thread:<uuid>"); older OpenCode routes were "ses_...".
  return result.ok && id && /^[A-Za-z0-9_][A-Za-z0-9_:.-]{0,199}$/.test(id) ? id : undefined;
}

/** The bridge names a wake's inbound row after the sha256 of its dedupe key (api.ts /wake). */
export const wakeInboundId = (key: string) => `wake:${hash(key)}`;

/**
 * State of a bridge inbound row: "pending" means still queued (the agent has not started on it);
 * processing/batched/done/cancelled/failed/unknown all mean the router has taken it. "missing" if absent,
 * undefined if the database could not be read.
 */
export async function inboundState(id: string): Promise<string | undefined> {
  if (!/^wake:[a-f0-9]{64}$/.test(id)) return undefined;
  const result = await run(["/usr/bin/sqlite3", "-readonly", BRIDGE_DB, `select state from inbound where id='${id}'`], 10_000);
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

export function wake(source: string, text: string, key: string): Promise<{ ok: boolean; out: string }> {
  return run([BUN, SPECTRUM_CLI, "wake", "--source", source.slice(0, 100), "--text", clip(text, MAX_WAKE), "--key", key]);
}

export async function imessage(text: string, key: string): Promise<{ ok: boolean; out: string }> {
  const session = await liveSession();
  if (!session) return { ok: false, out: "no live route session" };
  return run([BUN, SPECTRUM_CLI, "send", "--text", clip(text, MAX_WAKE), "--session", session, "--key", key]);
}

export function telegram(source: string, text: string, key: string, severity = "info"): Promise<{ ok: boolean; out: string }> {
  return run([BUN, TELEGRAM_CLI, "notify", "--source", telegramSource(source), "--severity", severity, "--text", clip(text, MAX_WAKE), "--key", key]);
}

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
export function withRelayLock<T>(fn: () => T): T {
  mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const db = new Database(join(ROOT, "relay-lock.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout = 15000");
    db.exec("BEGIN IMMEDIATE");
    try { return fn(); } finally { db.exec("COMMIT"); }
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

export function wakeText(watcher: Watcher, event: string, state: State, test = false): string {
  const fires = watcher.max_fires === 0 ? `fire ${state.fires + 1}, unlimited` : `fire ${state.fires + 1} of ${watcher.max_fires}`;
  const after = watcher.max_fires !== 0 && state.fires + 1 >= watcher.max_fires
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
    "Context saved when this watcher was set up (written by the agent that set it up; the owner's instructions for this event):",
    watcher.context || "(none)",
    "",
    `Watcher ${watcher.id} (${fires}). ${after}`,
  ].join("\n");
}

export type Delivery = { ok: boolean; via: string; detail: string };

/** Delivers one event; each channel is idempotent under the same key. */
export async function deliver(watcher: Watcher, event: string, key: string, state: State, test = false): Promise<Delivery> {
  const tried: string[] = [];
  const plain = `${test ? "[Watcher test] " : ""}${watcher.title}\n${clip(event.trim(), MAX_EVENT)}`;
  if (watcher.mode === "wake") {
    const result = await wake(`robob-watch ${watcher.id}`, wakeText(watcher, event, state, test), key);
    if (result.ok) return { ok: true, via: "wake", detail: result.out };
    tried.push(`wake: ${result.out}`);
  }
  const sent = await imessage(plain, key);
  if (sent.ok) return { ok: true, via: "imessage-send", detail: [...tried, sent.out].join(" | ") };
  tried.push(`send: ${sent.out}`);
  const notified = await telegram(`Watcher ${watcher.id}`, plain, key);
  if (notified.ok) return { ok: true, via: "telegram", detail: [...tried, notified.out].join(" | ") };
  tried.push(`telegram: ${notified.out}`);
  return { ok: false, via: "none", detail: tried.join(" | ") };
}

/** Housekeeping notices (failures, expiry) go to the alert channel first, iMessage second. */
export async function alert(watcher: Watcher, text: string, key: string, severity = "attention"): Promise<Delivery> {
  const notified = await telegram(`Watcher ${watcher.id}`, text, key, severity);
  if (notified.ok) return { ok: true, via: "telegram", detail: notified.out };
  const sent = await imessage(`${watcher.title}: ${text}`, key);
  return sent.ok ? { ok: true, via: "imessage-send", detail: sent.out } : { ok: false, via: "none", detail: `${notified.out} | ${sent.out}` };
}

/**
 * A real error alerts after FAILURE_ALERT_AFTER failures in a row. Timeouts are transient (a stalled CLI or a
 * load spike), so a run of them alerts only once it has also lasted TIMEOUT_ALERT_AFTER_MS.
 */
export function shouldAlert(state: State, timedOut: boolean, t = now()): boolean {
  if (state.failure_alerted || state.consecutive_failures < FAILURE_ALERT_AFTER) return false;
  if (!timedOut) return true;
  return t - Date.parse(state.failing_since ?? iso(t)) >= TIMEOUT_ALERT_AFTER_MS;
}

/**
 * A wake watcher that keeps failing is blind, and a Telegram alert alone went unanswered for 2.5h (4 Oct 2026,
 * wacli daemon booted out). After ESCALATE_AFTER_MS of failing, wake the agent (iMessage text as fallback) once
 * per failure run so it can repair the cause.
 */
export const ESCALATE_AFTER_MS = Number(process.env.ROBOB_WATCH_ESCALATE_AFTER_MS ?? 15 * 60_000);

export function shouldEscalate(watcher: Watcher, state: State, t = now()): boolean {
  if (watcher.mode !== "wake" || state.failure_escalated || !state.failing_since) return false;
  return t - Date.parse(state.failing_since) >= ESCALATE_AFTER_MS;
}

export function escalationText(watcher: Watcher, state: State, mins: number): string {
  return [
    `Watcher ${watcher.id} ("${watcher.title}") has been FAILING for ${mins} min (${state.consecutive_failures} runs) and is blind until fixed.`,
    `Last error: ${(state.last_error ?? "").slice(0, 500)}`,
    "",
    "Diagnose and repair the cause now (e.g. \"wacli sync daemon is not running\" -> `wa start`, then `wa status`; see the robob-watchers skill's Troubleshooting).",
    `Then \`robob-watch resume ${watcher.id}\` to re-run it at once and \`robob-watch show ${watcher.id}\` to confirm. Only text the owner if you cannot fix it or something was missed; otherwise log it and end with NO_REPLY.`,
    "",
    "The watcher's own context (do not act on it now; it is for when it fires):",
    clip(watcher.context || "(none)", 1_500),
  ].join("\n");
}

export async function escalate(watcher: Watcher, state: State, key: string): Promise<Delivery> {
  const mins = Math.round((now() - Date.parse(state.failing_since!)) / 60_000);
  const text = escalationText(watcher, state, mins);
  const woke = await wake(`robob-watch ${watcher.id} failing`, text, key);
  if (woke.ok) return { ok: true, via: "wake", detail: woke.out };
  const sent = await imessage(`Watcher "${watcher.title}" has been failing for ${mins} min: ${(state.last_error ?? "").slice(0, 300)}`, key);
  return sent.ok ? { ok: true, via: "imessage-send", detail: sent.out } : { ok: false, via: "none", detail: `${woke.out} | ${sent.out}` };
}

export function ensureDirs(): void {
  for (const dir of [ROOT, WATCHERS, ARCHIVE]) mkdirSync(dir, { recursive: true, mode: 0o700 });
}
