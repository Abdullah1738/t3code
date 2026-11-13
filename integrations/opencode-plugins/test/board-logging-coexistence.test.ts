import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('the installed gate emits one event per decision into each board', () => {
  const root = mkdtempSync(join(tmpdir(), 'board-log-coexistence-'));
  try {
    const config = join(root, '.config/opencode');
    const skill = join(config, 'skills/remote-compute');
    for (const directory of ['plugin', 'lib', 'skills/remote-compute/scripts']) mkdirSync(join(config, directory), {recursive:true});
    const integrations = resolve(import.meta.dir, '../..');
    copyFileSync(join(integrations, 'offbox/plugin/offbox-gate.ts'), join(config, 'plugin/offbox-gate.ts'));
    copyFileSync(join(integrations, 'opencode-plugins/lib/toollog.ts'), join(config, 'lib/toollog.ts'));
    for (const file of ['classify.ts', 'toollog.ts']) copyFileSync(join(integrations, 'offbox/skill/scripts', file), join(skill, 'scripts', file));
    copyFileSync(join(integrations, 'offbox/skill/heavy-rules.json'), join(skill, 'heavy-rules.json'));
    mkdirSync(join(root, '.local/bin'), {recursive:true});
    writeFileSync(join(root, '.local/bin/offbox'), 'fixture');
    const cases = [
      {label:'observe', mode:'observe', command:'go test ./...', agent:'allowed', offbox:'allowed'},
      {label:'deny', mode:'enforce', command:'go test ./...', agent:'denied', offbox:'denied'},
      {label:'light', mode:'enforce', command:'echo PrivateFixtureArgument', agent:'allowed', offbox:'allowed'},
      {label:'off', mode:'off', command:'go test ./...', agent:'allowed', offbox:'allowed'},
      {label:'exempt', mode:'enforce', command:'go test ./...', agent:'allowed', offbox:'local-override'},
      {label:'classifier-error', mode:'observe', command:'true', agent:'allowed', offbox:'allowed'},
      {label:'rewrite-error', mode:'enforce', command:'go test ./...', agent:'denied', offbox:'allowed'},
    ];
    function records(board: string) {
      const directory = join(root,'logs',board);
      try {
        return readdirSync(directory).filter(file=>file.endsWith('.ndjson')).flatMap(file=>readFileSync(join(directory,file),'utf8').trim().split('\n').map(line=>JSON.parse(line)));
      } catch { return []; }
    }
    for (const scenario of cases) {
      const before = { 'agent-tools': records('agent-tools').length, offbox: records('offbox').length };
      const state = join(root,'state-'+scenario.label);
      mkdirSync(state);
      if (scenario.label==='exempt') writeFileSync(join(state,'exemptions.json'), JSON.stringify([{session_id:'fixture-session'}]));
      const script = `
        import {mock} from 'bun:test';
        if (${JSON.stringify(scenario.label)}==='classifier-error') mock.module(${JSON.stringify(join(skill,'scripts/classify.ts'))},()=>({classify:()=>({heavy:false,error:'private-classifier-body'}),loadRules:()=>{}}));
        const {default:plugin} = await import(${JSON.stringify(join(config,'plugin/offbox-gate.ts'))});
        let before;
        await plugin.setup({tool:{hook:async(_,fn)=>{before=fn}},shell:{hook:async()=>{}},session:{hook:async()=>{},get:async()=>null}});
        const input={command:${JSON.stringify(scenario.command)},workdir:${JSON.stringify(root)}};
        const event={tool:'shell',sessionID:'fixture-session',input};
        if (${JSON.stringify(scenario.label)}==='rewrite-error') Object.defineProperty(event,'input',{get:()=>input,set:()=>{throw new Error('private-rewrite-body')}});
        await before(event);
      `;
      const result = spawnSync(process.execPath, ['-e', script], {encoding:'utf8',env:{...process.env,
        HOME:root, TOOLLOG_ROOT:join(root,'logs'), OFFBOX_TOOL_LOG_DIR:join(root,'logs/offbox'),
        OFFBOX_STATE_DIR:state, OFFBOX_GATE_MODE:scenario.mode, BUN_INSPECT:''}});
      expect(result.status).toBe(0);
      for (const [board, name] of [['agent-tools','hook.decision'],['offbox','gate.decision']] as const) {
        const rows = records(board).slice(before[board]);
        expect(rows).toHaveLength(1);
        expect(rows[0].tool).toBe(board);
        expect(rows[0].name).toBe(name);
        expect(rows[0].props.decision).toBe(board==='agent-tools' ? scenario.agent : scenario.offbox);
        const failed=scenario.label.endsWith('-error');
        expect(rows[0].ok).toBe(board==='agent-tools' ? scenario.agent!=='denied' && !failed : !failed);
        expect(JSON.stringify(rows)).not.toContain('PrivateFixtureArgument');
        expect(JSON.stringify(rows)).not.toContain('private-classifier-body');
        expect(JSON.stringify(rows)).not.toContain('private-rewrite-body');
      }
    }
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});
