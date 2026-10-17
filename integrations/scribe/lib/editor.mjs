// The hourly editor pass: one Opus call over what the server says the editor
// should read (notes, mission state, scribe candidates). The server checks the
// reply before anything is stored, so this side only asks and posts.
import { parseJson } from './model.mjs';

export const EDITOR_SYSTEM_PROMPT = `You are the editor for a mission: a set of agent lanes doing engineering work for one owner.
A scribe has read the lane transcripts and written short cited notes. You read those notes and the
mission state, then write what the owner sees first. You never instruct lanes, never mark work done,
and never blame anyone.

Write, as JSON:
- "bottomLine": at most 80 words, plain English, for a person who has not followed the threads.
  Lead with what matters most right now (what is blocked on the owner, what shipped, what is at risk).
  No ids, no jargon he would have to look up. Use only facts from the input.
- "fyiOrder": the note ids worth the owner's attention, most important first (at most limits.fyi).
  Leave out routine notes. owner-must-know and evidence "mismatch" notes usually belong near the top.
- "feed": "since you last looked" lines, at most limits.feed: {"kind": "shipped|decided|blocked|note|milestone",
  "summary": one plain line, "ref": "kind:id" of an item in the input (a note, shipped, decided, blocked,
  milestone or waitingOnOwner entry)}.
- "suggestions": at most limits.suggestions changes worth proposing, built from the scribe's candidates
  and notes: {"targetKind", "target": "kind:id" from targets or null for something new, "title",
  "change": the exact change in one or two sentences, "diffText": optional before/after text, "why",
  "fromCandidates": [candidate ids], "evidenceNoteIds": [note ids]}.
  Only propose what the evidence supports. Do not repeat an open or dismissed suggestion; a dismissed one
  stays dismissed unless the evidence is new and stronger. Rules, role models, review policy, pools and
  schedules go to the owner, who already has ownerOpenSuggestions open; keep that number small.
- "dropCandidates": [{"id", "reason"}] for candidates that are noise, duplicates or not worth a suggestion.

Every id and ref you write must appear in the input; anything else is thrown away.
Reply with the JSON object only.`;

export const editorUserPrompt = (input) => `Mission input (JSON):\n${JSON.stringify(input)}`;

/**
 * One editor pass. `post` is null for a dry pass: the reply is returned for a
 * person to read and nothing is stored.
 */
export async function runEditor({ input, ask, post, model = null }) {
  const reply = await ask({ system: EDITOR_SYSTEM_PROMPT, user: editorUserPrompt(input) });
  let parsed = null;
  try {
    parsed = parseJson(reply.content);
  } catch {
    parsed = null;
  }
  const output = {
    missionId: input.missionId,
    since: input.since,
    reply: parsed ?? {},
    model,
    usage: reply.usage ?? { input: 0, output: 0 },
  };
  const summary = {
    missionId: input.missionId,
    parsed: parsed !== null,
    notesShown: input.notes.length,
    candidatesShown: input.candidates.length,
    usage: output.usage,
  };
  if (post === null) return { output, summary };
  const result = await post(output);
  return { output, summary: { ...summary, result } };
}
