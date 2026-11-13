import {test, expect} from 'bun:test';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir, homedir} from 'node:os';
import {join} from 'node:path';
import {hook, cwdClass, commandProps, matchedRoot} from '../lib/toollog';
import {createGuardHook} from '../plugin/rootwide-search-guard';
import scope from '../plugin/betterstack-scope';
import statev2 from '../plugin/statev2-guard';
import codemode from '../plugin/codemode-guard';

const temp = mkdtempSync(join(tmpdir(), 'decision-attribution-'));
function rows(root: string) {
  return readFileSync(join(root, 'agent-tools', new Date().toISOString().slice(0,10)+'.ndjson'), 'utf8').trim().split('\n').map(r=>JSON.parse(r));
}
test('all OpenCode guard paths carry session attribution and emit once', async()=>{
  const root = join(temp,'guards');
  process.env.TOOLLOG_ROOT=root;
  const oldThread=process.env.ROBOB_THREAD_ID, oldCard=process.env.ROBOB_CARD_NUMBER;
  delete process.env.ROBOB_THREAD_ID; delete process.env.ROBOB_CARD_NUMBER;
  try {
    for (const blocked of [false,true]) {
      const sessionID='session-'+blocked;
      await createGuardHook(temp,async()=>({root:blocked?'/Volumes/ExternalSSD/board-wt':null,reason:blocked?'refused':null}))({tool:'shell',sessionID,input:{command:'rg private-fixture .'}});
      let run: (e: any)=>unknown=()=>{};
      await scope.setup({location:{directory:blocked?temp:'/Users/ardud/crpko-devops'},permission:{hook:async(_:string,fn:typeof run)=>{run=fn}}});
      run({sessionID,action:'betterstack_query',effect:'allow'});
      await statev2.setup({location:{directory:temp},tool:{hook:async(_:string,fn:typeof run)=>{run=fn}}});
      await run({tool:'shell',sessionID,input:{command:blocked?'sqlite3 ~/.robob/userdata/statev2.sqlite private-fixture':'git status'}});
      await codemode.setup({location:{directory:temp},tool:{hook:async(_:string,fn:typeof run)=>{run=fn}}});
      await run({tool:'execute',sessionID,input:{code:blocked?'await new Promise(r=>r)':'return 1'}});
    }
    const records=rows(root);
    expect(records).toHaveLength(8);
    for (const row of records) {
      expect(row.props.harness).toBe('opencode');
      expect(row.ids.threadId).toBe('native:opencode:'+row.ids.sessionId);
      expect(row.props).toMatchObject({threadIdSource:'native',repeatCount:1});
      expect(['repo-root','worktree','home','other']).toContain(row.props.cwdClass);
    }
    expect(records[4].props.matchedRoot).toBe('board-worktrees');
    expect(JSON.stringify(records)).not.toContain(temp);
    expect(JSON.stringify(records)).not.toContain('private-fixture');
    expect(JSON.stringify(records)).not.toContain('statev2.sqlite');
  } finally {
    if(oldThread===undefined) delete process.env.ROBOB_THREAD_ID; else process.env.ROBOB_THREAD_ID=oldThread;
    if(oldCard===undefined) delete process.env.ROBOB_CARD_NUMBER; else process.env.ROBOB_CARD_NUMBER=oldCard;
  }
});

