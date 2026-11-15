const { emit, observed, tagFailurePhase = error => error } = await import('../../router-logging/toollog.mjs').catch(() => ({ emit: () => {}, observed: (_c, _n, work) => work() }));
export { emit, observed };

export function deferThread(io, threadId, error) {
  if (error?.code !== 'REPLICA_BEHIND_THREAD') return false;
  io.recordThreadDeferral?.(threadId, error);
  emit('stream-recovery', 'thread.deferred', { ids:{thread:threadId},
    props:{replicaGeneration:error.replicaGeneration,replicaAgeMs:error.replicaAgeMs,threadAheadMs:error.threadAheadMs},
    error:{tag:error.code,message:error.message} });
  return true;
}
const phases = new Set(['acquireLock', 'loadState', 'saveState', 'openDb', 'serverRuntime', 'openCodeRuntime',
  'failedRunsSince', 'failedSubagentsSince', 'cancelledSubagentsSince', 'cancelledDelegatedTasksSince',
  'childRunOutcomeSince', 'delegatedStoppedSince', 'childNativeSession', 'restartRunsSince', 'stoppedSince',
  'restartNoteRun', 'threadRoot', 'subagentsStartedSince', 'runStartedSince', 'turnCutAndIdle',
  'subagentResultSeen', 'subagentParent', 'laterRuns', 'queuedRuns', 'runMessages', 'messageText',
  'threadMessageIdsSince', 'harnessCutoverStatus', 'getThread', 'robobHealthy', 'installerResumePendingMs',
  'sendToThread', 'threadByNative', 'interruptThread', 'activeThreads', 'dispatchCommand', 'activeSessions',
  'ocSession', 'ocMessages', 'ocForms', 'ocPermissions', 'ocTail', 'ocChildren', 'ocInterrupt', 'telegram']);

export async function timedScan(name, io, work) {
  const totals = new Map(), timed = { ...io };
  const deferred = new Set();
  const props = { deferredThreads:0, maxThreadAheadMs:'unknown' };
  timed.recordThreadDeferral = (threadId, error) => {
    deferred.add(threadId);
    props.deferredThreads = deferred.size;
    if (Number.isFinite(error.threadAheadMs)) props.maxThreadAheadMs =
      Number.isFinite(props.maxThreadAheadMs) ? Math.max(props.maxThreadAheadMs, error.threadAheadMs) : error.threadAheadMs;
    // Nested restart scans also contribute to the enclosing stream scan.
    io.recordThreadDeferral?.(threadId, error);
  };
  for (const key of phases) {
    if (typeof io[key] !== 'function') continue;
    timed[key] = (...args) => {
      const start = performance.now();
      const finish = (failed = false) => {
        const ms = performance.now() - start;
        const row = totals.get(key) ?? { ms: 0, max: 0, count: 0, failed: 0 };
        row.ms += ms; row.max = Math.max(row.max, ms); row.count++; row.failed += Number(failed);
        totals.set(key, row);
      };
      try {
        const result = io[key](...args);
        if (result && typeof result.then === 'function') return result.then(
          value => { finish(); return value; }, error => { finish(true); throw tagFailurePhase(error, key); });
        finish();
        return result;
      } catch (error) { finish(true); throw tagFailurePhase(error, key); }
    };
  }
  try { return await observed('stream-recovery', `${name}.scan`, () => work(timed), {props}); }
  finally {
    // Aggregate repeated calls and cap output, including on failed scans. No
    // SQL, call arguments or server responses are retained by the timer.
    const ordered = [...totals].sort((a, b) => b[1].ms - a[1].ms);
    const selected = ordered.slice(0, 5);
    if (ordered.length > 5) selected.push(['other', ordered.slice(5).reduce((a, [, r]) => ({
      ms: a.ms + r.ms, max: Math.max(a.max, r.max), count: a.count + r.count, failed: a.failed + r.failed,
    }), { ms: 0, max: 0, count: 0, failed: 0 })]);
    for (const [phase, row] of selected) emit('stream-recovery', `${name}.phase`, {
      kind: 'perf', ok: row.failed === 0, durationMs: row.ms,
      props: { phase, count: row.count, failed: row.failed, durationMaxMs: row.max,
        ...(phase === 'other' ? { omitted: ordered.length - 5 } : {}) },
    });
  }
}
const operations = new Set(['sendToThread', 'interruptThread', 'dispatchCommand', 'ocInterrupt']);
const wrapped = new WeakSet();
// Wrap only mutations. Message bodies and arbitrary server responses never enter logs.
export function recoveryIo(io) {
  const result = { ...io };
  for (const key of [...operations, 'telegram']) {
    const value = io[key];
    if (typeof value !== 'function' || wrapped.has(value)) continue;
    const work = (...args) => {
      if (key !== 'telegram') return observed('stream-recovery', `recovery.${key}`, () => value.apply(io, args));
      const start = performance.now();
      try {
        const reply = value.apply(io, args);
        emit('stream-recovery', 'recovery.telegram', {kind:'perf',ok:true,durationMs:performance.now()-start});
        return reply;
      } catch (error) {
        emit('stream-recovery', 'recovery.telegram', {kind:'error',ok:false,durationMs:performance.now()-start,error:{tag:'notification_failed'}});
        throw error;
      }
    };
    wrapped.add(work);
    result[key] = work;
  }
  return result;
}
