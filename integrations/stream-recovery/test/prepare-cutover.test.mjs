import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cutoverInput, prepare, writeCutoverInput } from '../scripts/prepare-cutover.mjs';

const cards = [{ n: 12, stage: 'in_review', id: 'card-12', thread: 'stopped-review' },
  { n: 13, stage: 'working', id: 'card-13', thread: 'stopped-work' }];
const running = { threadId: 'running', state: 'running', activeRunId: 'r1',
  model: { instanceId: 'opencode', model: 'opus/claude-opus-5-5' } };
const page = (threads) => ({ ok: true, total: threads.length, threads });

test('preparation preserves exact card identities/stages and claims only OpenCode Claude/OpenAI roots', () => {
  assert.deepEqual(cutoverInput(cards, page([
    running, { ...running, threadId: 'native', state: 'waiting', activeRunId: null, latestRunId: 'r2', model: { instanceId: 'codex', model: 'gpt-6.1-sol' } },
    { ...running, threadId: 'ask', state: 'needs-input', activeRunId: 'r3' },
    { ...running, threadId: 'queue-only', state: 'queued', activeRunId: null, latestRunId: 'queued' },
    { ...running, threadId: 'child', activeRunId: 'child-run', parentThreadId: 'running' },
    { ...running, threadId: 'retained', model: { instanceId: 'opencode', model: 'surplus/glm-5.3-flash' } },
    { ...running, threadId: 'native-claude', model: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' } },
    { ...running, threadId: 'native-terra', model: { instanceId: 'codex-cu', model: 'gpt-6.1-terra' } },
    { ...running, threadId: 'openai', activeRunId: 'r4', model: { instanceId: 'opencode', model: 'opus/cx/gpt-6.1-sol#xhigh' } },
  ])), { version: 1, stoppedCards: cards, interruptedThreads: [
    { threadId: 'ask', runId: 'r3' }, { threadId: 'openai', runId: 'r4' }, { threadId: 'running', runId: 'r1' },
  ] });
});

test('unknown Claude/OpenAI family routes remain claimed for an explicit cutover refusal', () => {
  for (const model of ['opus/claude-future', 'anthropic/new-model', 'opus/cc/future', 'openai/future',
    'opus/cx/future', 'layso/gpt-new', 'chatgpt-new', 'or/o3-new#high']) {
    assert.deepEqual(cutoverInput([], page([{ ...running, model: { instanceId: 'opencode', model } }])).interruptedThreads,
      [{ threadId: 'running', runId: 'r1' }]);
  }
});

test('missing or incomplete explicit model selections refuse the snapshot instead of guessing ownership', () => {
  for (const model of [undefined, null, {}, { instanceId: 'opencode' }, { model: 'opus/claude-opus-5-5' },
    { instanceId: 'codex', model: '' }, { instanceId: '', model: 'gpt-6.1-sol' }]) {
    assert.throws(() => cutoverInput([], page([{ ...running, model }])), /no explicit model selection/);
  }
});

test('invalid manifests, missing source IDs and truncated/control-fallback responses refuse preparation', () => {
  for (const manifest of [{}, [{ ...cards[0], stage: 'todo' }], [...cards, cards[0]], [{ ...cards[0], thread: null }]]) {
    assert.throws(() => cutoverInput(manifest, page([])), /manifest|stopped card/);
  }
  for (const response of [null, '<html>', { threads: [] }, { ...page([running]), total: 501 },
    { ...page([running]), nextCursor: 'more' }, page([{ ...running, activeRunId: null }]), page([running, running])]) {
    assert.throws(() => cutoverInput(cards, response), /snapshot|source run|active thread/);
  }
});

test('atomic prepared input is private and idempotent; different unfinished input is never overwritten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prepare-cutover-'));
  try {
    const path = join(dir, 'home/harness-cutover-input.json');
    const input = cutoverInput(cards, page([running]));
    assert.equal(writeCutoverInput(path, input), true);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), input);
    assert.equal(writeCutoverInput(path, input), false);
    assert.throws(() => writeCutoverInput(path, cutoverInput(cards, page([]))), /different cutover input/);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), input);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('helper uses only authenticated control reads; dry run and API errors never write output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prepare-cutover-'));
  try {
    const manifest = join(dir, 'cards.json'), output = join(dir, 'input.json');
    writeFileSync(manifest, JSON.stringify(cards));
    const calls = [];
    const control = async (...args) => { calls.push(args); return page([running]); };
    assert.equal((await prepare({ stoppedCardsPath: manifest, output, dryRun: true }, control)).interruptedThreads, 1);
    assert.equal(existsSync(output), false);
    assert.deepEqual(calls, [['GET', '/threads?active=true&limit=500']]);
    await assert.rejects(() => prepare({ stoppedCardsPath: manifest, output }, async () => { throw new Error('offline'); }), /offline/);
    assert.equal(existsSync(output), false);
    await prepare({ stoppedCardsPath: manifest, output }, control);
    assert.equal(existsSync(output), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
