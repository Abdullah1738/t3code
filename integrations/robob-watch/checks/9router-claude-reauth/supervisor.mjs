import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLease, DEFAULT_LEASE, leaseOwner, releaseLease } from './lease.mjs';

const { emit, observed } = await import('../../../router-logging/toollog.mjs').catch(() => ({ emit: () => {}, observed: (_c, _n, work) => work() }));

export const ROOT = dirname(fileURLToPath(import.meta.url));
const STATE = join(ROOT, 'supervisor-state.json');
// No currently deployed capability is known to enforce an atomic fence over
// intended identity + enabled state + marker. A file/env flag cannot prove a
// live server capability. This build cannot launch or authorize reattachment.
export const SERVER_IDENTITY_FENCE_VERIFIED = false;
const MODEL = { instanceId: 'opencode', model: 'opus/cx/gpt-6.1-terra', variant: 'max' };
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'rolled_back']);
const BUSY = new Set(['running', 'waiting', 'queued', 'needs-input']);
const LAUNCH_STATUSES = new Set(['preparing', 'starting', 'running', 'waiting', 'queued']);
const MAX_ATTEMPTS = 3;
const MAX_SENDS = 3;
const COOLDOWNS = [5 * 60_000, 15 * 60_000];
const REPLAY_DELAY = 60_000;
const DELIVERY_DEADLINE = 3 * 60_000;
export const ROUTER_UNAVAILABLE_LIMIT_MS = 15 * 60_000;
// Allow 300s wake backoff + 240s slot queue + the runner's 90s timeout,
// with 90s scheduling slack. Check execution can outlive our own 45s timer.
export const ROUTER_STREAK_GAP_MS = 12 * 60_000;
export const SUPERVISOR_DEADLINE_MS = 45_000;
// Skip persistence is one atomic journal write (file + directory fsync).
export const SAVE_RESERVE_MS = 5_000;
export const MIN_FETCH_BUDGET_MS = 3_000;
export const BOOT_SKIP_HARD_CEILING_MS = 80_000;

function newState() { return { version: 1, incidents: [], active: null }; }

export function readState(path) {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'));
    if (s?.version !== 1 || !Array.isArray(s.incidents) || !Object.hasOwn(s, 'active')) throw new Error('invalid state');
    if (s.routerUnavailableSince !== undefined || s.routerUnavailableCount !== undefined || s.routerUnavailableLastAt !== undefined) {
      if (!Number.isFinite(s.routerUnavailableSince) || s.routerUnavailableSince < 0 || !Number.isSafeInteger(s.routerUnavailableCount) || s.routerUnavailableCount < 1) throw new Error('invalid router availability state');
      if (s.routerUnavailableLastAt !== undefined && (!Number.isFinite(s.routerUnavailableLastAt) || s.routerUnavailableLastAt < s.routerUnavailableSince)) throw new Error('invalid router availability state');
    }
    const incidentIds = new Set(), accountIds = new Set();
    for (const i of s.incidents) {
      if (typeof i.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(i.id) || typeof i.accountId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(i.accountId) || !validMarker(i.marker) || incidentIds.has(i.id) || accountIds.has(i.accountId) || !Number.isInteger(i.attempts) || i.attempts < 0 || i.attempts > MAX_ATTEMPTS || typeof i.blocked !== 'boolean' || typeof i.notified !== 'boolean' || (i.alertState !== undefined && !['pending', 'sent'].includes(i.alertState)) || !Number.isFinite(i.nextAt) || i.nextAt < 0) throw new Error('invalid incident');
      incidentIds.add(i.id); accountIds.add(i.accountId);
    }
    if (s.detectorIncidents !== undefined) {
      if (!Array.isArray(s.detectorIncidents)) throw new Error('invalid detector state');
      const detectorIds = new Set(), markers = new Set();
      for (const i of s.detectorIncidents) {
        const key = `${i.accountId}:${i.marker}`;
        if (i.kind !== 'detector' || typeof i.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(i.id) || incidentIds.has(i.id) || detectorIds.has(i.id) || markers.has(key) || typeof i.accountId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(i.accountId) || !validMarker(i.marker) || typeof i.notified !== 'boolean' || (i.mayHaveQueued !== undefined && typeof i.mayHaveQueued !== 'boolean') || (i.firstEnqueuedAt !== undefined && (!Number.isFinite(i.firstEnqueuedAt) || i.firstEnqueuedAt < 0)) || (i.alertState !== undefined && !['pending', 'sent'].includes(i.alertState)) || (!i.notified && i.alertState !== undefined)) throw new Error('invalid detector incident');
        detectorIds.add(i.id); markers.add(key);
      }
    }
    if (s.active) {
      const a = s.active;
      const i = s.incidents.find(i => i.id === a.incidentId);
      const attempt = i?.attempts + (a.phase === 'finishing' && a.sends === 0 ? 1 : 0);
      if (!i || attempt < 1 || !['prepared', 'sent', 'finishing'].includes(a.phase) || (a.holdReason !== undefined && !['worker-terminal-uncertain', 'partial-accept', 'run-changed'].includes(a.holdReason)) || typeof a.leaseId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(a.leaseId) || a.requestId !== `9router-claude-reauth:${i.id}:attempt:${attempt}` || a.threadId !== threadIdFor(a.requestId) || !Number.isInteger(a.sends) || a.sends < 0 || a.sends > MAX_SENDS || (a.phase === 'prepared' && a.sends !== 0) || (a.phase === 'sent' && a.sends < 1) || !Number.isFinite(a.nextSendAt) || a.nextSendAt < 0 || (a.runId !== null && typeof a.runId !== 'string')) throw new Error('invalid active attempt');
    }
    return s;
  } catch (e) { if (e.code === 'ENOENT') return newState(); throw Object.assign(new Error('state unavailable or invalid'), { code: 'REAUTH_STATE_INVALID' }); }
}

export function writeState(path, state) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(state) + '\n'); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(tmp, path);
    // Persist the rename, too; a crash must not lose a sent-attempt journal.
    const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}

// /api/providers is responsible for comparing the current token fingerprint;
// its output is the effective mark, not the raw DB data or the dashboard label.
function validMarker(x) { return typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(x) && !Number.isNaN(Date.parse(x)); }

export function pendingConnections(payload) {
  if (!payload || !Array.isArray(payload.connections)) throw Object.assign(new Error('invalid provider response'), { code: 'REAUTH_PROVIDERS_INVALID' });
  const result = [];
  const ids = new Set();
  for (const c of payload.connections) {
    if (!c || typeof c !== 'object' || typeof c.provider !== 'string') throw Object.assign(new Error('invalid provider record'), { code: 'REAUTH_PROVIDERS_INVALID' });
    if (c.provider === 'claude' && (typeof c.authType !== 'string' || typeof c.isActive !== 'boolean' || typeof c.id !== 'string' || !c.id)) throw Object.assign(new Error('incomplete Claude record'), { code: 'REAUTH_PROVIDERS_INVALID' });
    if (c.provider !== 'claude' || c.authType !== 'oauth' || c.isActive !== true || !c.reauthRequiredAt) continue;
    if (typeof c.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(c.id) || !validMarker(c.reauthRequiredAt) || ids.has(c.id)) throw Object.assign(new Error('invalid effective reauth record'), { code: 'REAUTH_PROVIDERS_INVALID' });
    ids.add(c.id); result.push({ accountId: c.id, marker: c.reauthRequiredAt });
  }
  return result;
}

