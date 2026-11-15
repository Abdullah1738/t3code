import { afterAll, expect, mock, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { spawn as nativeSpawn } from 'node:child_process';
if (process.env.HEALTH_DELIVERY_TEST_CHILD !== '1') {
  test('health delivery fixtures run in their own process before importing watcher state', async () => {
    // Reproduce a sibling test caching the stateful module before the fixture starts.
    await import('../src/lib.ts');
    const child = Bun.spawn([process.execPath, 'test', '--timeout', '10000', import.meta.path], {
      env: {...process.env, ROBOB_TEST:'1', HEALTH_DELIVERY_TEST_CHILD:'1'}, stdout:'pipe', stderr:'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code, stdout + stderr).toBe(0);
    expect(stdout + stderr).toContain('3 pass');
  });
} else {
  const { recordHealthDelivery } = await import('../src/healthDelivery.ts');
  // Production uses macOS zsh; the check fixture itself is portable shell.
  const fixtureSpawn = nativeSpawn;
  if (process.platform !== 'darwin') mock.module('node:child_process', () => ({spawn: (file: string, args: string[], options: Parameters<typeof nativeSpawn>[2]) => fixtureSpawn(file === '/bin/zsh' ? '/bin/bash' : file, args, options)}));
  const root = mkdtempSync(join(tmpdir(), 'health-delivery-'));
  const envKeys = ['HEALTH_TOOLLOG_DIR', 'ROBOB_WATCH_ROOT', 'ROBOB_WATCH_BRIDGE_DB', 'ROBOB_WATCH_TELEGRAM_CLI'];
  const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  process.env.ROBOB_WATCH_BRIDGE_DB = join(root, 'bridge.sqlite');
  const bridge = new Database(process.env.ROBOB_WATCH_BRIDGE_DB);
  bridge.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)');
  bridge.close();
  const telegram = join(root, 'telegram.ts');
  const failSend = join(root, 'fail-send');
  writeFileSync(telegram, `import { existsSync } from 'node:fs'; process.exit(existsSync(${JSON.stringify(failSend)}) ? 1 : 0);`);
  process.env.ROBOB_WATCH_TELEGRAM_CLI = telegram;
  process.env.HEALTH_TOOLLOG_DIR = join(root, 'logs');
  process.env.ROBOB_WATCH_ROOT = join(root, 'watch');
  const { runCheck, loadState, saveState } = await import('../src/lib.ts');
  const run = 'a'.repeat(32);
  const rows = () => readdirSync(process.env.HEALTH_TOOLLOG_DIR!).filter(p => p.endsWith('.ndjson')).flatMap(p => readFileSync(join(process.env.HEALTH_TOOLLOG_DIR!, p), 'utf8').trim().split('\n').map(l => JSON.parse(l)));
  afterAll(() => {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    mock.restore();
    rmSync(root, {recursive:true, force:true});
  });

  test('notify results link to check run, survive persistence/retry, and exclude message text', async () => {
    const dir = join(root, 'check'); mkdirSync(dir, {recursive:true});
    const logger = join(import.meta.dir, '../toollog.py');
    writeFileSync(join(dir, 'check.py'), `import sys\nsys.path.insert(0, ${JSON.stringify(join(logger, '..'))})\nimport toollog\nwith toollog.run('meds-nag', name='watcher.run') as span:\n toollog.emit('meds-nag','nag.sent',props={'count':1},run_id=span.run_id)\nprint('PRIVATE MEDICAL MESSAGE')\n`);
    const result = await runCheck({id:'meds-nag',check:'/usr/bin/python3 check.py',serial:false} as Parameters<typeof runCheck>[0], dir, {HEALTH_TOOLLOG_RUN:run}, 5000);
    expect(result.code).toBe(0);
    expect(rows().find(r=>r.name==='nag.sent').ids.run).toBe(run);
    mkdirSync(join(root, 'watch/watchers/meds-nag'), {recursive:true});
    saveState('meds-nag', {status:'active', fires:0, consecutive_failures:0, failure_alerted:false, pending:{key:'fixture',event:'PRIVATE',at:new Date().toISOString(),healthRun:run}});
    expect(loadState('meds-nag').pending?.healthRun).toBe(run);
    await recordHealthDelivery('meds-nag', run, {ok:false,via:'none'});
    await recordHealthDelivery('meds-nag', loadState('meds-nag').pending?.healthRun, {ok:true,via:'imessage-send'});
    const events = rows().filter(r=>r.name==='delivery.result');
    expect(events.map(r=>r.props.ok)).toEqual([false,true]);
    expect(events.every(r=>r.props.runIdRef===run)).toBe(true);
    expect(JSON.stringify(rows())).not.toContain('PRIVATE');
  });

  test('agent wakes remain unmarked; direct Telegram send counts; sink failure cannot fail delivery', async () => {
    const before=rows().filter(r=>r.name==='delivery.result').length;
    await recordHealthDelivery('nutrition-nudge', run, {ok:true,via:'wake'});
    await recordHealthDelivery('nutrition-nudge', run, {ok:false,accepted:true,via:'thread:abcd1234'});
    await recordHealthDelivery('other', run, {ok:true,via:'telegram'});
    expect(rows().filter(r=>r.name==='delivery.result')).toHaveLength(before);
    await recordHealthDelivery('gym-nudge', 'b'.repeat(32), {ok:true,via:'telegram'});
    expect(rows().filter(r=>r.name==='delivery.result')).toHaveLength(before+1);
    const saved=process.env.HEALTH_TOOLLOG_DIR;process.env.HEALTH_TOOLLOG_DIR='/dev/null/no';
    await expect(recordHealthDelivery('gym-nudge',run,{ok:false,via:'none'})).resolves.toBeUndefined();
    process.env.HEALTH_TOOLLOG_DIR=saved;
  });


  test('real runner retains one origin across quiet hold, failed notify and successful retry', async () => {
    const { tickOne } = await import('../src/runner.ts');
    const dir = join(root, 'watch/watchers/meds-nag');
    const loggerDir = join(import.meta.dir, '..');
    writeFileSync(join(dir, 'check.py'), `import sys\nsys.path.insert(0, ${JSON.stringify(loggerDir)})\nimport toollog\nwith toollog.run('meds-nag', name='watcher.run') as span:\n toollog.emit('meds-nag','nag.sent',props={'count':1},run_id=span.run_id)\nprint('PRIVATE')\n`);
    const hour = new Date().getUTCHours();
    const watcher = {id:'meds-nag', title:'Fixture', check:'/usr/bin/python3 check.py', mode:'notify',
      interval_s:300, max_fires:0, serial:false, paused:false,
      created_at:new Date().toISOString(), created_by_session:null,
      quiet:{start:hour, end:(hour+1)%24, time_zone:'UTC'}};
    writeFileSync(join(dir, 'watcher.json'), JSON.stringify(watcher));
    saveState('meds-nag', {status:'active', fires:0, consecutive_failures:0, failure_alerted:false});
    const before = rows().filter(r => r.name === 'nag.sent').length;
    await tickOne('meds-nag');
    const pending = loadState('meds-nag').pending!;
    expect(pending.healthRun).toMatch(/^[a-f0-9]{32}$/);
    expect(rows().filter(r => r.name === 'delivery.result' && r.props.runIdRef === pending.healthRun)).toHaveLength(0);
    const { quiet, ...awake } = watcher;
    writeFileSync(join(dir, 'watcher.json'), JSON.stringify(awake));
    writeFileSync(failSend, 'fixture');
    saveState('meds-nag', {...loadState('meds-nag'), next_at:0});
    await tickOne('meds-nag');
    expect(loadState('meds-nag').pending).toEqual(pending);
    rmSync(failSend);
    saveState('meds-nag', {...loadState('meds-nag'), next_at:0});
    await tickOne('meds-nag');
    expect(loadState('meds-nag').pending).toBeUndefined();
    expect(loadState('meds-nag').fires).toBe(1);
    expect(rows().filter(r => r.name === 'nag.sent')).toHaveLength(before + 1);
    const results = rows().filter(r => r.name === 'delivery.result' && r.props.runIdRef === pending.healthRun);
    expect(results.map(r => r.props.ok)).toEqual([false,true]);
    expect(JSON.stringify(rows())).not.toContain('PRIVATE');
  });
}
