// Stall watch: one pass over OpenCode's active sessions per scan. Spots
// sessions that stay "running" with nothing changing, interrupts them, follows
// up until they are clear, then reports once. The caller loads and saves state.
import * as realIo from "./io.mjs";
import { isNestedThreadId, truncate } from "./detect.mjs";
import {
  FALLBACK_MS, GHOST_LABEL, GHOST_RUN_MS, GIVE_UP_MS, buildStallNote, buildStallSummary, fingerprint,
  ghostCandidates, observe, observeGhosts, planGhost, planStall, quietSince, sessionLetGo, stallCleared,
  stallId, tailActivity,
} from "./stall.mjs";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MAX_TRIES = 3;
const IDENTITY_BUDGET_MS = 1_000;
const IDENTITY_DEFER_MS = 5 * 60_000;

const childThread = (id) => isNestedThreadId(id) || (typeof id === "string" && id.startsWith("thread:delegated-task:"));

// A fork is a separate thread; a subagent belongs to its nearest non-subagent owner.
function directOwner(thread) {
  if (!thread?.threadId || thread.relationshipToParent === "subagent") return null;
  if (thread.relationshipToParent === "fork") return thread.threadId;
  if (thread.relationshipToParent !== null || thread.parentThreadId !== null || childThread(thread.threadId)) return null;
  return thread.threadId;
}