// Only valid output from the explicit CLI flag can verify identity. Unknown,
// invalid or incomplete queries are errors; a stale/null mark prints NOT_PENDING.
export function assertIncident(payload, accountId, marker) {
  const list = pendingConnections(payload);
  const matches = payload.connections.filter(c => c.id === accountId);
  if (matches.length > 1) throw Object.assign(new Error('ambiguous connection'), { code: 'REAUTH_CONNECTION_INVALID' });
  return list.some(c => c.accountId === accountId && c.marker === marker);
}

export function assertCleared(payload, accountId) {
  // Validate all records and duplicate effective IDs before asserting anything.
  pendingConnections(payload);
  const matches = payload.connections.filter(c => c.id === accountId);
  if (matches.length !== 1) throw Object.assign(new Error('connection missing or ambiguous'), { code: 'REAUTH_CONNECTION_INVALID' });
  const c = matches[0];
  if (c.provider !== 'claude' || c.authType !== 'oauth' || c.isActive !== true) throw Object.assign(new Error('connection not active Claude OAuth'), { code: 'REAUTH_CONNECTION_INVALID' });
  return !c.reauthRequiredAt;
}

function stillBad(list, incident) { return list.some(c => c.accountId === incident.accountId && c.marker === incident.marker); }
export function threadIdFor(requestId) { return `ardud-control:thread:${encodeURIComponent(requestId)}`; }
function matchingModel(model) { return model?.instanceId === MODEL.instanceId && model?.model === MODEL.model && model?.variant === MODEL.variant; }

export function workerPrompt(incident, active, leasePath) {
  return `SAFETY HOLD: No live 9router capability has been verified to atomically fence expected identity, enabled state, and this exact marker at reattachment. Do not call ANY existing 9router OAuth reauth/exchange endpoint, do not submit an OAuth flow, and do not write, replace, clear, or attach credentials by any method. Stop now with REAUTH_RESULT: HUMAN_ACTION_REQUIRED. This restriction overrides all workflow instructions below; no manual confirmation or local boolean/file may waive it. A future implementation must machine-verify the actual live API's fence contract and binding before it can be removed.

The disabled future workflow would recover exactly one 9router Claude OAuth connection. Connection ID: ${incident.accountId}
Effective reauth marker for this incident: ${incident.marker}
The automatic recovery lease is ${leasePath}; owner kind auto, owner ID ${active.leaseId}. Verify it with node ${join(ROOT, 'lease.mjs')} status: that exact lease must still exist and match throughout. Do not release it; the supervisor releases it only after this thread is terminal. This is a global manual/auto exclusion lease. Do not start any async/background work, timers, watchers, schedules, subagents, or separate threads.

Before starting, check the authenticated 9router GET /api/providers using this safe, read-only helper: node ${join(ROOT, 'supervisor.mjs')} --assert-incident ${incident.accountId} ${incident.marker}. Only PENDING permits continuing; NOT_PENDING or UNKNOWN means stop without mutation. It checks exact ID, provider claude, authType oauth, isActive true and the same effective reauthRequiredAt. Run it again immediately before reattaching credentials. If disabled, already healthy, missing, changed, unknown or lease lost, stop without changing anything. A dashboard label is not an account identity. Verify the actual Claude identity against independent reliable account evidence before using it; if identity cannot be established unambiguously, stop and request human action. Never renew a healthy/disabled account, select a different connection, or add a duplicate. Immediately before submitting the per-account exchange, independently re-check the signed-in account's actual identity against trusted evidence, not the label or pre-existing browser session, and re-run --assert-incident and lease status. Unknown, mismatch, stale evidence, an account switch, or loss of lease means stop with HUMAN_ACTION_REQUIRED; never guess. Client checks are not server-enforced and cannot eliminate a race with a non-cooperating actor; if safe identity or targeting cannot be established, do not submit.

Use Dia's global catalog, inspect dia_profiles, and perform the interactive flow serially in the correct foreground Dia tab; do not use background focus emulation. Use Keychain service 9router-dashboard, account ardud, as needed; use the appropriate OTP inbox when available. Never print, log or return secrets, hashes, codes, tokens, cookies, URLs, raw responses, or auth headers. Do not ask for a Mac password if the documented Keychain helper can answer. Use the per-account re-login request with reauthConnectionId exactly equal to the intended connection ID; verify the target ID before submitting. Never use a generic add-connection exchange. The account label alone is not proof of identity. If any human factor, approval, OTP or identity evidence is unavailable, do not guess or proceed; finish with exactly REAUTH_RESULT: HUMAN_ACTION_REQUIRED on its own line. The supervisor sends the single Telegram attention; do not send a second notice yourself.

After reattachment run node ${join(ROOT, 'supervisor.mjs')} --assert-cleared ${incident.accountId}; only CLEARED proves the same enabled Claude OAuth ID has no effective marker. UNKNOWN or NOT_CLEARED is not success. Do not use a dashboard status label as success. Preserve the existing marker contract: return REAUTH_RESULT: CLEARED only when the effective marker is confirmed gone, otherwise REAUTH_RESULT: NOT_CLEARED or REAUTH_RESULT: HUMAN_ACTION_REQUIRED. No inference result changes or replaces the marker.

After CLEARED, independently verify the new credentials, not merely the browser session or the dashboard label. Using only a read-only exact-ID lookup of the currently attached access token, call Anthropic's read-only OAuth profile endpoint with that token and compare the returned account identity against the independently established intended identity. The local 9router DB path is ~/.9router/db/data.sqlite; source ~/tmp/9router/src/lib/db/repos/connectionsRepo.js documents the providerConnections row and its JSON data column. Open that DB read-only, select by exact ID and never print the row or mutate it. The profile endpoint and required headers are in ~/tmp/9router/open-sse/providers/registry/claude.js and open-sse/services/usage/claude.js; use only the profile GET, never the reset-grant operation. Read/use the token and profile in memory in a single bounded process; do not place credentials in command arguments, environment variables, files, logs, output, URLs or tool results. Do not send credentials to another origin or follow redirects. Never force a token refresh for either the profile or inference verification, whatever the response. If the token, identity, or exact account cannot be established or matched, stop verification and report CLEARED_UNVERIFIED with a reason; do not try another account.

If identity matches and feasible, make ONE minimal real inference request pinned to that same exact currently attached access token and Claude account; use a supported Claude model and the provider's transport configuration in the 9router source. The request must reach the real upstream and return a valid assistant response, not a local bypass, mock, metadata or profile response. No account pool, generic router chat fallback, alternate connection, unpinned routing, or forced token refresh is allowed. The 9router provider test route may refresh or mutate state: do not use it. Keep the request tiny and bounded; if safe pinning is unavailable, skip it and report CLEARED_UNVERIFIED. Re-read the exact connection read-only and compare the token in memory after the checks; if it changed, the connection was disabled, or the effective marker returned, do not claim verification. Re-run --assert-cleared after verification: if the marker has returned or its state is unknown, do not report REAUTH_RESULT: CLEARED.

Classify HTTP 429 from profile or inference as RATE_LIMITED, distinct from auth failure, other inference failure and service/network unavailability. Never refresh tokens or repeat OAuth/login because of a mere 429. Never repeat login just because identity or inference verification is unavailable, rate-limited or unsuccessful. If the same original marker remains after a 429, return REAUTH_RESULT: HUMAN_ACTION_REQUIRED so the supervisor will not retry login. A later independently observed new effective reauth marker is a separate incident. Do not leave any login flow running after finishing.

In the final answer preserve exactly one original result line and add separate verification lines, using only these fixed reason codes (no raw errors, identity values, URLs or secrets):
REAUTH_RESULT: CLEARED | NOT_CLEARED | HUMAN_ACTION_REQUIRED
VERIFICATION_RESULT: VERIFIED_WORKING | CLEARED_UNVERIFIED | NOT_VERIFIED
VERIFICATION_REASON: NONE | RATE_LIMITED | PROFILE_UNAVAILABLE | IDENTITY_MISMATCH | ACCESS_TOKEN_UNAVAILABLE | PINNING_UNAVAILABLE | INFERENCE_UNAVAILABLE | INFERENCE_FAILED | AUTH_FAILURE | TOKEN_CHANGED | MARKER_UNKNOWN
Emit one value, not the pipe-separated list. VERIFIED_WORKING requires CLEARED, the post-reauth exact-token profile identity match, real pinned inference success, and an unchanged enabled, marker-free connection. Use reason NONE only for VERIFIED_WORKING. For CLEARED with any missing, failed, rate-limited or uncertain verification, report CLEARED_UNVERIFIED with the applicable reason. If the marker was not confirmed cleared, report NOT_VERIFIED with the applicable reason. Do not equate a cleared marker with verified working.`;
}

