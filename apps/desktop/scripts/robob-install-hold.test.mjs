import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireInstallHold, finishInstallHold } from "./robob-install-hold.mjs";

test("hold spans the install and post-launch health window", async () => {
  const calls = [];
  const hold = await acquireInstallHold({home: "/sandbox", pid: 42, env: {}, run: async (_cmd, args) => calls.push(args)});
  const {release}=hold;
  assert.equal(hold.by,"release-install");assert.equal(hold.pid,42);
  calls.push("quit", "launch", "healthy");
  await release();
  assert.deepEqual(calls, [["start", "--by", "release-install", "--pid", "42"], "quit", "launch", "healthy", ["stop", "--by", "release-install", "--pid", "42"]]);
});
test("nested installer refreshes its parent hold without releasing it", async () => {
  const calls=[];
  const hold=await acquireInstallHold({env:{ROBOB_INSTALL_HOLD_BY:"supervisor",ROBOB_INSTALL_HOLD_PID:"7"},run:async (_cmd,args)=>calls.push(args)});
  const {release}=hold;
  assert.equal(hold.by,"supervisor");assert.equal(hold.pid,7);
  await release();
  assert.deepEqual(calls,[["beat","--by","supervisor","--pid","7"]]);
});
test("missing helper warns and continues; other errors abort", async () => {
  const warnings=[];
  const hold=await acquireInstallHold({env:{},warn:(s)=>warnings.push(s),run:async()=>{throw Object.assign(new Error("missing"),{code:"ENOENT"});}});
  const {release}=hold;
  assert.equal(hold.by,null);assert.equal(hold.pid,null);
  await release();assert.equal(warnings.length,1);
  await assert.rejects(acquireInstallHold({env:{},run:async()=>{throw new Error("foreign owner");}}),/foreign owner/);
});
test("dead inherited owner gets its own hold",async()=>{
  const calls=[];
  const hold=await acquireInstallHold({pid:42,env:{ROBOB_INSTALL_HOLD_BY:"dead",ROBOB_INSTALL_HOLD_PID:"7"},run:async(_cmd,args)=>{calls.push(args);if(args[0]==="beat")throw new Error("dead");}});
  const {release}=hold;
  assert.equal(hold.by,"release-install");assert.equal(hold.pid,42);
  await release();assert.deepEqual(calls.map(x=>x[0]),["beat","start","stop"]);
});

test("pre-quit failure releases without requiring recovery", async () => {
  const calls=[];
  await finishInstallHold({release:async()=>calls.push("stop"),quitStarted:false,healthy:async()=>assert.fail("no downtime")});
  assert.deepEqual(calls,["stop"]);
});

test("healthy completion releases immediately", async () => {
  const calls=[];
  await finishInstallHold({release:async()=>calls.push("stop"),quitStarted:true,healthy:async()=>true,onWaiting:async()=>assert.fail("already healthy")});
  assert.deepEqual(calls,["stop"]);
});

test("notification failure cannot end the recovery hold",async()=>{
  let probes=0;
  const calls=[];
  await finishInstallHold({release:async()=>calls.push("stop"),quitStarted:true,
    healthy:async()=>++probes===3,onWaiting:async()=>{throw new Error("notify failed");},
    sleep:async()=>{assert.equal(calls.includes("stop"),false);calls.push("wait");}});
  assert.deepEqual(calls,["wait","wait","stop"]);
});