test('classes, optional card, safe identity, and retry isolation',()=>{
  process.env.TOOLLOG_ROOT=join(temp,'repeat');
  const repo=join(temp,'repo'), wt=join(temp,'wt');
  mkdirSync(join(repo,'.git'),{recursive:true}); mkdirSync(wt); writeFileSync(join(wt,'.git'),'gitdir: private-fixture');
  for(const [cwd,expected] of [[repo,'repo-root'],[wt,'worktree'],[homedir(),'home'],[temp,'other']]) expect(cwdClass(cwd)).toBe(expected);
  for(const [path,expected] of [['/','filesystem'],['/Users/ardud','home'],['/Volumes/ExternalSSD','external'],['/Volumes/ExternalSSD/board-wt','board-worktrees'],['/private-fixture','other']]) expect(matchedRoot(path)).toBe(expected);
  for(const [command,expected] of [['rg secret /','search'],['/private/bin/python3 x','interpreter'],['npm install','package-manager'],['go test','build'],['git status','git'],['private-fixture secret','other']]) expect(commandProps(command).argv0Class).toBe(expected);
  for(const sessionId of ['retry-session','retry-session','another-session']) hook('shell','denied','retry-fixture',performance.now(),'rg private-fixture /',undefined,{sessionId,threadId:'robob-fixture',cardNumber:85},{cwd:wt,matchedRoot:'/'});
  const result=rows(process.env.TOOLLOG_ROOT);
  expect(result.map(r=>r.props.repeatCount)).toEqual([1,2,1]);
  expect(result[0].ids).toEqual({sessionId:'retry-session',threadId:'robob-fixture',cardNumber:85});
  hook('shell','denied','privacy',performance.now(),'rg secret /',undefined,{threadId:'/private-fixture',sessionId:'/private-session'},{cwd:'/private-fixture',matchedRoot:'/private-fixture'});
  expect(JSON.stringify(rows(process.env.TOOLLOG_ROOT))).not.toContain('/private-fixture');
});

test('attributed OpenCode hook stays under 0.1 ms',()=>{
  process.env.TOOLLOG_ROOT=join(temp,'perf');
  const call=()=>hook('shell','denied','retry-perf',performance.now(),'rg private-fixture /',undefined,{sessionId:'perf-session'},{cwd:temp,matchedRoot:'/'});
  call();
  const start=performance.now();
  for(let i=0;i<500;i++) call();
  const ms=(performance.now()-start)/500;
  console.log(`attributed OpenCode hook cost: ${ms.toFixed(3)} ms/call`);
  expect(ms).toBeLessThan(.1);
});

test('retry expiration and environment identity are safe',()=>{
  process.env.TOOLLOG_ROOT=join(temp,'expiry');
  const originalNow=Date.now, originalThread=process.env.ROBOB_THREAD_ID, originalCard=process.env.ROBOB_CARD_NUMBER;
  try {
    process.env.ROBOB_THREAD_ID='environment-thread'; process.env.ROBOB_CARD_NUMBER='85';
    let now=100000;
    Date.now=()=>now;
    for(const elapsed of [0,60000,60001]) {
      now+=elapsed;
      hook('shell','denied','expiry-fixture',performance.now(),'git status',undefined,{sessionId:'expiry-session'});
    }
    const records=rows(process.env.TOOLLOG_ROOT);
    expect(records.map(r=>r.props.repeatCount)).toEqual([1,2,1]);
    expect(records[0].ids).toEqual({threadId:'environment-thread',sessionId:'expiry-session',cardNumber:85});
    expect(records[0].props.threadIdSource).toBe('robob');
  } finally {
    Date.now=originalNow;
    if(originalThread===undefined) delete process.env.ROBOB_THREAD_ID; else process.env.ROBOB_THREAD_ID=originalThread;
    if(originalCard===undefined) delete process.env.ROBOB_CARD_NUMBER; else process.env.ROBOB_CARD_NUMBER=originalCard;
  }
});

test('OpenCode first-write retention removes native repeat sidecars',()=>{
  const root=join(temp,'native-retention'), directory=join(root,'agent-tools');
  process.env.TOOLLOG_ROOT=root;
  mkdirSync(directory,{recursive:true});
  const {existsSync}=require('node:fs');
  const key='a'.repeat(32);
  for(const ext of ['json','bin']) writeFileSync(join(directory,`.repeat-2000-01-01-${key}.${ext}`),'fixture');
  const today=new Date().toISOString().slice(0,10);
  writeFileSync(join(directory,`.repeat-${today}-${key}.bin`),'fixture');
  hook('shell','allowed','retention',performance.now(),'git status');
  for(const ext of ['json','bin']) expect(existsSync(join(directory,`.repeat-2000-01-01-${key}.${ext}`))).toBe(false);
  expect(existsSync(join(directory,`.repeat-${today}-${key}.bin`))).toBe(true);
});