function createInput(i, a, leasePath) {
  return { title: '9router Claude recovery', prompt: workerPrompt(i, a, leasePath), scratch: true,
    providerInstanceId: MODEL.instanceId, model: MODEL.model, variant: MODEL.variant,
    runtimeMode: 'full-access', interactionMode: 'default', origin: 'watcher', clientRequestId: a.requestId };
}

export function notificationId(key) { return `notify:${createHash('sha256').update(key).digest('hex')}`; }
export function telegramHealthy(body) {
  return body?.status === 'healthy' && body.ready === true && body.paired === true && body.enabled === true && body.telegramConnected === true;
}
export function notificationState(body, key) {
  if (!body || !Array.isArray(body.notifications)) throw Object.assign(new Error('notification delivery failed or unknown'), { code: 'REAUTH_DELIVERY_UNKNOWN' });
  const matches = body.notifications.filter(n => n?.id === notificationId(key));
  if (matches.length !== 1 || !['pending', 'sending', 'sent'].includes(matches[0].state)) throw Object.assign(new Error('notification delivery failed or unknown'), { code: 'REAUTH_DELIVERY_UNKNOWN' });
  return matches[0].state;
}
const alertKey = i => `${i.kind === 'detector' ? '9router-claude-detector' : '9router-claude-reauth'}:${i.id}`;
function alertText(i) { return `9router Claude recovery needs manual attention for connection ${i.accountId}. Check the recovery thread and lease before proceeding.`; }
async function checkAlert(ctx, state, i) {
  if (!i.notified || i.alertState === 'sent') return;
  let status;
  try { status = await ctx.notificationState(alertKey(i)); }
  catch { throw Object.assign(new Error('notification delivery failed or unknown'), { code: 'REAUTH_DELIVERY_UNKNOWN' }); }
  if (status === 'sent') { i.alertState = 'sent'; ctx.save(state); }
  else if (status !== 'pending' && status !== 'sending') throw Object.assign(new Error('notification delivery failed or unknown'), { code: 'REAUTH_DELIVERY_UNKNOWN' });
}
async function alertOnce(ctx, state, i, text = alertText(i)) {
  if (!i.notified) {
    // Queue acceptance is not delivery. On ambiguity replay the same key/text.
    const key = alertKey(i);
    let reply;
    try { reply = await ctx.notify(key, text); } catch { throw Object.assign(new Error('notification queue unavailable'), { code: 'REAUTH_NOTIFY_UNAVAILABLE' }); }
    if (!reply || reply.id !== notificationId(key) || typeof reply.created !== 'boolean') throw Object.assign(new Error('notification queue unavailable'), { code: 'REAUTH_NOTIFY_UNAVAILABLE' });
    i.notified = true; i.alertState = 'pending'; ctx.save(state);
  }
  await checkAlert(ctx, state, i);
}

function detectorAlertText(i) {
  return `9router Claude connection ${i.accountId} requires reauthentication. Automatic recovery is disabled until the server identity fence is verified. Recover manually using the shared lease.`;
}

// Interim mode has no path to createThread, lease mutation, or credentials.
// Notices are durable per exact (connection ID, effective marker), including
// across restarts and a temporary clear/disable followed by the same marker.
async function detectOnly(ctx, state, payload) {
  const pending = pendingConnections(payload);
  for (const item of pending) emit('reauth', 'relogin.needed', { ids: { account: item.accountId }, props: { tag: 'effective_marker' } });
  state.detectorIncidents ??= [];
  for (const item of pending) {
    const coveredByRecoveryAlert = state.incidents.some(i => i.accountId === item.accountId && i.marker === item.marker && i.notified);
    if (!coveredByRecoveryAlert && !state.detectorIncidents.some(i => i.accountId === item.accountId && i.marker === item.marker)) {
      state.detectorIncidents.push({ id: randomUUID(), kind: 'detector', ...item, notified: false });
    }
  }
  for (const incident of state.detectorIncidents) {
    const present = pending.some(p => p.accountId === incident.accountId && p.marker === incident.marker);
    const cleared = payload.connections.some(c => c.id === incident.accountId && c.provider === 'claude' && c.authType === 'oauth' && c.isActive === true && !c.reauthRequiredAt);
    if (cleared && !incident.logResolved) emit('reauth', 'relogin.ok', { kind: 'perf', ok: true, ids: { account: incident.accountId }, durationMs: Math.max(0, ctx.now() - Date.parse(incident.marker)), props: { tag: 'marker_cleared_observed' } });
    if (cleared) incident.logResolved = true;
    else if (present) incident.logResolved = false;
  }
  // Persist the stable dedupe identity before even attempting to enqueue.
  ctx.save(state);
  // The CLI outbox list is capped at 50. Snapshot it once per tick, not once
  // per pending item; this keeps the check bounded as incidents accumulate.
  const toCheck = [...state.incidents, ...state.detectorIncidents].filter(i => i.notified && i.alertState !== 'sent');
  let unknown = false;
  // Startup/reboots can observe an account already repaired. Preserve its
  // queue-time delivery uncertainty, but do not send a stale reauth request.
  const staleQueued = state.detectorIncidents.filter(i => i.mayHaveQueued && !i.notified && !pending.some(p => p.accountId === i.accountId && p.marker === i.marker));
  // An ambiguous enqueue may have left a pending outbox item even when the
  // row is temporarily missing from the snapshot.
  let pendingDelivery = toCheck.length > 0 || staleQueued.length > 0;
  if (toCheck.length || staleQueued.length) {
    let snapshot;
    try { snapshot = await ctx.notificationSnapshot(); } catch { unknown = true; }
    if (snapshot) {
      for (const i of staleQueued) {
        try {
          const status = notificationState(snapshot, alertKey(i));
          i.notified = true; i.alertState = status === 'sent' ? 'sent' : 'pending'; ctx.save(state);
          if (status !== 'sent') pendingDelivery = true;
        } catch { unknown = true; }
      }
      for (const i of toCheck) {
        try {
          const status = notificationState(snapshot, alertKey(i));
          if (status === 'sent') { i.alertState = 'sent'; ctx.save(state); }
          else {
            // Legacy journals may have notified=true but no alertState. An
            // observed pending/sending row must enter the deadline check too.
            if (i.alertState !== 'pending') { i.alertState = 'pending'; ctx.save(state); }
            pendingDelivery = true;
          }
        } catch { unknown = true; }
      }
    }
  }
  const unsent = state.detectorIncidents.filter(i => !i.notified && pending.some(p => p.accountId === i.accountId && p.marker === i.marker));
  // Pending delivery (including after the incident clears) requires health
  // too, not only newly queued alerts. Evaluate once, then keep processing
  // independent incidents before returning a nonzero result.
  let healthy = true;
  if (unsent.length || pendingDelivery) {
    healthy = false;
    try { healthy = (await ctx.notificationAvailable()) === true; } catch { /* treated as unknown */ }
    if (!healthy) unknown = true;
  }
  for (const i of [...state.incidents, ...state.detectorIncidents]) {
    if (i.notified && i.alertState === 'pending') {
      // Legacy queued records with no trustworthy timestamp are already
      // unknown, not granted a new 3-minute lease after reboot/upgrade.
      const first = i.firstEnqueuedAt;
      if (!Number.isFinite(first) || first < 0 || !Number.isFinite(ctx.now()) || ctx.now() < first || ctx.now() - first >= DELIVERY_DEADLINE) unknown = true;
    }
  }
  if (unsent.length && healthy) {
    for (const i of unsent.slice(0, 3)) {
      try {
        // A timeout can occur after durable acceptance. Record that possibility
        // before sending so a later healthy snapshot cannot hide uncertainty.
        // Use the first attempt as a conservative bound on queue acceptance;
        // never reset it on an ambiguous replay or reboot.
        i.mayHaveQueued = true;
        if (i.firstEnqueuedAt === undefined) i.firstEnqueuedAt = ctx.now();
        ctx.save(state);
        const key = alertKey(i), reply = await ctx.notify(key, detectorAlertText(i));
        if (!reply || reply.id !== notificationId(key) || typeof reply.created !== 'boolean') throw Object.assign(new Error('notification queue unavailable'), { code: 'REAUTH_NOTIFY_UNAVAILABLE' });
        i.notified = true; i.alertState = 'pending'; ctx.save(state);
        if (ctx.now() < i.firstEnqueuedAt || ctx.now() - i.firstEnqueuedAt >= DELIVERY_DEADLINE) unknown = true;
      } catch { unknown = true; }
    }
  }
  // An older in-flight recovery is not silently forgotten during migration.
  if (state.active) unknown = true;
  if (unknown) throw Object.assign(new Error('detector notification delivery or prior recovery unknown'), { code: 'REAUTH_DETECTOR_UNKNOWN' });
}

