import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { volumeState, recordWritten, recordDrop, recordWriteError, pendingVolumes, volumeSnapshot, volumeProps, startVolumeReports } from './volume.mjs';

const CAP = 200 * 1024 * 1024;
const seen = new Set();
const failurePhases = new WeakMap();
const connectionFailures = new WeakMap();
const scans = new AsyncLocalStorage();
const socketConnects = new AsyncLocalStorage();
const socketRequests = new WeakMap();
export const connectionErrnos = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN']);
const syscalls = new Set(['connect', 'read', 'write', 'getaddrinfo', 'send', 'recv', 'shutdown']);
export function safeTarget(value) {
  try {
    if (typeof value !== 'string' || value.length > 4096 || !/^(?:https?|wss?):\/\//i.test(value) || /[\s\\]/.test(value)) return undefined;
    const url = new URL(value);
    const ports = { 'http:':'80', 'https:':'443', 'ws:':'80', 'wss:':'443' };
    if (!ports[url.protocol] || !url.hostname || url.hostname.length > 253 || !/^[a-zA-Z0-9._:[\]-]+$/.test(url.hostname)) return undefined;
    return `${url.protocol}//${url.hostname}:${url.port || ports[url.protocol]}`;
  } catch { return undefined; }
}
export function tagConnectionFailure(error, url, attemptNo = 1) {
  try {
    const pending = [error], seen = new Set();
    while (pending.length && seen.size < 16) {
      const cause = pending.shift();
      if (!cause || typeof cause !== 'object' || seen.has(cause)) continue;
      seen.add(cause);
      const known = connectionFailures.get(cause);
      if (known) {
        connectionFailures.set(error, {...known, target:safeTarget(url), attemptNo});
        break;
      }
      const errno = [cause.code, cause.errno].find(code => connectionErrnos.has(code));
      if (errno) {
        connectionFailures.set(error, { target:safeTarget(url), errno,
          ...(syscalls.has(cause.syscall) ? {syscall:cause.syscall} : {}), attemptNo });
        break;
      }
      pending.push(cause.cause, cause.error, ...(Array.isArray(cause.errors) ? cause.errors.slice(0, 16) : []));
    }
  } catch { /* Untrusted errors must not affect the caller. */ }
  return error;
}
// Node's WebSocket ErrorEvent hides errno. Correlate the handshake request and
// upgraded socket by identity, never by matching a shared host or request path.
channel('undici:request:create').subscribe(message => {
  try {
    const connection = socketConnects.getStore();
    if (connection) socketRequests.set(message.request, connection);
  } catch {}
});
channel('undici:request:error').subscribe(message => {
  try {
    const connection = socketRequests.get(message.request);
    if (connection) {
      tagConnectionFailure(message.error, connection.target);
      const failure = connectionFailures.get(message.error);
      if (failure) connection.failure = failure;
    }
  } catch {}
});
channel('undici:client:sendHeaders').subscribe(message => {
  try {
    const connection = socketRequests.get(message.request);
    if (!connection) return;
    const capture = error => {
      tagConnectionFailure(error, connection.target);
      const failure = connectionFailures.get(error);
      if (failure) connection.failure = failure;
    };
    // This listener precedes undici's post-upgrade listener, so its otherwise
    // generic ErrorEvent can inherit metadata from the actual Node socket.
    const socket = message.socket;
    socket.once('error', capture);
    socket.once('close', () => socket.removeListener('error', capture));
  } catch {}
});
export function connectionWebSocket(url, options) {
  const connection = {target:safeTarget(url)};
  const socket = socketConnects.run(connection, () => new WebSocket(url, options));
  socket.addEventListener('error', event => {
    try { if (connection.failure) connectionFailures.set(event.error ?? event, connection.failure); } catch {}
  });
  return socket;
}
export async function errorScan(work) {
  if (scans.getStore()) return work();
  const scan = { errors:new Map(), seen:new WeakSet() };
  try { return await scans.run(scan, work); }
  finally {
    scan.closed = true;
    for (const row of scan.errors.values()) emit(row.component, row.name, row);
    scan.errors.clear();
  }
}
export function recordFailure(component, name, error, fields = {}) {
  try {
    const scan = scans.getStore();
    const connection = connectionFailures.get(error);
    if (connection && scan) {
      if (scan.seen.has(error)) return;
      scan.seen.add(error);
    }
    const phase = failurePhases.get(error);
    emit(component, name, { ...fields, props:{...fields.props, ...replicaProps(error), ...httpProps(error), ...connection,
      ...(phase ? {phase} : {}), ...(connection ? {step:phase ?? fields.props?.step ?? name} : {})},
      kind:'error', ok:false, error:connection ? {tag:connection.errno} : failure(error) });
  } catch { /* Logging must preserve the original error. */ }
}
export function recordConnectionFailure(component, name, error, fields) {
  if (connectionFailures.has(error)) recordFailure(component, name, error, fields);
}
const props = new Set(['model','size','count','status','enabled','locked','limited','reloginNeeded','state','action','tag','dryRun','complete','cost','hour','exitCode','attempt','source','failed','total','fourxx','fivexx','phase','durationMaxMs','omitted']);
for (const prop of ['target', 'step', 'errno', 'syscall', 'attemptNo', 'firstTs', 'lastTs', 'ok', 'loopBlockMaxMs', 'longestSyncOp', 'longestSyncMs', 'httpStatus']) props.add(prop);
const numericScanProps = new Set(['loopBlockMaxMs', 'longestSyncMs']);
const safeProp = (key, value) => {
  if (key === 'reason') return ['boot_exhausted', 'below_minimum', 'exhausted', 'retry_dropped', 'unavailable'].includes(value);
  if (key === 'httpStatus') return Number.isFinite(value);
  if (numericScanProps.has(key)) return Number.isFinite(value) && value >= 0;
  if (key === 'longestSyncOp') return Boolean(token(value));
  if (key === 'step') return Boolean(token(value));
  if (key === 'target') return ['control', 'opencode'].includes(value) || Boolean(safeTarget(value));
  if (key === 'errno') return connectionErrnos.has(value);
  if (key === 'syscall') return syscalls.has(value);
  if (key === 'attemptNo') return Number.isSafeInteger(value) && value > 0;
  if (key === 'firstTs' || key === 'lastTs') return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
  if (key === 'ok') return typeof value === 'boolean';
  return typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || token(value);
};
const ids = new Set(['account','connection','thread','incident','request','session']);
ids.add('writer');
for (const prop of ['firstAttemptMs', 'retryAttemptMs', 'outcome', 'consecutive', 'sinceMs', 'reason']) props.add(prop);
const token = v => typeof v === 'string' && /^[A-Za-z0-9_.:/-]{1,100}$/.test(v) && !/(sk-|bearer|password|secret|token|api.?key|otp|cookie|prompt|@)/i.test(v) ? v : undefined;
const errorTag = v => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(v) ? token(v) : undefined;
// Only fixed operational messages survive. Exception text can contain arbitrary
// provider output, credentials or a filesystem path, even after regex redaction.
const messages = new Set(['Robob replica is stale; recovery deferred', 'Robob replica is not ready',
  'thread is newer than Robob replica; recovery deferred', 'unverified Robob replica',
  'The operation was aborted due to timeout', 'The operation was aborted', 'fetch failed']);
const errorMessage = (value, tag) => messages.has(value) ? value.slice(0, 300) : tag;
// Replica metadata is untrusted. Invalid values become an explicit unknown.
const replicaProps = value => Object.fromEntries(['replicaGeneration', 'replicaAgeMs', 'threadAheadMs', 'deferredThreads', 'maxThreadAheadMs']
  .filter(key => value?.[key] !== undefined)
  .map(key => [key, Number.isFinite(value[key]) ? value[key] : 'unknown']));
const httpProps = value => Number.isFinite(value?.httpStatus) ? { httpStatus: value.httpStatus } : {};
export function failure(value, result = false) {
  try {
    const fetchFailed = !result && value?.name === 'TypeError' && value?.message === 'fetch failed';
    const causedAbort = !result && ['AbortError', 'TimeoutError'].includes(value?.name) && value?.cause;
    const causeTag = fetchFailed || causedAbort
      ? errorTag(value?.cause?.code) ?? errorTag(value?.cause?.name) ?? 'FETCH_FAILED' : undefined;
    const tag = causeTag ?? (result ? errorTag(value?.tag) : undefined) ?? errorTag(value?.code)
      ?? (result ? undefined : errorTag(value?.name)) ?? 'operation_failed';
    return { tag, message: errorMessage(value?.message, tag) };
  } catch { return { tag: 'operation_failed', message: 'operation_failed' }; }
}
// Keep metadata off caller-owned errors, including frozen errors. Only the
// operation identifier is retained; arguments and exception text stay out.
export function tagFailurePhase(error, phase) {
  if (error !== null && ['object', 'function'].includes(typeof error) && token(phase)) failurePhases.set(error, phase);
  return error;
}
export function clean(event, now = new Date()) {
  const name = token(event.name), component = token(event.component);
  if (!name || !component || !['event','perf','error'].includes(event.kind)) return null;
  const row = { ts: now.toISOString(), tool: '9router', component, kind: event.kind, name };
  if (Number.isFinite(event.durationMs) && event.durationMs >= 0) row.durationMs = Math.round(event.durationMs * 1000) / 1000;
  if (typeof event.ok === 'boolean') row.ok = event.ok;
  const safeIds = Object.fromEntries(Object.entries(event.ids ?? {}).filter(([k,v]) => ids.has(k) && ['string','number'].includes(typeof v)).map(([k,v]) => [k,createHash('sha256').update(String(v)).digest('hex').slice(0,16)]));
  const safeProps = Object.fromEntries(Object.entries(event.props ?? {}).filter(([k,v]) => props.has(k) && safeProp(k, v)));
  if (safeProps.target && !['control', 'opencode'].includes(safeProps.target)) safeProps.target = safeTarget(safeProps.target);
  Object.assign(safeProps, replicaProps(event.props));
  if (name === 'log.volume') Object.assign(safeProps, volumeProps(event.props));
  if (Object.keys(safeIds).length) row.ids = safeIds;
  if (Object.keys(safeProps).length) row.props = safeProps;
  if (event.error) { const tag = token(event.error.tag) ?? 'unknown'; row.error = { tag, message: errorMessage(event.error.message, tag) }; }
  return row;
}
export function emit(component, name, fields = {}) {
  let counts;
  try {
    // Direct test runs and their children must opt into a log destination.
    if (process.env.ROUTER_LOG_DIR === undefined && process.env.NODE_TEST_CONTEXT !== undefined) return;
    const now = new Date(), day = now.toISOString().slice(0,10);
    const root = process.env.ROUTER_LOG_DIR ?? join(homedir(), '.robob/logs/tools/9router');
    counts = volumeState(root, day);
    const row = clean({ ...fields, component, name, kind: fields.kind ?? 'event' }, now);
    if (!row) { recordDrop(counts, 'invalid_event'); return; }
    if (Buffer.byteLength(JSON.stringify(row)+'\n') > 4096) { recordDrop(counts, 'line_size'); return; }
    const scan = scans.getStore();
    if (scan && row.kind === 'error' && connectionErrnos.has(row.props?.errno) && safeTarget(row.props?.target)) {
      if (scan.closed) {
        row.props = {...row.props, count:1, firstTs:row.ts, lastTs:row.ts};
        write(root, day, now, row, counts);
        return;
      }
      const key = JSON.stringify([component, row.props.target, row.props.errno]);
      const previous = scan.errors.get(key);
      if (previous) {
        previous.props.count++;
        previous.props.lastTs = row.ts;
        previous.props.attemptNo = row.props.attemptNo;
      } else scan.errors.set(key, { ...row, props:{...row.props, count:1, firstTs:row.ts, lastTs:row.ts} });
      return;
    }
    write(root, day, now, row, counts);
  } catch { if (counts) recordDrop(counts, 'invalid_event'); }
}
function write(root, day, now, row, counts) {
  const volume = row.name === 'log.volume';
  try {
    if (Buffer.byteLength(JSON.stringify(row)+'\n') > 4096) { recordDrop(counts, 'line_size'); return false; }
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.chmodSync(root, 0o700);
    const key = `${root}/${day}`;
    if (!seen.has(key)) {
      try {
        fs.closeSync(fs.openSync(join(root, `.retention-${day}`), 'wx', 0o600));
        const cutoff = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0,10);
        for (const file of fs.readdirSync(root)) {
          const match = /^(?:rollup-|\.cap-|\.retention-)?(\d{4}-\d{2}-\d{2})(?:\.ndjson|\.json)?$/.exec(file);
          if (match && match[1] < cutoff) fs.unlinkSync(join(root, file));
        }
      } catch (e) { if (e.code !== 'EEXIST') throw e; }
      seen.add(key);
    }
    const fd = fs.openSync(join(root, `${day}.ndjson`), 'a', 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      if (fs.fstatSync(fd).size >= CAP) {
        try {
          fs.closeSync(fs.openSync(join(root, `.cap-${day}`), 'wx', 0o600));
          fs.writeSync(fd, JSON.stringify(clean({ component:'logger', name:'log.cap', kind:'error', error:{tag:'daily_cap'} }, now)) + '\n');
          recordWritten(counts, 'log.cap');
        } catch (e) { if (e.code !== 'EEXIST') throw e; }
        // Drop counters must remain visible after the daily cap.
        if (row.kind !== 'error' && !volume) { recordDrop(counts, 'daily_cap'); return false; }
      }
      fs.writeSync(fd, JSON.stringify(row) + '\n');
      if (!volume) recordWritten(counts, row.name);
      return true;
    } finally { fs.closeSync(fd); }
  } catch { recordWriteError(counts, !volume); return false; }
}
export function reportVolume(heartbeat = false) {
  for (const counts of pendingVolumes(heartbeat)) {
    try {
      if (!fs.existsSync(counts.root) || !fs.statSync(counts.root).isDirectory()) continue;
      const file = join(counts.root, counts.day+'.ndjson');
      const snapshot = volumeSnapshot(counts, fs.existsSync(file) ? fs.statSync(file).size : 0);
      const now = new Date(counts.day + new Date().toISOString().slice(10));
      const row = clean({component:'logger',name:'log.volume',kind:'event',ids:snapshot.ids,props:snapshot.props},now);
      if (write(counts.root,counts.day,now,row,counts)) counts.reported = snapshot.version;
    } catch { recordWriteError(counts, false); }
  }
}
startVolumeReports(reportVolume, reportVolume);
export async function observed(component, name, work, fields = {}) {
  const start = performance.now();
  let result;
  try {
    result = await work();
  } catch (error) {
    try { recordFailure(component, name, error, { ...fields, durationMs:performance.now()-start }); } catch {}
    throw error;
  }
  try {
    const ok = result?.ok !== false && (!fields.exitCodeResult || result === 0);
    emit(component, name, { ...fields, kind: ok ? 'perf' : 'error', ok, durationMs:performance.now()-start, ...(ok ? {} : { error: failure(result, true) }) });
  } catch { /* Caller-owned metadata must not change a successful result. */ }
  return result;
}
