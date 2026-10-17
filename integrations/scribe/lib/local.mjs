// A file-backed sink for dry runs: cursors and notes live in <dir>/state.json,
// every posted batch is appended to <dir>/batches.jsonl. Nothing reaches the
// server. The same batch posted twice is reported as a duplicate, like the
// server does, so dry runs show the idempotency behaviour too.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function localSink(dir, { threadId, missionId }) {
  mkdirSync(dir, { recursive: true });
  const statePath = join(dir, 'state.json');
  const load = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { cursors: {}, notes: [] });
  const save = (state) => {
    writeFileSync(`${statePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(`${statePath}.tmp`, statePath);
  };
  const key = `${missionId}|${threadId}`;
  return {
    cursor: async () => load().cursors[key] ?? 0,
    setCursor: (value) => {
      const state = load();
      state.cursors[key] = value;
      save(state);
    },
    openNotes: async () => {
      const notes = load().notes.filter((note) => note.missionId === missionId && note.threadId === threadId);
      const replaced = new Set(notes.map((note) => note.replaces).filter(Boolean));
      return notes.filter((note) => !replaced.has(note.id)).reverse();
    },
    postBatch: async (batch) => {
      const state = load();
      const cursor = state.cursors[key] ?? 0;
      if (batch.toEvent <= cursor) return { duplicate: true, accepted: 0, failed: 0, cursor };
      const notes = batch.notes.map((note, index) => ({
        id: `note-local-${batch.fromEvent}-${index}`,
        missionId,
        threadId,
        ...note,
      }));
      state.notes.push(...notes);
      state.cursors[key] = batch.toEvent;
      appendFileSync(join(dir, 'batches.jsonl'), `${JSON.stringify(batch)}\n`);
      save(state);
      return { duplicate: false, accepted: notes.length, failed: 0, cursor: batch.toEvent };
    },
  };
}