async function holdActive(ctx, state, i, a, reason) {
  emit('reauth', 'relogin.fail', { kind: 'error', ok: false, ids: { account: i.accountId }, durationMs: Math.max(0, ctx.now() - (a.nextSendAt - REPLAY_DELAY)), error: { tag: reason } });
  i.blocked = true; a.holdReason ??= reason; ctx.save(state);
  await alertOnce(ctx, state, i);
}

async function releaseActive(ctx, state, active) {
  // Only the exact owner may remove a lease. An incomplete lease remains held.
  const owner = ctx.leaseOwner();
  if (owner?.kind === 'auto' && owner.id === active.leaseId) {
    if (!ctx.releaseLease({ kind: 'auto', id: active.leaseId })) throw Object.assign(new Error('lease release failed'), { code: 'REAUTH_LEASE_RELEASE_FAILED' });
  }
  // If a manual owner acquired after a previous successful release, never touch it.
  else if (owner && owner.kind !== 'manual') throw Object.assign(new Error('recovery lease owner uncertain'), { code: 'REAUTH_LEASE_UNKNOWN' });
  state.active = null; ctx.save(state);
}

function ensureIncidents(state, list) {
  // Budgets and cooldowns belong to the account, not its current marker.
  // Never prune them on clear, disable, restart, or an old->new marker change.
  for (const c of list) {
    const i = state.incidents.find(i => i.accountId === c.accountId);
    if (!i) state.incidents.push({ id: randomUUID(), ...c, attempts: 0, nextAt: 0, blocked: false, notified: false });
    else if (state.active?.incidentId !== i.id) i.marker = c.marker;
  }
}

// All IO is injected so the synthetic suite cannot hit a live endpoint or send.
export async function tick(ctx) {
  return observed('reauth', 'relogin.tick', () => tickImpl(ctx));
}

