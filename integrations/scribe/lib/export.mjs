// Writes a 4h update into a running OWNER-UPDATES.md-style file.
//
// Same format as the hand-kept Crpko file: updates go newest-first directly
// below the UPDATES-INSERT-BELOW marker, and the STORY-START..STORY-END block
// is never touched. The export is a copy of what the mission already holds;
// the default target is scratch, and the live Crpko file takes an explicit
// `live` (the cutover's report jobs).
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { unpin } from './writer/lines.mjs';

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

/**
 * Where `path` really is, read the way the filesystem reads it: each part in
 * turn, a symlink resolved before a later `..` steps out of it, and parts
 * that don't exist yet kept as given. So `alias/../x.md`, with `alias` a
 * link into another folder, names that folder's parent, as a write would.
 */
export const canonicalPath = (path) => {
  const raw = isAbsolute(path) ? path : `${process.cwd()}/${path}`;
  let at = '/';
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      at = dirname(at);
      continue;
    }
    const next = join(at, part);
    try {
      lstatSync(next);
      at = realpathSync.native(next);
    } catch {
      at = next;
    }
  }
  return at;
};

// Case folded broadly (upper then lower, so final sigma and sigma, or the
// Kelvin sign and k, meet), whatever the volume does with case: two names a
// case-blind volume might take for one count as one. Too broad only refuses
// a pair of outputs, never merges them.
// Repeated to a fixed point, with full mappings: capital sharp S, sharp S
// and SS all end as "ss", the way a lower-upper-lower pass alone does not.
const fold = (text) => {
  let out = text.normalize('NFKD');
  for (let prev = null; prev !== out; ) {
    prev = out;
    out = out.toLowerCase().toUpperCase().toLowerCase().normalize('NFKD');
  }
  return out.normalize('NFC');
};

// A path as a case-blind volume compares names.
const comparable = (path) => fold(canonicalPath(path).normalize('NFC'));

/**
 * Whether two paths are one file: the same place once links are resolved
 * and case is folded (so two names for a file that doesn't exist yet count
 * too, on any volume), or the same inode (hard links).
 */
export const sameFile = (a, b) => {
  if (comparable(a) === comparable(b)) return true;
  try {
    const one = statSync(a);
    const two = statSync(b);
    return one.dev === two.dev && one.ino === two.ino;
  } catch {
    return false;
  }
};

export const isLiveReport = (path) => LIVE.some((pattern) => pattern.test(canonicalPath(path)));

/**
 * Writes a file by replacing it (a new file renamed into place, at the
 * file's real location), so a hard link to it elsewhere, a published report
 * say, keeps its old text and a symlink stays a symlink. Keeps the old mode.
 */
export const replaceFile = (path, text) => {
  const real = canonicalPath(path);
  mkdirSync(dirname(real), { recursive: true });
  const temp = join(dirname(real), `.${basename(real)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(temp, text);
  try {
    chmodSync(temp, statSync(real).mode & 0o7777);
  } catch {}
  renameSync(temp, real);
};

/** Inserts `section` below the marker; returns the new file text. Pure. */
export const insertUpdate = (file, section) => {
  const lines = file.split('\n');
  const at = lines.findIndex((line) => line.startsWith(MARKER_PREFIX));
  if (at === -1) throw new Error('no UPDATES-INSERT-BELOW marker in the target file');
  // The heading names the window; the code's [record: ...] pins after a name
  // in it can change between two writes of the same window.
  const bare = (line) => unpin(line).trim();
  const heading = bare(section.split('\n', 1)[0]);
  if (heading.startsWith('### ') && lines.some((line) => bare(line) === heading)) {
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
  // The real place, as replaceFile will write it: `missing/../x` is x.
  const real = canonicalPath(path);
  refuseLive(real, live);
  if (!existsSync(real)) return;
  const current = readFileSync(real, 'utf8');
  if (kind === 'daily' && !current.startsWith(DAILY_STAMP)) {
    throw new Error(`refusing to overwrite ${path}: it was not written by scribe`);
  }
  if (kind === 'update' && !current.split('\n').some((line) => line.startsWith(MARKER_PREFIX))) {
    throw new Error('no UPDATES-INSERT-BELOW marker in the target file');
  }
};

/** Writes the update into `path` (created with a header when missing). */
export const exportUpdate = (path, section, { title = 'Mission', live = false } = {}) => {
  // Resolved once: what is checked, read and replaced is the same file.
  const real = canonicalPath(path);
  assertWritable(real, { kind: 'update', live });
  const current = existsSync(real) ? readFileSync(real, 'utf8') : header(title);
  const { text, inserted } = insertUpdate(current, section);
  // Replaced, not rewritten in place: a hard link elsewhere keeps its text.
  if (inserted || !existsSync(real)) replaceFile(real, text);
  return { path, inserted };
};

/**
 * Writes a daily summary to `path`. Refuses the live report files unless `live`, and
 * only overwrites a file this exporter wrote before (it starts with a stamp line).
 */
export const exportDaily = (path, text, { live = false } = {}) => {
  const real = canonicalPath(path);
  assertWritable(real, { kind: 'daily', live });
  replaceFile(real, `${DAILY_STAMP}\n${text.endsWith('\n') ? text : `${text}\n`}`);
  return { path, inserted: true };
};
