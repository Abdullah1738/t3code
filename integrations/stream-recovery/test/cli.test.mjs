import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));

for (const unavailable of ['missing', 'not-ready', 'stale', 'live-override']) {
  test(`API-only stall scan still runs with ${unavailable} recovery replica`, async (t) => {
    const home = mkdtempSync(join(tmpdir(), 'recovery-cli-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    mkdirSync(join(home, '.config/opencode-service'), { recursive: true });
    writeFileSync(join(home, '.config/opencode-service/password'), 'fixture-password');
    const data = join(home, 'data');
    mkdirSync(data);
    const lastScan = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(join(data, 'state.json'), JSON.stringify({ handled: {}, lastScan }));
    let path = join(home, 'replica.sqlite');
    if (unavailable === 'not-ready' || unavailable === 'stale') {
      const db = new DatabaseSync(path);
      db.exec("create table ardud_readonly_meta(key text primary key,value text not null); insert into ardud_readonly_meta values ('ready','0'),('schema_version','1')");
      if (unavailable === 'stale') {
        db.exec("update ardud_readonly_meta set value='1' where key='ready'");
        db.prepare('insert into ardud_readonly_meta values (?,?)').run('updated_at', new Date(Date.now() - 60_000).toISOString());
      }
      db.close();
    } else if (unavailable === 'live-override') {
      path = join(home, '.t3/userdata/state.sqlite');
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, 'must not SQLite-open');
    }
    const requests = [];
    const server = createServer((req, res) => {
      requests.push(req.url);
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/session/active') res.end(JSON.stringify({ data: {} }));
      else if (req.url.startsWith('/api/ardud/control/threads?')) res.end(JSON.stringify({ threads: [] }));
      else { res.statusCode = 500; res.end(JSON.stringify({ error: 'unexpected fixture request' })); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}`;
    const child = spawn(process.execPath, [cli, 'scan', '--json'], {
      env: { ...process.env, HOME: home, STREAM_RECOVERY_DATA: data, STREAM_RECOVERY_DB: path,
        ROBOB_HOME: join(home, '.robob'), T3CODE_HOME: join(home, '.t3'),
        XDG_DATA_HOME: join(home, '.local/share'), OPENCODE_SERVICE_URL: url,
        T3_CONTROL_URL: url, T3_CONTROL_TOKEN: 'fixture-token' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 1, stderr);
    const report = JSON.parse(stdout);
    assert.match(report.recoveryError, /ENOENT|not ready|stale|refusing live/);
    assert.deepEqual(report.stalls, []);
    assert.ok(requests.includes('/api/session/active'));
    assert.ok(requests.some((path) => path.startsWith('/api/ardud/control/threads?')));
    const state = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'));
    assert.equal(state.lastScan, lastScan);
    assert.ok(Date.parse(state.lastStallScan) > Date.parse(lastScan));
    assert.deepEqual(state.handled, {});
  });
}