async function tickImpl(ctx) {
  const state = ctx.load();
  const startedAt = ctx.now();
  const continuing = state.routerUnavailableLastAt !== undefined
    && startedAt >= state.routerUnavailableLastAt
    && startedAt - state.routerUnavailableLastAt <= ROUTER_STREAK_GAP_MS;
  // A killed fetch cannot publish its result. Preserve an ongoing outage's
  // continuity before fetching so the following retry does not look like downtime.
  if (continuing) {
    state.routerUnavailableLastAt = startedAt;
    ctx.save(state);
  }
  let payload;
  try { payload = await ctx.providers(); }
  catch (error) {
    if (!(error instanceof RouterUnavailableError)) throw error;
    const now = ctx.now();
    // Legacy journals lack a last tick; their elapsed time cannot prove continuity.
    if (!continuing) {
      state.routerUnavailableSince = now;
      state.routerUnavailableCount = 0;
    }
    state.routerUnavailableLastAt = now;
    state.routerUnavailableCount = (state.routerUnavailableCount ?? 0) + 1;
    ctx.save(state);
    const elapsed = Math.max(0, now - state.routerUnavailableSince);
    if (elapsed >= (ctx.routerUnavailableLimitMs ?? ROUTER_UNAVAILABLE_LIMIT_MS)) {
      error.sustainedMinutes = Math.floor(elapsed / 60_000);
      throw error;
    }
    emit('reauth', 'providers.fetch.skipped', { props: { reason: error.reason, consecutive: state.routerUnavailableCount, sinceMs: state.routerUnavailableSince } });
    const detail = error.attemptMs.length ? `attempt ms ${error.attemptMs.join('/')}`
      : error.fetchAttempted ? `fetch interrupted: ${error.reason}`
      : `no fetch: ${error.reason}${error.reason === 'boot_exhausted' ? `, boot ${Math.round(error.bootMs)}ms` : Number.isFinite(error.remainingMs) ? `, ${Math.floor(error.remainingMs)}ms left` : ''}`;
    ctx.log?.(`9router Claude detector: router slow/unavailable (${detail}); skipped this tick (${state.routerUnavailableCount} consecutive, since ${new Date(state.routerUnavailableSince).toISOString()})`);
    // Unknown is not an empty snapshot: leave all incident/worker/delivery state
    // untouched, including queued notices whose markers might still be pending.
    return;
  }
  pendingConnections(payload);
  if (state.routerUnavailableSince !== undefined) {
    ctx.log?.(`9router Claude detector: router recovered after ${state.routerUnavailableCount} consecutive unavailable ticks`);
    delete state.routerUnavailableLastAt;
    delete state.routerUnavailableSince;
    delete state.routerUnavailableCount;
    ctx.save(state);
  }
  // In the live build the unverified server fence selects detector-only mode;
  // flags and local files cannot enable the recovery path. A future code change
  // must integrate and verify a real server capability before launch is allowed.
  if (ctx.enforceSafetyFence && !SERVER_IDENTITY_FENCE_VERIFIED) return detectOnly(ctx, state, payload);
  const list = pendingConnections(payload); // failure is UNKNOWN, never healthy
  for (const item of list) emit('reauth', 'relogin.needed', { ids: { account: item.accountId }, props: { tag: 'effective_marker' } });
  ensureIncidents(state, list); ctx.save(state);
  for (const i of state.incidents) await checkAlert(ctx, state, i);
  for (const i of state.incidents) if (i.blocked && !i.notified && i.id !== state.active?.incidentId && stillBad(list, i)) await alertOnce(ctx, state, i);
  if (!state.active) {
    const owner = ctx.leaseOwner();
    if (owner?.kind === 'manual') return;
    if (owner) throw Object.assign(new Error('orphaned recovery lease'), { code: 'REAUTH_LEASE_ORPHANED' });
    const i = state.incidents.find(x => stillBad(list, x) && !x.blocked && x.nextAt <= ctx.now());
    if (!i) return;
    if (!await ctx.available()) throw Object.assign(new Error('control service unavailable'), { code: 'REAUTH_CONTROL_UNAVAILABLE' });
    if (!await ctx.notificationAvailable()) throw Object.assign(new Error('notification service unavailable'), { code: 'REAUTH_NOTIFY_UNAVAILABLE' });
    i.attempts++;
    const requestId = `9router-claude-reauth:${i.id}:attempt:${i.attempts}`;
    state.active = { incidentId: i.id, leaseId: randomUUID(), requestId, threadId: threadIdFor(requestId), phase: 'prepared', sends: 0, nextSendAt: 0, runId: null };
    ctx.save(state); // Reserve the owner ID before attempting to take the lease.
  }

  const a = state.active;
  const i = state.incidents.find(x => x.id === a.incidentId);
  if (a.holdReason) { await holdActive(ctx, state, i, a, a.holdReason); return; }
  if (a.phase === 'finishing') {
    if (i.blocked && !i.notified && list.some(c => c.accountId === i.accountId)) await alertOnce(ctx, state, i);
    await releaseActive(ctx, state, a); return;
  }
  let owner = ctx.leaseOwner();
  if (a.phase === 'prepared' && !owner) {
    // A crash on either side of this atomic publish can resume safely.
    ctx.acquireLease(a.leaseId);
    owner = ctx.leaseOwner();
  }
  if (a.phase === 'prepared' && owner?.kind === 'manual') {
    if (!stillBad(list, i)) { i.attempts--; a.phase = 'finishing'; ctx.save(state); await releaseActive(ctx, state, a); }
    return;
  }
  if (a.phase === 'prepared' && !stillBad(list, i) && (!owner || (owner.kind === 'auto' && owner.id === a.leaseId))) {
    i.attempts--; // no launch was sent; a later reactivation gets its full budget
    a.phase = 'finishing'; ctx.save(state); await releaseActive(ctx, state, a); return;
  }
  if (!owner || owner.kind !== 'auto' || owner.id !== a.leaseId) {
    // A prior terminal cleanup may have removed the lease before saving state.
    // Query the thread below; never launch or send without our exact lease.
    a.leaseMismatch = true;
  }

  let detail;
  try { detail = await ctx.thread(a.threadId); }
  catch (e) { if (e?.status === 404) detail = null; else throw Object.assign(new Error('control status unavailable'), { code: 'REAUTH_CONTROL_STATUS_UNAVAILABLE' }); }
  if (detail !== null) {
    const t = detail.thread;
    if (!t || t.threadId !== a.threadId || typeof t.state !== 'string') throw Object.assign(new Error('invalid control status'), { code: 'REAUTH_CONTROL_STATUS_INVALID' });
    if (a.phase === 'prepared') {
      // Even a supposedly unsent key can name a pre-existing command if the
      // journal was restored from backup or the server was independently used.
      // Never adopt or replay it as our new worker without an operator.
      await holdActive(ctx, state, i, a, 'partial-accept'); return;
    }
    if (t.state === 'idle' && !t.run) { await holdActive(ctx, state, i, a, 'partial-accept'); return; }
    if (a.runId && (!Array.isArray(t.recentRuns) || t.recentRuns.length !== 1 || t.recentRuns[0]?.runId !== a.runId || t.run?.runId !== a.runId)) { await holdActive(ctx, state, i, a, 'run-changed'); return; }
    if (!a.runId && (t.run || (Array.isArray(t.recentRuns) && t.recentRuns.length))) {
      // A crashed create may have been accepted, then restart recovery may have
      // added a second run before the supervisor learned its original runId.
      if (!t.run?.runId || !Array.isArray(t.recentRuns) || t.recentRuns.length !== 1 || t.recentRuns[0]?.runId !== t.run.runId) { await holdActive(ctx, state, i, a, 'run-changed'); return; }
      a.runId = t.run.runId; ctx.save(state);
    }
    if (t.state === 'idle' && t.run && TERMINAL.has(t.run.status) && t.run.status !== 'completed') { await holdActive(ctx, state, i, a, 'worker-terminal-uncertain'); return; }
    // Only a reported, wrong selection proves a mismatch. An absent model is
    // uncertainty, not permission to continue or accuse a particular provider.
    if (!t.model || (t.run && !t.run.model)) throw Object.assign(new Error('model selection unavailable'), { code: 'REAUTH_MODEL_UNAVAILABLE' });
    const modelOkay = matchingModel(t.model) && (!t.run || matchingModel(t.run.model));
    if (BUSY.has(t.state)) {
      if (i.blocked && !i.notified) await alertOnce(ctx, state, i);
      if (!modelOkay) { i.blocked = true; ctx.save(state); await alertOnce(ctx, state, i); }
      if (t.state === 'needs-input') { i.blocked = true; ctx.save(state); await alertOnce(ctx, state, i); }
      return;
    }
    if (t.state !== 'idle' || !t.run || !TERMINAL.has(t.run.status)) throw Object.assign(new Error('thread state is not conclusively terminal'), { code: 'REAUTH_THREAD_NOT_TERMINAL' });
    // Restart recovery can resume failed/cancelled/interrupted runs later.
    // Keep the lease even if the marker is already gone or a later run starts.
    if (t.run.status !== 'completed') { await holdActive(ctx, state, i, a, 'worker-terminal-uncertain'); return; }
    // A resumed turn can start while the provider read is in flight. Require
    // a second exact terminal/single-run status before releasing the lease.
    const fresh = pendingConnections(await ctx.providers());
    let confirm;
    try { confirm = (await ctx.thread(a.threadId))?.thread; } catch { throw Object.assign(new Error('control status unavailable'), { code: 'REAUTH_CONTROL_STATUS_UNAVAILABLE' }); }
    if (!confirm || confirm.threadId !== a.threadId || confirm.state !== 'idle' || confirm.run?.runId !== a.runId || confirm.run?.status !== 'completed' || !Array.isArray(confirm.recentRuns) || confirm.recentRuns.length !== 1 || confirm.recentRuns[0]?.runId !== a.runId || !matchingModel(confirm.model) || !matchingModel(confirm.run.model)) { await holdActive(ctx, state, i, a, 'run-changed'); return; }
    const current = fresh.find(c => c.accountId === i.accountId);
    emit('reauth', current ? 'relogin.fail' : 'relogin.ok', { kind: current ? 'error' : 'perf', ok: !current, ids: { account: i.accountId }, durationMs: Math.max(0, ctx.now() - (a.nextSendAt - REPLAY_DELAY)), props: { tag: current ? 'marker_remains' : 'marker_cleared' }, ...(current ? { error: { tag: 'marker_remains' } } : {}) });
    // Cooldown applies even when the marker briefly clears then reappears.
    if (i.attempts < MAX_ATTEMPTS) i.nextAt = ctx.now() + COOLDOWNS[i.attempts - 1];
    else i.blocked = true;
    if (current) {
      i.marker = current.marker; // changed marker is still bad, never success
      if (!modelOkay) i.blocked = true;
      const answer = await ctx.lastAssistant(a.threadId, t.run.runId);
      if (i.notified || /^REAUTH_RESULT:\s*HUMAN_ACTION_REQUIRED\s*$/m.test(answer ?? '') || /^VERIFICATION_REASON:\s*RATE_LIMITED\s*$/m.test(answer ?? '')) i.blocked = true;
    }
    a.phase = 'finishing'; ctx.save(state);
    if (i.blocked && current) await alertOnce(ctx, state, i);
    await releaseActive(ctx, state, a);
    return;
  }

  if (a.leaseMismatch) throw Object.assign(new Error('recovery lease owner uncertain'), { code: 'REAUTH_LEASE_UNKNOWN' });
  if (i.blocked) { await alertOnce(ctx, state, i); return; }
  if (a.phase === 'sent' && a.sends >= MAX_SENDS) { i.blocked = true; ctx.save(state); await alertOnce(ctx, state, i); return; }
  // The relay could have accepted a launch even if its thread is temporarily
  // absent. If Telegram is down, don't create an unseen worker or replay yet.
  if (!await ctx.notificationAvailable()) throw Object.assign(new Error('notification service unavailable'), { code: 'REAUTH_NOTIFY_UNAVAILABLE' });
  // A prepared attempt provably has not sent: it is safe to abandon if the
  // current effective mark changed. A sent one is ambiguous even on a 404.
  const fresh = pendingConnections(await ctx.providers());
  if (!stillBad(fresh, i)) {
    if (a.phase === 'prepared') { i.attempts--; a.phase = 'finishing'; ctx.save(state); await releaseActive(ctx, state, a); return; }
    i.blocked = true; ctx.save(state); await alertOnce(ctx, state, i); return;
  }
  if (a.sends >= MAX_SENDS) { i.blocked = true; ctx.save(state); await alertOnce(ctx, state, i); return; }
  if (a.nextSendAt > ctx.now()) return;
  // Persist before launch, including the idempotency key and next retry time.
  a.phase = 'sent'; a.sends++; a.nextSendAt = ctx.now() + REPLAY_DELAY; ctx.save(state);
  let created;
  const launchStart = performance.now();
  emit('reauth', 'relogin.start', { ids: { account: i.accountId }, props: { tag: 'worker_launch', attempt: i.attempts } });
  try { created = await ctx.create(createInput(i, a, ctx.leasePath)); }
  catch { emit('reauth', 'relogin.fail', { kind: 'error', ok: false, ids: { account: i.accountId }, durationMs: performance.now() - launchStart, error: { tag: 'launch_unknown' } }); throw Object.assign(new Error('control launch outcome unknown'), { code: 'REAUTH_LAUNCH_UNKNOWN' }); }
  if (!created || typeof created.threadId !== 'string' || !created.model) throw Object.assign(new Error('launch outcome not verified'), { code: 'REAUTH_LAUNCH_UNVERIFIED' });
  if (created.threadId !== a.threadId || !matchingModel(created.model)) {
    // Defer the notice until status is queried and the mark rechecked. The
    // worker may already have finished and cleared it despite a bad response.
    i.blocked = true; ctx.save(state);
    throw Object.assign(new Error('launch identity or model not verified'), { code: 'REAUTH_LAUNCH_UNVERIFIED' });
  }
  if (created.runId) a.runId = created.runId;
  ctx.save(state);
  // A terminal create response could be auto-resumed before the next tick.
  // An idle/null response is a partial accept, not proof nothing launched.
  if (!created.runId || !LAUNCH_STATUSES.has(created.status)) {
    await holdActive(ctx, state, i, a, created.runId ? 'worker-terminal-uncertain' : 'partial-accept');
  }
}

