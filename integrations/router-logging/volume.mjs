import { randomBytes } from 'node:crypto';

export const VOLUME_INTERVAL_MS = 300000;
const writer = randomBytes(8).toString('hex');
const states = new Map();
const names = new Set(['proxy.request','proxy.retry','proxy.progress','proxy.fallback','proxy.sticky_miss','account.health','account.locked','account.lock','account.unlock','endpoint.get','poll.complete','usage.errors','usage.coverage','spend.snapshot','spend.unavailable','log.cap','log.rollup','restart.scan','restart.phase','restart.decision','restart.late','stream.scan','stream.phase','stall.scan','catalog.check','catalog.decision','relogin.tick','relogin.needed','img.request','img.result','img.fallback','img.fallback.result','img.write','auth.helper','recovery.sendToThread','recovery.dispatchCommand','recovery.telegram','other']);
names.add('pool.exhausted');
names.add('pool.recovered');
const reasons = new Set(['daily_cap','line_size','queue_full','invalid_event','write_error']);
const integer = value => Number.isSafeInteger(value) && value >= 0;

export function volumeState(root, day) {
  const key = `${root}/${day}`;
  if (!states.has(key)) states.set(key, {root,day,lines:new Map(),drops:{},writeErrors:0,writtenLines:0,version:0,reported:0});
  return states.get(key);
}
export function recordWritten(state, name) {
  name = names.has(name) ? name : 'other';
  state.lines.set(name, (state.lines.get(name) || 0) + 1);
  state.writtenLines++; state.version++;
}
export function recordDrop(state, reason) {
  state.drops[reason] = (state.drops[reason] || 0) + 1;
  state.version++;
}
export function recordWriteError(state, dropped = true) {
  state.writeErrors++; state.version++;
  if (dropped) recordDrop(state, 'write_error');
}
export function pendingVolumes(heartbeat = false) {
  const today = new Date().toISOString().slice(0,10);
  return [...states.values()].filter(state => state.version > state.reported || heartbeat && state.day === today);
}
export function volumeSnapshot(state, bytesToday) {
  const lines = [...state.lines].sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0]));
  return {version:state.version, ids:{writer}, props:{bytesToday,writtenLines:state.writtenLines,
    linesByName:Object.fromEntries(lines.slice(0,10)),otherLines:lines.slice(10).reduce((n,row)=>n+row[1],0),
    droppedByReason:{...state.drops},droppedLines:Object.values(state.drops).reduce((a,b)=>a+b,0),writeErrors:state.writeErrors}};
}
export function volumeProps(input = {}) {
  const out = {};
  for (const key of ['bytesToday','writtenLines','otherLines','droppedLines','writeErrors']) if (integer(input[key])) out[key] = input[key];
  for (const [key, allowed, cap] of [['linesByName',names,10],['droppedByReason',reasons,5]]) {
    if (input[key] && typeof input[key] === 'object' && !Array.isArray(input[key])) {
      out[key] = Object.fromEntries(Object.entries(input[key]).filter(([name,count])=>allowed.has(name) && integer(count)).slice(0,cap));
    }
  }
  return out;
}
export function startVolumeReports(report, reportSync) {
  const run = heartbeat => { try { return Promise.resolve(report(heartbeat)).catch(()=>{}); } catch { return Promise.resolve(); } };
  const timer = setInterval(() => run(true), VOLUME_INTERVAL_MS);
  timer.unref?.();
  // Short-lived helper processes must publish their final counters too.
  process.once('beforeExit', () => run(false));
  process.once('exit', () => { try { reportSync(); } catch {} });
  for (const signal of ['SIGTERM','SIGINT']) {
    process.prependOnceListener(signal, () => {
      const handledElsewhere = process.listenerCount(signal) > 0;
      try { reportSync(); } catch {}
      if (!handledElsewhere) process.kill(process.pid, signal);
    });
  }
}
