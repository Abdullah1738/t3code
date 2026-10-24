// Writes one report: gather the facts pack, one editor call, code checks,
// one retry with the failed checks, and the plain render (flagged in the
// text) when the retry fails too. The release, deploy and review sections
// are the code's own lines in every version (lines.mjs). A text whose only fault is a few merged
// units left out keeps its writing; the code adds those units as plain
// lines under a line that says so. A report always comes out; one that fails
// its checks even in plain form comes out marked `passed: false`.
import { EDITOR_MODEL, chat } from '../model.mjs';
import { checkReport, layout } from './checks.mjs';
import { parseSetToday } from './followups.mjs';
import { OWNED_FORMS, pinFacts, unpin, withOwned } from './lines.mjs';
import { hanging } from './mission.mjs';
import { gatherPack } from './pack.mjs';
import { fixPrompt, writerPrompt } from './prompt.mjs';
import { FALLBACK_LEVELS, fallbackBody, mendBuilt, reportHeader, updateTail } from './render.mjs';
import { redact } from './scrub.mjs';

// Room for the editor's thinking as well as a 60k-character report.
export const WRITER_MAX_TOKENS = 64_000;
export const WRITER_TIMEOUT_MS = 15 * 60_000;

const FIRST_HEADING = { daily: /^##\s/, update: /^####\s/ };
// Finish reasons of a reply that ended on its own.
const FINISHED = new Set(['stop', 'end_turn', 'stop_sequence']);

/**
 * The editor's reply as a body: no code fences, nothing before the first
 * section heading (a repeated title or preamble).
 */
export function cleanBody(kind, content) {
  let text = String(content ?? '').trim();
  const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(text);
  if (fenced) text = fenced[1].trim();
  const lines = text.split('\n');
  const start = lines.findIndex((line) => FIRST_HEADING[kind].test(line));
  return (start > 0 ? lines.slice(start) : lines).join('\n').trim();
}

const total = (attempts) =>
  attempts.reduce((sum, attempt) => (attempt.usage ? { input: sum.input + attempt.usage.input, output: sum.output + attempt.usage.output } : sum), {
    input: 0,
    output: 0,
  });

/**
 * One report for [from, to). `previous` is the report this one follows (the
 * last daily for a daily, the last update for an update), or null. Returns
 * {text, open, facts}: the text to save, the items left open, and the facts
 * (the pack and how the text was written) to store with it.
 */
export async function writeReport({
  config,
  kind,
  from,
  to,
  db,
  exec,
  previous = null,
  chatImpl = chat,
  model = config.model || EDITOR_MODEL,
  useModel = true,
  maxTokens = WRITER_MAX_TOKENS,
  timeoutMs = WRITER_TIMEOUT_MS,
  log = () => {},
}) {
  if (kind !== 'daily' && kind !== 'update') throw new Error(`kind must be daily or update, not ${kind}`);
  const pack = await gatherPack({ config, kind, from, to, db, exec, previous, log });
  log(`pack: ${pack.counts.merged} merged, ${pack.reviews.length} reviews, ${pack.releases.length} releases, ${pack.errors.length} sources failed`);
  const header = reportHeader(config, pack, kind);
  const hang = kind === 'update' ? hanging(db, { config, previousOpen: pack.previous?.open ?? [], to }) : null;
  // The editor's text with the code's release, deploy and review lines in
  // place (a shorter form when the full one would break the size limit).
  const shape = layout(kind, pack);
  // The header and the update's closing parts come from the records too, and
  // the whole report gets the pins (a title or label can name a tag or PR).
  const compose = (body, usage) =>
    `${pinFacts(config, pack, [header, '', body.trim(), ...(kind === 'update' ? ['', updateTail(config, pack, hang, usage)] : [])].join('\n'), kind, shape)}\n`;
  // The fullest form of the code's lines that fits (OWNED_FORMS: full, brief, compact).
  const place = (body, usage) => {
    let placed = body;
    for (const form of OWNED_FORMS) {
      placed = withOwned(config, pack, kind, shape, body, form);
      if (compose(placed, usage).length <= config.limits[kind]) break;
    }
    return placed;
  };

  const attempts = [];
  // The editor's last text that failed its checks, kept with the facts for a look.
  let rejected = null;
  let text = null;
  let status = 'plain';
  if (useModel) {
    const { system, user } = writerPrompt(config, pack, { kind, header });
    let message = user;
    for (let round = 1; round <= 2 && text === null; round++) {
      try {
        const reply = await chatImpl({ model, system, user: message, maxTokens, timeoutMs, stream: true });
        const usage = total([...attempts, { usage: reply.usage }]);
        const written = cleanBody(kind, reply.content);
        let body = place(written, usage);
        let candidate = compose(body, usage);
        let errors = checkReport(config, pack, kind, candidate);
        // A few merged units left out of an otherwise good text: add them as plain lines rather than lose the writing.
        let mended = [];
        const mend = errors.length && reply.finish !== 'length' ? mendBuilt(config, pack, kind, body) : null;
        if (mend) {
          const mendedBody = place(mend.text, usage);
          const mendedText = compose(mendedBody, usage);
          if (!checkReport(config, pack, kind, mendedText).length) {
            body = mendedBody;
            candidate = mendedText;
            errors = [];
            mended = mend.added;
          }
        }
        if (reply.finish === 'length') errors.unshift(`The reply was cut off at the ${maxTokens} token limit; write it shorter.`);
        // Only a reply that says it finished can be published; one that just stopped can't.
        else if (!FINISHED.has(reply.finish)) errors.unshift(`The reply ended without finishing (${reply.finish ?? 'no finish reason'}); write the whole report.`);
        attempts.push({ round, usage: reply.usage ?? null, finish: reply.finish ?? null, errors, ...(mended.length ? { mended } : {}) });
        rejected = errors.length ? body : null;
        log(`round ${round}: ${reply.usage?.input ?? '?'} in, ${reply.usage?.output ?? '?'} out, ${errors.length} failed checks${mended.length ? `, ${mended.length} left-out units added` : ''}`);
        if (!errors.length) {
          text = candidate;
          status = round === 1 ? 'written' : 'retried';
        } else {
          message = `${user}\n\n${fixPrompt(written, errors)}`;
        }
      } catch (error) {
        attempts.push({ round, usage: null, errors: [`The call failed: ${String(error.message ?? error).slice(0, 300)}`] });
        log(`round ${round}: call failed: ${error.message}`);
      }
    }
  }

  let fallbackErrors = [];
  if (text === null) {
    const reached = attempts.some((attempt) => attempt.usage);
    const note = !useModel
      ? 'This is the plain version, built straight from the records (written without the editor on purpose).'
      : reached
        ? `This is the plain version, built straight from the records: the written version failed its checks twice (${attempts.at(-1)?.errors.length ?? 0} problems in the last try).`
        : 'This is the plain version, built straight from the records: the editor could not be reached.';
    status = useModel ? 'fallback' : 'plain';
    // Shorter plain versions until one passes (only work items, open items
    // and gists shrink; every merged unit, release and review stays).
    for (let level = 0; level < FALLBACK_LEVELS; level++) {
      text = compose(fallbackBody(config, pack, kind, note, level), total(attempts));
      fallbackErrors = checkReport(config, pack, kind, text, { plain: true });
      if (!fallbackErrors.length) break;
    }
    if (fallbackErrors.length) log(`plain version still fails ${fallbackErrors.length} checks: ${fallbackErrors.join(' | ').slice(0, 500)}`);
  }

  const open = pack.open.map((item) => ({ ref: item.ref, label: redact(item.label, config.banned).slice(0, 300), since: item.since }));
  return {
    text,
    open,
    status,
    // False when even the plain version fails its checks: keep it for a
    // look, but don't publish or store it.
    passed: fallbackErrors.length === 0,
    facts: {
      schema: 'scribe.writer.report.v1',
      writer: { status, model: useModel ? model : null, attempts, fallbackErrors, usage: total(attempts), ...(status === 'fallback' && rejected ? { rejected } : {}) },
      // Without the pinned record outcomes: tomorrow's records are different.
      followUps: { set: kind === 'daily' ? parseSetToday(unpin(text)) : [] },
      hanging: hang,
      pack,
    },
  };
}