export class RouterUnavailableError extends Error {
  constructor(attemptMs, { reason = 'unavailable', remainingMs, bootMs } = {}) {
    super('router slow/unavailable');
    this.code = 'ROUTER_UNAVAILABLE';
    this.attemptMs = attemptMs;
    this.reason = reason;
    this.remainingMs = remainingMs;
    this.bootMs = bootMs;
  }
}

function transientFetchError(error) {
  return ['AbortError', 'TimeoutError'].includes(error?.name)
    || ['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(error?.code)
    || ['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(error?.cause?.code)
    || error?.message === 'socket hang up';
}

function abortable(work, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { signal.removeEventListener('abort', abort); abort(); return; }
    Promise.resolve().then(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function liveProviders({ data = join(homedir(), '.9router'), url = 'http://127.0.0.1:20128/api/providers', timeoutMs = 6_000, retryTimeoutMs = 15_000, phase = () => {}, fetch: fetchProvider = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => performance.now(), log = () => {}, deadlineAt = Infinity, signal, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const attemptMs = [];
  const remaining = () => Math.max(0, deadlineAt - now());
  const budgetLog = (tag, ms) => {
    emit('reauth', 'providers.fetch.budget', { durationMs: ms, props: { tag } });
    log(`9router Claude detector: providers fetch budget ${tag} (${Math.floor(ms)}ms remaining)`);
  };
  const exhausted = tag => { const ms = remaining(); budgetLog(tag, ms); return new RouterUnavailableError(attemptMs, { reason: tag, remainingMs: ms }); };
  if (remaining() < MIN_FETCH_BUDGET_MS) throw exhausted('below_minimum');
  phase('providers:credentials');
  const raw = readFileSync(join(data, 'machine-id'), 'utf8').trim();
  const secret = readFileSync(join(data, 'auth', 'cli-secret'), 'utf8').trim();
  if (!raw || !secret) throw Object.assign(new Error('router auth unavailable'), { code: 'REAUTH_AUTH_MISSING' });
  const token = createHash('sha256').update(raw + '9r-cli-auth' + secret).digest('hex').substring(0, 16);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (remaining() < MIN_FETCH_BUDGET_MS || signal?.aborted) throw exhausted('below_minimum');
    phase(attempt ? 'providers:fetch:retry' : 'providers:fetch');
    const started = now();
    const requestedMs = attempt ? retryTimeoutMs : timeoutMs;
    const allowedMs = Math.min(requestedMs, remaining());
    if (allowedMs < requestedMs) budgetLog(attempt ? 'retry_shortened' : 'first_shortened', allowedMs);
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimer(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), Math.ceil(allowedMs));
    let retryable = false, payload, failure, response;
    try {
      const r = await abortable(() => fetchProvider(url, { headers: { 'x-9r-cli-token': token, accept: 'application/json' }, cache: 'no-store', signal: controller.signal }), controller.signal);
      response = r;
      if (!r.ok) {
        retryable = [502, 503, 504].includes(r.status);
        throw Object.assign(new Error('router unavailable'), { code: 'ROUTER_HTTP', httpStatus: r.status });
      }
      if (!(r.headers.get('content-type') ?? '').includes('application/json')) throw Object.assign(new Error('invalid provider content type'), { code: 'REAUTH_PROVIDERS_INVALID' });
      phase(attempt ? 'providers:body:retry' : 'providers:body');
      payload = await abortable(() => r.json(), controller.signal);
      pendingConnections(payload);
      if (remaining() <= 0 || signal?.aborted) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    } catch (error) {
      failure = error;
      retryable ||= transientFetchError(error) || error instanceof RouterUnavailableError;
    } finally {
      // Rejected headers leave the body unread. Close its socket before
      // retiring both abort paths, or a streaming error can outlive the tick.
      if (response?.body && !response.bodyUsed) {
        void response.body.cancel().catch(() => {});
        controller.abort();
      }
      clearTimer(timer);
      signal?.removeEventListener('abort', abort);
    }
    attemptMs.push(Math.round(now() - started));
    if (attempt) {
      const outcome = failure ? (retryable ? 'unavailable' : 'failed') : 'success';
      emit('reauth', 'providers.fetch.retry', { ok: !failure, durationMs: attemptMs[1], props: { firstAttemptMs: attemptMs[0], retryAttemptMs: attemptMs[1], outcome } });
      log(`9router Claude detector: providers retry ${outcome} (providers:fetch=${attemptMs[0]}ms, providers:fetch:retry=${attemptMs[1]}ms)`);
    }
    if (!failure) return payload;
    if (!retryable) throw failure;
    if (remaining() <= 0 || signal?.aborted) throw exhausted('exhausted');
    if (attempt) throw new RouterUnavailableError(attemptMs);
    if (remaining() < 1_000 + MIN_FETCH_BUDGET_MS) throw exhausted('retry_dropped');
    phase('providers:backoff');
    if (signal) {
      try { await abortable(() => sleep(1_000), signal); }
      catch (error) { if (signal.aborted) throw exhausted('exhausted'); throw error; }
    } else await sleep(1_000);
  }
}

// Resolve on exit, never on pipe close: a descendant may inherit stdout.
export function runBoundedCommand(command, args, { timeoutMs = 8_000, signal, env = { HOME: homedir(), PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env });
    let output = '', bytes = 0, settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      // Only the process group created by this spawn is ours to terminate.
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      child.stdout.destroy();
      child.unref();
      if (error) reject(error); else resolve(output);
    };
    const abort = () => finish(Object.assign(new Error('notification service aborted'), { code: 'REAUTH_NOTIFY_ABORTED' }));
    const timer = setTimeout(() => finish(Object.assign(new Error('notification service timed out'), { code: 'REAUTH_NOTIFY_TIMEOUT' })), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 256 * 1024) finish(Object.assign(new Error('notification response too large'), { code: 'REAUTH_NOTIFY_TOO_LARGE' }));
      else output += chunk;
    });
    child.on('error', () => finish(Object.assign(new Error('notification service unavailable'), { code: 'REAUTH_NOTIFY_UNAVAILABLE' })));
    child.on('exit', code => finish(code === 0 ? null : Object.assign(new Error('notification service unavailable'), { code: 'REAUTH_NOTIFY_UNAVAILABLE' })));
  });
}

