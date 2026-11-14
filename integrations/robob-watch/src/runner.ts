import { randomUUID } from "node:crypto";
import { recordHealthDelivery, isHealthNag } from "./healthDelivery.ts";
import { toolLog, toolError, logDirectory } from "./toollog.ts";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  withRelayLock, watcherInstance, finalizeClosing, checking, pollingWatcher, checkEvent, PERSON_BATCH_MS, queueEvent, sealBatch, sameDestination, alert, deliver, ensureDirs, escalate, failureSources, hash, shouldEscalate, HEADSUP_GIVE_UP_MS, HEADSUP_MS, headsUpText, imessage,
  inboundState, inQuiet, iso, listIds, loadState, loadWatcher, log, now, ROOT, RUN_OK_FILE, runCheck, saveState, type State, telegram, type TrackedWake,
  heldByMaintenance, loadMaintenance, type Maintenance, shouldNotifyFailure, shouldPause, FAILURE_NOTICE_AFTER, triggerSig, type Watcher, wakeInboundId, watcherDir, SLOW_RUN_MS, TIMEOUT_BACKOFF_CAP_S,
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
  toolLog({ component: "runner", kind: "event", name: "watch.disabled", ids: { watcher: watcher.id }, props: { state: status } });
  state.status = status;
  saveState(watcher.id, state);
  log(watcher.id, `status -> ${status}`);
}

async function runPendingCheck(watcher: Watcher, at: number, mainChecked = false): Promise<void> {
  const instance = watcherInstance(watcher.id);
  if (!watcher.pending_check || !instance) return;
  await slots.run(async () => {
    const current = loadWatcher(watcher.id);
    const state = loadState(watcher.id);
    if (!current || watcherInstance(watcher.id) !== instance || held(current) || current.paused || !current.pending_check
      || state.status === "closing" || state.reply_handoff) return;
    const result = await runCheck({ ...current, check: current.pending_check }, watcherDir(watcher.id),
      { WATCH_PENDING: "1", WATCH_RUN: `pending-${at.toString(36)}`, ...(mainChecked ? { WATCH_MAIN_CHECKED: "1" } : {}) },
      checkTimeout(current, sampleLoad()), instance);
    log(watcher.id, `pending check exit=${result.code} timeout=${result.timedOut}`);
  });
}

