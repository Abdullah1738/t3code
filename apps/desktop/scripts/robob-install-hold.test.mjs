import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireInstallHold } from "./robob-install-hold.mjs";

test("hold spans the install and post-launch health window", async () => {
  const calls = [];
  const release = await acquireInstallHold({home: "/sandbox", pid: 42, env: {}, run: async (_cmd, args) => calls.push(args)});
  calls.push("quit", "launch", "healthy");
  await release();
  assert.deepEqual(calls, [["start", "--by", "release-install", "--pid", "42"], "quit", "launch", "healthy", ["stop", "--by", "release-install", "--pid", "42"]]);
});
test("nested installer refreshes its parent hold without releasing it", async () => {
  const calls=[];
  const release=await acquireInstallHold({env:{ROBOB_INSTALL_HOLD_BY:"supervisor",ROBOB_INSTALL_HOLD_PID:"7"},run:async (_cmd,args)=>calls.push(args)});
  await release();
  assert.deepEqual(calls,[["beat","--by","supervisor","--pid","7"]]);
});
test("missing helper warns and continues; other errors abort", async () => {
  const warnings=[];
  const release=await acquireInstallHold({env:{},warn:(s)=>warnings.push(s),run:async()=>{throw Object.assign(new Error("missing"),{code:"ENOENT"});}});
  await release();assert.equal(warnings.length,1);
  await assert.rejects(acquireInstallHold({env:{},run:async()=>{throw new Error("foreign owner");}}),/foreign owner/);
});
test("dead inherited owner gets its own hold",async()=>{
  const calls=[];
  const release=await acquireInstallHold({pid:42,env:{ROBOB_INSTALL_HOLD_BY:"dead",ROBOB_INSTALL_HOLD_PID:"7"},run:async(_cmd,args)=>{calls.push(args);if(args[0]==="beat")throw new Error("dead");}});
  await release();assert.deepEqual(calls.map(x=>x[0]),["beat","start","stop"]);
});