export async function telegramCommand(args, { phase = () => {}, signal } = {}) {
  phase(`telegram:${args[0]}`);
  const output = await runBoundedCommand(join(homedir(), '.bun/bin/bun'), [join(homedir(), '.local/share/telegram-bridge/src/cli.ts'), ...args], { signal });
  try { return JSON.parse(output); } catch { throw Object.assign(new Error('notification response invalid'), { code: 'REAUTH_NOTIFY_INVALID' }); }
}

function stderrLine(line) {
  // process.stderr.write can be buffered and lost when the runner SIGKILLs us.
  try { writeSync(2, line + '\n'); } catch { /* marker still survives */ }
}

export function phaseReporter(watchDir, { previous = process.env.WATCH_PREVIOUS_PHASE, stderr = stderrLine, startedAt = Number(process.env.WATCH_STARTED_AT), now = () => performance.now(), wallNow = Date.now, log = () => {} } = {}) {
  const path = join(watchDir, '.phase');
  const bootMs = Number.isFinite(startedAt) && startedAt > 0 ? Math.max(0, wallNow() - startedAt) : 0;
  let phase = 'start', since = now();
  const durations = [`boot=${bootMs.toFixed(1)}ms`];
  emit('reauth', 'supervisor.boot', { durationMs: bootMs });
  log(`9router Claude detector: phase durations: boot=${bootMs.toFixed(1)}ms`);
  let previousStall;
  try {
    const old = JSON.parse(previous ?? readFileSync(path, 'utf8'));
    if (typeof old.phase === 'string' && /^[a-z:-]{1,80}$/.test(old.phase) && Number.isFinite(old.t) && old.phase !== 'done' && old.phase !== 'failed') {
      previousStall = `previous run stalled in ${old.phase} (${Math.max(0, (Date.now() - old.t) / 1000).toFixed(1)}s)`;
      stderr(previousStall);
    }
  } catch { /* no valid previous marker */ }
  const mark = next => {
    const at = now();
    durations.push(`${phase}=${(at - since).toFixed(1)}ms`);
    phase = next; since = at;
    try { writeFileSync(path, JSON.stringify({ phase, t: Date.now() }) + '\n', { mode: 0o600 }); } catch { /* observability must not change detector safety */ }
  };
  mark('start');
  // Successful stderr is discarded by robob-watch. Preserve killed-run evidence
  // in its log without spending another failure or changing recovery/backoff.
  if (previousStall) {
    try { appendFileSync(join(watchDir, 'log'), `${new Date().toISOString()} 9router Claude detector: ${previousStall}\n`, { mode: 0o600 }); } catch { /* stderr remains available */ }
  }
  return {
    mark, previousStall,
    failure: reason => {
      stderr(`phase durations: ${[...durations, `${phase}=${(now() - since).toFixed(1)}ms`].join(', ')}`);
      // The runner keeps only the last 500 stderr characters on failure.
      if (previousStall) stderr(previousStall);
      stderr(`9router Claude detector: ${phase} ${reason}`);
      try { writeFileSync(path, JSON.stringify({ phase: 'failed', at: phase, t: Date.now() }) + '\n', { mode: 0o600 }); } catch { /* observability must not change detector safety */ }
    },
  };
}

