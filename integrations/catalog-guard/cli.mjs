#!/usr/bin/env node
// catalog-guard: notices when Robob's OpenCode model catalog has gone partial
// (opus/* models missing while the OpenCode service lists them) and asks Robob
// to re-read it. Run `check` every few minutes (LaunchAgent) or by hand.
import { assessCache, planRefresh, cachedSlugs, summarize, MIN_REFRESH_GAP_MS } from './lib/check.mjs';
import * as io from './lib/io.mjs';

function parseArgs(argv) {
  const [cmd = 'check', ...rest] = argv;
  const opts = { cmd, dryRun: false, cache: io.PATHS.cache };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--cache') opts.cache = rest[++i];
    else if (a === '--help' || a === '-h') opts.cmd = 'help';
    else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

const log = (...parts) => console.log(new Date().toISOString(), 'catalog-guard', ...parts);

async function check(opts) {
  const now = Date.now();
  const state = opts.dryRun ? {} : io.readState();
  const cache = io.readJson(opts.cache);
  const assessed = assessCache(cache, { now });
  const record = (result) => {
    if (!opts.dryRun) io.writeState({ ...state, ...result, lastCheckAt: new Date(now).toISOString() });
  };

  if (assessed.next !== 'check-service') {
    if (opts.dryRun) log(`dry-run: cache ${assessed.count ?? '?'} models, ${assessed.next} (${assessed.reason})`);
    record({ lastResult: assessed.next });
    return 0;
  }

  let service;
  try {
    service = await io.serviceSlugs();
  } catch (e) {
    log(`cache ${assessed.count} models (${assessed.reason}); could not read the OpenCode service: ${e.message}`);
    record({ lastResult: 'service-error' });
    return 1;
  }
  const plan = planRefresh({ cache, serviceSlugs: service, lastRefreshAt: Date.parse(state.lastRefreshAt ?? '') || 0, now });
  const head = `cache ${assessed.count} models, service ${service.length}`;

  if (plan.action === 'service-lacks') {
    // Not Robob's fault; log once per distinct situation.
    const key = `${assessed.reason}|${service.length}`;
    if (opts.dryRun || state.lastServiceLacks !== key) log(`${head}: ${assessed.reason}, and the service does not list them either; no refresh`);
    record({ lastResult: 'service-lacks', lastServiceLacks: key });
    return 0;
  }
  if (plan.action === 'rate-limited') {
    if (opts.dryRun) log(`dry-run: ${head}, missing ${summarize(plan.missing)}; would wait ${Math.ceil(plan.waitMs / 1000)}s (last refresh ${state.lastRefreshAt})`);
    record({ lastResult: 'rate-limited' });
    return 0;
  }
  if (opts.dryRun) {
    log(`dry-run: ${head}, missing ${summarize(plan.missing)}; would send server.refreshProviders {instanceId:'${io.INSTANCE_ID}'} (min gap ${MIN_REFRESH_GAP_MS / 60_000} min)`);
    return 0;
  }

  const refreshAt = new Date().toISOString();
  io.writeState({ ...state, lastRefreshAt: refreshAt, lastCheckAt: new Date(now).toISOString(), lastResult: 'refreshing' });
  try {
    const reply = await io.refreshProviders();
    const after = io.readJson(opts.cache);
    const left = planRefresh({ cache: after, serviceSlugs: service, now: Date.now(), lastRefreshAt: 0 }).missing;
    const result = left.length === 0 ? 'repaired' : 'still-missing';
    log(`${head}, missing ${summarize(plan.missing)}; refreshed (status ${reply.status}, rpc ${reply.slugs.length} models), cache now ${cachedSlugs(after).size} models: ${result}${left.length ? ` (${summarize(left)})` : ''}`);
    io.writeState({ ...state, lastRefreshAt: refreshAt, lastCheckAt: new Date(now).toISOString(), lastResult: result, refreshes: (state.refreshes ?? 0) + 1 });
    return left.length === 0 ? 0 : 1;
  } catch (e) {
    log(`${head}, missing ${summarize(plan.missing)}; refresh failed: ${e.message}`);
    io.writeState({ ...state, lastRefreshAt: refreshAt, lastCheckAt: new Date(now).toISOString(), lastResult: 'refresh-failed' });
    return 1;
  }
}

const HELP = `catalog-guard check [--dry-run] [--cache <path>]
  Reads Robob's OpenCode provider cache (read-only). If opus/* models are
  missing while the OpenCode service lists them, sends Robob's targeted
  server.refreshProviders RPC (at most once per 5 min) and logs one line.
  --dry-run   decide and print, never refresh or write state
  --cache     read this cache file instead of ~/.robob/caches/opencode.json
  status      print the state file`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.cmd === 'help') return console.log(HELP), 0;
  if (opts.cmd === 'status') return console.log(JSON.stringify(io.readState(), null, 2)), 0;
  if (opts.cmd === 'check') return check(opts);
  throw new Error(`unknown command ${opts.cmd}`);
}

main().then(
  (code) => process.exit(code ?? 0),
  (e) => {
    log(`error: ${e.message}`);
    process.exit(2);
  },
);
