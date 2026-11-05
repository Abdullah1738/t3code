import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const MAX_REPLICA_AGE_MS = 45_000;

export function replicaPath(env = process.env, home = env.HOME || homedir()) {
  return env.STREAM_RECOVERY_DB || env.ROBOB_READONLY_DB || join(home, '.robob/userdata/readonly/state.sqlite');
}

// stat/realpath only: never open the writer to identify aliases of it.
export function assertReplicaPath(path, home = process.env.HOME || homedir(), env = process.env) {
  if (typeof path !== 'string' || !path || path.startsWith('file:') || path.includes('\0')) {
    throw new Error('replica must be a filesystem path');
  }
  const candidate = resolve(path);
  const expandHome = (value) => value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : value;
  const homes = [join(home, '.robob'), join(home, '.t3'), '/Volumes/ExternalSSD/robob-data',
    ...['ROBOB_HOME', 'T3CODE_HOME'].flatMap((key) => env[key] ? [expandHome(env[key])] : [])];
  const livePaths = homes.flatMap((root) => ['statev2.sqlite', 'state.sqlite'].map((name) => resolve(root, 'userdata', name)));
  livePaths.push(join(home, '.local/share/opencode/opencode.db'));
  if (env.XDG_DATA_HOME) livePaths.push(resolve(expandHome(env.XDG_DATA_HOME), 'opencode/opencode.db'));
  for (const live of livePaths) {
    if (candidate === resolve(live)) throw new Error('refusing live Robob/OpenCode database');
  }
  const real = realpathSync(candidate);
  const info = statSync(candidate);
  if (!info.isFile()) throw new Error('replica is not a regular file');
  for (const live of livePaths) {
    let liveReal, liveInfo;
    try { liveReal = realpathSync(live); liveInfo = statSync(live); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (real === liveReal || (info.dev === liveInfo.dev && info.ino === liveInfo.ino)) {
      throw new Error('refusing live Robob/OpenCode database alias');
    }
  }
  return real;
}

const snapshots = new WeakMap();

export function registerReplica(db, path) {
  const updatedMs = replicaTimestamp(db);
  snapshots.set(db, { db, path, updatedMs });
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

function replicaTimestamp(db) {
  const meta = Object.fromEntries(db.prepare(
    "select key, value from ardud_readonly_meta where key in ('ready','updated_at','schema_version')",
  ).all().map(({ key, value }) => [key, value]));
  const updatedMs = typeof meta.updated_at === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(meta.updated_at)
    ? Date.parse(meta.updated_at) : NaN;
  if (meta.ready !== '1' || meta.schema_version !== '1' || !Number.isFinite(updatedMs)) {
    throw new Error('Robob replica is not ready');
  }
  return updatedMs;
}

// The timestamp belongs to the opened snapshot, not a newer file renamed over it.
export function assertReplicaFresh(db, now = Date.now()) {
  const snapshot = snapshots.get(db);
  if (!snapshot) throw new Error('unverified Robob replica');
  const age = now - snapshot.updatedMs;
  try {
    replicaTimestamp(snapshot.db);
    if (age < -5_000 || age > MAX_REPLICA_AGE_MS) throw new Error('Robob replica is stale; recovery deferred');
    assertReplicaPath(snapshot.path);
  } catch (e) {
    e.code = 'REPLICA_UNAVAILABLE';
    throw e;
  }
}

// An idle Stop can leave latestRunId unchanged. A newer shell timestamp still
// proves the replica cannot yet know whether that mutation was a Stop.
export function assertThreadInReplica(db, thread) {
  assertReplicaFresh(db);
  const updatedMs = Date.parse(thread?.updatedAt);
  if (!Number.isFinite(updatedMs) || updatedMs > snapshots.get(db).updatedMs) {
    throw Object.assign(new Error('thread is newer than Robob replica; recovery deferred'), { code: 'REPLICA_UNAVAILABLE' });
  }
}
