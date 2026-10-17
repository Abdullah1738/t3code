import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EDITOR_SYSTEM_PROMPT, editorUserPrompt, runEditor } from '../lib/editor.mjs';

const input = { missionId: 'm1', since: '2026-10-17T11:00:00.000Z', notes: [{ id: 'note-a' }], candidates: [] };

test('editor pass posts the parsed reply with the input window', async () => {
  const asked = [];
  const posted = [];
  const result = await runEditor({
    input,
    model: 'cc/claude-opus-5-5',
    ask: async (request) => {
      asked.push(request);
      return { content: '```json\n{"bottomLine":"All quiet.","fyiOrder":["note-a"]}\n```', usage: { input: 10, output: 5 } };
    },
    post: async (output) => {
      posted.push(output);
      return { opened: [] };
    },
  });
  assert.equal(asked[0].system, EDITOR_SYSTEM_PROMPT);
  assert.equal(asked[0].user, editorUserPrompt(input));
  assert.deepEqual(posted, [
    {
      missionId: 'm1',
      since: input.since,
      reply: { bottomLine: 'All quiet.', fyiOrder: ['note-a'] },
      model: 'cc/claude-opus-5-5',
      usage: { input: 10, output: 5 },
    },
  ]);
  assert.deepEqual(result.summary.result, { opened: [] });
});

test('a dry pass stores nothing and an unparseable reply posts an empty one', async () => {
  const dry = await runEditor({ input, ask: async () => ({ content: 'no json here' }), post: null });
  assert.equal(dry.summary.parsed, false);
  assert.deepEqual(dry.output.reply, {});
  assert.equal(dry.summary.result, undefined);
});
