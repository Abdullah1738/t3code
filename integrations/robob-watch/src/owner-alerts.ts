import { randomUUID } from "node:crypto";
import { imessage, iso, loadState, loadWatcher, now, saveState, watcherInstance, withRelayLock, type State, type Watcher } from "./lib.ts";
import { toolError, toolLog } from "./toollog.ts";

export type OwnerAlertEpisode = {
  key: string;
  since: string;
  paused_at?: string;
  kind: "pause" | "failing";
  text: string;
  sent?: boolean;
  recovery?: string;
  retry_at?: number;
};

const enabled = (watcher: Watcher) => watcher.owner_imessage_alerts === true && !watcher.chat;
export const ownerFailureAlerts = (watcher: Watcher, state: State) => enabled(watcher) && !state.dependency_busy;
const clock = (at: string) => new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Dubai",
}).format(Date.parse(at));

export function queueOwnerFailure(watcher: Watcher, state: State, kind: "pause" | "failing"): boolean {
  if (!ownerFailureAlerts(watcher, state)) return false;
  const episodes = state.owner_imessage_episodes ??= [];
  const open = episodes.find(episode => !episode.recovery);
  if (open) {
    const changed = !open.paused_at && !!state.failure_paused_at;
    open.paused_at ??= state.failure_paused_at;
    return changed;
  }
  const since = state.failing_since ?? iso();
  const error = (state.last_error ?? "unknown error").split(/\r?\n/, 1)[0]!.slice(0, 300);
  episodes.push({ key: `robob-watch:${watcher.id}:owner-alert:${randomUUID()}`, since,
    ...(state.failure_paused_at ? { paused_at: state.failure_paused_at } : {}), kind,
    text: `${watcher.title} ${kind === "pause" ? `is paused after ${state.consecutive_failures} failed runs` : "is FAILING"} (since ${clock(since)} Dubai): ${error}. Screening is interrupted. Resume: robob-watch resume ${watcher.id}`,
  });
  return true;
}

export function queueOwnerRecovery(watcher: Watcher, state: State): void {
  if (!enabled(watcher)) return;
  for (const episode of state.owner_imessage_episodes ?? []) {
    if (episode.recovery) continue;
    const minutes = Math.max(0, Math.floor((now() - Date.parse(episode.paused_at ?? episode.since)) / 60_000));
    const duration = minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60}m` : `${minutes}m`;
    episode.recovery = `${watcher.title} is running again (${episode.paused_at ? "paused" : "interrupted"} ${duration}). Missed messages: checking.`;
    delete episode.retry_at;
  }
}

const sending = new Map<string, Promise<void>>();
const completed = new Map<string, { instance?: string; key: string; kind: "pause" | "failing" | "recovered" }>();

// Apply between checks: an async send must never race a check's state.json snapshot.
export function applyOwnerAlertResults(id: string): void {
  const result = completed.get(id);
  if (!result) return;
  withRelayLock(() => {
    if (!loadWatcher(id) || watcherInstance(id) !== result.instance) return;
    const state = loadState(id);
    const episode = state.owner_imessage_episodes?.find(episode => episode.key === result.key);
    if (!episode) return;
    if (result.kind === "recovered") {
      state.owner_imessage_episodes = state.owner_imessage_episodes!.filter(entry => entry.key !== result.key);
      if (!state.owner_imessage_episodes.length) delete state.owner_imessage_episodes;
    } else {
      episode.sent = true;
      delete episode.retry_at;
    }
    saveState(id, state);
  });
  completed.delete(id);
}

async function flush(id: string): Promise<void> {
  const instance = watcherInstance(id);
  const pending = withRelayLock(() => {
    const watcher = loadWatcher(id);
    if (!watcher || !enabled(watcher) || watcherInstance(id) !== instance) return;
    const state = loadState(id);
    const episode = state.owner_imessage_episodes?.[0];
    if (!episode || (episode.retry_at ?? 0) > now() || (episode.sent && !episode.recovery)) return;
    // Persist a retry delay before I/O. A crash retries the identical bridge key and payload.
    episode.retry_at = now() + 60_000;
    saveState(id, state);
    return { key: episode.key, kind: episode.sent ? "recovered" as const : episode.kind,
      text: episode.sent ? episode.recovery! : episode.text };
  });
  if (!pending) return;
  const started = performance.now();
  let ok = false;
  try { ok = (await imessage(pending.text, `${pending.key}:${pending.kind}`, { reconcile: true })).ok; }
  catch { /* The persisted entry retries; bridge keys reconcile ambiguous acceptance. */ }
  toolLog({ component: "runner", kind: ok ? "event" : "error", name: `alert.imessage.${ok ? "sent" : "failed"}`,
    ok, durationMs: Math.max(0, performance.now() - started), ids: { watcher: id }, props: { alertKind: pending.kind },
    ...(ok ? {} : { error: { tag: "alert.imessage.send_failed" } }),
  });
  // A restart before this result is persisted replays the same key at the bridge.
  if (ok) completed.set(id, { instance, key: pending.key, kind: pending.kind });
  return;
}

/** Separate from checks and Telegram: the receipt/route lookups and send have 10s/10s/20s deadlines. */
export function dispatchOwnerAlerts(id: string): void {
  if (sending.has(id) || completed.has(id)) return;
  const job = flush(id).catch(() => toolError("runner", "alert.imessage.dispatch_failed", { watcher: id }))
    .finally(() => { sending.delete(id); });
  sending.set(id, job);
}

export async function drainOwnerAlerts(): Promise<void> {
  await Promise.all(sending.values());
}
