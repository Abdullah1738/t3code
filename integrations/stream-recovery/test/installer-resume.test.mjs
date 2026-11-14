import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('installer fetches historical claims and holds a snapshot without its source run', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'installer-claims-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snapshot = join(dir, 'snapshot.json');
  writeFileSync(snapshot, JSON.stringify({ threads: [{ threadId: 'migrated' }, { threadId: 'other' }] }));
  const server = createServer((req, res) => {
    const full = req.url === '/api/ardud/control/harness-cutover/status?claims=1';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, cutover: { active: false, completed: true,
      threadClaimsIncluded: full, claimedThreadIds: full ? ['migrated'] : [], claimedRuns: [] } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const helper = fileURLToPath(new URL('../scripts/installer-resume-plan.mjs', import.meta.url));
  const child = spawn(process.execPath, [helper, snapshot], {
    env: { ...process.env, T3_CONTROL_URL: `http://127.0.0.1:${server.address().port}`, T3_CONTROL_TOKEN: 'fixture-token' },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { resumeThreadIds: ['other'], cutoverPendingThreadIds: [],
    cutoverCompletedThreadIds: [], unresolvedThreadIds: ['migrated'] });
});
