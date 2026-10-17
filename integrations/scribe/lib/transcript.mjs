// Lane transcript events: raw quotable text and the trimmed slice the model reads.
//
// eventText mirrors apps/server/src/ardud/missions/scribe/transcriptText.ts.
// Keep the two in sync: the server checks every quote against that raw text,
// and every body line rendered here is an exact substring of it (headers and
// cut markers are the only additions), so a quote copied from a body line
// passes the citation check. Redaction is the one exception: a quote that
// contains "[redacted]" fails the check on purpose.

const str = (value) => {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
};

const join = (...parts) => parts.map(str).filter((part) => part.length > 0).join('\n');

export function eventText(type, payload) {
  switch (type) {
    case 'user_message':
    case 'assistant_message':
      return str(payload.text);
    case 'command_execution':
      return join(
        payload.input,
        payload.output,
        payload.exitCode === undefined || payload.exitCode === null ? '' : `exit ${str(payload.exitCode)}`,
      );
    case 'dynamic_tool':
      return join(payload.toolName, payload.input, payload.output);
    case 'file_change':
      return join(payload.fileName, payload.newStr);
    case 'subagent':
      return join(payload.title, payload.prompt, payload.result);
    case 'notification':
      return join(payload.summary, payload.outcome);
    case 'compaction':
      return str(payload.summary);
    case 'file_search':
      return join(payload.pattern, payload.results);
    case 'web_search':
      return join(payload.query, payload.results, payload.output);
    case 'error':
      return join(payload.message, payload.text, payload.detail);
    default:
      return join(payload.title);
  }
}

// Same patterns as integrations/memory-system/src/recall_ask.py. Redacted text
// can't be quoted, so a secret never reaches a note.
const SECRET_RE = new RegExp(
  [
    'sk-[A-Za-z0-9_-]{16,}',
    'gh[pousr]_[A-Za-z0-9]{20,}',
    'xox[abpr]-[A-Za-z0-9-]{10,}',
    'AKIA[0-9A-Z]{16}',
    '-----BEGIN [A-Z ]*PRIVATE KEY[\\s\\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)',
    '\\b(?:[Pp]assword|[Pp]asswd|[Ss]ecret|[Tt]oken|[Aa]pi[_ -]?[Kk]ey|[Mm]nemonic|[Ss]eed phrase|[Pp]rivate key)\\b\\s*[:=]\\s*\\S{6,}',
    // Long opaque blobs: upper, lower and digits mixed, no path separators.
    '(?<![\\w/.-])(?=[A-Za-z0-9+_-]*[A-Z])(?=[A-Za-z0-9+_-]*[a-z])(?=[A-Za-z0-9+_-]*\\d)[A-Za-z0-9+_-]{40,}={0,2}(?![\\w/.-])',
  ].join('|'),
  'g',
);

export const redact = (text) => text.replace(SECRET_RE, '[redacted]');

/** Keep head and tail of long text; both halves are exact substrings. */
export function trim(text, head, tail = 0) {
  if (text.length <= head + tail + 40) return text;
  const cut = text.length - head - tail;
  return `${text.slice(0, head)}\n…[${cut} chars cut]…\n${tail > 0 ? text.slice(text.length - tail) : ''}`.trimEnd();
}

