import { spawnSync } from 'node:child_process';
import { beforeEach, afterEach, spyOn, test, expect } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CAP_BYTES, HOOKS_CAP_BYTES, HOOK_SAMPLE_RATE, hookProps, emit, hook } from '../lib/toollog';
import rootGuard, {createGuardHook} from '../plugin/rootwide-search-guard';
import scope from '../plugin/betterstack-scope';
import statev2 from '../plugin/statev2-guard';
import codemode from '../plugin/codemode-guard';
let sampling: ReturnType<typeof spyOn>;
beforeEach(() => { sampling = spyOn(Math, 'random').mockReturnValue(0); });
afterEach(() => { sampling.mockRestore(); });
const temp = mkdtempSync(join(tmpdir(), 'toollog-tests-'));
process.env.TOOLLOG_ROOT = join(temp, 'logs');
const directory = join(process.env.TOOLLOG_ROOT, 'agent-tools');
const file = () => join(directory, new Date().toISOString().slice(0,10) + '.ndjson');
const rows = () => readFileSync(file(),'utf8').trim().split('\n').map(line => JSON.parse(line));

test('format, privacy, retention, cap, and silent write failure', () => {
  const command = 'curl --password fixture-secret --header token-secret';
  hook('shell','denied','fixture.deny',performance.now(),command,undefined,{sessionId:'fixture-session'});
  emit('fixture','event','fixture.input',{props:{count:2, command, password:'secret'},errorTag:'secret text'});
  expect(rows()[0].ids).toEqual({threadId:'native:opencode:fixture-session',sessionId:'fixture-session'});
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

test('hooks stop at their budget, other components keep logging, and Python shares cap claims', () => {
  process.env.TOOLLOG_ROOT=join(temp,'budgets');
  const day=new Date().toISOString().slice(0,10);
  const path=join(process.env.TOOLLOG_ROOT,'agent-tools',day+'.ndjson');
  emit('rcsim','perf','sim.start');
  truncateSync(path,HOOKS_CAP_BYTES);
  sampling.mockReturnValue(.99);
  for (let i=0;i<3;i++) {
    emit('hooks','perf','hook.dropped');
    emit('rcsim','perf','sim.kept');
    hook('shell','denied','fixture.denied',performance.now());
  }
  // A native writer must observe the same claim, rather than add a second marker.
  const python = spawnSync('python3', ['-I','-c',
    "import sys;sys.path.insert(0,sys.argv[1]);import toollog;toollog.emit('hooks','perf','hook.dropped')",
    resolve(import.meta.dir,'../../local-helpers/libexec/toollog')], {env:process.env,encoding:'utf8'});
  expect(python.status).toBe(0);
  const records=readFileSync(path,'utf8').slice(HOOKS_CAP_BYTES).trim().split('\n').map(line=>JSON.parse(line));
  expect(records.filter(r=>r.name==='sim.kept')).toHaveLength(3);
  expect(records.filter(r=>r.name==='hook.decision')).toHaveLength(3);
  expect(records.some(r=>r.name==='hook.dropped')).toBe(false);
  expect(records.filter(r=>r.name==='log.cap').map(r=>r.props)).toEqual([{component:'hooks',capBytes:HOOKS_CAP_BYTES}]);
  truncateSync(path,CAP_BYTES);
  emit('rcsim','perf','sim.dropped');
  emit('hooks','error','hook.kept',{props:{sampleRate:16}});
  emit('rcsim','error','sim.error');
  const tail=readFileSync(path,'utf8').slice(CAP_BYTES).trim().split('\n').map(line=>JSON.parse(line));
  expect(tail.map(r=>r.name)).toEqual(['log.cap','hook.kept','sim.error']);
  expect(tail[0].props).toEqual({component:'all',capBytes:CAP_BYTES});
});

test('successful hooks sample at the boundary and errors keep their complete context', () => {
  process.env.TOOLLOG_ROOT=join(temp,'sampling');
  for (const decision of ['allowed','rewritten']) {
    sampling.mockReturnValueOnce(0).mockReturnValueOnce(1/HOOK_SAMPLE_RATE).mockReturnValueOnce(.99);
    for(let i=0;i<3;i++) hook('shell',decision,'fixture',performance.now(),undefined,undefined,{threadId:'sample-fixture'});
  }
  sampling.mockReturnValue(.99);
  hook('shell','denied','fixture',performance.now(),undefined,undefined,{threadId:'sample-fixture'});
  hook('shell','allowed','failure',performance.now(),undefined,'fixture.error');
  const path=join(process.env.TOOLLOG_ROOT,'agent-tools',new Date().toISOString().slice(0,10)+'.ndjson');
  const records=readFileSync(path,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  expect(records).toHaveLength(4);
  for (const row of records.slice(0,2)) {
    expect(row.ids.threadId).toBe('sample-fixture');
    expect(row.props.sampleRate).toBe(HOOK_SAMPLE_RATE);
    for(const key of ['cwdClass','matchedRoot','argv0Class']) expect(row.props[key]).toBeUndefined();
  }
  for (const row of records.slice(2)) {
    expect(row.kind).toBe('error');
    expect(row.props).toMatchObject({cwdClass:'other',matchedRoot:'none',argv0Class:'none'});
    expect(row.props.sampleRate).toBeUndefined();
  }
});

test('Python and TypeScript builders agree for every optional default and nondefault', () => {
  const cases: Record<string,unknown>[]=[];
  const defaults: [string,unknown[],unknown][]=[['argv0Class',['none','',null],'search'],
    ['matchedRoot',['none','',null],'filesystem'],['repeatCount',[0,1,null],2],
    ['firstWord',['',null],'rg'],['commandLength',[0,null],10],['cwdClass',['other','',null],'worktree']];
  for(const decision of ['allowed','rewritten','denied']) for(const [key,empty,nondefault] of defaults) {
    for(const value of [...empty,nondefault]) cases.push({harness:'opencode',guard:'shell',decision,rule:'fixture',[key]:value});
  }
  const result=spawnSync('python3',['-I','-c',
    'import sys,json;sys.path.insert(0,sys.argv[1]);import toollog;print(json.dumps([toollog.hook_props(p) for p in json.load(sys.stdin)]))',
    resolve(import.meta.dir,'../../local-helpers/libexec/toollog')],{input:JSON.stringify(cases),encoding:'utf8'});
  expect(result.status).toBe(0);
  expect(cases.map(p=>hookProps(p))).toEqual(JSON.parse(result.stdout));
});
