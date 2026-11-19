import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const logger = new URL('../toollog.mjs', import.meta.url).href;
const source = `
  import assert from 'node:assert/strict';
  import { emit, reportVolume } from ${JSON.stringify(logger)};
  assert.doesNotThrow(() => emit('test', 'fixture.context'));
  const hostile = new Proxy({}, { ownKeys() { throw new Error('private'); } });
  assert.doesNotThrow(() => emit('test', 'fixture.invalid', hostile));
  reportVolume();
`;

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'router-test-context-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home };
  delete env.ROUTER_LOG_DIR;
  delete env.NODE_TEST_CONTEXT;
  return { home, env, root: join(home, '.robob/logs/tools/9router') };
}

function run(args, env, cwd) {
  const child = spawnSync(process.execPath, args, { env, cwd, encoding: 'utf8', timeout: 15_000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr + child.stdout);
}

function rows(root) {
  return readdirSync(root).filter(file => file.endsWith('.ndjson'))
    .flatMap(file => readFileSync(join(root, file), 'utf8').trim().split('\n').map(JSON.parse));
}

for (const context of ['child-v8', '']) {
  test(`test context ${JSON.stringify(context)} without a destination leaves the home log directory absent`, t => {
    const { env, root } = fixture(t);
    env.NODE_TEST_CONTEXT = context;
    run(['--input-type=module', '-e', source], env);
    assert.equal(existsSync(root), false);
  });
}

test('production without a destination still writes to the home log directory', t => {
  const { env, root } = fixture(t);
  run(['--input-type=module', '-e', source], env);
  assert.equal(rows(root).filter(row => row.name === 'fixture.context').length, 1);
});

test('test context with an explicit destination still captures fixture rows', t => {
  const { home, env, root } = fixture(t);
  const logs = join(home, 'capture');
  env.NODE_TEST_CONTEXT = 'child-v8';
  env.ROUTER_LOG_DIR = logs;
  run(['--input-type=module', '-e', source], env);
  assert.equal(rows(logs).filter(row => row.name === 'fixture.context').length, 1);
  assert.equal(existsSync(root), false);
});

test('Node sets the test context for single-file and multi-file test runs', t => {
  const { home, env, root } = fixture(t);
  const probe = `
    ${source}
    assert.notEqual(process.env.NODE_TEST_CONTEXT, undefined);
  `;
  const files = ['one.test.mjs', 'two.test.mjs'].map(file => join(home, file));
  for (const file of files) writeFileSync(file, probe);
  run(['--test', files[0]], env, home);
  run(['--test', ...files], env, home);
  assert.equal(existsSync(root), false);
});
