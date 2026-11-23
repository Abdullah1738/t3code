import { applyOwnerAlertResults, dispatchOwnerAlerts, ownerFailureAlerts, queueOwnerFailure, queueOwnerRecovery } from "./owner-alerts.ts";
import { randomUUID } from "node:crypto";
import { cadenceStale, completeCadence, isStarved, starvedText, syncCadenceSuspension, urgentLoadRetry } from "./cadence.ts";
import type { DependencyBusy } from "./cause.ts";
import type { CheckGroup } from "./check-groups.ts";
import { recordHealthDelivery, isHealthNag } from "./healthDelivery.ts";
import { toolLog, toolError, logDirectory } from "./toollog.ts";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  clearFailureState, clearFailureEscalation, ensureFailureProbe, failureProbeDue, failureProbeDelay, pausedDuration, pauseRetryText,
  CheckShutdownError, CheckStuckError, checkGroups, withRelayLock, withRelayLockAsync, watcherInstance, finalizeClosing, checking, pollingWatcher, checkEvent, PERSON_BATCH_MS, queueEvent, sealBatch, sameDestination, alert, deliver, ensureDirs, escalate, failureSources, hash, shouldEscalate, HEADSUP_GIVE_UP_MS, HEADSUP_MS, headsUpText, imessage,
  trackConfirmation, confirmWakes, inboundState, inQuiet, iso, installCheckShutdown, killRunningChecks, listIds, loadState, loadWatcher, log, now, ROOT, RUN_OK_FILE, runCheck, saveState, writeJson, type State, telegram, type TrackedWake,
  heldByMaintenance, loadMaintenance, type Maintenance, shouldNotifyFailure, shouldPause, FAILURE_NOTICE_AFTER, TriggerError, triggerSig, type MissingTrigger, type Watcher, wakeInboundId, watcherDir, SLOW_RUN_MS, TIMEOUT_BACKOFF_CAP_S,
} from "./lib.ts";

import { CheckSlots, checkClassification, recentCheckRuntimes, checkSlotCap, checkTimeout, hostLoad, isMounted, LoadMode, LOAD_DWELL_MS, LOAD_LOW, LOAD_GRACE_MS, LOAD_HIGH, SSD_PATH, type SlotTiming } from "./host.ts";