function sameStall(a, b) {
  if (!a.ses || a.ses !== b.ses) return false;
  const aRun = a.alertRunId ?? a.runId;
  const bRun = b.alertRunId ?? b.runId;
  if (aRun && bRun) return aRun === bRun;
  return Number.isFinite(a.quietSince) && Number.isFinite(b.quietSince)
    && Math.floor(a.quietSince / 1000) === Math.floor(b.quietSince / 1000);
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const errText = (err) => String(err?.message || err).slice(0, 300);

export async function stallScan({ state, now, dryRun = false, verbose = false, log }, io = realIo) {
  const iso = new Date(now).toISOString();
  const active = await io.activeSessions();
  const tails = new Map();
  await mapLimit([...active], 8, async (ses) => {
    try {
      const messages = await io.ocTail(ses, 2);
      if (messages) tails.set(ses, messages);
    } catch (err) {
      if (verbose) log(`stall: ${ses} tail failed: ${errText(err)}`);
    }
  });

  const fps = new Map();
  for (const [ses, messages] of tails) {
    const fp = fingerprint(messages);
    fps.set(ses, fp);
    state.watch[ses] = observe(state.watch[ses], fp, now);
  }
  const open = Object.entries(state.stalls).filter(([, s]) => !s.done);
  const openSes = new Set(open.map(([, s]) => s.ses));
  for (const ses of Object.keys(state.watch)) {
    if (!active.has(ses) && !openSes.has(ses)) delete state.watch[ses];
  }

  const report = [];
  const notifications = [];
  const identityHints = new Map();
  const notify = (id, stall) => {
    const summary = buildStallSummary(stall);
    if (dryRun) return log(`summary (${summary.severity}):\n${summary.text}`);
    stall.telegramTries = (stall.telegramTries ?? 0) + 1;
    try {
      io.telegram({ text: summary.text, severity: summary.severity, key: `stream-recovery:${id}` });
      stall.telegram = true;
    } catch (err) {
      stall.telegram = false;
      log(`telegram failed (${stall.telegramTries}/${MAX_TRIES}): ${errText(err)}`);
    }
  };
  const finish = (id, stall, outcome, detail) => {
    // A dry run may report what would happen but must not finish a stored stall.
    const completed = dryRun ? { ...stall } : stall;
    Object.assign(completed, { outcome, detail: detail ?? null, done: true, doneAt: iso });
    completed.summary = buildStallSummary(completed).text.split("\n")[0];
    if (!dryRun) completed.alertPending = true;
    log(`stall ${id}: ${outcome}${detail ? ` (${detail})` : ""} | ${truncate(stall.title, 60)}`);
    notifications.push([id, completed]);
  };
  // The OpenCode interrupt is retried on later scans when the call itself fails.
  const ocStop = async (stall) => {
    stall.ocTries = (stall.ocTries ?? 0) + 1;
    try {
      stall.ocInterrupted = await io.ocInterrupt(stall.ses);
      stall.ocTried = now;
    } catch (err) {
      stall.errors.push(`opencode interrupt: ${errText(err)}`);
      if (stall.ocTries >= MAX_TRIES) stall.ocTried = now;
    }
  };

  // Follow up on stalls interrupted by earlier scans.
  for (const [id, stall] of open) {
    const age = now - stall.interruptedAt;
    const ocDone = sessionLetGo({ stall, active: active.has(stall.ses), fp: fps.get(stall.ses) ?? null });
    let thread = null;
    if (stall.threadId) {
      try {
        thread = await io.getThread(stall.threadId);
      } catch (err) {
        // Robob can't be read, but the OpenCode fallback doesn't need it.
        if (verbose) log(`stall ${id}: thread read failed: ${errText(err)}`);
        if (age >= GIVE_UP_MS) finish(id, stall, "failed", `could not read the Robob thread: ${errText(err)}`);
        else if (!ocDone && !stall.ocTried && age >= FALLBACK_MS && !dryRun && stall.kind !== "ghost") await ocStop(stall);
        report.push({ id, ...stall });
        continue;
      }
    }
    const c = stallCleared({ stall, active: active.has(stall.ses), fp: fps.get(stall.ses) ?? null, thread });
    if (c.cleared) {
      if (stall.note && !stall.noted && thread && !dryRun) {
        try {
          await io.sendToThread(stall.threadId, buildStallNote(stall), { clientRequestId: `${id}:note`, mode: "auto" });
          stall.noted = true;
        } catch (err) {
          stall.errors.push(`note: ${errText(err)}`);
          if (age >= GIVE_UP_MS) finish(id, stall, "failed", "interrupted, but the carry-on note was not sent");
          continue;
        }
      }
      finish(id, stall, "cleared");
    } else if (!c.ocDone && !stall.ocTried && age >= FALLBACK_MS && stall.kind !== "ghost") {
      const after = stall.ocTries ? "a failed OpenCode interrupt" : "the Robob interrupt";
      log(`stall ${id}: OpenCode still running ${Math.round(age / 1000)}s after ${after}, interrupting the session`);
      if (!dryRun) await ocStop(stall);
    } else if (age >= GIVE_UP_MS) {
      const detail = !c.ocDone && !c.robobDone
        ? "Robob run and OpenCode session both still running after the interrupt"
        : !c.ocDone
          ? "OpenCode session still running after the interrupt"
          : "OpenCode stopped, but Robob still shows the run as running";
      finish(id, stall, "failed", detail);
    }
    report.push({ id, ...stall });
  }

  // Look for new stalls.
  for (const [ses, messages] of tails) {
    if (openSes.has(ses)) continue;
    const activity = tailActivity(messages);
    const since = quietSince(state.watch[ses], activity.lastMs);
    const quietMs = now - since;
    if (!(quietMs >= activity.limitMs)) continue;
    const id = stallId(ses, since);
    if (state.stalls[id]) continue;

    let info, waiting, thread, childActive = false, parentTitle = null;
    try {
      info = await io.ocSession(ses);
      const [forms, permissions] = await Promise.all([io.ocForms(ses), io.ocPermissions(ses)]);
      waiting = forms.length + permissions.length > 0;
      thread = await io.threadByNative(ses);
      if (activity.kind === "subagent") childActive = (await io.ocChildren(ses)).some((c) => active.has(c));
      if (info?.parentID) parentTitle = (await io.ocSession(info.parentID).catch(() => null))?.title ?? null;
    } catch (err) {
      log(`stall: ${ses} gather failed: ${errText(err)}`);
      continue;
    }
    const recent = Object.values(state.stalls).filter(
      (s) => s.ses === ses && (s.action === "robob" || s.action === "opencode") && now - Date.parse(s.at) < DAY_MS,
    ).length;
    const plan = planStall({
      ses, kind: activity.kind, limitMs: activity.limitMs, quietMs, waiting, childActive,
      parentID: info?.parentID, thread, recent,
    });
    const title = thread?.title || info?.title || ses;
    if (plan.action === "skip") {
      if (verbose) log(`stall: skip ${ses} | ${truncate(title, 60)} | ${plan.reason}`);
      continue;
    }
    const robob = plan.action === "robob";
    const stall = {
      at: iso, ses, threadId: robob ? thread.threadId : null, runId: robob ? thread.activeRunId ?? null : null, title,
      origin: thread?.origin ?? null, parentTitle, kind: activity.kind, label: activity.label,
      quietSince: since, quietMs, fp: fps.get(ses), action: plan.action, note: plan.note ?? false,
      reason: plan.reason, interruptedAt: now, errors: [],
      alertSourceThreadId: thread?.threadId ?? null, alertParentSessionId: info?.parentID ?? null,
      alertRunId: thread?.nativeSessionId === ses ? thread.activeRunId ?? null : null,
    };
    log(`stall ${id}: ${plan.action} | ${truncate(title, 60)} | quiet ${Math.round(quietMs / 60_000)}m | ${activity.label} | ${plan.reason}${dryRun ? " (dry run)" : ""}`);
    report.push({ id, ...stall });
    if (dryRun) continue;
    state.stalls[id] = stall;
    identityHints.set(stall, { thread, info });
    if (plan.action === "report") {
      finish(id, stall, "report");
    } else if (plan.action === "opencode") {
      await ocStop(stall);
    } else {
      try {
        const res = await io.interruptThread(stall.threadId, { clientRequestId: id, reason: `stall watch: ${activity.label}` });
        stall.robobResult = res.result ?? null;
        if (res.result === "interrupt_requested") {
          stall.runId = res.runId ?? stall.runId;
        } else {
          // Robob had no run to stop, so only OpenCode is holding the session.
          // A note would start a new run Robob never had, so send none.
          Object.assign(stall, { runId: null, note: false });
          await ocStop(stall);
        }
      } catch (err) {
        stall.errors.push(`robob interrupt: ${errText(err)}`);
      }
    }
  }

  // Runs Robob shows as running while OpenCode's session sits idle never reach
  // the loop above, which only sees OpenCode's active sessions.
  let live = null;
  try {
    live = await io.activeThreads();
  } catch (err) {
    if (verbose) log(`stall: thread list failed: ${errText(err)}`);
  }
  if (live) {
    const ghosts = ghostCandidates(live, active);
    state.ghosts = observeGhosts(state.ghosts, ghosts, now);
    const installing = io.installerResumePendingMs() != null;
    // The tail read is awaited after the snapshots above, so the run may have moved
    // on or OpenCode may have picked the session up. Re-check just before acting.
    const stillGhost = async (t, g) => {
      try {
        const [fresh, freshActive] = await Promise.all([io.activeThreads(), io.activeSessions()]);
        const cur = fresh.find((x) => x.threadId === t.threadId);
        return cur !== undefined && ghostCandidates([cur], freshActive).length === 1
          && cur.activeRunId === g.runId && cur.nativeSessionId === g.ses;
      } catch (err) {
        if (verbose) log(`stall: ghost re-check failed: ${errText(err)}`);
        return false;
      }
    };
    for (const t of ghosts) {
      const g = state.ghosts[t.threadId];
      const quietMs = now - g.since;
      if (quietMs < GHOST_RUN_MS || installing || openSes.has(g.ses)) continue;
      const id = stallId(g.ses, g.since);
      if (state.stalls[id]) continue;
      let lastMs = 0;
      try {
        lastMs = tailActivity((await io.ocTail(g.ses, 2)) ?? []).lastMs;
      } catch (err) {
        if (verbose) log(`stall: ${g.ses} tail failed: ${errText(err)}`);
        continue;
      }
      // The session did something recently, so this is not a dead turn.
      if (now - lastMs < GHOST_RUN_MS) continue;
      if (!(await stillGhost(t, g))) {
        // Start the 15 min clock again from the next scan.
        delete state.ghosts[t.threadId];
        continue;
      }
      const recent = Object.values(state.stalls).filter(
        (s) => s.ses === g.ses && (s.action === "robob" || s.action === "opencode") && now - Date.parse(s.at) < DAY_MS,
      ).length;
      const plan = planGhost({ thread: t, recent });
      const stall = {
        at: iso, ses: g.ses, threadId: t.threadId, runId: t.activeRunId, title: t.title || g.ses,
        origin: t.origin ?? null, parentTitle: null, kind: "ghost", label: GHOST_LABEL,
        quietSince: g.since, quietMs, fp: null, action: plan.action, note: plan.note,
        reason: plan.reason, interruptedAt: now, errors: [], alertRunId: t.activeRunId,
      };
      log(`stall ${id}: ${plan.action} | ${truncate(stall.title, 60)} | ghost run ${Math.round(quietMs / 60_000)}m | ${plan.reason}${dryRun ? " (dry run)" : ""}`);
      report.push({ id, ...stall });
      if (dryRun) continue;
      state.stalls[id] = stall;
      identityHints.set(stall, { thread: t });
      if (plan.action === "report") {
        finish(id, stall, "report");
        continue;
      }
      try {
        const res = await io.interruptThread(t.threadId, { clientRequestId: id, reason: `stall watch: ${GHOST_LABEL}` });
        stall.robobResult = res.result ?? null;
        if (res.result === "interrupt_requested") {
          // Track the run we verified, not whatever run the server reports back.
          if (res.runId && res.runId !== t.activeRunId) stall.errors.push(`interrupted ${res.runId}, expected ${t.activeRunId}`);
          stall.runId = t.activeRunId;
        } else {
          Object.assign(stall, { runId: null, note: false });
        }
      } catch (err) {
        stall.errors.push(`robob interrupt: ${errText(err)}`);
      }
    }
  }
  // Identity work and Telegram are deliberately after every recovery action.
  // All extra reads share a deadline, including parent traversal and migration.
  const deadline = Date.now() + IDENTITY_BUDGET_MS;
  const ownerCache = new Map();
  let lookups = 0;
  const bounded = async (fn) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || lookups++ >= 32) return null;
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(fn).catch(() => null),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), remaining); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  const owner = async (stall) => {
    if (stall.alertOwnerId) return stall.alertOwnerId;
    if (ownerCache.has(stall)) return ownerCache.get(stall);
    const hints = identityHints.get(stall);
    let ses = stall.ses;
    let info = hints?.info;
    let thread = hints?.thread;
    if (!thread && (stall.alertSourceThreadId || stall.threadId)) {
      const id = stall.alertSourceThreadId || stall.threadId;
      thread = await bounded(() => io.getThread(id));
    }
    const seenSessions = new Set();
    let found = null;
    while (ses && !seenSessions.has(ses) && seenSessions.size < 16) {
      seenSessions.add(ses);
      if (!thread) thread = await bounded(() => io.threadByNative(ses));
      const seenThreads = new Set();
      while (thread?.threadId && !seenThreads.has(thread.threadId)) {
        seenThreads.add(thread.threadId);
        found = directOwner(thread);
        if (found || !thread.parentThreadId) break;
        const parent = thread.parentThreadId;
        thread = await bounded(() => io.getThread(parent));
      }
      if (found) break;
      if (info === undefined) info = await bounded(() => io.ocSession(ses));
      ses = info?.parentID || (seenSessions.size === 1 ? stall.alertParentSessionId : null);
      info = undefined;
      thread = null;
    }
    ownerCache.set(stall, found);
    if (found && !dryRun) stall.alertOwnerId = found;
    return found;
  };

  // Capture already-read mappings first, so simultaneous active and ghost
  // detections can correlate without waiting on unrelated historical lookups.
  for (const [stall, hint] of identityHints) {
    const id = directOwner(hint.thread);
    if (id) {
      ownerCache.set(stall, id);
      stall.alertOwnerId = id;
    }
  }

  const entries = Object.entries(state.stalls);
  const eligible = async (id, stall) => {
    if (typeof stall.alertEligible === "boolean") return stall.alertEligible;
    const at = Date.parse(stall.at);
    if (!Number.isFinite(at)) return null;
    const index = entries.findIndex(([key]) => key === id);
    const prior = entries.filter(([otherId, other], otherIndex) => {
      if (otherId === id || other.excluded || sameStall(other, stall)) return false;
      const age = at - Date.parse(other.at);
      return age >= 0 && age <= HOUR_MS && (age > 0 || otherIndex < index);
    }).map(([, other]) => other);
    if (!prior.length) return false;
    const currentOwner = await owner(stall);
    if (!currentOwner) return null;
    // Check known matches before spending the scan budget on unknown owners.
    if (prior.some((other) => (other.alertOwnerId || ownerCache.get(other)) === currentOwner)) return true;
    let unresolved = false;
    for (const other of prior) {
      const priorOwner = await owner(other);
      if (priorOwner === currentOwner) return true;
      if (!priorOwner) unresolved = true;
    }
    return unresolved ? null : false;
  };

  for (const [id, stall] of entries) {
    if (stall.done && (stall.alertPending || stall.telegram === false)
      && (stall.telegramTries ?? 0) < MAX_TRIES) notifications.push([id, stall]);
  }
  const seen = new Set();
  for (const [id, stall] of notifications) {
    if (seen.has(id)) continue;
    seen.add(id);
    let send = await eligible(id, stall);
    if (send === null && now - Date.parse(stall.doneAt || stall.at) >= IDENTITY_DEFER_MS) {
      send = false;
      if (!dryRun) stall.alertSuppressed = "owner_unresolved";
    }
    if (!dryRun) {
      stall.alertPending = send === null;
      if (send !== null) stall.alertEligible = send;
    }
    if (send === true) notify(id, stall);
    else log(`stall ${id}: Telegram ${send === null ? "deferred (owner unavailable)" : "suppressed (no confirmed repeat)"}`);
  }
  // Resolve new unmapped children even before they finish: their records are
  // prior evidence if another stall is detected before the next scan.
  for (const stall of identityHints.keys()) await owner(stall);
  return report;
}
