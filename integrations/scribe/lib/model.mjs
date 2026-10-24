// Model calls through 9router, the same local route Robob agents use.
// 9router speaks the OpenAI chat API on 127.0.0.1:20128 and spreads requests
// over the Claude accounts; no API key is needed locally.
import { CANDIDATE_TARGETS, NOTE_TYPES, SEVERITIES } from './prompt.mjs';
import { resolveEvent } from './transcript.mjs';

export const ROUTER_URL = (process.env.SCRIBE_ROUTER_URL || 'http://127.0.0.1:20128').replace(/\/$/, '');
export const SCRIBE_MODEL = process.env.SCRIBE_MODEL || 'cc/claude-haiku-5-5';
export const EDITOR_MODEL = process.env.SCRIBE_EDITOR_MODEL || 'cc/claude-opus-5-5';

/**
 * One chat completion. `stream` reads the reply as server-sent events: long
 * replies (the report writer's) outlast fetch's five-minute wait for response
 * headers when the router only answers once the whole reply is done.
 */
export async function chat({ model, system, user, maxTokens = 8000, timeoutMs = 240_000, stream = false, fetchImpl = fetch }) {
  const res = await fetchImpl(`${ROUTER_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`9router ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = stream ? await readStream(res) : JSON.parse(await res.text());
  const content = String(data.content ?? data.choices?.[0]?.message?.content ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim();
  const usage = data.usage ?? {};
  const finish = data.finish ?? data.choices?.[0]?.finish_reason ?? null;
  return {
    content,
    usage: { input: Number(usage.prompt_tokens ?? 0), output: Number(usage.completion_tokens ?? 0) },
    finish,
  };
}

// The pieces of a streamed completion, joined; an error event fails the call.
async function readStream(res) {
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage = null;
  let finish = null;
  let done = false;
  const take = (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') done = true;
    if (!payload || payload === '[DONE]') return;
    const event = JSON.parse(payload);
    if (event.error) throw new Error(`9router stream: ${JSON.stringify(event.error).slice(0, 300)}`);
    const choice = event.choices?.[0];
    if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
    if (choice?.finish_reason) finish = choice.finish_reason;
    if (event.usage) usage = event.usage;
  };
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      take(buffer.slice(0, at).trim());
      buffer = buffer.slice(at + 1);
    }
  }
  take((buffer + decoder.decode()).trim());
  // A stream that just stops (a dropped connection) is not a whole reply.
  if (!finish && !done) throw new Error('9router stream: the reply ended without finishing');
  return { content, usage, finish };
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
