#!/usr/bin/env node
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ctl } from '../lib/io.mjs';

// Match the resolver's family boundary, not only its verified routes: unknown
// Claude/OpenAI routes must stay held for cutover's explicit refusal.
const cutoverModel = (model) => model.replace(/#([A-Za-z0-9][A-Za-z0-9_-]*)$/, '').split('/')
  .some((part) => /^(?:anthropic|cc|openai|cx)$|^(?:claude|gpt|chatgpt)(?:$|[-_.])|^o\d(?:$|[-_.])/i.test(part));

export function cutoverInput(stoppedCards, page) {
  if (!Array.isArray(stoppedCards)) throw new Error('stopped-cards manifest must be an array');
  const cards = new Set(), numbers = new Set();
  for (const card of stoppedCards) {
    if (!Number.isSafeInteger(card?.n) || card.n <= 0 || !['working', 'in_review'].includes(card.stage)
      || typeof card.id !== 'string' || !card.id || typeof card.thread !== 'string' || !card.thread
      || cards.has(card.id) || numbers.has(card.n)) throw new Error('invalid or duplicate stopped card');
    cards.add(card.id); numbers.add(card.n);
  }
  if (page?.ok !== true || !Array.isArray(page.threads) || !Number.isSafeInteger(page.total)
    || page.total !== page.threads.length || page.nextCursor) {
    throw new Error('active thread snapshot is invalid or truncated; nothing prepared');
  }
  const interruptedThreads = [];
  const seen = new Set();
  for (const thread of page.threads) {
    if (typeof thread?.threadId !== 'string' || !thread.threadId || seen.has(thread.threadId)
      || !['running', 'waiting', 'needs-input', 'queued'].includes(thread.state)) {
      throw new Error('invalid or duplicate active thread');
    }
    seen.add(thread.threadId);
    if (typeof thread.model?.instanceId !== 'string' || !thread.model.instanceId
      || typeof thread.model.model !== 'string' || !thread.model.model) {
      throw new Error(`active thread ${thread.threadId} has no explicit model selection`);
    }
    if (thread.archived || thread.parentThreadId || thread.threadId.startsWith('thread:provider:')) continue;
    if (thread.model.instanceId !== 'opencode' || !cutoverModel(thread.model.model)) continue;
    // A queue with no current execution is not interrupted work. Waiting
    // threads can have a completed own run while native children still work.
    if (thread.state === 'queued' && !thread.activeRunId) continue;
    const runId = thread.activeRunId ?? thread.latestRunId;
    if (typeof runId !== 'string' || !runId) throw new Error(`active thread ${thread.threadId} has no source run ID`);
    interruptedThreads.push({ threadId: thread.threadId, runId });
  }
  return {
    version: 1,
    stoppedCards: stoppedCards.map(({ n, stage, id, thread }) => ({ n, stage, id, thread })),
    interruptedThreads: interruptedThreads.sort((a, b) => a.threadId.localeCompare(b.threadId)),
  };
}

export function writeCutoverInput(path, input) {
  const text = JSON.stringify(input, null, 2) + '\n';
  if (existsSync(path)) {
    if (JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))) === JSON.stringify(input)) return false;
    throw new Error('a different cutover input already exists; reconcile it before preparing another cutover');
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, text);
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    // Linking a fully written inode publishes it atomically without replacing
    // another preparer's input between the existence check and publication.
    linkSync(temporary, path);
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
  return true;
}

export async function prepare({ stoppedCardsPath, output, dryRun = false }, control = ctl) {
  const cards = JSON.parse(readFileSync(stoppedCardsPath, 'utf8'));
  const page = await control('GET', '/threads?active=true&limit=500');
  const input = cutoverInput(cards, page);
  if (!dryRun) writeCutoverInput(output, input);
  return { ok: true, dryRun, output, stoppedCards: input.stoppedCards.length, interruptedThreads: input.interruptedThreads.length };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    let stoppedCardsPath, output = join(process.env.HOME || homedir(), '.robob/harness-cutover-input.json'), dryRun = false;
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--stopped-cards') stoppedCardsPath = args[++index];
      else if (args[index] === '--output') output = args[++index];
      else if (args[index] === '--dry-run') dryRun = true;
      else throw new Error(`unknown argument ${args[index]}`);
    }
    if (!stoppedCardsPath || !output) throw new Error('usage: prepare-cutover.mjs --stopped-cards MANIFEST.json [--output INPUT.json] [--dry-run]');
    console.log(JSON.stringify(await prepare({ stoppedCardsPath, output, dryRun })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
