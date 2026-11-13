import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  withRelayLock, watcherInstance, finalizeClosing, checking, pollingWatcher, checkEvent, PERSON_BATCH_MS, queueEvent, sealBatch, sameDestination, alert, deliver, ensureDirs, escalate, hash, shouldEscalate, HEADSUP_GIVE_UP_MS, HEADSUP_MS, headsUpText, imessage,
  inboundState, inQuiet, iso, listIds, loadState, loadWatcher, log, now, ROOT, RUN_OK_FILE, runCheck, saveState, type State, telegram, type TrackedWake,
  heldByMaintenance, loadMaintenance, type Maintenance, shouldPause, triggerSig, type Watcher, wakeInboundId, watcherDir, shouldAlert, SLOW_RUN_MS, TIMEOUT_BACKOFF_CAP_S,
} from "./lib.ts";

import { CheckSlots, checkSlotCap, checkTimeout, hostLoad, isMounted, LOAD_GRACE_MS, LOAD_HIGH, SSD_PATH } from "./host.ts";

// A 1s tick costs a few stats and JSON reads per watcher; it lets trigger files and short intervals act fast.
const TICK_MS = 1_000;
/** By default a trigger-file change never runs the same check more often than this (watcher.trigger_gap_s overrides). */
const TRIGGER_MIN_GAP_MS = 2_000;
const running = new Set<string>();
let maintenance: Maintenance | undefined;
let ssdMounted = true;
let highLoad = false;
function sampleLoad(): number {
  const load = hostLoad();
  const high = load >= LOAD_HIGH;
  if (high !== highLoad) log(null, `host load mode ${high ? "started" : "ended"}: ${load.toFixed(1)}/core, slots=${checkSlotCap(load)}`);
  highLoad = high;
  return load;
}
const slots = new CheckSlots(() => checkSlotCap(sampleLoad()));
function held(watcher: Watcher): boolean {
  return heldByMaintenance(watcher, maintenance) || (!ssdMounted && !!watcher.depends?.includes("ssd"));
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
  const instance = watcherInstance(watcher.id);
  // A held event keeps its key and is retried each minute, so it goes out once the quiet hours end.
  if (held(watcher) || inQuiet(watcher.quiet)) return false;
  const pending = state.pending!;
  const delivery = await deliver(pending.watcher ?? watcher, pending.event, pending.key, state);
  if (watcherInstance(watcher.id) !== instance) return false;
  log(watcher.id, `deliver key=${pending.key} ok=${delivery.ok} via=${delivery.via} ${delivery.detail}`);
  if (!loadWatcher(watcher.id)) return false;
  const current = loadState(watcher.id);
  if (current.pending?.key !== pending.key) return false;
  state = current;
  if (!delivery.ok) return false;
  state.fires += pending.count ?? 1;
  state.last_fire_at = iso();
  state.last_delivery = delivery.via;
  if (delivery.via === "wake") {
    state.wakes = [...(state.wakes ?? []), { inbound: wakeInboundId(pending.key), key: pending.key, event: pending.event, delivered_at: now() }];
  }
  delete state.pending;
  if (state.status !== "closing" && watcher.max_fires !== 0 && state.fires >= watcher.max_fires && !state.batch) finish(watcher, state, "done");
  else saveState(watcher.id, state);
  return true;
}

/**
 * A delivered wake queues behind whatever turn the agent is on. If it is still unconsumed after HEADSUP_MS,
 * the owner gets one short plain text so a long turn does not hide the event. Runs even for done/paused
 * watchers, because a single-fire watcher is already done by the time its wake is waiting.
 */
