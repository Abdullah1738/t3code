// Writes a 4h update into a running OWNER-UPDATES.md-style file.
//
// Same format as the hand-kept Crpko file: updates go newest-first directly
// below the UPDATES-INSERT-BELOW marker, and the STORY-START..STORY-END block
// is never touched. The export is a copy of what the mission already holds;
// the default target is scratch, and the live Crpko file takes an explicit
// `live` (the cutover's report jobs).
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const MARKER =
  '<!-- UPDATES-INSERT-BELOW: routine updates add a new "### <date> <time> UTC" section directly below this line. -->';
const MARKER_PREFIX = '<!-- UPDATES-INSERT-BELOW';
const STORY = /<!-- STORY-START[\s\S]*?<!-- STORY-END -->/;

// The live hand-kept reports, written only when the caller says `live`. Case
// does not count: the external volume is case-insensitive.
const LIVE = [/\/crpko-devops\/tmp\/coordinator-study-[^/]+\/status\//i];
// First line of every daily this exporter writes; anything else is not ours.
const DAILY_STAMP = '<!-- scribe daily -->';

const header = (title) =>
  [
    `# ${title}: running update`,
    '',
    'Generated from mission data. Updates are dated and the newest one is first.',
    '',
    MARKER,
    '',
  ].join('\n');

const real = (path) => {
  const abs = resolve(path);
  try {
    return realpathSync.native(abs);
  } catch {
    try {
      return resolve(realpathSync.native(dirname(abs)), abs.split('/').pop());
    } catch {
      return abs;
    }
  }
};

export const isLiveReport = (path) => LIVE.some((pattern) => pattern.test(real(path)));

/** Inserts `section` below the marker; returns the new file text. Pure. */
export const insertUpdate = (file, section) => {
  const lines = file.split('\n');
  const at = lines.findIndex((line) => line.startsWith(MARKER_PREFIX));
  if (at === -1) throw new Error('no UPDATES-INSERT-BELOW marker in the target file');
  const heading = section.split('\n', 1)[0].trim();
  if (heading.startsWith('### ') && lines.some((line) => line.trim() === heading)) {
    return { text: file, inserted: false };
  }
  const before = lines.slice(0, at + 1);
  const after = lines.slice(at + 1);
  while (after.length > 0 && after[0].trim() === '') after.shift();
  const text = [...before, '', section.trimEnd(), '', ...after].join('\n');
  const story = file.match(STORY)?.[0];
  if (story !== undefined && text.match(STORY)?.[0] !== story) {
    throw new Error('refusing to write: the STORY block would change');
  }
  return { text: text.endsWith('\n') ? text : `${text}\n`, inserted: true };
};

// The live status files belong to the old master until the mission takes them over; the
// cutover's report jobs pass `live` (the CLI's --live) once it has.
const refuseLive = (path, live) => {
  if (!live && isLiveReport(path)) {
    throw new Error(`refusing to write the live report file ${path} (it takes --live)`);
  }
};

/**
 * Throws when `kind` ('update' or 'daily') could not be written to `path`. The CLI
 * checks this before asking the server, so a saved report is never one the file missed.
 */
export const assertWritable = (path, { kind, live = false }) => {
  refuseLive(path, live);
  if (!existsSync(path)) return;
  const current = readFileSync(path, 'utf8');
  if (kind === 'daily' && !current.startsWith(DAILY_STAMP)) {
    throw new Error(`refusing to overwrite ${path}: it was not written by scribe`);
  }
  if (kind === 'update' && !current.split('\n').some((line) => line.startsWith(MARKER_PREFIX))) {
    throw new Error('no UPDATES-INSERT-BELOW marker in the target file');
  }
};

/** Writes the update into `path` (created with a header when missing). */
export const exportUpdate = (path, section, { title = 'Mission', live = false } = {}) => {
  assertWritable(path, { kind: 'update', live });
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const current = existsSync(path) ? readFileSync(path, 'utf8') : header(title);
  const { text, inserted } = insertUpdate(current, section);
  if (inserted || !existsSync(path)) writeFileSync(path, text);
  return { path, inserted };
};

/**
 * Writes a daily summary to `path`. Refuses the live report files unless `live`, and
 * only overwrites a file this exporter wrote before (it starts with a stamp line).
 */
export const exportDaily = (path, text, { live = false } = {}) => {
  assertWritable(path, { kind: 'daily', live });
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${DAILY_STAMP}\n${text.endsWith('\n') ? text : `${text}\n`}`);
  return { path, inserted: true };
};
