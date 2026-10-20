import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessCache, planRefresh, missingFromCache, MIN_REFRESH_GAP_MS } from '../lib/check.mjs';

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
