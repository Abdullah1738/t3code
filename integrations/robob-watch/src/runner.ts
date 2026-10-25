import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  alert, CHECK_TIMEOUT_MS, deliver, ensureDirs, escalate, hash, heldCheck, shouldEscalate, HEADSUP_GIVE_UP_MS, HEADSUP_MS, headsUpText, imessage,
  inboundState, inQuiet, iso, listIds, loadState, loadWatcher, log, now, ROOT, RUN_OK_FILE, runCheck, saveState, type State, telegram, type TrackedWake,
  triggerSig, type Watcher, wakeInboundId, watcherDir, shouldAlert, SLOW_RUN_MS, TIMEOUT_BACKOFF_CAP_S,
} from "./lib.ts";

// A 1s tick costs a few stats and JSON reads per watcher; it lets trigger files and short intervals act fast.
const TICK_MS = 1_000;
/** By default a trigger-file change never runs the same check more often than this (watcher.trigger_gap_s overrides). */
const TRIGGER_MIN_GAP_MS = 2_000;
/** At most this many checks run at once; a burst (runner restart, many intervals lining up) queues instead. */
const MAX_CONCURRENT_CHECKS = Number(process.env.ROBOB_WATCH_MAX_CONCURRENT ?? 6);
const running = new Set<string>();
let activeChecks = 0;
const slotWaiters: (() => void)[] = [];

/** Queue time never counts against a check's timeout: the timer starts only once a slot is free. */
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeChecks >= MAX_CONCURRENT_CHECKS) await new Promise<void>(resolve => slotWaiters.push(resolve));
  else activeChecks += 1;
  try { return await fn(); } finally {
    const next = slotWaiters.shift();
    if (next) next(); else activeChecks -= 1;
  }
}

function backoff(state: State, interval: number, timedOut: boolean): number {
  // 1x, 2x, 4x ... the interval, capped at 30 minutes. A timeout is usually a load spike, so it retries
  // at least every TIMEOUT_BACKOFF_CAP_S and the watcher catches up soon after the spike passes.
  const factor = 2 ** Math.min(Math.max(state.consecutive_failures - 1, 0), 8);
  return Math.min(interval * factor, timedOut ? Math.max(interval, TIMEOUT_BACKOFF_CAP_S) : 1_800) * 1_000;
}


function finish(watcher: Watcher, state: State, status: State["status"]): void {
  state.status = status;
  saveState(watcher.id, state);
  log(watcher.id, `status -> ${status}`);
}

/** Returns true once the event is delivered (or had been already). */
async function deliverPending(watcher: Watcher, state: State): Promise<boolean> {
  // A held event keeps its key and is retried each minute, so it goes out once the quiet hours end.
  if (inQuiet(watcher.quiet)) return false;
  const pending = state.pending!;
  const delivery = await deliver(watcher, pending.event, pending.key, state);
  log(watcher.id, `deliver key=${pending.key} ok=${delivery.ok} via=${delivery.via} ${delivery.detail}`);
  if (!delivery.ok) return false;
  state.fires += 1;
  state.last_fire_at = iso();
  state.last_delivery = delivery.via;
  if (delivery.via === "wake") {
    state.wakes = [...(state.wakes ?? []), { inbound: wakeInboundId(pending.key), key: pending.key, event: pending.event, delivered_at: now() }];
  }
  delete state.pending;
  if (watcher.max_fires !== 0 && state.fires >= watcher.max_fires) finish(watcher, state, "done");
  else saveState(watcher.id, state);
  return true;
}

/**
 * A delivered wake queues behind whatever turn the agent is on. If it is still unconsumed after HEADSUP_MS,
 * the owner gets one short plain text so a long turn does not hide the event. Runs even for done/paused
 * watchers, because a single-fire watcher is already done by the time its wake is waiting.
 */
