// Stall watch: one pass over OpenCode's active sessions per scan. Spots
// sessions that stay "running" with nothing changing, interrupts them, follows
// up until they are clear, then reports once. The caller loads and saves state.
import * as realIo from "./io.mjs";
import { truncate } from "./detect.mjs";
import { cutoverOwns, isOpenCodeSessionId, openCodeSession, recoveryOwned } from './harness.mjs';
import {
  FALLBACK_MS, GHOST_LABEL, GHOST_RUN_MS, GIVE_UP_MS, buildStallNote, buildStallSummary, fingerprint,
  ghostCandidates, observe, observeGhosts, planGhost, planStall, quietSince, sessionLetGo, stallCleared,
  stallId, tailActivity,
} from "./stall.mjs";

const DAY_MS = 86_400_000;
const MAX_TRIES = 3;

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
  const cutover = await io.harnessCutoverStatus();
  const active = new Set([...(await io.activeSessions())].filter(isOpenCodeSessionId));
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
    Object.assign(stall, { outcome, detail: detail ?? null, done: true, doneAt: iso });
    stall.summary = buildStallSummary(stall).text.split("\n")[0];
    log(`stall ${id}: ${outcome}${detail ? ` (${detail})` : ""} | ${truncate(stall.title, 60)}`);
    notify(id, stall);
  };
  // The OpenCode interrupt is retried on later scans when the call itself fails.
  const ocStop = async (stall) => {
    if (stall.threadId && await recoveryOwned(io, stall.threadId, [stall.runId])) {
      Object.assign(stall, { done: true, note: false, outcome: 'superseded', summary: 'harness cutover owns continuation; no recovery action' });
      return;
    }
    stall.ocTries = (stall.ocTries ?? 0) + 1;
    try {
      stall.ocInterrupted = await io.ocInterrupt(stall.ses);
      stall.ocTried = now;
    } catch (err) {
      stall.errors.push(`opencode interrupt: ${errText(err)}`);
      if (stall.ocTries >= MAX_TRIES) stall.ocTried = now;
    }
  };

  // Summaries whose Telegram send failed get a few more tries.
  for (const [id, stall] of Object.entries(state.stalls)) {
    if (stall.done && stall.telegram === false && (stall.telegramTries ?? 1) < MAX_TRIES) notify(id, stall);
  }

  // Follow up on stalls interrupted by earlier scans.
  for (const [id, stall] of open) {
    if (!isOpenCodeSessionId(stall.ses) || cutoverOwns(cutover, stall.threadId, [stall.runId])) {
      Object.assign(stall, { done: true, note: false, outcome: 'superseded', summary: 'harness cutover or native session; no recovery action' });
      continue;
    }
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
      if (thread && openCodeSession(thread) !== stall.ses) stall.note = false;
      if (stall.note && !stall.noted && thread && !dryRun) {
        try {
          if (await recoveryOwned(io, stall.threadId, [stall.runId])) {
            Object.assign(stall, { done: true, note: false, outcome: 'superseded', summary: 'harness cutover owns continuation; no recovery action' });
            continue;
          }
          await io.sendToThread(stall.threadId, buildStallNote(stall), { clientRequestId: `${id}:note`, mode: "queue" });
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
      if (thread && cutoverOwns(cutover, thread.threadId, [thread.activeRunId])) continue;
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
    };
    log(`stall ${id}: ${plan.action} | ${truncate(title, 60)} | quiet ${Math.round(quietMs / 60_000)}m | ${activity.label} | ${plan.reason}${dryRun ? " (dry run)" : ""}`);
    report.push({ id, ...stall });
    if (dryRun) continue;
    if (thread && await recoveryOwned(io, thread.threadId, [thread.activeRunId])) continue;
    state.stalls[id] = stall;
    if (plan.action === "report") {
      finish(id, stall, "report");
    } else if (plan.action === "opencode") {
      await ocStop(stall);
    } else {
      try {
        const res = await io.interruptThread(stall.threadId, { clientRequestId: id, reason: `stall watch: ${activity.label}`, expectedRunId: stall.runId });
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
    const ghosts = ghostCandidates(live, active).filter((t) => !cutoverOwns(cutover, t.threadId, [t.activeRunId]));
    state.ghosts = observeGhosts(state.ghosts, ghosts, now);
    const installing = io.installerResumePendingMs() != null;
    // The tail read is awaited after the snapshots above, so the run may have moved
    // on or OpenCode may have picked the session up. Re-check just before acting.
    const stillGhost = async (t, g) => {
      try {
        const [fresh, freshActive] = await Promise.all([io.activeThreads(), io.activeSessions()]);
        const cur = fresh.find((x) => x.threadId === t.threadId);
        return cur !== undefined && ghostCandidates([cur], freshActive).length === 1
          && cur.activeRunId === g.runId && cur.nativeSessionId === g.ses
          && !(await recoveryOwned(io, t.threadId, [g.runId]));
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
        reason: plan.reason, interruptedAt: now, errors: [],
      };
      log(`stall ${id}: ${plan.action} | ${truncate(stall.title, 60)} | ghost run ${Math.round(quietMs / 60_000)}m | ${plan.reason}${dryRun ? " (dry run)" : ""}`);
      report.push({ id, ...stall });
      if (dryRun) continue;
      state.stalls[id] = stall;
      if (plan.action === "report") {
        finish(id, stall, "report");
        continue;
      }
      try {
        const res = await io.interruptThread(t.threadId, { clientRequestId: id, reason: `stall watch: ${GHOST_LABEL}`, expectedRunId: t.activeRunId });
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
  return report;
}
