// One scribe pass over one lane: read settled events after the cursor, cut
// them into slices, ask the model for notes per slice, post each slice as a
// batch. The sink owns the cursor, so a retry after a crash re-reads the same
// slice and the server drops what it already has.
import { chunk, sliceText } from './transcript.mjs';
import { SYSTEM_PROMPT, userPrompt } from './prompt.mjs';
import { normalizeReply, parseJson } from './model.mjs';

const OPEN_NOTES_IN_PROMPT = 30;

/**
 * deps:
 *   readEvents(afterEvent, limit) -> { events, complete, lastSeen }
 *   ask({ system, user }) -> { content, usage }
 *   sink.cursor() -> number           last event already processed
 *   sink.openNotes() -> notes         current notes for this lane, newest first
 *   sink.postBatch(batch) -> { duplicate, accepted, failed }
 */
export async function runLane({ lane, readEvents, ask, sink, maxSlices = 20, chunkOptions, log = () => {} }) {
  const summary = { lane: lane.name, threadId: lane.threadId, slices: 0, notes: 0, failed: 0, duplicates: 0, input: 0, output: 0 };
  let cursor = await sink.cursor();
  while (summary.slices < maxSlices) {
    const { events, complete, lastSeen } = await readEvents(cursor, 400);
    const quotable = events.filter((event) => event.rendered.length > 0);
    if (quotable.length === 0) {
      // Only checkpoints or reasoning since the cursor: move past them without a model call.
      if (lastSeen > cursor) {
        await sink.postBatch(emptyBatch(lane, cursor, lastSeen));
        cursor = lastSeen;
        if (!complete) continue;
      }
      break;
    }
    const [slice] = chunk(quotable, chunkOptions);
    const fromEvent = cursor + 1;
    // Fold trailing checkpoints into the batch when this is the last slice.
    const toEvent = slice.length === quotable.length ? lastSeen : slice[slice.length - 1].event;
    const openNotes = (await sink.openNotes()).slice(0, OPEN_NOTES_IN_PROMPT);
    const { text, ordinals } = sliceText(slice);
    const user = userPrompt({ lane, openNotes, slice: text, count: ordinals.length });
    const reply = await ask({ system: SYSTEM_PROMPT, user });
    let parsed;
    try {
      parsed = parseJson(reply.content);
    } catch (error) {
      // An unreadable reply is retried once; a second failure records an empty
      // batch so one bad slice can't wedge the lane.
      log(`${lane.name} ${fromEvent}-${toEvent}: unreadable reply, retrying (${error.message})`);
      const retry = await ask({ system: SYSTEM_PROMPT, user });
      reply.usage.input += retry.usage.input;
      reply.usage.output += retry.usage.output;
      try {
        parsed = parseJson(retry.content);
      } catch {
        parsed = { notes: [], candidates: [], unreadable: true };
      }
    }
    const { notes, candidates, dropped } = normalizeReply(parsed, { ordinals });
    const result = await sink.postBatch({
      missionId: lane.missionId,
      laneId: lane.laneId ?? null,
      subMissionId: lane.subMissionId ?? null,
      threadId: lane.threadId,
      fromEvent,
      toEvent,
      notes,
      candidates,
      droppedCount: dropped.length + (parsed.unreadable ? 1 : 0),
      usage: reply.usage,
      model: lane.model ?? null,
    });
    summary.slices += 1;
    summary.input += reply.usage.input;
    summary.output += reply.usage.output;
    if (result.duplicate) summary.duplicates += 1;
    summary.notes += result.accepted ?? 0;
    summary.failed += result.failed ?? 0;
    log(`${lane.name} ${fromEvent}-${toEvent}: ${notes.length} notes (${result.failed ?? 0} failed citation)${result.duplicate ? ' duplicate' : ''}`);
    cursor = Math.max(cursor, toEvent, result.cursor ?? 0);
  }
  summary.cursor = cursor;
  return summary;
}

const emptyBatch = (lane, cursor, toEvent) => ({
  missionId: lane.missionId,
  laneId: lane.laneId ?? null,
  subMissionId: lane.subMissionId ?? null,
  threadId: lane.threadId,
  fromEvent: cursor + 1,
  toEvent,
  notes: [],
  candidates: [],
  droppedCount: 0,
  usage: { input: 0, output: 0 },
  model: null,
});
