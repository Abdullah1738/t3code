import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controlConfig } from '../lib/io.mjs';

const home = () => {
  const dir = mkdtempSync(join(tmpdir(), 'stream-recovery-control-'));
  mkdirSync(join(dir, '.robob'));
  return dir;
};
const write = (path, body, mode = 0o600) => {
  writeFileSync(path, JSON.stringify(body));
  chmodSync(path, mode);
  return path;
};

test('the stream-recovery credential file wins over the shared control file', () => {
  const dir = home();
  write(join(dir, '.robob/ardud-control.json'), { url: 'http://127.0.0.1:3773', token: 'shared' });
  const own = write(join(dir, 'stream-recovery.json'), { url: 'http://127.0.0.1:4000/', token: 'component' });
  assert.deepEqual(controlConfig({ T3_CONTROL_TOKEN_FILE: own }, dir), { url: 'http://127.0.0.1:4000', token: 'component' });
  // Env still overrides both, as for every other integration.
  assert.deepEqual(
    controlConfig({ T3_CONTROL_TOKEN_FILE: own, T3_CONTROL_URL: 'http://h:1/', T3_CONTROL_TOKEN: 'env' }, dir),
    { url: 'http://h:1', token: 'env' },
  );
});

test('reads its own component credential without any env, before the shared file', () => {
  const dir = home();
  mkdirSync(join(dir, '.robob/components'));
  write(join(dir, '.robob/ardud-control.json'), { url: 'http://127.0.0.1:3773', token: 'shared' });
  write(join(dir, '.robob/components/stream-recovery.json'), { url: 'http://127.0.0.1:3773', token: 'component' });
  assert.deepEqual(controlConfig({}, dir), { url: 'http://127.0.0.1:3773', token: 'component' });
});

test('falls back to the shared control file until a credential is issued', () => {
  const dir = home();
  write(join(dir, '.robob/ardud-control.json'), { url: 'http://127.0.0.1:3773', token: 'shared' });
  assert.deepEqual(controlConfig({}, dir), { url: 'http://127.0.0.1:3773', token: 'shared' });
  assert.deepEqual(
    controlConfig({ T3_CONTROL_TOKEN_FILE: join(dir, 'missing.json') }, dir),
    { url: 'http://127.0.0.1:3773', token: 'shared' },
  );
});

test('refuses token files others can read and fails without any token', () => {
  const dir = home();
  const loose = write(join(dir, 'loose.json'), { token: 'component' }, 0o644);
  assert.throws(() => controlConfig({ T3_CONTROL_TOKEN_FILE: loose }, dir), /chmod 600/);
  assert.throws(() => controlConfig({}, dir), /no control token/);
});

test('a malformed token file fails loudly, and env alone needs no file', () => {
  const dir = home();
  const broken = join(dir, 'broken.json');
  writeFileSync(broken, '{"token": ');
  chmodSync(broken, 0o600);
  assert.throws(() => controlConfig({ T3_CONTROL_TOKEN_FILE: broken }, dir), /not valid JSON/);
  const loose = write(join(dir, '.robob/ardud-control.json'), { token: 'shared' }, 0o644);
  assert.ok(loose);
  assert.deepEqual(controlConfig({ T3_CONTROL_URL: 'http://h:1', T3_CONTROL_TOKEN: 'env' }, dir), { url: 'http://h:1', token: 'env' });
});