// Synthetic callers inject IO; live() retains all deployment and identity fences.
export async function runObserved(ctx, { watchDir, deadlineMs = SUPERVISOR_DEADLINE_MS, startedAt = Number(process.env.WATCH_STARTED_AT), previous, stderr, phase, onDeadline = () => {}, now = () => performance.now(), wallNow = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, exit = code => process.exit(code) } = {}) {
  const report = phase ?? phaseReporter(watchDir, { previous, stderr, startedAt, now, wallNow, log: ctx.log });
  const bootMs = Number.isFinite(startedAt) && startedAt > 0 ? Math.max(0, wallNow() - startedAt) : 0;
  const nodeStartedAt = now();
  const remainingMs = Math.max(1, deadlineMs - bootMs);
  const deadlineAt = nodeStartedAt + remainingMs;
  const bootSkipped = bootMs > 0 && deadlineMs - bootMs < MIN_FETCH_BUDGET_MS + SAVE_RESERVE_MS;
  // A fetch cannot fit, but the outage checkpoint and skip still need to commit.
  // Use one fixed ceiling for this no-fetch path; a valid snapshot never gets
  // extra time. An invalid shell timestamp uses boot 0 and the normal budget.
  const hardDeadlineAt = bootSkipped ? nodeStartedAt + Math.max(0, BOOT_SKIP_HARD_CEILING_MS - bootMs) : deadlineAt;
  let fetching, fetchSkipped = false, fetchAttempted = false, firstFetch = true, currentPhase = 'start', deadlineFailed = false;
  const mark = next => {
    currentPhase = next;
    if (/^providers:(fetch|body|backoff)(:|$)/.test(next)) fetchAttempted = true;
    report.mark(next);
  };
  const hardDeadline = () => {
    deadlineFailed = true;
    report.failure('exceeded deadline');
    try { onDeadline(); } finally { exit(1); }
  };
  const deadline = () => {
    if (fetching && /^providers:(fetch|body|backoff)(:|$)/.test(currentPhase)) {
      fetching.abort(new RouterUnavailableError([]));
      // Let the skip's synchronous journal commit finish. Any subsequent async
      // work is still stopped at the supervisor deadline.
      timer = setTimer(hardDeadline, 0);
    } else hardDeadline();
  };
  let timer = setTimer(bootSkipped ? hardDeadline : deadline, Math.max(0, hardDeadlineAt - now()));
  try {
    await tick({
      ...ctx,
      load: () => {
        mark('load');
        const state = ctx.load();
        if (bootSkipped && now() >= hardDeadlineAt) hardDeadline();
        return state;
      },
      providers: async () => {
        mark('providers');
        // Only the initial snapshot can skip: later reads follow state changes.
        if (!firstFetch) return ctx.providers(mark);
        firstFetch = false;
        if (bootSkipped) {
          if (now() >= hardDeadlineAt) hardDeadline();
          fetchSkipped = true;
          const reason = bootMs + now() - nodeStartedAt >= deadlineMs ? 'boot_exhausted' : 'below_minimum';
          const remainingMs = Math.max(0, deadlineAt - now() - SAVE_RESERVE_MS);
          emit('reauth', 'providers.fetch.budget', { durationMs: remainingMs, props: { tag: reason } });
          ctx.log?.(`9router Claude detector: providers fetch budget ${reason} (${Math.floor(remainingMs)}ms remaining)`);
          throw new RouterUnavailableError([], { reason, remainingMs, bootMs });
        }
        const controller = new AbortController();
        fetching = controller;
        const budgetMs = Math.max(0, deadlineAt - now() - SAVE_RESERVE_MS);
        const budgetTimer = setTimer(() => {
          if (/^providers:(fetch|body|backoff)(:|$)/.test(currentPhase)) controller.abort(new RouterUnavailableError([]));
        }, budgetMs);
        try {
          return await abortable(() => ctx.providers(mark, { deadlineAt: deadlineAt - SAVE_RESERVE_MS, signal: controller.signal, now, setTimer, clearTimer }), controller.signal);
        } catch (error) {
          fetchSkipped = error instanceof RouterUnavailableError;
          if (fetchSkipped) error.fetchAttempted = fetchAttempted;
          throw error;
        } finally { fetching = undefined; clearTimer(budgetTimer); }
      },
      save: state => {
        mark('save');
        const before = now();
        if (bootSkipped && before >= hardDeadlineAt) hardDeadline();
        const result = ctx.save(state);
        if (bootSkipped ? now() >= hardDeadlineAt : now() >= deadlineAt && (!fetchSkipped || now() - before >= SAVE_RESERVE_MS)) hardDeadline();
        return result;
      },
    });
    if (now() >= hardDeadlineAt && (bootSkipped || !fetchSkipped)) hardDeadline();
    mark('done');
  } catch (error) {
    // Marker/delivery code can catch IO errors internally. A late result after
    // a valid snapshot must still report the deadline, even on that error path.
    if (!deadlineFailed && now() >= hardDeadlineAt && (bootSkipped || !fetchSkipped)) hardDeadline();
    if (error instanceof RouterUnavailableError) report.mark('providers:fetch:retry');
    report.failure(`failed; router, notification delivery, journal or prior-worker state unavailable.${error.sustainedMinutes === undefined ? '' : ` for ${error.sustainedMinutes} min`}`);
    throw error;
  } finally { clearTimer(timer); }
}

// Import and instantiate only if a future, explicitly fenced recovery path
// actually calls control. Notification-only operation needs no ExternalSSD.
export function lazyControlClient(load = () => import('/Volumes/ExternalSSD/t3code-fork/apps/server/src/ardud/control/client.mjs')) {
  let client;
  return async () => {
    if (!client) client = Promise.resolve().then(load).then(({ ControlClient }) => new ControlClient({ component: 'watchers', timeoutMs: 6_000 }));
    return client;
  };
}

async function live() {
  if (process.env.WATCH_DIR !== ROOT || process.env.WATCH_ID !== '9router-claude-reauth' || !process.env.WATCH_RUN || ROOT !== join(homedir(), '.local/share/robob-watch/watchers/9router-claude-reauth') || existsSync(join(ROOT, 'ENABLE_REQUIRED'))) throw new Error('live execution refused');
  // This exported function can also be imported for synthetic tests: the
  // live side additionally checks the runner-only environment and hold.
  // Successful stderr/stdout are not a safe diagnostic channel: the runner
  // discards stderr and treats stdout as a wake event.
  const log = line => {
    try { appendFileSync(join(ROOT, 'log'), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }); } catch { /* tool log remains available */ }
  };
  const report = phaseReporter(process.env.WATCH_DIR, { log });
  const commands = new AbortController();
  const command = args => telegramCommand(args, { phase: report.mark, signal: commands.signal });
  const control = lazyControlClient();
  await runObserved({
    enforceSafetyFence: true,
    now: Date.now, load: () => readState(STATE), save: s => writeState(STATE, s), providers: (phase, budget) => liveProviders({ phase, log, ...budget }), log,
    leasePath: DEFAULT_LEASE, leaseOwner: () => leaseOwner(DEFAULT_LEASE),
    acquireLease: id => acquireLease(DEFAULT_LEASE, 'auto', id), releaseLease: o => releaseLease(DEFAULT_LEASE, o),
    available: async () => (await (await control()).health())?.ok === true,
    notificationAvailable: async () => telegramHealthy(await command(['health'])),
    thread: async id => (await control()).thread(id), create: async body => (await control()).createThread(body),
    lastAssistant: async (id, runId) => (await (await control()).messages(id, { runId, limit: 1, role: 'assistant' })).lastAssistant?.text ?? null,
    notify: (key, text) => command(['notify', '--source', '9router Claude recovery', '--severity', 'attention', '--text', text, '--key', key]),
    notificationState: async key => notificationState(await command(['notifications']), key),
    notificationSnapshot: () => command(['notifications']),
  }, { phase: report, onDeadline: () => commands.abort() });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === '--assert-incident' && process.argv.length === 5) {
    liveProviders().then(payload => {
      const pending = assertIncident(payload, process.argv[3], process.argv[4]);
      process.stdout.write(pending ? 'PENDING\n' : 'NOT_PENDING\n');
      if (!pending) process.exitCode = 2;
    }).catch(() => { process.stderr.write('UNKNOWN\n'); process.exitCode = 1; });
  } else if (process.argv[2] === '--assert-cleared' && process.argv.length === 4) {
    liveProviders().then(payload => {
      const cleared = assertCleared(payload, process.argv[3]);
      process.stdout.write(cleared ? 'CLEARED\n' : 'NOT_CLEARED\n');
      if (!cleared) process.exitCode = 2;
    }).catch(() => { process.stderr.write('UNKNOWN\n'); process.exitCode = 1; });
  } else if (process.argv[2] !== '--live' || process.env.WATCH_DIR !== ROOT || process.env.WATCH_ID !== '9router-claude-reauth' || !process.env.WATCH_RUN || ROOT !== join(homedir(), '.local/share/robob-watch/watchers/9router-claude-reauth') || existsSync(join(ROOT, 'ENABLE_REQUIRED'))) {
    process.stderr.write('Live check refused; run the synthetic tests instead.\n'); process.exitCode = 2;
  } else {
    live().catch(() => { process.exitCode = 1; });
  }
}