const parsePayload = (payload) => {
  if (typeof payload !== 'string') return payload && typeof payload === 'object' ? payload : {};
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const hhmm = (iso) => (typeof iso === 'string' && iso.length >= 16 ? `${iso.slice(11, 16)}Z` : '');

// Who wrote a user message. Owner typing comes from the web or mobile app;
// master, coord and control-API messages arrive as server-created user messages.
export function speaker(payload) {
  if (payload.createdBy === 'agent') return 'agent message';
  if (payload.creationSource === 'web' || payload.creationSource === 'mobile') return 'OWNER';
  return 'message (master/coord)';
}

/**
 * One turn item row -> event with raw text (for checks) and rendered text (for
 * the model). `rendered` has no event number: slices number their events
 * e1..eN (see sliceText) because models shorten long ordinals.
 */
export function toEvent(row) {
  const payload = parsePayload(row.payload_json ?? row.payload);
  const type = row.type;
  const at = payload.completedAt ?? payload.startedAt ?? payload.updatedAt ?? null;
  const raw = eventText(type, payload);
  return { event: Number(row.ordinal), type, at, raw, rendered: render(type, payload, at) };
}

function render(type, p, at) {
  const head = (label) => `${label}${at ? ` ${hhmm(at)}` : ''}`;
  const body = (...parts) => parts.map(str).filter((part) => part.trim().length > 0).join('\n');
  switch (type) {
    case 'user_message':
      return `${head(speaker(p))}\n${trim(str(p.text), 3000, 600)}`;
    case 'assistant_message':
      return `${head('lane')}\n${trim(str(p.text), 3000, 800)}`;
    case 'command_execution': {
      const exit = p.exitCode === undefined || p.exitCode === null ? '' : ` exit ${p.exitCode}`;
      return `${head(`command${exit}`)}\n${body(trim(str(p.input), 500), trim(str(p.output), 900, 500))}`;
    }
    case 'dynamic_tool':
      return `${head(`tool ${str(p.toolName)}`)}\n${body(trim(str(p.input), 400), trim(str(p.output), 900, 400))}`;
    case 'file_change':
      return `${head('edit')}\n${body(str(p.fileName), trim(str(p.newStr), 300))}`;
    case 'subagent':
      return `${head('subagent')}\n${body(str(p.title), trim(str(p.prompt), 600), trim(str(p.result), 1500, 600))}`;
    case 'notification':
      return `${head('notification')}\n${body(str(p.summary), str(p.outcome))}`;
    case 'compaction':
      return `${head('context compacted')}\n${trim(str(p.summary), 1500)}`;
    case 'file_search':
      return `${head('search')}\n${body(str(p.pattern), trim(str(p.results), 300))}`;
    case 'web_search':
      return `${head('web search')}\n${body(str(p.query), trim(str(p.results), 300), trim(str(p.output), 300))}`;
    case 'error':
      return `${head('error')}\n${body(str(p.message), trim(str(p.text), 600), trim(str(p.detail), 600))}`;
    case 'checkpoint':
      return '';
    default:
      return p.title ? `${head(type)}\n${str(p.title)}` : '';
  }
}

/**
 * Split events into slices of at most `maxChars` rendered characters and
 * `maxEvents` events, in order. A single oversized event gets its own slice.
 */
export function chunk(events, { maxChars = 24_000, maxEvents = 150 } = {}) {
  const slices = [];
  let current = [];
  let size = 0;
  for (const event of events) {
    const length = redact(event.rendered).length + 2;
    if (current.length > 0 && (size + length > maxChars || current.length >= maxEvents)) {
      slices.push(current);
      current = [];
      size = 0;
    }
    current.push(event);
    size += length;
  }
  if (current.length > 0) slices.push(current);
  return slices;
}

/**
 * Slice text sent to the model, events numbered e1..eN in order. Returns the
 * text and `ordinals`, where ordinals[n - 1] is the real event behind eN.
 * Checkpoints and other empty events drop out.
 */
export function sliceText(events) {
  const ordinals = [];
  const parts = [];
  for (const event of events) {
    const text = redact(event.rendered);
    if (text.length === 0) continue;
    ordinals.push(event.event);
    parts.push(`[e${ordinals.length}] ${text}`);
  }
  return { text: parts.join('\n\n'), ordinals };
}

/**
 * Real event for a number the model wrote: a slice-local eN, or a full ordinal
 * that is in the slice. Anything else is null.
 */
export function resolveEvent(value, ordinals) {
  const n = typeof value === 'string' ? Number(value.replace(/^e/i, '')) : Number(value);
  if (!Number.isInteger(n)) return null;
  if (n >= 1 && n <= ordinals.length) return ordinals[n - 1];
  return ordinals.includes(n) ? n : null;
}