// A 1s tick costs a few stats and JSON reads per watcher; it lets trigger files and short intervals act fast.
const TICK_MS = 1_000;
/** By default a trigger-file change never runs the same check more often than this (watcher.trigger_gap_s overrides). */
const TRIGGER_MIN_GAP_MS = 2_000;
const running = new Set<string>();
let shuttingDown = false;
let maintenance: Maintenance | undefined;
let ssdMounted = true;
const loadMode = new LoadMode();
let loadAccountedAt: number | undefined;
const cadence = new Map<string, string>();
let queueSnapshot = "", queueSnapshotAt = 0;
function saveQueueSnapshot(): void {
  const queue = slots.queue(), snapshot = JSON.stringify(queue), at = now();
  if (snapshot === queueSnapshot && at - queueSnapshotAt < 60_000) return;
  writeJson(join(ROOT, "slot-queue.json"), { pid: process.pid, at, queue });
  queueSnapshot = snapshot;
  queueSnapshotAt = at;
}
function sampleLoad(): number {
  const load = hostLoad(), at = now(), wasHigh = loadMode.high;
  const high = loadMode.sample(load, at);
  if (loadAccountedAt !== undefined && (!high || at - loadAccountedAt >= 60_000)) {
    toolLog({ component: "runner", kind: "perf", name: "host.load_time", durationMs: Math.max(0, at - loadAccountedAt) });
    loadAccountedAt = high ? at : undefined;
  }
  if (high !== wasHigh) {
    log(null, `host load mode ${high ? "started" : "ended"}: ${load.toFixed(2)}/core, high=${LOAD_HIGH}, low=${LOAD_LOW}, dwell=${LOAD_DWELL_MS}ms, slots=${checkSlotCap(high)}+2 fast`);
    toolLog({ component: "runner", kind: "event", name: "host.load_mode", props: { loadMode: high, load } });
    if (high) loadAccountedAt = at;
  }
  const duration = loadMode.report(at);
  if (duration !== undefined) log(null, `host load mode still on: ${load.toFixed(2)}/core for ${Math.floor(duration / 60_000)} min`);
  return load;
}
const slots = new CheckSlots(() => checkSlotCap(loadMode.high), { queueChanged: saveQueueSnapshot, emit: event => {
  if (event.name === "slot.overrun") log(event.request.watcher, `fast lane overrun: ${(event.elapsedMs / 1000).toFixed(1)}s`);
  if (event.name === "slot.wait" || event.name === "slot.backlog") {
    const holders = event.holders.map(holder => `${holder.watcher}:${(holder.elapsedMs / 1000).toFixed(1)}s`).join(",");
    if (event.name === "slot.wait") log(event.request.watcher, `slot wait passed 30s: slot_wait ${(event.waitMs / 1000).toFixed(1)}s, holders [${holders}]`);
    else log(null, `slot backlog: depth ${event.depth}, oldest ${(event.oldestWaitMs / 1000).toFixed(1)}s, active ${event.active}/${event.cap}, holders [${holders}]`);
  }
  const { name, ...data } = event;
  const request = "request" in data ? data.request : undefined;
  toolLog({ component: "runner", kind: "perf", name, ...("durationMs" in data ? { durationMs: data.durationMs } : {}),
    ids: request ? { watcher: request.watcher, ...(request.run ? { run: request.run } : {}) } : undefined,
    props: { ...data, ...(request ? { operation: request.operation ?? "check", lane: request.lane ?? "slow" } : {}) } });
} }, 2, () => loadMode.high);
function slotStart(watcher: Watcher, timing: SlotTiming, operation: "check" | "pending", run: string): void {
  toolLog({ component: "runner", kind: "perf", name: "slot.start", ids: { watcher: watcher.id, run },
    props: { ...timing, operation, intervalMs: watcher.interval_s * 1_000 } });
}
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
  if (await skipStuckCheck(watcher.id)) return;
  const instance = watcherInstance(watcher.id);
  if (!watcher.pending_check || !instance) return;
  await slots.run(async timing => {
    if (shuttingDown || checkGroups.previous(watcher.id)) return;
    const result = await withRelayLockAsync(() => {
      if (shuttingDown || checkGroups.previous(watcher.id)) return;
      const current = loadWatcher(watcher.id);
      const state = loadState(watcher.id);
      if (!current || watcherInstance(watcher.id) !== instance || held(current) || current.paused || !current.pending_check
        || state.status === "closing" || state.reply_handoff) return;
      timing.startLateMs = Math.max(0, now() - at);
      slotStart(current, timing, "pending", `pending-${at.toString(36)}`);
      return runCheck({ ...current, check: current.pending_check }, watcherDir(watcher.id),
        { WATCH_PENDING: "1", WATCH_RUN: `pending-${at.toString(36)}`, ...(mainChecked ? { WATCH_MAIN_CHECKED: "1" } : {}) },
        checkTimeout(current, sampleLoad()), instance);
    });
    if (!result || shuttingDown) return;
    log(watcher.id, `pending check exit=${result.code} timeout=${result.timedOut}`);
  }, { watcher: watcher.id, operation: "pending", dueAt: at, intervalMs: watcher.interval_s * 1_000, urgent: watcher.urgent === true });
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
  log(watcher.id, `deliver key=${pending.key} ok=${delivery.ok} via=${delivery.via}${delivery.meantFor ? ` meant_for=${delivery.meantFor.split(":").at(-1)!.slice(0, 8)}` : ""} confirmed=${delivery.confirmed ?? "n/a"}${delivery.sendDeferred ? " send=deferred" : ""} ${delivery.detail}`);
  const definition = loadWatcher(watcher.id);
  if (!definition) return false;
  const current = loadState(watcher.id);
  if (current.pending?.key !== pending.key) return false;
  state = current;
  if (!delivery.ok && !delivery.accepted) return false;
  state.fires += pending.count ?? 1;
  if (state.status === "closing") state.closing_relays = (state.closing_relays ?? 0) + (pending.count ?? 1);
  toolLog({ component: "runner", kind: "event", name: "watch.fire", ok: true, ids: { watcher: watcher.id, key: wakeInboundId(pending.key) }, props: { count: state.fires, events: pending.count ?? 1, batched: pending.key.includes(":batch:"), urgent: pending.urgent === true, route: delivery.route ?? "other", waitMs: now() - Date.parse(pending.at), closing: state.status === "closing" } });
  state.last_fire_at = iso();
  state.last_delivery = delivery.via;
  trackConfirmation(state, delivery);
  if (delivery.via === "wake" || delivery.via === "wake:owner-fallback") {
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
    const row = await inboundState(wake.inbound, watcher.id);
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
    const sent = await imessage(text, key, { watcher: watcher.id });
    if (sent.ok) via = "imessage-send";
    else {
      const notified = await telegram(`Watcher ${watcher.id}`, text, key, undefined, undefined, watcher.id);
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
export async function pauseNotice(watcher: Watcher, state: State): Promise<void> {
  const instance = watcherInstance(watcher.id);
  const pausedAt = state.failure_paused_at;
  const current = await withRelayLockAsync(() => {
    const definition = loadWatcher(watcher.id);
    const fresh = loadState(watcher.id);
    if (!definition || watcherInstance(watcher.id) !== instance || !fresh.failure_paused_at
      || fresh.failure_paused_at !== pausedAt) return;
    const changed = !fresh.failure_pause_notice;
    const mins = Math.round((Date.parse(pausedAt!) - Date.parse(fresh.failing_since!)) / 60_000);
    // A retry reuses the bridge key and its exact payload even after a manual pause or failed probe.
    fresh.failure_pause_notice ??= `Watcher "${definition.title}" paused after ${fresh.consecutive_failures} failures in a row (${mins} min). Last error: ${(fresh.last_error ?? "").slice(0, 300)}. ${pauseRetryText(definition, fresh)} Log: ${join(watcherDir(watcher.id), "log")}`;
    if (queueOwnerFailure(definition, fresh, "pause") || changed) saveState(watcher.id, fresh);
    return { watcher: definition, state: fresh };
  });
  if (!current) return;
  watcher = current.watcher;
  state = current.state;
  // Resume owns this same lock. Bridge completion must never restore its old pause snapshot.
  const update = (change: (fresh: State) => void) => withRelayLockAsync(() => {
    const fresh = loadState(watcher.id);
    if (!loadWatcher(watcher.id) || watcherInstance(watcher.id) !== instance || fresh.failure_paused_at !== pausedAt) return;
    change(fresh);
    saveState(watcher.id, fresh);
    return fresh;
  });
  if (!state.failure_alerted) {
    const sent = await alert(watcher, state.failure_pause_notice!,
      `robob-watch:${watcher.id}:paused:${hash(state.failure_episode ?? state.failing_since ?? "")}`, "error", !ownerFailureAlerts(watcher, state));
    log(watcher.id, `pause notice ok=${sent.ok} via=${sent.via}`);
    const fresh = await update(fresh => { fresh.failure_alerted = sent.ok; });
    if (!fresh) return;
    state = fresh;
  }
  if (shouldEscalate(watcher, state)) {
    await escalate(watcher, state, `robob-watch:${watcher.id}:escalate:${hash(state.failure_episode ?? state.failing_since ?? "").slice(0, 32)}`, !ownerFailureAlerts(watcher, state));
  }
}

async function failWatcher(watcher: Watcher, fresh: State, instance: string | undefined, t: number,
  timedOut: boolean, message: string, sources: string[] = [], detail = "", busy?: DependencyBusy): Promise<void> {
  const id = watcher.id;
  const sameInstance = () => watcherInstance(id) === instance;
  const previousEpisode = fresh.failure_episode;
  const firstFailure = fresh.consecutive_failures === 0;
  if (busy) {
    if (fresh.dependency_busy?.dependency !== busy.dependency) {
      fresh.dependency_busy = { dependency: busy.dependency, since: iso() };
      fresh.failure_episode = randomUUID();
      delete fresh.failure_escalated;
    }
  } else if (fresh.dependency_busy) {
    delete fresh.dependency_busy;
    fresh.failure_episode = randomUUID();
    delete fresh.failure_escalated;
  }
  fresh.consecutive_failures += 1;
  fresh.failure_alerted = false;
  if (fresh.consecutive_failures === 1 || !fresh.failing_since) fresh.failing_since = iso(t);
  fresh.last_error = message;
  if (sources.length) fresh.last_error_sources = sources;
  else delete fresh.last_error_sources;
  fresh.next_at = now() + backoff(fresh, watcher.interval_s, timedOut || !!busy);
  const failureKey = fresh.failure_episode ?? fresh.failing_since ?? "";
  if (firstFailure || fresh.failure_episode !== previousEpisode) {
    clearFailureEscalation(fresh);
    fresh.failure_escalation_key = `robob-watch:${id}:escalate:${hash(failureKey).slice(0, 32)}:wake`;
  }
  log(id, busy ? `check busy (${fresh.consecutive_failures}) ${busy.dependency}: ${busy.detail}`
    : `check failed (${fresh.consecutive_failures}) ${fresh.last_error}${detail}`);
  if (shouldPause(watcher, fresh, timedOut)) {
    toolLog({ component: "runner", kind: "event", name: "watch.disabled", ids: { watcher: id }, props: { action: "pause", count: fresh.consecutive_failures } });
    fresh.failure_paused_at = iso();
    fresh.failure_alerted = false;
    ensureFailureProbe(watcher, fresh);
    // Commit the pause before sending: a crash or failed send must retry the notice, never the check.
    saveState(id, fresh);
    await pauseNotice(watcher, fresh);
    return;
  }
  if (shouldEscalate(watcher, fresh)) queueOwnerFailure(watcher, fresh, "failing");
  saveState(id, fresh);
  if (shouldNotifyFailure(watcher, fresh, timedOut)) {
    const mins = Math.round((now() - Date.parse(fresh.dependency_busy?.since ?? fresh.failing_since!)) / 60_000);
    const text = busy ? `Dependency ${busy.dependency} has been busy for ${mins} min. Watcher "${watcher.title}" keeps retrying; nothing is lost. Check ${join(watcherDir(id), "log")}.`
      : `Watcher "${watcher.title}" has failed ${fresh.consecutive_failures} ${fresh.consecutive_failures === 1 ? "time" : "times"} in a row (${mins} min) and is backing off. Last error: ${fresh.last_error.slice(0, 300)}. Check ${join(watcherDir(id), "log")}.`;
    const sent = await alert(watcher, text,
      `robob-watch:${id}:failing:${hash(failureKey)}:${fresh.consecutive_failures}`, "error", !ownerFailureAlerts(watcher, fresh));
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
    await escalate(watcher, fresh, `robob-watch:${id}:escalate:${hash(failureKey).slice(0, 32)}`, !ownerFailureAlerts(watcher, fresh));
    const current = loadState(id);
    if (!loadWatcher(id) || !sameInstance() || current.failing_since !== fresh.failing_since) {
      log(id, "failure notice completed after resume/remove; state kept");
      return;
    }
    fresh = current;
  }
  // Keep the retry cadence at most 5 min apart for wake watchers so escalation and recovery are not delayed
  // by a 30 min backoff.
  if (watcher.mode === "wake") fresh.next_at = Math.min(fresh.next_at!, now() + Math.max(watcher.interval_s, 300) * 1_000);
  saveState(id, fresh);
}

const TRIGGER_ERROR_REPEAT_MS = 5 * 60_000;
function logTriggerError(watcher: Watcher, state: State, error: TriggerError, t: number): void {
  let previous = state.trigger_error;
  const first = !previous || previous.triggerPathHash !== error.triggerPathHash || previous.errnoCode !== error.errnoCode;
  if (first) previous = state.trigger_error = {
    triggerPathHash: error.triggerPathHash, triggerKind: error.triggerKind, errnoCode: error.errnoCode,
    missingSince: iso(t), loggedAt: t, count: 0,
  };
  const window = previous!;
  window.count += 1;
  if (!first && t - window.loggedAt < TRIGGER_ERROR_REPEAT_MS) return;
  const { triggerPathHash, triggerKind, errnoCode, missingSince, count } = window;
  toolLog({ component: "runner", kind: "error", name: first ? "runner.error" : "runner.error.repeat", ok: false,
    ids: { watcher: watcher.id }, props: { triggerPathHash, triggerKind, errnoCode, missingSince, count },
    error: { tag: "watch.trigger_stat_failed" } });
  window.loggedAt = t;
  window.count = 0;
}

const TRIGGER_MISSING_REPEAT_MS = 60 * 60_000;
function logMissingTriggers(watcher: Watcher, state: State, missing: MissingTrigger[], t: number): void {
  const previous = state.trigger_missing;
  if (!previous && !missing.length) return;
  let changed = false;
  let loggedAt = previous?.loggedAt ?? t;
  const paths = [...new Map(missing.map(trigger => [trigger.triggerPathHash, trigger])).values()].map(trigger => {
    const saved = previous?.paths.find(path => path.triggerPathHash === trigger.triggerPathHash);
    if (saved) return saved;
    const path = { ...trigger, missingSince: iso(t) };
    toolLog({ component: "runner", kind: "event", name: "runner.trigger_missing", ok: true,
      ids: { watcher: watcher.id }, props: path });
    changed = true;
    return path;
  });
  for (const path of previous?.paths ?? []) {
    if (paths.some(current => current.triggerPathHash === path.triggerPathHash)) continue;
    // Replacing a trigger in the definition is not evidence that the old file appeared.
    if (watcher.triggers?.some(trigger => hash(trigger).slice(0, 16) === path.triggerPathHash)) {
      toolLog({ component: "runner", kind: "event", name: "runner.trigger_present", ok: true,
        ids: { watcher: watcher.id }, props: { triggerPathHash: path.triggerPathHash, missingForS: Math.max(0, (t - Date.parse(path.missingSince)) / 1000) } });
    }
    changed = true;
  }
  // One reminder per watcher per hour, even when several trigger files are missing.
  if (paths.length && t - loggedAt >= TRIGGER_MISSING_REPEAT_MS) {
    const path = paths[0]!;
    toolLog({ component: "runner", kind: "event", name: "runner.trigger_missing.repeat", ok: true,
      ids: { watcher: watcher.id }, props: { ...path, missingForS: Math.max(0, (t - Date.parse(path.missingSince)) / 1000) } });
    loggedAt = t;
    changed = true;
  }
  if (!changed) return;
  if (paths.length) state.trigger_missing = { paths, loggedAt };
  else delete state.trigger_missing;
  saveState(watcher.id, state);
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

export async function skipStuckCheck(id: string): Promise<boolean> {
  const t = now(), group = checkGroups.previous(id, t);
  if (!group) return false;
  const ageMs = t - group.killedAt!;
  if (t >= group.nextLogAt) {
    group.nextLogAt = t + Math.max(1_000, group.watcher.interval_s * 1_000);
    // stdout reaches runner.log without opening the watcher's potentially stalled volume.
    log(null, `skip: previous check group ${group.pgid} still alive ${Math.floor(ageMs / 1000)}s after SIGKILL (stuck in kernel) watcher=${id}: ${group.diagnostic}`);
    toolLog({ component: "runner", kind: "event", name: "watch.skip", ids: { watcher: id },
      props: { outcome: "stuck_previous", pgid: group.pgid, ageMs, diagnostic: group.diagnostic } });
  }
  return true;
}

async function alertStuckGroup(group: CheckGroup, t: number): Promise<void> {
  const ageMs = t - group.killedAt!, id = group.watcher.id;
  if (ageMs >= 30 * 60_000 && !group.alerted && !group.alerting) {
    group.alerting = true;
    try {
      const sent = await alert(group.watcher, `Watcher "${group.watcher.title}" check group ${group.pgid} is still alive ${Math.floor(ageMs / 60_000)} min after SIGKILL: ${group.diagnostic}. New runs paused until it exits.`,
        `stuck-group:${id}:${group.pgid}`);
      group.alerted = sent.ok;
      log(null, `stuck group ${group.pgid} alert ok=${sent.ok} via=${sent.via} watcher=${id}`);
    } finally { group.alerting = false; }
  }
}

export async function recordStuckGroups(): Promise<void> {
  // Removed and paused watchers still own their surviving groups; notices cannot depend on listIds().
  const groups = checkGroups.stuck(), t = now();
  const count = checkGroups.globalWarning();
  if (count !== undefined) {
    log(null, `runner: ${count} check groups stuck in kernel — likely system-wide FS/TCC stall`);
    toolLog({ component: "runner", kind: "event", name: "watch.stuck_global", props: { count } });
  }
  await Promise.all(groups.map(group => alertStuckGroup(group, t)));
}

export async function tickOne(id: string): Promise<void> {
  if (shuttingDown) return;
  try {
    try {
      await applyOwnerAlertResults(id);
      await tickWatcher(id);
    } finally {
      if (!shuttingDown) {
        await applyOwnerAlertResults(id);
        if (!shuttingDown) dispatchOwnerAlerts(id);
        if (!shuttingDown) await recoveryNotice(id);
      }
    }
  } catch (error) {
    if (error instanceof CheckStuckError) { await skipStuckCheck(id); return; }
    if (!(error instanceof CheckShutdownError)) throw error;
  }
}

async function recoveryNotice(id: string): Promise<void> {
  if (shuttingDown) return;
  const instance = watcherInstance(id);
  const pending = await withRelayLockAsync(() => {
    if (shuttingDown || watcherInstance(id) !== instance) return;
    const watcher = loadWatcher(id), state = loadState(id);
    const notice = state.failure_recovery_notices?.[0];
    if (!watcher || !notice || (notice.retry_at ?? 0) > now()) return;
    notice.retry_at = now() + 60_000;
    saveState(id, state);
    return { watcher, ...notice };
  });
  if (!pending || shuttingDown) return;
  const sent = await alert(pending.watcher, pending.text, pending.key, "info");
  log(id, `auto-resume notice ok=${sent.ok} via=${sent.via}`);
  if (sent.ok && !shuttingDown) await withRelayLockAsync(() => {
    if (!loadWatcher(id) || watcherInstance(id) !== instance) return;
    const fresh = loadState(id);
    fresh.failure_recovery_notices = fresh.failure_recovery_notices?.filter(notice => notice.key !== pending.key);
    if (!fresh.failure_recovery_notices?.length) delete fresh.failure_recovery_notices;
    saveState(id, fresh);
  });
}

async function failedProbe(id: string, state: State, instance: string | undefined, attempt: number, previousNextAt: string, message: string, duration: number): Promise<void> {
  await withRelayLockAsync(() => {
    const current = loadWatcher(id), fresh = loadState(id);
    if (shuttingDown || !current || current.paused || watcherInstance(id) !== instance
      || fresh.failure_paused_at !== state.failure_paused_at || fresh.failure_probe_attempts !== state.failure_probe_attempts) return;
    fresh.recent_check_ms = recentCheckRuntimes(fresh.recent_check_ms ?? (fresh.last_run_ms === undefined ? [] : [fresh.last_run_ms]), duration);
    fresh.last_run_ms = duration;
    // Acquiring the mutex yields, so a hold may start after the check completes.
    if (held(current)) {
      fresh.failure_probe_attempts = attempt - 1;
      fresh.failure_probe_next_at = previousNextAt;
      fresh.next_at = 0;
      saveState(id, fresh);
      log(id, `probe ${attempt} failure ignored while held; retry deadline restored`);
      log(id, heldByMaintenance(current, maintenance) ? "check failure ignored during maintenance" : "check failure ignored while SSD is unmounted");
      return;
    }
    fresh.last_error = message;
    fresh.failure_probe_attempts = attempt;
    fresh.failure_probe_next_at = iso(now() + failureProbeDelay(attempt));
    saveState(id, fresh);
    const firstLine = message.split(/\r?\n/, 1)[0]!.slice(0, 500);
    log(id, `probe ${attempt} failed: ${firstLine}; next probe ${fresh.failure_probe_next_at}`);
    toolLog({ component: "runner", kind: "event", name: "watch.pause_probe", ok: false, durationMs: duration,
      ids: { watcher: id }, props: { attempt, ok: false, duration_ms: duration, next_at: fresh.failure_probe_next_at, error_first_line: firstLine } });
  });
}

async function tickWatcher(id: string): Promise<void> {
  const instance = watcherInstance(id);
  const sameInstance = () => watcherInstance(id) === instance;
  const initial = loadWatcher(id);
  if (!initial) return;
  finishRecoveredCap(id);
  await withRelayLockAsync(() => recoverAdmission(id, instance));
  let state = loadState(id);
  const unacked = state.discarded_run ?? state.reply_handoff?.accepted_run
    ?? (state.admitted_run?.accepted ? state.admitted_run.run : undefined);
  if (unacked) {
    // State records acceptance before the separate helper ack; finish that ack after a crash/write failure.
    try { await withRelayLockAsync(() => acknowledgeRun(id, instance, unacked)); }
    catch (error) { if (error instanceof CheckShutdownError) throw error; toolError("runner", "watch.ack_failed", { watcher: id }); return; }
    state = loadState(id);
    finishRecoveredCap(id);
    state = loadState(id);
  }
  const initialPoller = pollingWatcher(initial, state);
  if (!initialPoller) return;
  if (!held(initialPoller)) await confirmWakes(initialPoller);
  if (!sameInstance()) return;
  state = loadState(id);
  await headsUps(initialPoller, state);
  if (!sameInstance()) return;
  if (state.failure_paused_at && !state.failure_probe_next_at && !initialPoller.paused && initialPoller.failure_pause_probe !== false) await withRelayLockAsync(() => {
    const definition = loadWatcher(id);
    state = loadState(id);
    const current = definition && pollingWatcher(definition, state);
    if (sameInstance() && current && ensureFailureProbe(current, state)) saveState(id, state);
  });
  if (state.failure_paused_at) await pauseNotice(initialPoller, state);
  if (!sameInstance()) return;
  const definition = loadWatcher(id);
  if (!definition) return;
  state = loadState(id);
  const watcher = pollingWatcher(definition, state);
  if (!watcher) return;
  if (state.status === "closing" && now() >= state.closing_until! && (watcher.paused || (state.closing_final_check && !state.pending && !state.batch))) {
    await withRelayLockAsync(() => finalizeClosing(id));
    return;
  }
  if (!checking(state) || watcher.paused) return;
  if (held(watcher)) return;
  const t = now();
  recordCadence(watcher);
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
  const probing = !finalCheck && failureProbeDue(watcher, state, t);
  if (state.failure_paused_at && !finalCheck && !probing) return;
  if (state.batch?.watcher && !sameDestination(state.batch.watcher, watcher)) return;
  if (state.status !== "closing" && !state.reply_handoff && !state.admitted_run && watcher.max_fires !== 0 && state.fires + (state.batch?.events.length ?? 0) >= watcher.max_fires) return;
  if (await skipStuckCheck(id)) return;
  // Trigger files (e.g. chat.db-wal) run the check as soon as they change; interval_s stays the fallback.
  // A failing watcher keeps its backoff; the signature is recorded before the run so a change mid-run re-triggers.
  let sig: string | undefined;
  const missing: MissingTrigger[] = [];
  try { sig = triggerSig(watcher, trigger => missing.push(trigger)); }
  catch (error) {
    if (!(error instanceof TriggerError)) throw error;
    if ((state.next_at ?? 0) > t && !probing && !(finalCheck && !state.closing_final_started)) return;
    state.last_run_at = iso(t);
    if (finalCheck) state.closing_final_started = true;
    delete state.load_timeouts;
    delete state.load_timeout_since;
    logTriggerError(watcher, state, error, t);
    if (probing) {
      const attempt = (state.failure_probe_attempts ?? 0) + 1;
      log(id, `probe ${attempt}`);
      await failedProbe(id, state, instance, attempt, state.failure_probe_next_at!, error.message, 0);
      return;
    }
    await failWatcher(watcher, state, instance, t, false, error.message);
    return;
  }
  if (state.trigger_error) {
    delete state.trigger_error;
    saveState(id, state);
  }
  logMissingTriggers(watcher, state, missing, t);
  const initialMissing = state.trigger_sig === undefined && sig?.split("|").every(part => part === "missing");
  const triggered = !initialMissing && sig !== undefined && sig !== state.trigger_sig && !state.consecutive_failures && !state.load_timeouts && !state.pending
    && t - Date.parse(state.last_run_at ?? "1970-01-01") >= (watcher.trigger_gap_s ? watcher.trigger_gap_s * 1_000 : TRIGGER_MIN_GAP_MS);
  if ((state.next_at ?? 0) > t && !probing && !triggered && !(finalCheck && !state.closing_final_started)) return;
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
  let slotTiming: SlotTiming | undefined;
  let probe: { pausedAt: string; attempt: number; previousNextAt: string } | undefined;
  const dueAt = probing ? Date.parse(state.failure_probe_next_at!) : triggered || finalCheck || !state.next_at || state.next_at < 0 ? t : state.next_at;
  const scheduledAt = Number.isFinite(dueAt) && dueAt > 0 && !triggered && !finalCheck && (probing || (state.next_at ?? 0) > 0) ? iso(dueAt) : "";
  const classification = checkClassification(state.last_run_ms, state.recent_check_ms);
  let lane = classification.lane, laneReason = classification.reason;
  const trigger = finalCheck ? "final" : state.consecutive_failures || state.load_timeouts ? "retry" : triggered ? "trigger" : "schedule";
  let lateMs = 0, loadModeAtAdmission = false;
  const result = await slots.run(async timing => {
    if (shuttingDown) return;
    slotTiming = timing;
    lane = timing.slotLane ?? lane;
    if (lane !== classification.lane) laneReason = "fast:overdue";
    lateMs = Math.max(0, now() - dueAt);
    loadModeAtAdmission = loadMode.high;
    return withRelayLockAsync(() => {
    if (shuttingDown || !sameInstance() || checkGroups.previous(id)) return undefined;
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
    if (!current || !checking(state) || current.paused || held(current)) return undefined;
    if (state.failure_paused_at && !final) {
      if (!probing || !failureProbeDue(current, state)) return undefined;
      const attempt = state.failure_probe_attempts = (state.failure_probe_attempts ?? 0) + 1;
      probe = { pausedAt: state.failure_paused_at, attempt, previousNextAt: state.failure_probe_next_at! };
      // A crash during the check consumes one attempt, rather than replaying overdue checks in a burst.
      state.failure_probe_next_at = iso(now() + failureProbeDelay(attempt));
      log(id, `probe ${attempt}`);
    } else if (probing) return undefined;
    if (state.batch?.watcher && !sameDestination(state.batch.watcher, current)) return undefined;
    handoffRun = state.reply_handoff?.run;
    recoveredRun = state.admitted_run?.run;
    runId = recoveredRun ?? attemptId;
    if (final && !handoffRun) { finalDeadline = state.closing_until; state.closing_final_started = true; }
    checkedWatcher = current;
    (state.cadence ??= { since: now() }).lastStart = now();
    state.admitted_run = { run: runId, attempt: attemptId, watcher: current };
    schedule();
    startLoad = sampleLoad();
    timeoutMs = checkTimeout(current, startLoad);
    timing.startLateMs = Math.max(0, now() - dueAt);
    slotStart(current, timing, "check", runId);
    if (state.consecutive_failures || state.load_timeouts) toolLog({ component: "runner", kind: "event", name: "watch.retry", ids: { watcher: id, run: runId }, props: { action: "check", attempt: state.consecutive_failures + 1 } });
    return runCheck(current, watcherDir(id), { HEALTH_TOOLLOG_SCHEDULED_AT: scheduledAt, HEALTH_TOOLLOG_TRIGGER: state.consecutive_failures || state.load_timeouts ? "retry" : "schedule", WATCH_RUN: runId, WATCH_ATTEMPT: attemptId, WATCH_CLOSING: state.status === "closing" ? "1" : "0", ...(healthRun ? { HEALTH_TOOLLOG_RUN: healthRun } : {}) }, timeoutMs, instance);
    });
  }, { watcher: id, run: attemptId, operation: "check", intervalMs: watcher.interval_s * 1_000,
    dueAt, lane, recentMinMs: classification.recentMinMs, urgent: watcher.urgent === true });
  if (!result || shuttingDown) return;
  const runTimedOut = result.timedOut && (result.code === null || result.code === 0);
  const failed = runTimedOut || result.code !== 0;
  const endLoad = sampleLoad();
  const loadTimeout = runTimedOut && Math.max(startLoad, endLoad) >= LOAD_HIGH;
  const queuedMs = Math.max(0, now() - t - result.ms);
  const starved = (!failed || loadTimeout) && isStarved(watcher.interval_s, slotTiming?.slotWaitMs ?? 0);
  toolLog({ component: "runner", kind: failed ? "error" : "perf", name: "watch.run", durationMs: result.ms, ok: !failed, ids: { watcher: id, run: runId }, props: { outcome: result.busy ? "busy" : runTimedOut ? "timeout" : failed ? "fail" : result.stdout.trim() ? "fire" : "no_change", ...(result.busy ? { stderrClass: "dependency_busy", dependency: result.busy.dependency } : {}), exitCode: result.code, signal: result.signal, timedOut: result.timedOut, queuedMs, urgent: watcher.urgent === true, starved, slotPickReason: slotTiming?.slotPickReason ?? "fifo", ...slotTiming, dueAt, lateMs, lane, lane_reason: laneReason, recentMinMs: classification.recentMinMs, loadMode: loadModeAtAdmission, intervalMs: watcher.interval_s * 1_000, trigger }, ...(failed ? { error: { tag: result.busy ? "watch.dependency_busy" : runTimedOut ? "watch.timeout" : "watch.check_failed" } } : {}) });
  if (!sameInstance()) return;
  let fresh = loadState(id);
  const currentDefinition = loadWatcher(id);
  const current = currentDefinition && pollingWatcher(currentDefinition, fresh);
  if (!current || !checking(fresh)) return;
  if (probe && (current.paused || fresh.failure_paused_at !== probe.pausedAt || fresh.failure_probe_attempts !== probe.attempt)) {
    log(id, `probe ${probe.attempt} completed after pause/resume/remove; state kept`);
    return;
  }
  const ackRun = async () => {
    try { await withRelayLockAsync(() => acknowledgeRun(id, instance, runId)); }
    catch (error) { if (error instanceof CheckShutdownError) throw error; toolError("runner", "watch.ack_failed", { watcher: id }); }
  };
  if (fresh.status === "closing" && checkedWatcher?.check !== current.check) {
    // Only the reply-only command may recover helper output. Keep its original delivery identity
    // until that poll succeeds, so an unacked outbox cannot cross recipients after a retarget.
    if (checkedWatcher?.inflight_check) {
      fresh.reply_handoff ??= { run: runId, watcher: { ...checkedWatcher, check: checkedWatcher.inflight_check } };
    } else fresh.discarded_run = runId;
    delete fresh.admitted_run;
    fresh.next_at = 0;
    saveState(id, fresh);
    if (!checkedWatcher?.inflight_check) await ackRun();
    log(id, "normal check completed after removal; only the configured in-flight check may emit during grace");
    return;
  }
  fresh.recent_check_ms = recentCheckRuntimes(fresh.recent_check_ms ?? (fresh.last_run_ms === undefined ? [] : [fresh.last_run_ms]), result.ms);
  fresh.last_run_ms = result.ms;
  const cadenceState = fresh.cadence ??= { since: t };
  cadenceState.lastEnd = now();
  cadenceState.lastQueuedMs = queuedMs;
  if (failed) cadenceState.lastOutcome = starved ? "starved" : loadTimeout ? "load timeout" : "fail";
  const queued = now() - t - result.ms;
  if (starved) log(id, starvedText(queuedMs, slotTiming!, checkSlotCap(loadModeAtAdmission) + 2, result.ms, loadTimeout ? timeoutMs : undefined));
  else if (result.ms >= SLOW_RUN_MS || queued >= 5_000) log(id, `slow run: check ${(result.ms / 1000).toFixed(1)}s, queued ${(queued / 1000).toFixed(1)}s, slot_wait ${((slotTiming?.slotWaitMs ?? 0) / 1000).toFixed(1)}s, depth ${slotTiming?.slotQueueDepth ?? 0}, active ${slotTiming?.slotActiveAtEnqueue ?? 0}`);
  // A shell can exit nonzero while a descendant holds its pipes until the deadline.
  const timedOut = result.timedOut && (result.code === null || result.code === 0);
  if (timedOut || result.code !== 0) {
    if (probe) {
      await failedProbe(id, fresh, instance, probe.attempt, probe.previousNextAt,
        result.busy ? `busy: ${result.busy.dependency}: ${result.busy.detail}` : timedOut ? `timed out after ${timeoutMs / 1000}s` : `exit ${result.code}: ${result.stderr.trim().slice(-500)}`, result.ms);
      return;
    }
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
      if (fresh.dependency_busy) {
        delete fresh.dependency_busy;
        fresh.failure_episode = randomUUID();
        clearFailureEscalation(fresh);
        fresh.failure_escalation_key = `robob-watch:${id}:escalate:${hash(fresh.failure_episode).slice(0, 32)}:wake`;
      }
      fresh.load_timeouts = (fresh.load_timeouts ?? 0) + 1;
      fresh.load_timeout_since ??= iso();
      if (now() - Date.parse(fresh.load_timeout_since) < LOAD_GRACE_MS) {
        fresh.last_error = `timed out after ${timeoutMs / 1000}s under host load ${Math.max(startLoad, endLoad).toFixed(1)}/core`;
        delete fresh.last_error_sources;
        fresh.next_at = now() + Math.min(watcher.interval_s, TIMEOUT_BACKOFF_CAP_S) * 1_000;
        urgentLoadRetry(current, fresh, now());
        saveState(id, fresh);
        if (!starved) log(id, `load timeout (${fresh.load_timeouts}): ${fresh.last_error}`);
        return;
      }
    }
    await failWatcher(watcher, fresh, instance, t, timedOut,
      result.busy ? `busy: ${result.busy.dependency}: ${result.busy.detail}` : timedOut ? `timed out after ${timeoutMs / 1000}s` : `exit ${result.code}: ${result.stderr.trim().slice(-500)}`,
      timedOut || result.busy ? [] : failureSources(result.stderr),
      timedOut && result.stderr.trim() ? ` | stderr: ${result.stderr.trim().slice(-300)}` : "", result.busy);
    return;
  }
  if (finalDeadline !== undefined && fresh.status === "closing" && fresh.closing_until === finalDeadline) fresh.closing_final_check = true;
  const recoveredCadence = completeCadence(fresh, now(), result.stdout.trim() ? "fire" : "no_change", queuedMs, starved);
  if (recoveredCadence) {
    log(id, `cadence recovered after ${Math.floor(recoveredCadence.staleMs / 60_000)} min`);
    toolLog({ component: "runner", kind: "event", name: "watch.cadence_recovered", ids: { watcher: id }, props: recoveredCadence });
  }
  delete fresh.load_timeouts;
  delete fresh.load_timeout_since;
  if (fresh.consecutive_failures) {
    const failures = fresh.consecutive_failures;
    const notified = fresh.failure_alerted;
    toolLog({ component: "runner", kind: "event", name: "watch.recovered", ids: { watcher: id }, props: { count: failures, failures, notified } });
    log(id, `check recovered after ${failures} failures (${notified ? "notified" : "not notified"})`);
  }
  if (probe) {
    const pausedMs = Math.max(0, now() - Date.parse(probe.pausedAt));
    const duration = pausedDuration(pausedMs);
    const text = `Watcher "${watcher.title}" is running again on its own after ${duration} paused (retry ${probe.attempt} passed).`;
    if (fresh.owner_imessage_episodes?.some(episode => !episode.recovery) && ownerFailureAlerts(current, fresh)) queueOwnerRecovery(current, fresh, text);
    else (fresh.failure_recovery_notices ??= []).push({
      key: `robob-watch:${id}:auto-resumed:${hash(fresh.failure_episode ?? fresh.failing_since ?? probe.pausedAt)}`, text,
    });
    log(id, `auto-resumed after ${duration} (probe ${probe.attempt})`);
    toolLog({ component: "runner", kind: "event", name: "watch.pause_probe", ok: true, durationMs: result.ms,
      ids: { watcher: id }, props: { attempt: probe.attempt, ok: true, duration_ms: result.ms } });
    toolLog({ component: "runner", kind: "event", name: "watch.auto_resumed", ids: { watcher: id },
      props: { paused_ms: pausedMs, attempts: probe.attempt } });
  } else queueOwnerRecovery(watcher, fresh);
  clearFailureState(fresh);
  if (handoffRun && fresh.reply_handoff?.run === handoffRun) {
    fresh.reply_handoff.accepted_run = runId;
    fresh.next_at = 0;
  }
  const { event, urgent } = checkEvent(result.stdout);
  if (fresh.admitted_run?.run === runId) fresh.admitted_run.accepted = true;
  if (!event) {
    saveState(id, fresh); await ackRun();
    fresh = loadState(id);
    finishRecoveredCap(id);
    if (fresh.status === "closing" && fresh.closing_final_check && !fresh.batch) await withRelayLockAsync(() => finalizeClosing(id));
    await runPendingCheck(watcher, t, true);
    return;
  }
  queueEvent(checkedWatcher!, fresh, event, urgent, !!handoffRun || !!recoveredRun);
  if (healthRun) {
    if (fresh.pending) fresh.pending.healthRun = healthRun;
    else if (fresh.batch) (fresh.batch.healthRuns ??= []).push(healthRun);
  }
  saveState(id, fresh);
  await ackRun();
  log(id, `event: ${event.slice(0, 500)}`);
  if (inQuiet(watcher.quiet)) log(id, "quiet hours: event held until they end");
  if (fresh.pending && !current.paused) await deliverPending(current, fresh);
  await runPendingCheck(watcher, t, true);
}

let previousMaintenance: Maintenance | undefined;
let urgentWarningAt: number | undefined;
const cadenceNotices = new Set<string>();
async function monitorCadence(id: string): Promise<void> {
  const instance = watcherInstance(id);
  const notice = await withRelayLockAsync(() => {
    const definition = loadWatcher(id), state = loadState(id);
    const watcher = definition && pollingWatcher(definition, state);
    if (!watcher?.urgent || !checking(state)) return;
    const at = now(), suspended = !!(watcher.paused || held(watcher) || state.failure_paused_at);
    if (syncCadenceSuspension(watcher, state, at, maintenance, ssdMounted)) saveState(id, state);
    if (suspended) return;
    const stale = cadenceStale(watcher, state, at);
    if (!stale) return;
    const c = state.cadence!;
    const queue = slots.queue();
    const lastOutcome = c.lastOutcome === "starved" ? "starved" : queue.some(row => row.watcher === id) ? "queued" : stale.lastOutcome;
    if (c.staleAt === undefined) {
      c.staleAt = at;
      toolLog({ component: "runner", kind: "event", name: "watch.cadence_stale", ids: { watcher: id }, props: { ...stale, lastOutcome } });
      saveState(id, state);
    }
    if (c.alerted || (c.alertRetryAt ?? 0) > at || inQuiet(watcher.quiet)) return;
    c.alertRetryAt = at + 60_000;
    c.alertText ??= `robob-watch: ${id} has not completed a check for ${Math.floor(stale.staleMs / 60_000)} min (last: ${lastOutcome}, queue depth ${queue.length}, load ${hostLoad().toFixed(1)}/core)`;
    saveState(id, state);
    return { watcher, episode: c.staleAt, text: c.alertText };
  });
  if (!notice) return;
  const sent = await alert(notice.watcher, notice.text, `robob-watch:${id}:cadence:${notice.episode}`);
  await withRelayLockAsync(() => {
    if (watcherInstance(id) !== instance) return;
    const state = loadState(id);
    if (state.cadence?.staleAt !== notice.episode) return;
    if (sent.ok) state.cadence.alerted = true;
    saveState(id, state);
  });
}
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
function recordCadence(watcher: Watcher): void {
  const key = `${iso().slice(0, 10)}:${watcher.interval_s}`;
  if (cadence.get(watcher.id) === key) return;
  cadence.set(watcher.id, key);
  toolLog({ component: "runner", kind: "event", name: "watch.cadence", ids: { watcher: watcher.id }, props: { intervalMs: watcher.interval_s * 1_000 } });
}
export async function tick(): Promise<void> {
  if (shuttingDown) return;
  void recordStuckGroups().catch(() => toolError("runner", "watch.stuck_notice_failed"));
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
  let live = 0, urgent = 0;
  for (const id of listIds()) {
    const definition = loadWatcher(id), state = loadState(id);
    const watcher = definition && pollingWatcher(definition, state);
    if (watcher && checking(state)) {
      if (!watcher.paused) live++;
      if (watcher.urgent) {
        if (!watcher.paused) urgent++;
        if (!cadenceNotices.has(id)) {
          cadenceNotices.add(id);
          void monitorCadence(id).catch(() => toolError("runner", "watch.cadence_failed", { watcher: id })).finally(() => cadenceNotices.delete(id));
        }
      }
    }
    if (running.has(id)) {
      // A queued check can span midnight without entering tickWatcher again.
      if (!cadence.get(id)?.startsWith(`${iso().slice(0, 10)}:`)) {
        const watcher = loadWatcher(id), state = loadState(id);
        if (watcher && checking(state) && !watcher.paused && !held(watcher)) recordCadence(watcher);
      }
      continue;
    }
    running.add(id);
    jobs.push(tickOne(id).catch(error => { toolError("runner", "watch.runner_failed", { watcher: id }); log(id, `runner error: ${String(error).slice(0, 500)}`); }).finally(() => running.delete(id)));
  }
  if (urgent > live / 4 && (urgentWarningAt === undefined || now() - urgentWarningAt >= 3600_000)) {
    urgentWarningAt = now();
    log(null, `urgent watchers: ${urgent} of ${live}`);
  }
  // Watchers run concurrently; a slow one never delays the next tick of the others.
  void Promise.all(jobs);
}

let tickTimer: ReturnType<typeof setInterval> | undefined;
installCheckShutdown(() => {
  shuttingDown = true;
  if (tickTimer) clearInterval(tickTimer);
});

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
      await killRunningChecks();
      process.exit(0);
    }
  }
  writeFileSync(pidPath, `${process.pid}\n`);
  log(null, `robob-watch runner started pid=${process.pid} host load=${hostLoad().toFixed(1)}/core`);
  await tick().catch(() => toolError("runner", "watch.tick_failed"));
  if (!shuttingDown) tickTimer = setInterval(() => void tick().catch(() => toolError("runner", "watch.tick_failed")), TICK_MS);
}
