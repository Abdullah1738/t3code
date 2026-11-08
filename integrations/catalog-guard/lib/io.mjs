// I/O for catalog-guard: Robob's provider cache (read-only), the OpenCode
// service's model list, Robob's server.refreshProviders RPC, the state file.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const HOME = process.env.HOME || homedir();
export const PATHS = {
  cache: process.env.CATALOG_GUARD_CACHE || join(HOME, '.robob/caches/opencode.json'),
  // catalog-guard has no component name of its own; it runs as one of the
  // local watchers. A T3_CONTROL_TOKEN_FILE must exist; otherwise the shared
  // file is the last resort while it exists.
  control: process.env.T3_CONTROL_TOKEN_FILE
    ? [process.env.T3_CONTROL_TOKEN_FILE]
    : [join(HOME, '.robob/components/watchers.json'), join(HOME, '.robob/ardud-control.json')],
  ocPassword: join(HOME, '.config/opencode-service/password'),
  state: process.env.CATALOG_GUARD_STATE || join(HOME, '.local/share/catalog-guard/data/state.json'),
};
export const OC_URL = (process.env.OPENCODE_SERVICE_URL || 'http://127.0.0.1:49374').replace(/\/$/, '');
// Robob probes the catalog from its own working directory, the home folder.
export const PROBE_DIRECTORY = process.env.CATALOG_GUARD_DIRECTORY || HOME;
export const INSTANCE_ID = process.env.CATALOG_GUARD_INSTANCE || 'opencode';

export function configuredWatch(env = process.env) {
  const required = env.CATALOG_GUARD_REQUIRED === undefined ? undefined : JSON.parse(env.CATALOG_GUARD_REQUIRED);
  if (required !== undefined && (!Array.isArray(required) || !required.every((s) => typeof s === 'string' && s.length))) {
    throw new Error('CATALOG_GUARD_REQUIRED must be a JSON array of model slugs');
  }
  return { required, prefix: env.CATALOG_GUARD_PREFIX };
}

const parse = (text) => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

export function readJson(path) {
  if (!existsSync(path)) return null;
  return parse(readFileSync(path, 'utf8'));
}

export function readState(path = PATHS.state) {
  return readJson(path) ?? {};
}

export function writeState(state, path = PATHS.state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

/** Slugs the shared OpenCode service lists for Robob's probe directory. */
export async function serviceSlugs({ directory = PROBE_DIRECTORY, timeoutMs = 20_000 } = {}) {
  const auth = 'Basic ' + Buffer.from(`opencode:${readFileSync(PATHS.ocPassword, 'utf8').trim()}`).toString('base64');
  const url = `${OC_URL}/api/model?${new URLSearchParams({ 'location[directory]': directory })}`;
  const res = await fetch(url, { headers: { authorization: auth }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`opencode /api/model: HTTP ${res.status}`);
  const body = parse(await res.text());
  const data = Array.isArray(body?.data) ? body.data : [];
  return data.map((m) => `${m.providerID}/${m.id}`);
}

function control() {
  const fromEnv = process.env.T3_CONTROL_URL && process.env.T3_CONTROL_TOKEN;
  const file = fromEnv
    ? undefined
    : PATHS.control.length === 1
      ? PATHS.control[0]
      : PATHS.control.find((path) => existsSync(path));
  if (file && statSync(file).mode & 0o077) throw new Error(`${file} must be chmod 600`);
  const cfg = (file && readJson(file)) ?? {};
  return {
    url: (process.env.T3_CONTROL_URL || cfg.url || 'http://127.0.0.1:3773').replace(/\/$/, ''),
    token: process.env.T3_CONTROL_TOKEN || cfg.token,
  };
}

export async function harnessCutoverStatus({ timeoutMs = 15_000 } = {}) {
  const { url, token } = control();
  if (!token) throw new Error('no control token');
  const response = await fetch(`${url}/api/ardud/control/harness-cutover/status`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs),
  });
  const body = parse(await response.text());
  const cutover = body?.cutover;
  if (!response.ok || body?.ok !== true || typeof cutover?.active !== 'boolean' || typeof cutover.completed !== 'boolean'
    || (cutover.retainedOpenCodeModels !== undefined && (!Array.isArray(cutover.retainedOpenCodeModels)
      || !cutover.retainedOpenCodeModels.every((s) => typeof s === 'string')))) {
    throw new Error('harness-cutover status unavailable or invalid; catalog refresh held');
  }
  return cutover;
}

/**
 * Robob's targeted provider refresh, the same RPC the web app's refresh button
 * sends. Re-probes one instance; no restart, no OpenCode location reload.
 * Resolves with the refreshed instance's model slugs.
 */
export function refreshProviders({ instanceId = INSTANCE_ID, timeoutMs = 90_000 } = {}) {
  if (instanceId !== 'opencode') return Promise.reject(new Error('OpenCode service comparator cannot refresh a native provider'));
  const { url, token } = control();
  if (!token) return Promise.reject(new Error('no control token'));
  const wsUrl = `${url.replace(/^http/, 'ws')}/ws?orchestrationProtocol=2`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } });
    ws.binaryType = 'arraybuffer';
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      fn(v);
    };
    const timer = setTimeout(() => finish(reject, new Error('refreshProviders: timeout')), timeoutMs);
    ws.addEventListener('open', () =>
      ws.send(JSON.stringify({ _tag: 'Request', id: '1', tag: 'server.refreshProviders', payload: { instanceId }, headers: [] })),
    );
    ws.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
      const parsed = parse(raw);
      for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
        if (!msg) continue;
        if (msg._tag === 'Ping') ws.send(JSON.stringify({ _tag: 'Pong' }));
        else if (msg._tag === 'Exit') {
          if (msg.exit?._tag !== 'Success') {
            // The failure body can echo request details; keep only its tag.
            finish(reject, new Error(`refreshProviders: ${msg.exit?._tag ?? 'failed'}`));
            continue;
          }
          const providers = msg.exit.value?.providers ?? [];
          const provider = providers.find((p) => p?.instanceId === instanceId);
          finish(resolve, {
            status: provider?.status ?? null,
            slugs: (provider?.models ?? []).map((m) => m.slug),
          });
        } else if (msg._tag === 'Defect') finish(reject, new Error('refreshProviders: defect'));
      }
    });
    ws.addEventListener('error', () => finish(reject, new Error('refreshProviders: socket error')));
    ws.addEventListener('close', () => finish(reject, new Error('refreshProviders: closed before reply')));
  });
}