/** Returns true once the event is delivered (or had been already). */
async function deliverPending(watcher: Watcher, state: State): Promise<boolean> {
  const instance = watcherInstance(watcher.id);
  // A held event keeps its key and is retried each minute, so it goes out once the quiet hours end.
  if (held(watcher) || inQuiet(watcher.quiet)) return false;
  const pending = state.pending!;
  const accepted = pending.watcher ?? watcher;
  const delivery = await deliver(accepted, pending.event, pending.key, state);
  for (const run of pending.healthRuns ?? [pending.healthRun]) await recordHealthDelivery(watcher.id, run, delivery);
  if (watcherInstance(watcher.id) !== instance) return false;
  log(watcher.id, `deliver key=${pending.key} ok=${delivery.ok} via=${delivery.via} ${delivery.detail}`);
  const definition = loadWatcher(watcher.id);
  if (!definition) return false;
  const current = loadState(watcher.id);
  if (current.pending?.key !== pending.key) return false;
  state = current;
  if (!delivery.ok) return false;
  state.fires += pending.count ?? 1;
  if (state.status === "closing") state.closing_relays = (state.closing_relays ?? 0) + (pending.count ?? 1);
  toolLog({ component: "runner", kind: "event", name: "watch.fire", ok: true, ids: { watcher: watcher.id, key: wakeInboundId(pending.key) }, props: { count: state.fires, events: pending.count ?? 1, batched: pending.key.includes(":batch:"), urgent: pending.urgent === true, route: delivery.route ?? "other", waitMs: now() - Date.parse(pending.at), closing: state.status === "closing" } });
  state.last_fire_at = iso();
  state.last_delivery = delivery.via;
  if (delivery.via === "wake") {
    state.wakes = [...(state.wakes ?? []), { inbound: wakeInboundId(pending.key), key: pending.key, event: pending.event, delivered_at: now() }];
  }
  delete state.pending;
  if (state.status !== "closing" && definition.max_fires !== 0 && state.fires >= definition.max_fires && !state.batch && !state.admitted_run && !state.reply_handoff) {
    toolLog({ component: "runner", kind: "event", name: "watch.fire_cap", ids: { watcher: watcher.id }, props: { count: state.fires } });
    finish(definition, state, "done");
  }
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

function acknowledgeRun(id: string, instance: string | undefined, run: string): void {
  withRelayLock(() => {
    if (!instance || watcherInstance(id) !== instance || !loadWatcher(id)) return;
    writeFileSync(join(watcherDir(id), RUN_OK_FILE), `${run}\n`);
    const state = loadState(id);
    const discarded = state.discarded_run === run;
    if (discarded) delete state.discarded_run;
    const admitted = state.admitted_run?.run === run;
    if (admitted) delete state.admitted_run;
    if (state.reply_handoff?.accepted_run === run) {
      delete state.reply_handoff;
      saveState(id, state);
    } else if (discarded || admitted) saveState(id, state);
  });
}

function finishRecoveredCap(id: string): void {
  const definition = loadWatcher(id);
  const state = loadState(id);
  if (definition && state.status === "active" && !state.admitted_run && !state.reply_handoff && !state.pending && !state.batch
    && definition.max_fires !== 0 && state.fires >= definition.max_fires) finish(definition, state, "done");
}

function recoverAdmission(id: string, instance: string | undefined): void {
  withRelayLock(() => {
    if (!instance || watcherInstance(id) !== instance) return;
    const state = loadState(id);
    const admitted = state.admitted_run;
    const definition = loadWatcher(id);
    if (!admitted || admitted.accepted || !definition) return;
    const expected = state.reply_handoff?.watcher ?? (state.status === "closing" ? state.closing_watcher : definition);
    if (expected && sameDestination(admitted.watcher, expected) && admitted.watcher.check === expected.check
      && (state.status !== "closing" || admitted.watcher.context === expected.context)) return;
    // A crash can leave a helper outbox before its wrapper returns. Its saved admission, never
    // a replacement definition, decides who may receive it and which reply checker can replay it.
    if (admitted.watcher.inflight_check) state.reply_handoff ??= {
      run: admitted.run, watcher: { ...admitted.watcher, check: admitted.watcher.inflight_check },
    };
    else state.discarded_run = admitted.run;
    delete state.admitted_run;
    state.next_at = 0;
    saveState(id, state);
  });
}

export async function tickOne(id: string): Promise<void> {
  const instance = watcherInstance(id);
  const sameInstance = () => watcherInstance(id) === instance;
  const initial = loadWatcher(id);
  if (!initial) return;
  finishRecoveredCap(id);
  recoverAdmission(id, instance);
  let state = loadState(id);
  const unacked = state.discarded_run ?? state.reply_handoff?.accepted_run
    ?? (state.admitted_run?.accepted ? state.admitted_run.run : undefined);
  if (unacked) {
    // State records acceptance before the separate helper ack; finish that ack after a crash/write failure.
    try { acknowledgeRun(id, instance, unacked); } catch { toolError("runner", "watch.ack_failed", { watcher: id }); return; }
    state = loadState(id);
    finishRecoveredCap(id);
    state = loadState(id);
  }
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
  if (state.status !== "closing" && !state.reply_handoff && !state.admitted_run && watcher.expires_at && Date.parse(watcher.expires_at) <= t && !state.pending && !state.batch) {
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
    state.last_run_at = iso();
    state.next_at = t + watcher.interval_s * 1_000;
    saveState(id, state);
    toolLog({ component: "runner", kind: "event", name: "watch.retry", ids: { watcher: id }, props: { action: "send" } });
    if (!(await deliverPending(watcher, state))) {
      if (sameInstance() && loadWatcher(id)) {
        state = loadState(id);
        state.next_at = now() + Math.min(watcher.interval_s, 60) * 1_000;
        saveState(id, state);
        if (!held(watcher)) await runPendingCheck(watcher, t);
      }
      return;
    }
    return;
  }
  if (state.status === "closing" && state.closing_final_check) return;
  const finalCheck = state.status === "closing" && t >= state.closing_until!;
  if (state.failure_paused_at && !finalCheck) return;
  if (state.batch?.watcher && !sameDestination(state.batch.watcher, watcher)) return;
  if (state.status !== "closing" && !state.reply_handoff && !state.admitted_run && watcher.max_fires !== 0 && state.fires + (state.batch?.events.length ?? 0) >= watcher.max_fires) return;
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
  const attemptId = `${t.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let runId = attemptId;
  const healthRun = isHealthNag(id) ? randomUUID().replaceAll("-", "") : undefined;
  let startLoad = 0;
  let timeoutMs = 0;
  let checkedWatcher: Watcher | undefined;
  let handoffRun: string | undefined;
  let recoveredRun: string | undefined;
  let finalDeadline: number | undefined;
  const result = await slots.run(async () => withRelayLock(() => {
    if (!sameInstance()) return undefined;
    recoverAdmission(id, instance);
    const recovery = loadState(id);
    const unacked = recovery.discarded_run ?? recovery.reply_handoff?.accepted_run
      ?? (recovery.admitted_run?.accepted ? recovery.admitted_run.run : undefined);
    if (unacked) {
      try { acknowledgeRun(id, instance, unacked); } catch { toolError("runner", "watch.ack_failed", { watcher: id }); return undefined; }
      finishRecoveredCap(id);
    }
    const definition = loadWatcher(id);
    state = loadState(id);
    const current = definition && pollingWatcher(definition, state);
    // A slot may open several ticks later, after maintenance or an owner pause began.
    const final = state.status === "closing" && now() >= state.closing_until!;
    if (!current || !checking(state) || current.paused || (state.failure_paused_at && !final) || held(current)) return undefined;
    if (state.batch?.watcher && !sameDestination(state.batch.watcher, current)) return undefined;
    handoffRun = state.reply_handoff?.run;
    recoveredRun = state.admitted_run?.run;
    runId = recoveredRun ?? attemptId;
    if (final && !handoffRun) { finalDeadline = state.closing_until; state.closing_final_started = true; }
    checkedWatcher = current;
    state.admitted_run = { run: runId, attempt: attemptId, watcher: current };
    schedule();
    startLoad = sampleLoad();
    timeoutMs = checkTimeout(current, startLoad);
    if (state.consecutive_failures || state.load_timeouts) toolLog({ component: "runner", kind: "event", name: "watch.retry", ids: { watcher: id, run: runId }, props: { action: "check", attempt: state.consecutive_failures + 1 } });
    return runCheck(current, watcherDir(id), { WATCH_RUN: runId, WATCH_ATTEMPT: attemptId, WATCH_CLOSING: state.status === "closing" ? "1" : "0", ...(healthRun ? { HEALTH_TOOLLOG_RUN: healthRun } : {}) }, timeoutMs, instance);
  }));
  if (!result) return;
  const runTimedOut = result.timedOut && (result.code === null || result.code === 0);
  const failed = runTimedOut || result.code !== 0;
  toolLog({ component: "runner", kind: failed ? "error" : "perf", name: "watch.run", durationMs: result.ms, ok: !failed, ids: { watcher: id, run: runId }, props: { outcome: runTimedOut ? "timeout" : failed ? "fail" : result.stdout.trim() ? "fire" : "no_change", exitCode: result.code, signal: result.signal, timedOut: result.timedOut, queuedMs: Math.max(0, now() - t - result.ms) }, ...(failed ? { error: { tag: runTimedOut ? "watch.timeout" : "watch.check_failed" } } : {}) });
  if (!sameInstance()) return;
  const endLoad = sampleLoad();
  let fresh = loadState(id);
  const currentDefinition = loadWatcher(id);
  const current = currentDefinition && pollingWatcher(currentDefinition, fresh);
  if (!current || !checking(fresh)) return;
  const ackRun = () => { try { acknowledgeRun(id, instance, runId); } catch { toolError("runner", "watch.ack_failed", { watcher: id }); } };
  if (fresh.status === "closing" && checkedWatcher?.check !== current.check) {
    // Only the reply-only command may recover helper output. Keep its original delivery identity
    // until that poll succeeds, so an unacked outbox cannot cross recipients after a retarget.
    if (checkedWatcher?.inflight_check) {
      fresh.reply_handoff ??= { run: runId, watcher: { ...checkedWatcher, check: checkedWatcher.inflight_check } };
    } else fresh.discarded_run = runId;
    delete fresh.admitted_run;
    fresh.next_at = 0;
    saveState(id, fresh);
    if (!checkedWatcher?.inflight_check) ackRun();
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
        delete fresh.last_error_sources;
        fresh.next_at = now() + Math.min(watcher.interval_s, TIMEOUT_BACKOFF_CAP_S) * 1_000;
        saveState(id, fresh);
        log(id, `load timeout (${fresh.load_timeouts}): ${fresh.last_error}`);
        return;
      }
    }
    fresh.consecutive_failures += 1;
    fresh.failure_alerted = false;
    if (fresh.consecutive_failures === 1 || !fresh.failing_since) fresh.failing_since = iso(t);
    const sources = timedOut ? [] : failureSources(result.stderr);
    fresh.last_error = timedOut ? `timed out after ${timeoutMs / 1000}s` : `exit ${result.code}: ${result.stderr.trim().slice(-500)}`;
    if (sources.length) fresh.last_error_sources = sources;
    else delete fresh.last_error_sources;
    fresh.next_at = now() + backoff(fresh, watcher.interval_s, timedOut);
    log(id, `check failed (${fresh.consecutive_failures}) ${fresh.last_error}${timedOut && result.stderr.trim() ? ` | stderr: ${result.stderr.trim().slice(-300)}` : ""}`);
    if (shouldPause(watcher, fresh, timedOut)) {
      toolLog({ component: "runner", kind: "event", name: "watch.disabled", ids: { watcher: id }, props: { action: "pause", count: fresh.consecutive_failures } });
      fresh.failure_paused_at = iso();
      fresh.failure_alerted = false;
      // Commit the pause before sending: a crash or failed send must retry the notice, never the check.
      saveState(id, fresh);
      await pauseNotice(watcher, fresh);
      return;
    }
    saveState(id, fresh);
    if (shouldNotifyFailure(watcher, fresh, timedOut)) {
      const mins = Math.round((now() - Date.parse(fresh.failing_since!)) / 60_000);
      const sent = await alert(watcher, `Watcher "${watcher.title}" has failed ${fresh.consecutive_failures} ${fresh.consecutive_failures === 1 ? "time" : "times"} in a row (${mins} min) and is backing off. Last error: ${fresh.last_error.slice(0, 300)}. Check ${join(watcherDir(id), "log")}.`,
        `robob-watch:${id}:failing:${hash(fresh.failing_since ?? "")}:${fresh.consecutive_failures}`, "error");
      const current = loadState(id);
      if (!loadWatcher(id) || !sameInstance() || current.failing_since !== fresh.failing_since) {
        log(id, "failure notice completed after resume/remove; state kept");
        return;
      }
      fresh = current;
      fresh.failure_alerted = sent.ok;
      saveState(id, fresh);
      log(id, `failure alert ok=${sent.ok} via=${sent.via}`);
    } else {
      const count = fresh.consecutive_failures;
      const threshold = watcher.failure_notice_after ?? FAILURE_NOTICE_AFTER;
      log(id, `failure notice held (${count}/${threshold})`);
      toolLog({ component: "runner", kind: "event", name: "watch.failure_notice_held", ids: { watcher: id }, props: { count, threshold, timedOut } });
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
  if (fresh.consecutive_failures) {
    const failures = fresh.consecutive_failures;
    const notified = fresh.failure_alerted;
    toolLog({ component: "runner", kind: "event", name: "watch.recovered", ids: { watcher: id }, props: { count: failures, failures, notified } });
    log(id, `check recovered after ${failures} failures (${notified ? "notified" : "not notified"})`);
  }
  fresh.consecutive_failures = 0;
  fresh.failure_alerted = false;
  delete fresh.failure_escalated;
  delete fresh.last_error;
  delete fresh.last_error_sources;
  delete fresh.failing_since;
  if (handoffRun && fresh.reply_handoff?.run === handoffRun) {
    fresh.reply_handoff.accepted_run = runId;
    fresh.next_at = 0;
  }
  const { event, urgent } = checkEvent(result.stdout);
  if (fresh.admitted_run?.run === runId) fresh.admitted_run.accepted = true;
  if (!event) {
    saveState(id, fresh); ackRun();
    fresh = loadState(id);
    finishRecoveredCap(id);
    if (fresh.status === "closing" && fresh.closing_final_check && !fresh.batch) finalizeClosing(id);
    await runPendingCheck(watcher, t, true);
    return;
  }
  queueEvent(checkedWatcher!, fresh, event, urgent, !!handoffRun || !!recoveredRun);
  if (healthRun) {
    if (fresh.pending) fresh.pending.healthRun = healthRun;
    else if (fresh.batch) (fresh.batch.healthRuns ??= []).push(healthRun);
  }
  saveState(id, fresh);
  ackRun();
  log(id, `event: ${event.slice(0, 500)}`);
  if (inQuiet(watcher.quiet)) log(id, "quiet hours: event held until they end");
  if (fresh.pending && !current.paused) await deliverPending(current, fresh);
  await runPendingCheck(watcher, t, true);
}

let previousMaintenance: Maintenance | undefined;
let rollingDay: string | undefined;
export function previousDayRollup(): void {
  const at = new Date();
  // Late-day release markers need their full 30-minute post-release window.
  if (at.getUTCHours() === 0 && at.getUTCMinutes() < 30) return;
  const day = new Date(at.getTime() - 86400_000).toISOString().slice(0, 10);
  if (rollingDay === day) return;
  rollingDay = day;
  const dayEnd = Date.parse(`${day}T00:00:00Z`) + 86400_000;
  try {
    if (statSync(join(logDirectory(), `rollup-${day}.json`)).mtimeMs >= dayEnd) return;
  } catch { /* Missing or unreadable rollups need another attempt. */ }
  // Parsing a day file runs outside the one-second runner tick.
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), "log-rollup", "--day", day], { env: process.env, stdout: "ignore", stderr: "ignore" });
    void child.exited.then(code => { if (code) toolError("runner", "log.rollup_failed"); }).catch(() => toolError("runner", "log.rollup_failed"));
  } catch { toolError("runner", "log.rollup_spawn_failed"); }
}
export async function tick(): Promise<void> {
  previousDayRollup();
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
    jobs.push(tickOne(id).catch(error => { toolError("runner", "watch.runner_failed", { watcher: id }); log(id, `runner error: ${String(error).slice(0, 500)}`); }).finally(() => running.delete(id)));
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
    try { process.kill(other, 0); alive = true; } catch { toolError("runner", "watch.stale_pid"); }
    const command = alive ? Bun.spawnSync(["/bin/ps", "-o", "command=", "-p", String(other)]).stdout.toString() : "";
    if (alive && command.includes("robob-watch/src/runner.ts")) {
      log(null, `another runner is live (pid ${other}); exiting`);
      process.exit(0);
    }
  }
  writeFileSync(pidPath, `${process.pid}\n`);
  log(null, `robob-watch runner started pid=${process.pid} host load=${hostLoad().toFixed(1)}/core`);
  await tick().catch(() => toolError("runner", "watch.tick_failed"));
  setInterval(() => void tick().catch(() => toolError("runner", "watch.tick_failed")), TICK_MS);
}
