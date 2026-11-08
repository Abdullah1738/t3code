import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  captureOwnedTree,
  cleanupOwnedTree,
  processTable,
  signalOwned,
  survivingOwned,
  refreshOwnedTree,
} from "./ownedProcessTree.ts";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function line(stream) {
  let value = "";
  for await (const chunk of stream) {
    value += chunk;
    if (value.includes("\n")) return JSON.parse(value.slice(0, value.indexOf("\n")));
  }
  throw Error("No subprocess handshake");
}
test("retains child and grandchild after TERM exits leader; other group survives", async () => {
  const grandchild = `process.on('SIGTERM',()=>{});console.log(process.pid);setInterval(()=>{},1000)`;
  const child = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});const c=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','pipe','ignore']});c.stdout.once('data',b=>console.log(JSON.stringify([process.pid,Number(String(b))])));setInterval(()=>{},1000)`;
  const code = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore','pipe','ignore']});c.stdout.pipe(process.stdout);setInterval(()=>{},1000)`;
  const sentinel = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    detached: true,
    stdio: "ignore",
  });
  const sentinelExit = once(sentinel, "exit");
  const leader = spawn(process.execPath, ["-e", code], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const leaderExit = once(leader, "exit");
  let tree;
  try {
    const [childPid, grandchildPid] = await line(leader.stdout);
    tree = await captureOwnedTree(leader.pid);
    assert.ok(tree.members.has(childPid));
    assert.ok(tree.members.has(grandchildPid));
    await signalOwned(tree, "SIGTERM", true);
    await leaderExit;
    assert.ok((await survivingOwned(tree, true)).some((r) => r.pid === childPid));
    assert.ok((await survivingOwned(tree, true)).some((r) => r.pid === grandchildPid));
    await cleanupOwnedTree(tree, 100, true);
    for (let i = 0; i < 100 && (await survivingOwned(tree, true)).length; i++) await sleep(20);
    assert.deepEqual(await survivingOwned(tree, true), []);
    assert.ok(
      (await processTable()).some((r) => r.pid === sentinel.pid),
      "unrelated group untouched",
    );
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    if (tree)
      await cleanupOwnedTree(tree, 50, true, 10000).catch((e) => console.error("cleanup:", e));
    sentinel.kill("SIGKILL");
    await sentinelExit;
  }
});
test("simulated PID and PGID reuse never signals replacement; read is repeated immediately before signal", async () => {
  const root = { pid: 90001, ppid: 1, pgid: 90001, start: "100" };
  const child = { pid: 90002, ppid: 90001, pgid: 90001, start: "101" };
  const tree = {
    root,
    members: new Map([
      [root.pid, root],
      [child.pid, child],
    ]),
    groups: new Map([[root.pgid, root]]),
    excluded: new Set(),
  };
  let calls = 0;
  const killed = [];
  await signalOwned(tree, "SIGKILL", true, {
    table: async () =>
      ++calls === 1
        ? [root, child]
        : [
            { ...root, start: "999" },
            { ...child, start: "1000" },
          ],
    kill: (...args) => {
      killed.push(args);
      return true;
    },
  });
  assert.deepEqual(killed, []);
  assert.ok(calls >= 3);
  refreshOwnedTree(tree, [{ pid: 90003, ppid: 1, pgid: 90001, start: "1001" }]);
  assert.equal(tree.members.has(90003), false, "unanchored reused PGID refused");
});
test("kernel identity signal refuses a forged generation", async () => {
  const { signalIdentity } = await import("./ownedProcessTree.ts");
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    detached: true,
    stdio: "ignore",
  });
  const exited = once(child, "exit");
  try {
    const tree = await captureOwnedTree(child.pid);
    const forged =
      process.platform === "darwin"
        ? { ...tree.root, version: tree.root.version + 100 }
        : { ...tree.root, start: "0" };
    await signalIdentity(forged, "SIGKILL");
    assert.ok(
      (await processTable()).some((r) => r.pid === child.pid),
      "kernel-bound signal leaves replacement alive",
    );
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
});
test("captured descendants stay owned across PGID changes and newly protected trees are skipped", async () => {
  const root = { pid: 91001, ppid: 1, pgid: 91001, start: "100" };
  const child = { pid: 91002, ppid: 91001, pgid: 91001, start: "101" };
  const grandchild = { pid: 91003, ppid: 91002, pgid: 91001, start: "102" };
  const tree = {
    root,
    members: new Map([
      [root.pid, root],
      [child.pid, child],
      [grandchild.pid, grandchild],
    ]),
    groups: new Map(),
    excluded: new Set(),
  };
  const killed = [];
  const rows = [root, { ...child, pgid: child.pid }, grandchild];
  await signalOwned(tree, "SIGTERM", true, {
    table: async () => rows,
    kill: (pid) => {
      killed.push(pid);
      return true;
    },
  });
  assert.ok(killed.includes(child.pid), "changing process group does not change ownership");
  killed.length = 0;
  rows[1] = { ...rows[1], protected: true };
  await signalOwned(tree, "SIGKILL", true, {
    table: async () => rows,
    kill: (pid) => {
      killed.push(pid);
      return true;
    },
  });
  assert.deepEqual(killed, [root.pid], "protection covers the captured descendant closure");
});
