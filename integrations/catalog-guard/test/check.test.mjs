import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessCache, planRefresh, missingFromCache, watchPolicy, MIN_REFRESH_GAP_MS } from '../lib/check.mjs';
import { check } from '../cli.mjs';
import { refreshProviders } from '../lib/io.mjs';

const NOW = Date.parse('2026-10-19T09:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const FREE = [
  'opencode/beam-free', 'opencode/big-pickle', 'opencode/deepseek-v4.1-flash-free', 'opencode/glm-5.3-flash-free',
  'opencode/longcat-2.5-preview-free', 'opencode/mimo-v2.6-flash-free', 'opencode/nemotron-3-ultra-free',
  'opencode/nemotron-3.5-lightning-free', 'opencode/nemotron-3.5-super-vl-free', 'opencode/space-bunny-free',
  'ollama/qwen2.5-coder:3b',
];
const OPUS = ['opus/claude-opus-5-5', 'opus/cc/claude-haiku-5-5', 'opus/cx/gpt-6.1-sol', 'opus/gpt-6-astra'];
const cacheOf = (slugs, checkedAt = iso(NOW - 3600_000)) => ({
  enabled: true, status: 'ready', checkedAt, models: slugs.map((slug) => ({ slug })),
});

test('a complete catalog is ok without asking the service', () => {
  assert.equal(assessCache(cacheOf([...FREE, ...OPUS]), { now: NOW }).next, 'ok');
});

test('the 11-model free-only catalog needs a service check', () => {
  const a = assessCache(cacheOf(FREE), { now: NOW });
  assert.equal(a.next, 'check-service');
  assert.equal(a.count, 11);
  assert.match(a.reason, /no opus\/\* models/);
});

test('one required model missing is enough', () => {
  const a = assessCache(cacheOf([...FREE, 'opus/claude-opus-5-5', 'opus/gpt-6-astra']), { now: NOW });
  assert.equal(a.next, 'check-service');
  assert.match(a.reason, /opus\/cx\/gpt-6.1-sol/);
});

test('a cache written moments ago is left to settle', () => {
  assert.equal(assessCache(cacheOf(FREE, iso(NOW - 5_000)), { now: NOW }).next, 'settling');
});

test('missing, unreadable or disabled caches are skipped', () => {
  assert.equal(assessCache(null, { now: NOW }).next, 'skip');
  assert.equal(assessCache({ ...cacheOf(FREE), enabled: false }, { now: NOW }).next, 'skip');
});

test('refreshes when the service lists what the cache lacks', () => {
  const plan = planRefresh({ cache: cacheOf(FREE), serviceSlugs: [...FREE, ...OPUS, 'surplus/kimi-k3'], now: NOW });
  assert.equal(plan.action, 'refresh');
  assert.deepEqual(plan.missing, [...OPUS].toSorted());
});

test('never refreshes twice within five minutes', () => {
  const base = { cache: cacheOf(FREE), serviceSlugs: [...FREE, ...OPUS], now: NOW };
  assert.equal(planRefresh({ ...base, lastRefreshAt: NOW - 60_000 }).action, 'rate-limited');
  assert.equal(planRefresh({ ...base, lastRefreshAt: NOW - MIN_REFRESH_GAP_MS }).action, 'refresh');
});

test('does nothing when the service does not list the models either', () => {
  const plan = planRefresh({ cache: cacheOf(FREE), serviceSlugs: FREE, now: NOW });
  assert.equal(plan.action, 'service-lacks');
});

test('only watched models count as missing', () => {
  assert.deepEqual(missingFromCache(cacheOf([...FREE, ...OPUS]), [...FREE, ...OPUS, 'surplus/kimi-k3']), []);
});

test('active and completed cutovers stop requiring OpenCode Claude/OpenAI and retain the title model', () => {
  for (const cutover of [{ active: true, completed: false }, { active: false, completed: true }]) {
    const policy = watchPolicy(cutover);
    assert.equal(assessCache(cacheOf(['surplus/glm-5.3-flash']), { now: NOW, ...policy }).next, 'ok');
    assert.deepEqual(missingFromCache(cacheOf(FREE), [...OPUS, 'surplus/glm-5.3-flash'], policy), ['surplus/glm-5.3-flash']);
    assert.deepEqual(missingFromCache(cacheOf(['surplus/glm-5.3-flash']), OPUS, policy), []);
  }
});

test('explicit retained OpenCode selections are watched without resurrecting departing models', () => {
  const policy = watchPolicy({ completed: true, retainedOpenCodeModels: ['surplus/title', 'kimi/k3', ...OPUS] });
  assert.deepEqual(policy.required, ['surplus/title', 'kimi/k3']);
  assert.deepEqual(planRefresh({ cache: cacheOf([]), serviceSlugs: ['kimi/k3', ...OPUS], now: NOW, ...policy }).missing, ['kimi/k3']);
});

test('CLI passes cutover requirements through assessment and repair', async () => {
  const calls = { service: 0, refresh: 0, writes: [] };
  let slugs = FREE;
  const fake = {
    INSTANCE_ID: 'opencode', readState: () => ({}), readJson: () => cacheOf(slugs),
    harnessCutoverStatus: async () => ({ active: false, completed: true }), configuredWatch: () => ({}),
    serviceSlugs: async () => { calls.service++; return [...FREE, ...OPUS, 'surplus/glm-5.3-flash']; },
    refreshProviders: async () => { calls.refresh++; slugs = [...FREE, 'surplus/glm-5.3-flash']; return { status: 'ready', slugs }; },
    writeState: (s) => calls.writes.push(s),
  };
  assert.equal(await check({ cache: 'fixture', dryRun: false }, fake), 0);
  assert.equal(calls.refresh, 1);
  assert.equal(calls.writes.at(-1).lastResult, 'repaired');
  assert.equal(await check({ cache: 'fixture', dryRun: true }, fake), 0);
  assert.equal(calls.service, 1);
  assert.equal(calls.refresh, 1);
});

test('unknown cutover state and wrong provider never refresh', async () => {
  await assert.rejects(() => refreshProviders({ instanceId: 'codex' }), /cannot refresh a native provider/);
  await assert.rejects(() => check({}, { INSTANCE_ID: 'claudeAgent' }), /only compares the OpenCode/);
  const fake = { INSTANCE_ID: 'opencode', readState: () => ({}), readJson: () => cacheOf(FREE),
    harnessCutoverStatus: async () => { throw new Error('status unavailable'); } };
  await assert.rejects(() => check({}, fake), /status unavailable/);
});

test('cutover beginning during service read abandons the pre-cutover refresh', async () => {
  let reads = 0;
  const fake = { INSTANCE_ID: 'opencode', readState: () => ({}), readJson: () => cacheOf(FREE),
    harnessCutoverStatus: async () => ({ active: ++reads > 1, completed: false }), configuredWatch: () => ({}),
    serviceSlugs: async () => OPUS };
  assert.equal(await check({ cache: 'fixture' }, fake), 0);
  assert.equal(reads, 2);
});
