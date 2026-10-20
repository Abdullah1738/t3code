import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MARKER, exportDaily, exportUpdate, insertUpdate, isLiveReport } from '../lib/export.mjs';

const FILE = [
  '# Crpko: running update for Abdullah',
  '',
  'Intro.',
  '',
  '<!-- STORY-START: the backfill agent replaces everything between these markers. Routine updates never touch it. -->',
  'The story so far.',
  '<!-- STORY-END -->',
  '',
  MARKER,
  '',
  '### 2026-10-17 04:03 UTC',
  '',
  'Older update.',
  '',
].join('\n');

const section = '### 2026-10-17 08:05 UTC\n\n**Short version:** New.\n';

test('inserts newest-first right below the marker and keeps the story block', () => {
  const { text, inserted } = insertUpdate(FILE, section);
  assert.equal(inserted, true);
  const lines = text.split('\n');
  const at = lines.indexOf(MARKER);
  assert.deepEqual(lines.slice(at, at + 4), [MARKER, '', '### 2026-10-17 08:05 UTC', '']);
  assert.ok(text.indexOf('08:05 UTC') < text.indexOf('04:03 UTC'));
  assert.ok(text.includes('The story so far.\n<!-- STORY-END -->'));
  assert.equal(text.slice(0, text.indexOf(MARKER)), FILE.slice(0, FILE.indexOf(MARKER)));
});

test('the same update twice is written once', () => {
  const once = insertUpdate(FILE, section).text;
  const twice = insertUpdate(once, section);
  assert.equal(twice.inserted, false);
  assert.equal(twice.text, once);
});

test('refuses a file without the marker', () => {
  assert.throws(() => insertUpdate('# no marker\n', section), /no UPDATES-INSERT-BELOW marker/);
});

test('exportUpdate creates the file in scratch and appends below the marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scribe-export-'));
  try {
    const path = join(dir, 'nested', 'OWNER-UPDATES.md');
    exportUpdate(path, section, { title: 'Crpko' });
    exportUpdate(path, '### 2026-10-17 12:05 UTC\n\nLater.\n');
    const text = readFileSync(path, 'utf8');
    assert.ok(text.startsWith('# Crpko: running update'));
    assert.ok(text.indexOf('12:05 UTC') < text.indexOf('08:05 UTC'));
    writeFileSync(join(dir, 'other.md'), FILE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the live Crpko report file is refused', () => {
  const live =
    '/Volumes/ExternalSSD/crpko-devops/tmp/coordinator-study-20261002/status/OWNER-UPDATES.md';
  assert.equal(isLiveReport(live), true);
  assert.throws(() => exportUpdate(live, section), /refusing to write the live report file/);
  assert.equal(isLiveReport(join(tmpdir(), 'OWNER-UPDATES.md')), false);
});

test('the live check ignores case, and the daily export refuses live and foreign files', () => {
  const shouty =
    '/Volumes/ExternalSSD/Crpko-Devops/tmp/coordinator-study-20261002/status/OWNER-UPDATES.md';
  assert.equal(isLiveReport(shouty), true);
  assert.throws(() => exportDaily(shouty, '# daily\n'), /refusing to write the live report file/);
  const dir = mkdtempSync(join(tmpdir(), 'scribe-daily-'));
  try {
    const path = join(dir, 'DAILY.md');
    exportDaily(path, '# day one\n');
    exportDaily(path, '# day two\n');
    assert.ok(readFileSync(path, 'utf8').includes('# day two'));
    const foreign = join(dir, 'notes.md');
    writeFileSync(foreign, 'my own notes\n');
    assert.throws(() => exportDaily(foreign, '# daily\n'), /not written by scribe/);
    assert.equal(readFileSync(foreign, 'utf8'), 'my own notes\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with live, the report jobs write the status files and keep their rules', () => {
  const root = mkdtempSync(join(tmpdir(), 'scribe-live-'));
  try {
    const status = join(root, 'crpko-devops', 'tmp', 'coordinator-study-20261002', 'status');
    const updates = join(status, 'OWNER-UPDATES.md');
    const daily = join(status, 'DAILY.md');
    assert.equal(isLiveReport(updates), true);
    assert.throws(() => exportUpdate(updates, section), /it takes --live/);
    mkdirSync(status, { recursive: true });
    const story = '<!-- STORY-START -->\nthe story\n<!-- STORY-END -->';
    writeFileSync(updates, `# Crpko\n\n${story}\n\n${MARKER}\n\n### 2026-10-20 04:00 UTC\nold\n`);
    assert.equal(exportUpdate(updates, section, { live: true }).inserted, true);
    const text = readFileSync(updates, 'utf8');
    assert.ok(text.includes(story));
    assert.ok(text.indexOf(section.split('\n')[0]) < text.indexOf('### 2026-10-20 04:00 UTC'));
    exportDaily(daily, '# day\n', { live: true });
    assert.ok(readFileSync(daily, 'utf8').includes('# day'));
    writeFileSync(daily, 'kept by hand\n');
    assert.throws(() => exportDaily(daily, '# day\n', { live: true }), /not written by scribe/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