async function headsUps(watcher: Watcher, state: State): Promise<void> {
  const instance = watcherInstance(watcher.id);
  if (!state.wakes?.length) return;
  // Heads-ups leak raw watcher text to the owner; only watchers that opt in get them.
  if (watcher.headsup !== true) { delete state.wakes; const fresh = loadState(watcher.id); delete fresh.wakes; saveState(watcher.id, fresh); return; }
  const keep: TrackedWake[] = [];
  for (const wake of state.wakes) {
    const age = now() - wake.delivered_at;
    const row = await inboundState(wake.inbound);
    if (watcherInstance(watcher.id) !== instance) return;
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
  if (!loadWatcher(watcher.id) || watcherInstance(watcher.id) !== instance) return;
  const fresh = loadState(watcher.id);
  const seen = new Set(state.wakes.map(wake => wake.inbound));
  // Keep entries added since this pass loaded state; replace the ones it handled.
  fresh.wakes = [...(fresh.wakes ?? []).filter(wake => !seen.has(wake.inbound)), ...keep];
  if (!fresh.wakes.length) delete fresh.wakes;
  saveState(watcher.id, fresh);
  Object.assign(state, fresh);
  if (!fresh.wakes) delete state.wakes;
}

/** The persisted pause survives a failed notice send or runner restart; retries keep the same text and key. */
async function pauseNotice(watcher: Watcher, state: State): Promise<void> {
  const instance = watcherInstance(watcher.id);
  if (!state.failure_alerted) {
    const mins = Math.round((Date.parse(state.failure_paused_at!) - Date.parse(state.failing_since!)) / 60_000);
    const sent = await alert(watcher, `Watcher "${watcher.title}" paused after ${state.consecutive_failures} failures in a row (${mins} min). Last error: ${(state.last_error ?? "").slice(0, 300)}. Fix it, then robob-watch resume ${watcher.id}. Log: ${join(watcherDir(watcher.id), "log")}`,
      `robob-watch:${watcher.id}:paused:${hash(state.failing_since ?? "")}`, "error");
    log(watcher.id, `pause notice ok=${sent.ok} via=${sent.via}`);
    const fresh = loadState(watcher.id);
    // Resume/remove can happen while the bridge is sending; never restore the old pause over that command.
    if (!loadWatcher(watcher.id) || watcherInstance(watcher.id) !== instance || fresh.failure_paused_at !== state.failure_paused_at) return;
    fresh.failure_alerted = sent.ok;
    saveState(watcher.id, fresh);
    Object.assign(state, fresh);
  }
  if (shouldEscalate(watcher, state)) {
    const sent = await escalate(watcher, state, `robob-watch:${watcher.id}:escalate:${hash(state.failing_since ?? "").slice(0, 32)}`);
    log(watcher.id, `failure escalation ok=${sent.ok} via=${sent.via}${sent.ok ? "" : ` ${sent.detail}`}`);
    const fresh = loadState(watcher.id);
    if (!loadWatcher(watcher.id) || watcherInstance(watcher.id) !== instance || fresh.failure_paused_at !== state.failure_paused_at) return;
    fresh.failure_escalated = sent.ok;
    saveState(watcher.id, fresh);
    Object.assign(state, fresh);
  }
}

export async function tickOne(id: string): Promise<void> {
  const instance = watcherInstance(id);
  const sameInstance = () => watcherInstance(id) === instance;
  const initial = loadWatcher(id);
  if (!initial) return;
  let state = loadState(id);
  const initialPoller = pollingWatcher(initial, state);
  if (!initialPoller) return;
  await headsUps(initialPoller, state);
  if (!sameInstance()) return;
  if (state.failure_paused_at) await pauseNotice(initialPoller, state);
  if (!sameInstance()) return;
  const definition = loadWatcher(id);
  if (!definition) return;
  state = loadState(id);
  const watcher = pollingWatcher(definition, state);
  if (!watcher) return;
  if (state.status === "closing" && now() >= state.closing_until! && (watcher.paused || (state.closing_final_check && !state.pending && !state.batch))) {
    finalizeClosing(id);
    return;
  }
  if (!checking(state) || watcher.paused) return;
  if (held(watcher)) return;
  const t = now();
  if (state.status !== "closing" && watcher.expires_at && Date.parse(watcher.expires_at) <= t && !state.pending && !state.batch) {
    finish(watcher, state, "expired");
    const sent = await alert(watcher, `Watcher "${watcher.title}" expired without firing${state.fires ? " again" : ""} and is now off.`,
      `robob-watch:${id}:expired`, "info");
    log(id, `expiry notice ok=${sent.ok} via=${sent.via} ${sent.detail}`);
    return;
  }
  // Flush independently of the check schedule and never extend a window when another event arrives.
  const batchMs = process.env.ROBOB_TEST && process.env.ROBOB_WATCH_TEST_BATCH_MS !== undefined
    ? Number(process.env.ROBOB_WATCH_TEST_BATCH_MS) : PERSON_BATCH_MS;
  if (state.batch && !state.pending && t >= state.batch.at + batchMs) {
    sealBatch(watcher, state);
    state.next_at = 0;
    saveState(id, state);
  }
  if (state.pending) {
    if ((state.next_at ?? 0) > t) return;
    if (!(await deliverPending(watcher, state))) {
      if (sameInstance() && loadWatcher(id)) {
        state = loadState(id);
        state.next_at = now() + Math.min(watcher.interval_s, 60) * 1_000;
        saveState(id, state);
      }
      return;
    }
    return;
  }
  if (state.status === "closing" && state.closing_final_check) return;
  const finalCheck = state.status === "closing" && t >= state.closing_until!;
  if (state.failure_paused_at && !finalCheck) return;
  if (state.batch?.watcher && !sameDestination(state.batch.watcher, watcher)) return;
  if (state.status !== "closing" && watcher.max_fires !== 0 && state.fires + (state.batch?.events.length ?? 0) >= watcher.max_fires) return;
  // Trigger files (e.g. chat.db-wal) run the check as soon as they change; interval_s stays the fallback.
  // A failing watcher keeps its backoff; the signature is recorded before the run so a change mid-run re-triggers.
  const sig = triggerSig(watcher);
  const triggered = sig !== undefined && sig !== state.trigger_sig && !state.consecutive_failures && !state.load_timeouts && !state.pending
    && t - Date.parse(state.last_run_at ?? "1970-01-01") >= (watcher.trigger_gap_s ? watcher.trigger_gap_s * 1_000 : TRIGGER_MIN_GAP_MS);
  if ((state.next_at ?? 0) > t && !triggered && !(finalCheck && !state.closing_final_started)) return;
  const schedule = () => {
    state.last_run_at = iso();
    state.next_at = now() + watcher.interval_s * 1_000;
    if (sig !== undefined) state.trigger_sig = sig;
    saveState(id, state);
  };

  // WATCH_RUN lets helpers that commit their own cursor (whatsapp-new-message) keep an outbox: anything they
  // printed in a run that never reached RUN_OK_FILE (timeout, crash) is printed again on the next run.
  const runId = `${t.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let startLoad = 0;
  let timeoutMs = 0;
  let checkedWatcher: Watcher | undefined;
  let finalDeadline: number | undefined;
  const result = await slots.run(async () => withRelayLock(() => {
    if (!sameInstance()) return undefined;
    const definition = loadWatcher(id);
    state = loadState(id);
    const current = definition && pollingWatcher(definition, state);
    // A slot may open several ticks later, after maintenance or an owner pause began.
    const final = state.status === "closing" && now() >= state.closing_until!;
    if (!current || !checking(state) || current.paused || (state.failure_paused_at && !final) || held(current)) return undefined;
    if (state.batch?.watcher && !sameDestination(state.batch.watcher, current)) return undefined;
    if (final) { finalDeadline = state.closing_until; state.closing_final_started = true; }
    checkedWatcher = current;
    schedule();
    startLoad = sampleLoad();
    timeoutMs = checkTimeout(current, startLoad);
    return runCheck(current, watcherDir(id), { WATCH_RUN: runId, WATCH_CLOSING: state.status === "closing" ? "1" : "0" }, timeoutMs, instance);
  }));
  if (!result || !sameInstance()) return;
  const endLoad = sampleLoad();
  let fresh = loadState(id);
  const currentDefinition = loadWatcher(id);
  const current = currentDefinition && pollingWatcher(currentDefinition, fresh);
  if (!current || !checking(fresh)) return;
  const ackRun = () => { try { if (sameInstance()) writeFileSync(join(watcherDir(id), RUN_OK_FILE), `${runId}\n`); } catch { /* removed mid-run */ } };
  if (fresh.status === "closing" && checkedWatcher?.check !== current.check) {
    fresh.next_at = 0;
    saveState(id, fresh);
    // The canceled normal command must not replay its helper outbox through the reply-only command.
    ackRun();
    log(id, "normal check completed after removal; only the configured in-flight check may emit during grace");
    return;
  }
  fresh.last_run_ms = result.ms;
  const queued = now() - t - result.ms;
  if (result.ms >= SLOW_RUN_MS || queued >= 5_000) log(id, `slow run: check ${(result.ms / 1000).toFixed(1)}s, queued ${(queued / 1000).toFixed(1)}s`);
  // A shell can exit nonzero while a descendant holds its pipes until the deadline.
  const timedOut = result.timedOut && (result.code === null || result.code === 0);
  if (timedOut || result.code !== 0) {
    // Maintenance can remove a resource after admission; this failure must not pause an otherwise healthy check.
    if (held(current)) {
      fresh.next_at = 0;
      saveState(id, fresh);
      log(id, heldByMaintenance(current, maintenance) ? "check failure ignored during maintenance" : "check failure ignored while SSD is unmounted");
      return;
    }
    if (!timedOut) {
      delete fresh.load_timeouts;
      delete fresh.load_timeout_since;
    }
    if (timedOut && Math.max(startLoad, endLoad) >= LOAD_HIGH) {
      fresh.load_timeouts = (fresh.load_timeouts ?? 0) + 1;
      fresh.load_timeout_since ??= iso();
      if (now() - Date.parse(fresh.load_timeout_since) < LOAD_GRACE_MS) {
        fresh.last_error = `timed out after ${timeoutMs / 1000}s under host load ${Math.max(startLoad, endLoad).toFixed(1)}/core`;
        fresh.next_at = now() + Math.min(watcher.interval_s, TIMEOUT_BACKOFF_CAP_S) * 1_000;
        saveState(id, fresh);
        log(id, `load timeout (${fresh.load_timeouts}): ${fresh.last_error}`);
        return;
      }
    }
    fresh.consecutive_failures += 1;
    if (fresh.consecutive_failures === 1 || !fresh.failing_since) fresh.failing_since = iso(t);
    fresh.last_error = timedOut ? `timed out after ${timeoutMs / 1000}s` : `exit ${result.code}: ${result.stderr.trim().slice(-500)}`;
    fresh.next_at = now() + backoff(fresh, watcher.interval_s, timedOut);
    log(id, `check failed (${fresh.consecutive_failures}) ${fresh.last_error}${timedOut && result.stderr.trim() ? ` | stderr: ${result.stderr.trim().slice(-300)}` : ""}`);
    if (shouldPause(watcher, fresh, timedOut)) {
      fresh.failure_paused_at = iso();
      fresh.failure_alerted = false;
      // Commit the pause before sending: a crash or failed send must retry the notice, never the check.
      saveState(id, fresh);
      await pauseNotice(watcher, fresh);
      return;
    }
    saveState(id, fresh);
    if (watcher.max_consecutive_failures === 0 && shouldAlert(fresh, timedOut)) {
      const mins = Math.round((now() - Date.parse(fresh.failing_since!)) / 60_000);
      const sent = await alert(watcher, `Watcher "${watcher.title}" has failed ${fresh.consecutive_failures} times in a row (${mins} min) and is backing off. Last error: ${fresh.last_error.slice(0, 300)}. Check ${join(watcherDir(id), "log")}.`,
        `robob-watch:${id}:failing:${hash(fresh.failing_since ?? "")}`, "error");
      const current = loadState(id);
      if (!loadWatcher(id) || !sameInstance() || current.failing_since !== fresh.failing_since) {
        log(id, "failure notice completed after resume/remove; state kept");
        return;
      }
      fresh = current;
      fresh.failure_alerted = sent.ok;
      saveState(id, fresh);
      log(id, `failure alert ok=${sent.ok} via=${sent.via}`);
    }
    if (shouldEscalate(watcher, fresh)) {
      const sent = await escalate(watcher, fresh, `robob-watch:${id}:escalate:${hash(fresh.failing_since ?? "").slice(0, 32)}`);
      const current = loadState(id);
      if (!loadWatcher(id) || !sameInstance() || current.failing_since !== fresh.failing_since) {
        log(id, "failure notice completed after resume/remove; state kept");
        return;
      }
      fresh = current;
      fresh.failure_escalated = sent.ok;
      saveState(id, fresh);
      log(id, `failure escalation ok=${sent.ok} via=${sent.via}${sent.ok ? "" : ` ${sent.detail}`}`);
    }
    // Keep the retry cadence at most 5 min apart for wake watchers so escalation and recovery are not delayed
    // by a 30 min backoff.
    if (watcher.mode === "wake") fresh.next_at = Math.min(fresh.next_at!, now() + Math.max(watcher.interval_s, 300) * 1_000);
    saveState(id, fresh);
    return;
  }
  if (finalDeadline !== undefined && fresh.status === "closing" && fresh.closing_until === finalDeadline) fresh.closing_final_check = true;
  delete fresh.load_timeouts;
  delete fresh.load_timeout_since;
  if (fresh.consecutive_failures) log(id, `check recovered after ${fresh.consecutive_failures} failures`);
  fresh.consecutive_failures = 0;
  fresh.failure_alerted = false;
  delete fresh.failure_escalated;
  delete fresh.last_error;
  delete fresh.failing_since;
  const { event, urgent } = checkEvent(result.stdout);
  if (!event) {
    saveState(id, fresh); ackRun();
    if (fresh.status === "closing" && fresh.closing_final_check && !fresh.batch) finalizeClosing(id);
    return;
  }
  queueEvent(checkedWatcher!, fresh, event, urgent);
  saveState(id, fresh);
  ackRun();
  log(id, `event: ${event.slice(0, 500)}`);
  if (inQuiet(watcher.quiet)) log(id, "quiet hours: event held until they end");
  if (fresh.pending && !current.paused) await deliverPending(current, fresh);
}

let previousMaintenance: Maintenance | undefined;
async function tick(): Promise<void> {
  sampleLoad();
  const mounted = isMounted(SSD_PATH);
  if (mounted !== ssdMounted) log(null, `SSD ${mounted ? "mounted again" : "missing"}: ${SSD_PATH}`);
  ssdMounted = mounted;
  slots.drain();
  maintenance = loadMaintenance();
  if (maintenance && !previousMaintenance) log(null, `maintenance started until ${maintenance.until}: ${maintenance.reason} (${maintenance.depends.join(",")})`);
  if (!maintenance && previousMaintenance) log(null, "maintenance ended");
  previousMaintenance = maintenance;
  const jobs: Promise<void>[] = [];
  for (const id of listIds()) {
    if (running.has(id)) continue;
    running.add(id);
    jobs.push(tickOne(id).catch(error => log(id, `runner error: ${String(error).slice(0, 500)}`)).finally(() => running.delete(id)));
  }
  // Watchers run concurrently; a slow one never delays the next tick of the others.
  void Promise.all(jobs);
}

if (import.meta.main) {
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
  log(null, `robob-watch runner started pid=${process.pid} host load=${hostLoad().toFixed(1)}/core`);
  await tick();
  setInterval(() => void tick(), TICK_MS);
}
