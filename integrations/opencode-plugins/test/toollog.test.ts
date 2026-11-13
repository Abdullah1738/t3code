import { test, expect } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAP_BYTES, emit, hook } from '../lib/toollog';
import rootGuard, {createGuardHook} from '../plugin/rootwide-search-guard';
import scope from '../plugin/betterstack-scope';
import statev2 from '../plugin/statev2-guard';
import codemode from '../plugin/codemode-guard';
const temp = mkdtempSync(join(tmpdir(), 'toollog-tests-'));
process.env.TOOLLOG_ROOT = join(temp, 'logs');
const directory = join(process.env.TOOLLOG_ROOT, 'agent-tools');
const file = () => join(directory, new Date().toISOString().slice(0,10) + '.ndjson');
const rows = () => readFileSync(file(),'utf8').trim().split('\n').map(line => JSON.parse(line));

test('format, privacy, retention, cap, and silent write failure', () => {
  const command = 'curl --password fixture-secret --header token-secret';
  hook('shell','denied','fixture.deny',performance.now(),command,undefined,{sessionId:'fixture-session'});
  emit('fixture','event','fixture.input',{props:{count:2, command, password:'secret'},errorTag:'secret text'});
  expect(rows()[0].ids).toEqual({sessionId:'fixture-session'});
  expect(rows()[0].props).toMatchObject({harness:'opencode',firstWord:'curl',commandLength:command.length});
  expect(readFileSync(file(),'utf8')).not.toContain('fixture-secret');
  expect(readFileSync(file(),'utf8')).not.toContain('token-secret');
  expect(statSync(file()).mode & 0o777).toBe(0o600);
  expect(statSync(directory).mode & 0o777).toBe(0o700);
  // Simulate a prior process and trigger first-write cleanup for another board.
  const board = join(temp,'logs/retention');
  emit('fixture','event','fixture.start',{board:'retention'});
  const marker = join(board,'.retained-'+new Date().toISOString().slice(0,10));
  const {unlinkSync} = require('node:fs');
  unlinkSync(marker);
  writeFileSync(join(board,'2000-01-01.ndjson'),'old');
  emit('fixture','event','fixture.start',{board:'retention'});
  expect(readdirSync(board)).not.toContain('2000-01-01.ndjson');
  truncateSync(file(),CAP_BYTES);
  emit('fixture','event','fixture.dropped');
  emit('fixture','perf','fixture.dropped');
  emit('fixture','error','fixture.kept',{errorTag:'fixture.error'});
  const tail=readFileSync(file(),'utf8').slice(CAP_BYTES);
  expect(tail.match(/"name":"log.cap"/g)?.length).toBe(1);
  expect(tail).not.toContain('fixture.dropped');
  expect(tail).toContain('fixture.kept');
  const old=process.env.TOOLLOG_ROOT;
  process.env.TOOLLOG_ROOT = file();
  expect(() => emit('fixture','error','fixture.noop')).not.toThrow();
  process.env.TOOLLOG_ROOT=old;
});

test('hook added write cost stays under two ms', () => {
  process.env.TOOLLOG_ROOT=join(temp,'benchmark');
  hook('shell','allowed','no-policy',performance.now(),'git status');
  const started=performance.now();
  for(let i=0;i<500;i++) hook('shell','allowed','no-policy',performance.now(),'git status');
  const ms=(performance.now()-started)/500;
  console.log(`toollog TS added hook cost: ${ms.toFixed(3)} ms/call`);
  expect(ms).toBeLessThan(2);
});

test('OpenCode guard success and denial events share native shape', async () => {
  process.env.TOOLLOG_ROOT=join(temp,'events');
  for (const blocked of [false,true]) {
    const fn=createGuardHook('/fixture',async()=>({root:blocked?'/':null,reason:blocked?'fixture deny':null}));
    await fn({tool:'shell',input:{command:'rg fixture-secret .'}});
    let evaluate: Function=()=>{};
    await scope.setup({location:{directory:blocked?'/fixture':'/Users/ardud/crpko-devops'},permission:{hook:async (_:string,fn:Function)=>{evaluate=fn;}}});
    evaluate({action:'betterstack_query',effect:'allow'});
    let before: Function=()=>{};
    await statev2.setup({location:{directory:'/fixture'},tool:{hook:async (_:string,fn:Function)=>{before=fn;}}});
    await before({tool:'shell',input:{command:blocked?'sqlite3 ~/.robob/userdata/statev2.sqlite fixture-secret':'git status'}});
    await codemode.setup({tool:{hook:async (_:string,fn:Function)=>{before=fn;}}});
    await before({tool:'execute',input:{code:blocked?'await new Promise(r=>r)':'return 1'}});
  }
  const events=readFileSync(join(process.env.TOOLLOG_ROOT,'agent-tools',new Date().toISOString().slice(0,10)+'.ndjson'),'utf8').trim().split('\n').map(line => JSON.parse(line));
  for(const guard of ['rootwide-search','betterstack-scope','statev2','codemode']) {
    expect(events.filter(r=>r.props.guard===guard).map(r=>r.props.decision)).toEqual(['allowed','denied']);
  }
  expect(JSON.stringify(events)).not.toContain('fixture-secret');
});
