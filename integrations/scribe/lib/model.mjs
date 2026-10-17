// Model calls through 9router, the same local route Robob agents use.
// 9router speaks the OpenAI chat API on 127.0.0.1:20128 and spreads requests
// over the Claude accounts; no API key is needed locally.
import { CANDIDATE_TARGETS, NOTE_TYPES, SEVERITIES } from './prompt.mjs';
import { resolveEvent } from './transcript.mjs';

export const ROUTER_URL = (process.env.SCRIBE_ROUTER_URL || 'http://127.0.0.1:20128').replace(/\/$/, '');
export const SCRIBE_MODEL = process.env.SCRIBE_MODEL || 'cc/claude-haiku-5-5';
export const EDITOR_MODEL = process.env.SCRIBE_EDITOR_MODEL || 'cc/claude-opus-5-5';

export async function chat({ model, system, user, maxTokens = 8000, timeoutMs = 240_000, fetchImpl = fetch }) {
  const res = await fetchImpl(`${ROUTER_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`9router ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  const content = String(data.choices?.[0]?.message?.content ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim();
  const usage = data.usage ?? {};
  return {
    content,
    usage: { input: Number(usage.prompt_tokens ?? 0), output: Number(usage.completion_tokens ?? 0) },
  };
}

/**
 * First JSON object in a model reply (tolerates a code fence or stray prose).
 * A reply cut off by the token limit keeps its complete notes and candidates.
 */
export function parseJson(content) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/);
  const text = fenced ? fenced[1] : content;
  const start = text.indexOf('{');
  if (start < 0) throw new Error('no JSON object in reply');
  const end = text.lastIndexOf('}');
  try {
    if (end > start) return JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    const salvaged = salvage(text.slice(start));
    if (salvaged) return salvaged;
    throw error;
  }
  const salvaged = salvage(text.slice(start));
  if (salvaged) return salvaged;
  throw new Error('no complete JSON object in reply');
}

// Complete objects of the "notes" and "candidates" arrays of a truncated reply.
function salvage(text) {
  const out = { notes: [], candidates: [], truncated: true };
  let found = false;
  for (const key of ['notes', 'candidates']) {
    const at = text.search(new RegExp(`"${key}"\\s*:\\s*\\[`));
    if (at < 0) continue;
    found = true;
    out[key] = completeObjects(text.slice(text.indexOf('[', at) + 1));
  }
  return found ? out : null;
}

function completeObjects(text) {
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          objects.push(JSON.parse(text.slice(start, i + 1)));
        } catch {}
        start = -1;
      }
    } else if (ch === ']' && depth === 0) break;
  }
  return objects;
}

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5);
const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/**
 * Shape-check the model's notes and map its slice-local event numbers (e1..eN)
 * back to real events. Drops notes that can't be stored (unknown type, no
 * quote, an event outside the slice). Citation truth is the server's job.
 */
export function normalizeReply(reply, { ordinals }) {
  const dropped = [];
  const notes = [];
  for (const raw of Array.isArray(reply?.notes) ? reply.notes : []) {
    const quote = typeof raw?.quote === 'string' ? raw.quote.trim() : '';
    const summary = typeof raw?.summary === 'string' ? raw.summary.trim() : '';
    const event = resolveEvent(raw?.event, ordinals);
    if (!NOTE_TYPES.includes(raw?.type) || !quote || !summary || event === null) {
      dropped.push({ reason: 'shape', note: raw });
      continue;
    }
    const from = resolveEvent(raw.fromEvent, ordinals) ?? event;
    const to = resolveEvent(raw.toEvent, ordinals) ?? event;
    notes.push({
      type: raw.type,
      summary: clip(summary, 400),
      quote,
      event,
      fromEvent: Math.min(from, event),
      toEvent: Math.max(to, event),
      basis: raw.basis === 'observed' ? 'observed' : 'claimed',
      severity: SEVERITIES.includes(raw.severity) ? raw.severity : 'medium',
      confidence: clamp01(Number(raw.confidence)),
      replaces: typeof raw.replaces === 'string' && raw.replaces.startsWith('note-') ? raw.replaces : null,
    });
  }
  const candidates = [];
  for (const raw of Array.isArray(reply?.candidates) ? reply.candidates : []) {
    const event = resolveEvent(raw?.event, ordinals);
    if (!CANDIDATE_TARGETS.includes(raw?.targetKind) || !raw?.title || !raw?.proposal || !raw?.quote || event === null) {
      dropped.push({ reason: 'shape', candidate: raw });
      continue;
    }
    candidates.push({
      targetKind: raw.targetKind,
      title: clip(String(raw.title).trim(), 200),
      proposal: String(raw.proposal).trim(),
      why: String(raw.why ?? '').trim(),
      quote: String(raw.quote).trim(),
      event,
    });
  }
  return { notes, candidates, dropped };
}