async function headsUps(watcher: Watcher, state: State): Promise<void> {
  if (!state.wakes?.length) return;
  // Heads-ups leak raw watcher text to the owner; only watchers that opt in get them.
  if (watcher.headsup !== true) { delete state.wakes; const fresh = loadState(watcher.id); delete fresh.wakes; saveState(watcher.id, fresh); return; }
  const keep: TrackedWake[] = [];
  for (const wake of state.wakes) {
    const age = now() - wake.delivered_at;
    const row = await inboundState(wake.inbound);
    // A just-delivered wake's row can briefly read as missing; only trust "missing" after a short grace.
    if (row === "missing" && age < 15_000) { keep.push(wake); continue; }
    if (row !== undefined && row !== "pending") {
      log(watcher.id, `wake ${wake.inbound.slice(0, 17)} consumed (${row}) after ${Math.round(age / 1000)}s; no heads-up`);
      continue;
    }
    if (age >= HEADSUP_GIVE_UP_MS) {
      log(watcher.id, `wake ${wake.inbound.slice(0, 17)} tracking dropped after ${Math.round(age / 60_000)}m (row ${row ?? "unreadable"})`);
      continue;
    }
    if (row === undefined || age < HEADSUP_MS) { keep.push(wake); continue; }
    const key = `robob-watch:${watcher.id}:headsup:${hash(wake.key).slice(0, 32)}`;
    const text = headsUpText(watcher, wake.event);
    let via = "none";
    const sent = await imessage(text, key);
    if (sent.ok) via = "imessage-send";
    else {
      const notified = await telegram(`Watcher ${watcher.id}`, text, key);
      if (notified.ok) via = "telegram";
      else log(watcher.id, `heads-up failed send: ${sent.out} | telegram: ${notified.out}`);
    }
    log(watcher.id, `heads-up for wake ${wake.inbound.slice(0, 17)} still queued after ${Math.round(age / 1000)}s ok=${via !== "none"} via=${via}`);
    const attempts = (wake.attempts ?? 0) + 1;
    // Once sent it is never tracked again; a failed send retries a few ticks, same key, then gives up.
    if (via === "none" && attempts < 5) keep.push({ ...wake, attempts });
  }
  const fresh = loadState(watcher.id);
  const seen = new Set(state.wakes.map(wake => wake.inbound));
  // Keep entries added since this pass loaded state; replace the ones it handled.
  fresh.wakes = [...(fresh.wakes ?? []).filter(wake => !seen.has(wake.inbound)), ...keep];
  if (!fresh.wakes.length) delete fresh.wakes;
  saveState(watcher.id, fresh);
  Object.assign(state, fresh);
  if (!fresh.wakes) delete state.wakes;
}

