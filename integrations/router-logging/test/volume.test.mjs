import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture } from './support.mjs';
import { emit, reportVolume, clean } from '../toollog.mjs';
import { volumeState, recordWritten } from '../volume.mjs';

for (const explicit of [false,true]) test(`short-lived JS writer reports cap drops on ${explicit ? 'process.exit' : 'natural exit'} and keeps errors`, t=>{
  const {root}=fixture(t),cap=200*1024*1024;
  const path=join(root,new Date().toISOString().slice(0,10)+'.ndjson');
  fs.writeFileSync(path,'');fs.truncateSync(path,cap);
  const source=`import {emit} from ${JSON.stringify(new URL('../toollog.mjs',import.meta.url).href)};emit('proxy','proxy.request');emit('proxy','proxy.request');emit('proxy','proxy.request',{kind:'error',error:{tag:'http_502'}});${explicit ? 'process.exit(7);' : ''}`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',source],{env:process.env,encoding:'utf8'});
  assert.equal(child.status,explicit ? 7 : 0,child.stderr);
  const fd=fs.openSync(path,'r'),buffer=Buffer.alloc(8192);
  const n=fs.readSync(fd,buffer,0,buffer.length,cap);fs.closeSync(fd);
  const rows=buffer.subarray(0,n).toString().trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row=>row.name==='log.cap').length,1);
  assert.equal(rows.filter(row=>row.name==='proxy.request').length,1);
  const report=rows.find(row=>row.name==='log.volume');
  assert.deepEqual(report.props.droppedByReason,{daily_cap:2});
  assert.equal(report.props.droppedLines,2);assert.equal(report.props.writtenLines,2);
  assert.deepEqual(report.props.linesByName,{'log.cap':1,'proxy.request':1});
  assert.equal(report.kind,'event');assert.match(report.ids.writer,/^[a-f0-9]{16}$/);
});
for (const signal of ['SIGTERM','SIGINT']) for (const handled of [false,true]) {
  test(`JS writer snapshots on ${signal} and preserves ${handled ? 'the existing handler' : 'default termination'}`,t=>{
    const {root}=fixture(t),cap=200*1024*1024;
    const path=join(root,new Date().toISOString().slice(0,10)+'.ndjson');
    fs.writeFileSync(path,'');fs.truncateSync(path,cap);
    const module=new URL('../toollog.mjs',import.meta.url).href;
    const handler=handled ? `process.once(${JSON.stringify(signal)},()=>{const fd=fs.openSync(${JSON.stringify(path)},'r'),buffer=Buffer.alloc(4096);const n=fs.readSync(fd,buffer,0,buffer.length,${cap});fs.closeSync(fd);if(!buffer.subarray(0,n).toString().includes('log.volume'))process.exit(11);emit('proxy','proxy.request',{kind:'error'});process.exit(9)});` : '';
    const source=`import fs from 'node:fs';import {emit} from ${JSON.stringify(module)};${handler}emit('proxy','proxy.request');setInterval(()=>{},1000);process.kill(process.pid,${JSON.stringify(signal)});`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',source],{env:process.env,encoding:'utf8',timeout:10000});
    assert.equal(child.error,undefined);assert.equal(child.status,handled ? 9 : null,child.stderr);
    assert.equal(child.signal,handled ? null : signal);
    const fd=fs.openSync(path,'r'),buffer=Buffer.alloc(8192);
    const n=fs.readSync(fd,buffer,0,buffer.length,cap);fs.closeSync(fd);
    const rows=buffer.subarray(0,n).toString().trim().split('\n').map(JSON.parse);
    const reports=rows.filter(row=>row.name==='log.volume');
    assert.equal(reports.length,handled ? 2 : 1);
    assert.equal(reports.at(-1).props.droppedLines,1);
    assert.equal(reports.at(-1).props.writtenLines,handled ? 2 : 1);
  });
}
test('JS volume counters include recovered write errors and avoid duplicate snapshots',t=>{
  const {root,rows}=fixture(t),blocked=join(root,'blocked');
  fs.writeFileSync(blocked,'fixture');process.env.ROUTER_LOG_DIR=blocked;
  emit('proxy','proxy.request');fs.unlinkSync(blocked);fs.mkdirSync(blocked);
  reportVolume();reportVolume();
  const reports=fs.readdirSync(blocked).filter(file=>file.endsWith('.ndjson')).flatMap(file=>fs.readFileSync(join(blocked,file),'utf8').trim().split('\n').map(JSON.parse));
  assert.equal(reports.length,1);assert.equal(reports[0].name,'log.volume');
  assert.equal(reports[0].props.writeErrors,1);assert.equal(reports[0].props.droppedLines,1);
  assert.deepEqual(reports[0].props.droppedByReason,{write_error:1});
  process.env.ROUTER_LOG_DIR=root;
  emit('test','invalid name');emit('test','CANARY_EVENT_NAME');reportVolume();
  const row=rows().find(row=>row.name==='log.volume');
  assert.deepEqual(row.props.linesByName,{other:1});assert.deepEqual(row.props.droppedByReason,{invalid_event:1});
  assert.ok(!JSON.stringify(row).includes('CANARY'));
});
test('JS volume schema rejects private labels, boolean counts and unknown reasons',()=>{
  const row=clean({component:'logger',name:'log.volume',kind:'event',ids:{writer:'CANARY_WRITER'},props:{bytesToday:10,queueDepth:true,linesByName:{'proxy.request':2,CANARY_BODY:1},droppedByReason:{daily_cap:1,CANARY_BODY:2},writeErrors:-1}});
  assert.deepEqual(row.props,{bytesToday:10,linesByName:{'proxy.request':2},droppedByReason:{daily_cap:1}});
  assert.ok(!JSON.stringify(row).includes('CANARY'));
});
test('delayed JS snapshots keep the counted day in their timestamp and file',t=>{
  const {root}=fixture(t),day=new Date(Date.now()-86400000).toISOString().slice(0,10);
  recordWritten(volumeState(root,day),'proxy.request');
  reportVolume();
  const rows=fs.readFileSync(join(root,day+'.ndjson'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length,1);assert.equal(rows[0].ts.slice(0,10),day);
  assert.equal(rows[0].props.writtenLines,1);
});
