import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const MAX_REPLICA_AGE_MS = 45_000;

export function isReplicaUnavailable(error) {
  return error?.code === 'REPLICA_UNAVAILABLE' || error?.code === 'REPLICA_NOT_READY'
    || error?.code === 'REPLICA_BEHIND_THREAD';
}

function replicaError(message, code, { generation, updatedMs } = {}, now = Date.now()) {
  return Object.assign(new Error(message), {
    code,
    replicaGeneration: generation ?? 'unknown',
    replicaAgeMs: Number.isFinite(updatedMs) ? now - updatedMs : 'unknown',
  });
}

export function replicaPath(env = process.env, home = env.HOME || homedir()) {
  return env.STREAM_RECOVERY_DB || env.ROBOB_READONLY_DB || join(home, '.robob/userdata/readonly/state.sqlite');
}

// stat/realpath only: never open the writer to identify aliases of it.
export function assertReplicaPath(path, home = process.env.HOME || homedir(), env = process.env) {
  if (typeof path !== 'string' || !path || path.startsWith('file:') || path.includes('\0')) {
    throw Object.assign(new Error('replica must be a filesystem path'), { code: 'REPLICA_PATH_INVALID' });
  }
  const candidate = resolve(path);
  const expandHome = (value) => value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : value;
  const homes = [join(home, '.robob'), join(home, '.t3'), '/Volumes/ExternalSSD/robob-data',
    ...['ROBOB_HOME', 'T3CODE_HOME'].flatMap((key) => env[key] ? [expandHome(env[key])] : [])];
  const livePaths = homes.flatMap((root) => ['statev2.sqlite', 'state.sqlite'].map((name) => resolve(root, 'userdata', name)));
  livePaths.push(join(home, '.local/share/opencode/opencode.db'));
  if (env.XDG_DATA_HOME) livePaths.push(resolve(expandHome(env.XDG_DATA_HOME), 'opencode/opencode.db'));
  for (const live of livePaths) {
    if (candidate === resolve(live)) throw Object.assign(new Error('refusing live Robob/OpenCode database'), { code: 'REPLICA_LIVE_PATH' });
  }
  const real = realpathSync(candidate);
  const info = statSync(candidate);
  if (!info.isFile()) throw Object.assign(new Error('replica is not a regular file'), { code: 'REPLICA_PATH_INVALID' });
  for (const live of livePaths) {
    let liveReal, liveInfo;
    try { liveReal = realpathSync(live); liveInfo = statSync(live); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (real === liveReal || (info.dev === liveInfo.dev && info.ino === liveInfo.ino)) {
      throw Object.assign(new Error('refusing live Robob/OpenCode database alias'), { code: 'REPLICA_LIVE_PATH' });
    }
  }
  return real;
}

const snapshots = new WeakMap();

export function registerReplica(db, path) {
  const meta = replicaMetadata(db);
  snapshots.set(db, { db, path, ...meta });
  assertReplicaFresh(db);
}

export function guardReplica(db) {
  const guarded = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') return (sql) => {
        assertReplicaFresh(target);
        const statement = target.prepare(sql);
        return new Proxy(statement, {
          get(prepared, method) {
            const value = Reflect.get(prepared, method, prepared);
            if (typeof value !== 'function') return value;
            return (...args) => {
              assertReplicaFresh(target);
              return value.apply(prepared, args);
            };
          },
        });
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  snapshots.set(guarded, snapshots.get(db));
  return guarded;
}

function replicaMetadata(db, now = Date.now()) {
  let meta;
  try {
    meta = Object.fromEntries(db.prepare(
      "select key, value from ardud_readonly_meta where key in ('ready','updated_at','schema_version','generation')",
    ).all().map(({ key, value }) => [key, value]));
  } catch (cause) {
    throw Object.assign(replicaError('Robob replica is not ready', 'REPLICA_NOT_READY', {}, now), { cause });
  }
  const generation = typeof meta.generation === 'string' && /^\d+$/.test(meta.generation)
    && Number.isSafeInteger(Number(meta.generation)) ? Number(meta.generation) : 'unknown';
  const updatedMs = typeof meta.updated_at === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(meta.updated_at)
    ? Date.parse(meta.updated_at) : NaN;
  if (meta.ready !== '1' || meta.schema_version !== '1' || !Number.isFinite(updatedMs)) {
    throw replicaError('Robob replica is not ready', 'REPLICA_NOT_READY', { generation, updatedMs }, now);
  }
  return { updatedMs, generation };
}

// The timestamp belongs to the opened snapshot, not a newer file renamed over it.
export function assertReplicaFresh(db, now = Date.now()) {
  const snapshot = snapshots.get(db);
  if (!snapshot) throw replicaError('unverified Robob replica', 'REPLICA_UNAVAILABLE', {}, now);
  const age = now - snapshot.updatedMs;
  try {
    replicaMetadata(snapshot.db, now);
    if (age < -5_000 || age > MAX_REPLICA_AGE_MS) {
      throw replicaError('Robob replica is stale; recovery deferred', 'REPLICA_UNAVAILABLE', snapshot, now);
    }
    assertReplicaPath(snapshot.path);
  } catch (e) {
    if (e.code !== 'REPLICA_NOT_READY') {
      e.code = 'REPLICA_UNAVAILABLE';
      e.replicaGeneration = snapshot.generation;
      e.replicaAgeMs = age;
    }
    throw e;
  }
}

// An idle Stop can leave latestRunId unchanged. A newer shell timestamp still
// proves the replica cannot yet know whether that mutation was a Stop.
export function assertThreadInReplica(db, thread) {
  assertReplicaFresh(db);
  const snapshot = snapshots.get(db);
  const updatedMs = Date.parse(thread?.updatedAt);
  if (!Number.isFinite(updatedMs) || updatedMs > snapshot.updatedMs) {
    throw Object.assign(replicaError('thread is newer than Robob replica; recovery deferred',
      'REPLICA_BEHIND_THREAD', snapshot), {
      threadAheadMs: Number.isFinite(updatedMs) ? updatedMs - snapshot.updatedMs : 'unknown',
    });
  }
}