async function tickOne(id: string): Promise<void> {
  const watcher = loadWatcher(id);
  if (!watcher) return;
  const state = loadState(id);
  await headsUps(watcher, state);
  if (state.status !== "active" || watcher.paused) return;
  if (heldCheck(watcher)) {
    if (!state.held_alerted) {
      log(id, "held: its check runs wa draft/send and it may message nobody; the check doesn't run until it is added again with a check that doesn't draft or send");
      const sent = await alert(watcher, `Watcher "${watcher.title}" is from before watchers had to name who they may message, and its check drafts or sends WhatsApp. It is held and its check doesn't run. To keep it, have it added again with a check that only spots the change (it then tells only you), or with relays for the people you allow.`,
        `robob-watch:${id}:held`, "attention");
      log(id, `held notice ok=${sent.ok} via=${sent.via}`);
      if (sent.ok) { const fresh = loadState(id); fresh.held_alerted = true; saveState(id, fresh); }
    }
    return;
  }
  const t = now();
  if (watcher.expires_at && Date.parse(watcher.expires_at) <= t && !state.pending) {
    finish(watcher, state, "expired");
    const sent = await alert(watcher, `Watcher "${watcher.title}" expired without firing${state.fires ? " again" : ""} and is now off.`,
      `robob-watch:${id}:expired`, "info");
    log(id, `expiry notice ok=${sent.ok} via=${sent.via} ${sent.detail}`);
    return;
  }
  // Trigger files (e.g. chat.db-wal) run the check as soon as they change; interval_s stays the fallback.
  // A failing watcher keeps its backoff; the signature is recorded before the run so a change mid-run re-triggers.
  const sig = triggerSig(watcher);
  const triggered = sig !== undefined && sig !== state.trigger_sig && !state.consecutive_failures && !state.pending
    && t - Date.parse(state.last_run_at ?? "1970-01-01") >= (watcher.trigger_gap_s ? watcher.trigger_gap_s * 1_000 : TRIGGER_MIN_GAP_MS);
  if ((state.next_at ?? 0) > t && !triggered) return;
  state.last_run_at = iso(t);
  state.next_at = t + watcher.interval_s * 1_000;
  if (sig !== undefined) state.trigger_sig = sig;
  saveState(id, state);

  // An undelivered event is retried before running the check again, so nothing is lost or re-counted.
  if (state.pending) {
    if (!(await deliverPending(watcher, state))) {
      state.next_at = now() + Math.min(watcher.interval_s, 60) * 1_000;
      saveState(id, state);
    }
    return;
  }

  // WATCH_RUN lets helpers that commit their own cursor (whatsapp-new-message) keep an outbox: anything they
  // printed in a run that never reached RUN_OK_FILE (timeout, crash) is printed again on the next run.
  const runId = `${t.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const result = await withSlot(() => runCheck(watcher, watcherDir(id), { WATCH_RUN: runId }));
  const fresh = loadState(id);
  if (!loadWatcher(id) || fresh.status !== "active") return;
  fresh.last_run_ms = result.ms;
  const queued = now() - t - result.ms;
  if (result.ms >= SLOW_RUN_MS || queued >= 5_000) log(id, `slow run: check ${(result.ms / 1000).toFixed(1)}s, queued ${(queued / 1000).toFixed(1)}s`);
  const ackRun = () => { try { writeFileSync(join(watcherDir(id), RUN_OK_FILE), `${runId}\n`); } catch { /* removed mid-run */ } };
  if (result.timedOut || result.code !== 0) {
    fresh.consecutive_failures += 1;
    if (fresh.consecutive_failures === 1 || !fresh.failing_since) fresh.failing_since = iso(t);
    fresh.last_error = result.timedOut ? `timed out after ${CHECK_TIMEOUT_MS / 1000}s` : `exit ${result.code}: ${result.stderr.trim().slice(-500)}`;
    fresh.next_at = now() + backoff(fresh, watcher.interval_s, result.timedOut);
    log(id, `check failed (${fresh.consecutive_failures}) ${fresh.last_error}${result.timedOut && result.stderr.trim() ? ` | stderr: ${result.stderr.trim().slice(-300)}` : ""}`);
    if (shouldAlert(fresh, result.timedOut)) {
      const mins = Math.round((now() - Date.parse(fresh.failing_since!)) / 60_000);
      const sent = await alert(watcher, `Watcher "${watcher.title}" has failed ${fresh.consecutive_failures} times in a row (${mins} min) and is backing off. Last error: ${fresh.last_error.slice(0, 300)}. Check ${join(watcherDir(id), "log")}.`,
        `robob-watch:${id}:failing:${hash(fresh.failing_since ?? "")}`, "error");
      fresh.failure_alerted = sent.ok;
      log(id, `failure alert ok=${sent.ok} via=${sent.via}`);
    }
    if (shouldEscalate(watcher, fresh)) {
      const sent = await escalate(watcher, fresh, `robob-watch:${id}:escalate:${hash(fresh.failing_since ?? "").slice(0, 32)}`);
      fresh.failure_escalated = sent.ok;
      log(id, `failure escalation ok=${sent.ok} via=${sent.via}${sent.ok ? "" : ` ${sent.detail}`}`);
    }
    // Keep the retry cadence at most 5 min apart for wake watchers so escalation and recovery are not delayed
    // by a 30 min backoff.
    if (watcher.mode === "wake") fresh.next_at = Math.min(fresh.next_at!, now() + Math.max(watcher.interval_s, 300) * 1_000);
    saveState(id, fresh);
    return;
  }
  if (fresh.consecutive_failures) log(id, `check recovered after ${fresh.consecutive_failures} failures`);
  fresh.consecutive_failures = 0;
  fresh.failure_alerted = false;
  delete fresh.failure_escalated;
  delete fresh.last_error;
  delete fresh.failing_since;
  const event = result.stdout.trim();
  if (!event) { saveState(id, fresh); ackRun(); return; }
  fresh.pending = { key: `robob-watch:${id}:${fresh.fires + 1}:${hash(event).slice(0, 16)}`, event, at: iso() };
  saveState(id, fresh);
  ackRun();
  log(id, `event: ${event.slice(0, 500)}`);
  if (inQuiet(watcher.quiet)) log(id, "quiet hours: event held until they end");
  await deliverPending(watcher, fresh);
}

async function tick(): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const id of listIds()) {
    if (running.has(id)) continue;
    running.add(id);
    jobs.push(tickOne(id).catch(error => log(id, `runner error: ${String(error).slice(0, 500)}`)).finally(() => running.delete(id)));
  }
  // Watchers run concurrently; a slow one never delays the next tick of the others.
  void Promise.all(jobs);
}

ensureDirs();
// Only one runner at a time, even if launchd and a manual run overlap.
const pidPath = join(ROOT, "runner.pid");
const other = Number(existsSync(pidPath) ? readFileSync(pidPath, "utf8").trim() : 0);
if (other && other !== process.pid) {
  let alive = false;
  try { process.kill(other, 0); alive = true; } catch { /* stale */ }
  const command = alive ? Bun.spawnSync(["/bin/ps", "-o", "command=", "-p", String(other)]).stdout.toString() : "";
  if (alive && command.includes("robob-watch/src/runner.ts")) {
    log(null, `another runner is live (pid ${other}); exiting`);
    process.exit(0);
  }
}
writeFileSync(pidPath, `${process.pid}\n`);
log(null, `robob-watch runner started pid=${process.pid}`);
await tick();
setInterval(() => void tick(), TICK_MS);
