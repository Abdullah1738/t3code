import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { controlConfig } from '../lib/control.mjs';

const KEYS = ['HOME', 'T3_CONTROL_URL', 'T3_CONTROL_TOKEN', 'T3_CONTROL_TOKEN_FILE', 'COORD_CONTROL_TOKEN_FILE'];
let saved;
let home;

const write = (path, token, mode = 0o600) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ url: 'http://127.0.0.1:3773/', token }), { mode });
};
const shared = () => join(home, '.robob', 'ardud-control.json');
const own = () => join(home, '.robob', 'components', 'coord.json');

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  home = mkdtempSync(join(tmpdir(), 'coord-control-'));
  process.env.HOME = home;
});
afterEach(() => {
  for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  rmSync(home, { recursive: true, force: true });
});

test('coord reads its own component credential before the shared control token', () => {
  write(shared(), 'shared');
  write(own(), 'coord');
  assert.deepEqual(controlConfig(), { url: 'http://127.0.0.1:3773', token: 'coord' });
});

test('the shared control token still works while the coord credential is missing', () => {
  write(shared(), 'shared');
  assert.equal(controlConfig().token, 'shared');
});

test('COORD_CONTROL_TOKEN_FILE picks the file, and T3_CONTROL_TOKEN_FILE (crw\'s setting) is ignored', () => {
  write(own(), 'coord');
  const crw = join(home, 'crw.json');
  write(crw, 'crw');
  process.env.T3_CONTROL_TOKEN_FILE = crw;
  assert.equal(controlConfig().token, 'coord');
  const elsewhere = join(home, 'elsewhere.json');
  write(elsewhere, 'elsewhere');
  process.env.COORD_CONTROL_TOKEN_FILE = elsewhere;
  assert.equal(controlConfig().token, 'elsewhere');
  // A named file that doesn't exist doesn't fall back to the shared token.
  write(shared(), 'shared');
  process.env.COORD_CONTROL_TOKEN_FILE = join(home, 'missing.json');
  assert.throws(() => controlConfig(), /no control API url\/token/);
});

test('env url and token win, and a credential readable by others is refused', () => {
  process.env.T3_CONTROL_URL = 'http://robob';
  process.env.T3_CONTROL_TOKEN = 'env';
  write(own(), 'coord', 0o644);
  assert.deepEqual(controlConfig(), { url: 'http://robob', token: 'env' });
  delete process.env.T3_CONTROL_TOKEN;
  assert.throws(() => controlConfig(), /coord\.json must be chmod 600/);
});
