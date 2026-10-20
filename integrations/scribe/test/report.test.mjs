import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');

// A control API that builds every report it is asked for and counts the asks.
const fakeServer = async () => {
  const asked = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      asked.push(JSON.parse(body || '{}'));
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          report: {
            text: '### 2026-10-20 08:00 UTC\n\n- built\n',
            coversFrom: '2026-10-20T04:00:00.000Z',
            coversTo: '2026-10-20T08:00:00.000Z',
            open: [],
          },
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { asked, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
};

const cli = (url, args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, T3_CONTROL_URL: url, T3_CONTROL_TOKEN: 'test' },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stderr }));
  });

test('a report job never saves a report its target file would refuse', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scribe-report-'));
  const server = await fakeServer();
  try {
    const status = join(root, 'crpko-devops', 'tmp', 'coordinator-study-20261002', 'status');
    mkdirSync(status, { recursive: true });
    const daily = join(status, 'DAILY.md');
    writeFileSync(daily, 'kept by hand\n');
    const updates = join(status, 'OWNER-UPDATES.md');
    const base = ['report', '--mission', 'crpko', '--save'];

    const foreign = await cli(server.url, [...base, '--kind', 'daily', '--live', '--out', daily]);
    assert.equal(foreign.code, 1);
    assert.match(foreign.stderr, /not written by scribe/);
    const notLive = await cli(server.url, [...base, '--kind', 'update', '--out', updates]);
    assert.equal(notLive.code, 1);
    assert.match(notLive.stderr, /it takes --live/);
    assert.equal(server.asked.length, 0);
    assert.equal(readFileSync(daily, 'utf8'), 'kept by hand\n');

    const written = await cli(server.url, [...base, '--kind', 'update', '--live', '--out', updates]);
    assert.equal(written.code, 0, written.stderr);
    assert.deepEqual(server.asked, [{ missionId: 'crpko', kind: 'update', save: true }]);
    assert.ok(readFileSync(updates, 'utf8').includes('### 2026-10-20 08:00 UTC'));
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
