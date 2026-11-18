import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalize } from "../src/lib.ts";

const gone = (pid: number) => {
  try { process.kill(pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
};
async function until(check: () => boolean, timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  while (!check() && Date.now() < end) await Bun.sleep(10);
  return check();
}
const recordedPid = (file: string) => {
  try { const pid = Number(readFileSync(file, "utf8").trim()); return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined; }
  catch { return undefined; }
};

for (const [signal, ignoreTerm, owner] of [
  ["SIGTERM", false, "runner"], ["SIGINT", false, "runner"], ["SIGHUP", false, "runner"], ["SIGTERM", true, "runner"], ["EXIT", false, "runner"],
  ["SIGTERM", false, "imported"], ["SIGINT", false, "imported"], ["SIGHUP", false, "imported"], ["EXIT", false, "imported"],
  ["SIGTERM", false, "library"], ["EXIT", false, "library"],
] as const) test(`runner ${signal} leaves no check process (TERM ignored=${ignoreTerm}, owner=${owner})`, async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "watch-shutdown-"));
  const root = join(sandbox, "root"), dir = join(root, "watchers", "held"), pidFile = join(dir, "check.pid"), descendantFile = join(dir, "descendant.pid");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "watcher.json"), JSON.stringify(normalize({ id: "held", title: "Held", mode: "notify", interval_s: 300,
    max_fires: 0, check: `${ignoreTerm ? "trap '' TERM; " : ""}echo $$ > "$WATCH_DIR/check.pid"; sleep 30 & echo $! > "$WATCH_DIR/descendant.pid"; ${ignoreTerm ? "while :; do wait; done" : "wait"}` })));
  writeFileSync(join(dir, "state.json"), JSON.stringify({ status: "active", fires: 0, consecutive_failures: 0, next_at: 0 }));
  const queued = ["queued", "queued-two"].map(id => {
    const path = join(root, "watchers", id);
    mkdirSync(path);
    writeFileSync(join(path, "watcher.json"), JSON.stringify(normalize({ id, title: "Queued", mode: "notify", interval_s: 300,
      max_fires: 0, check: 'echo started > "$WATCH_DIR/started"' })));
    writeFileSync(join(path, "state.json"), JSON.stringify({ status: "active", fires: 0, consecutive_failures: 0, next_at: 0 }));
    return path;
  });
  const preload = join(sandbox, "exit.ts");
  writeFileSync(preload, `import {readFileSync} from "node:fs"; setInterval(()=>{try{const pid=Number(readFileSync(${JSON.stringify(descendantFile)},"utf8"));if(Number.isSafeInteger(pid)&&pid>1)process.exit(0);}catch{}},10);`);
  const runner = join(import.meta.dir, "../src/runner.ts");
  const entry = owner === "runner" ? [runner] : owner === "imported" ? ["-e", `const {tick}=await import(${JSON.stringify(runner)}); await tick();`]
    : ["-e", `const lib=await import(${JSON.stringify(join(import.meta.dir, "../src/lib.ts"))}); await lib.runCheck(lib.loadWatcher("held"),lib.watcherDir("held"));`];
  const child = Bun.spawn([process.execPath, ...(signal === "EXIT" ? ["--preload", preload] : []), ...entry], { env: {
    ...process.env, BUN_INSPECT: undefined, ROBOB_TEST: "1", ROBOB_WATCH_ROOT: root, TOOLLOG_DIR: join(sandbox, "logs"),
    ROBOB_WATCH_LOAD_OVERRIDE: ".1", ROBOB_WATCH_SSD_PATH: "/dev", ROBOB_WATCH_CHECK_TIMEOUT_MS: "60000", ROBOB_WATCH_MAX_CONCURRENT: "1",
  }, stdout: "ignore", stderr: "ignore" });
  let pid: number | undefined, descendant: number | undefined;
  try {
    expect(await until(() => !!recordedPid(pidFile) && !!recordedPid(descendantFile), 2000)).toBe(true);
    pid = recordedPid(pidFile);
    descendant = recordedPid(descendantFile);
    expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
    expect(Number.isSafeInteger(descendant) && descendant > 1).toBe(true);
    const stoppedAt = Date.now(), deadline = stoppedAt + 2000;
    if (signal !== "EXIT") child.kill(signal);
    await child.exited;
    if (ignoreTerm) expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(450);
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).consecutive_failures).toBe(0);
    for (const path of queued) {
      expect(existsSync(join(path, "started"))).toBe(false);
      const state = JSON.parse(readFileSync(join(path, "state.json"), "utf8"));
      expect(state.consecutive_failures).toBe(0);
      expect(state.next_at).toBe(0);
      expect(state.last_run_at).toBeUndefined();
      expect(state.admitted_run).toBeUndefined();
    }
    rmSync(dir, { recursive: true, force: true });
    expect(await until(() => gone(pid!) && gone(descendant!), Math.max(0, deadline - Date.now()))).toBe(true);
    expect(Date.now()).toBeLessThan(deadline + 20);
  } finally {
    if (child.exitCode === null) { child.kill(); await child.exited; }
    if (pid && !gone(pid)) { try { process.kill(-pid, "SIGKILL"); } catch {} }
    if (descendant && !gone(descendant)) { try { process.kill(descendant, "SIGKILL"); } catch {} }
    rmSync(sandbox, { recursive: true, force: true });
  }
}, 8000);

for (const [signal, leaderExits] of [["SIGTERM", false], ["SIGTERM", true], ["EXIT", false]] as const) {
  test(`runner ${signal} kills redirected TERM-resistant descendants (leader exited=${leaderExits})`, async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "watch-redirected-shutdown-"));
    const root = join(sandbox, "root"), dir = join(root, "watchers", "held");
    const leaderFile = join(dir, "leader.pid"), descendantFile = join(dir, "descendant.pid");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "watcher.json"), JSON.stringify(normalize({ id: "held", title: "Held", mode: "notify", interval_s: 300,
      max_fires: 0, check: `echo $$ > "$WATCH_DIR/leader.pid"; /usr/bin/perl -e '$SIG{TERM}="IGNORE"; open my $f, ">", "$ENV{WATCH_DIR}/descendant.pid" or die $!; print $f $$; close $f; sleep 30' >/dev/null 2>&1 & ${leaderExits ? "exit 0" : "wait"}` })));
    writeFileSync(join(dir, "state.json"), JSON.stringify({ status: "active", fires: 0, consecutive_failures: 0, next_at: 0 }));
    const preload = join(sandbox, "exit.ts");
    writeFileSync(preload, `import {readFileSync} from "node:fs"; setInterval(()=>{try{const pid=Number(readFileSync(${JSON.stringify(descendantFile)},"utf8"));if(Number.isSafeInteger(pid)&&pid>1)process.exit(0);}catch{}},10);`);
    const child = Bun.spawn([process.execPath, ...(signal === "EXIT" ? ["--preload", preload] : []), join(import.meta.dir, "../src/runner.ts")], { env: {
      ...process.env, BUN_INSPECT: undefined, ROBOB_TEST: "1", ROBOB_WATCH_ROOT: root, TOOLLOG_DIR: join(sandbox, "logs"),
      ROBOB_WATCH_LOAD_OVERRIDE: ".1", ROBOB_WATCH_SSD_PATH: "/dev", ROBOB_WATCH_CHECK_TIMEOUT_MS: "60000",
    }, stdout: "ignore", stderr: "ignore" });
    let leader: number | undefined, descendant: number | undefined;
    try {
      expect(await until(() => !!recordedPid(leaderFile) && !!recordedPid(descendantFile), 2000)).toBe(true);
      leader = recordedPid(leaderFile); descendant = recordedPid(descendantFile);
      if (leaderExits) expect(await until(() => JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).last_run_ms !== undefined, 2000)).toBe(true);
      const stoppedAt = Date.now();
      if (signal !== "EXIT") child.kill(signal);
      await child.exited;
      expect(child.exitCode).toBe(0);
      expect(await until(() => gone(leader!) && gone(descendant!), 2000 - (Date.now() - stoppedAt))).toBe(true);
    } finally {
      if (child.exitCode === null) { child.kill(); await child.exited; }
      if (leader && !gone(leader)) { try { process.kill(-leader, "SIGKILL"); } catch {} }
      if (descendant && !gone(descendant)) { try { process.kill(descendant, "SIGKILL"); } catch {} }
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 8000);
}

for (const owner of ["runner", "library"] as const) for (const release of [false, true]) for (const lockMode of ["IMMEDIATE", "EXCLUSIVE"]) {
  test(`relay contention preserves shutdown and retries (owner=${owner}, release=${release}, lock=${lockMode})`, async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "watch-locked-shutdown-"));
    const root = join(sandbox, "root"), held = join(root, "watchers", "held"), blocked = join(root, "watchers", "blocked");
    for (const [id, dir, check] of [
      ["held", held, 'echo $$ > "$WATCH_DIR/check.pid"; sleep 30 & echo $! > "$WATCH_DIR/descendant.pid"; wait'],
      ["blocked", blocked, 'echo started >> "$WATCH_DIR/started"'],
    ] as const) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "watcher.json"), JSON.stringify(normalize({ id, title: id, mode: "notify", interval_s: 300, max_fires: 0, check })));
      writeFileSync(join(dir, "state.json"), JSON.stringify({ status: "active", fires: 0, consecutive_failures: 0, next_at: 0 }));
    }
    const attempted = join(sandbox, "attempted"), completed = join(sandbox, "completed"), responsive = join(sandbox, "responsive");
    const child = Bun.spawn([process.execPath, "-e", `
      import {writeFileSync} from "node:fs";
      const lib=await import(${JSON.stringify(join(import.meta.dir, "../src/lib.ts"))});
      ${owner === "runner" ? `const {tickOne:run}=await import(${JSON.stringify(join(import.meta.dir, "../src/runner.ts"))});`
        : 'const run=id=>lib.runCheck(lib.loadWatcher(id),lib.watcherDir(id));'}
      void run("held");
      process.stdin.on("data",async data=>{
          writeFileSync(${JSON.stringify(attempted)},"waiting");
          setTimeout(()=>writeFileSync(${JSON.stringify(responsive)},"1"),20);
          try {await run("blocked"); writeFileSync(${JSON.stringify(completed)},"1");}
          catch(error) {writeFileSync(${JSON.stringify(attempted)},error.code??String(error));}
      });
    `], { env: {
      ...process.env, BUN_INSPECT: undefined, ROBOB_TEST: "1", ROBOB_WATCH_ROOT: root, TOOLLOG_DIR: join(sandbox, "logs"),
      ROBOB_WATCH_LOAD_OVERRIDE: ".1", ROBOB_WATCH_SSD_PATH: "/dev", ROBOB_WATCH_CHECK_TIMEOUT_MS: "60000",
    }, stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    let pid: number | undefined, descendant: number | undefined, lock: Database | undefined;
    try {
      expect(await until(() => !!recordedPid(join(held, "check.pid")) && !!recordedPid(join(held, "descendant.pid")), 3000)).toBe(true);
      pid = recordedPid(join(held, "check.pid")); descendant = recordedPid(join(held, "descendant.pid"));
      lock = new Database(join(root, "relay-lock.sqlite"));
      lock.exec(`BEGIN ${lockMode}`);
      child.stdin.write("attempt\n");
      expect(await until(() => existsSync(attempted), 1000)).toBe(true);
      expect(await until(() => existsSync(responsive), 1000)).toBe(true);
      expect(readFileSync(attempted, "utf8")).toBe("waiting");
      expect(existsSync(completed)).toBe(false);
      expect(existsSync(join(blocked, "started"))).toBe(false);
      expect(JSON.parse(readFileSync(join(blocked, "state.json"), "utf8"))).toEqual({ status: "active", fires: 0, consecutive_failures: 0, next_at: 0 });
      if (release) {
        lock.exec("COMMIT"); lock.close(); lock = undefined;
        expect(await until(() => existsSync(completed), 2000)).toBe(true);
        expect(readFileSync(join(blocked, "started"), "utf8")).toBe("started\n");
        expect(JSON.parse(readFileSync(join(blocked, "state.json"), "utf8")).consecutive_failures).toBe(0);
      }
      const stopped = Date.now();
      child.kill("SIGTERM");
      expect(await Promise.race([child.exited, Bun.sleep(2000).then(() => "did not exit")])).toBe(0);
      expect(await until(() => gone(pid!) && gone(descendant!), Math.max(0, 2000 - (Date.now() - stopped)))).toBe(true);
    } finally {
      if (lock) { lock.exec("ROLLBACK"); lock.close(); }
      if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
      if (pid && !gone(pid)) { try { process.kill(-pid, "SIGKILL"); } catch {} }
      if (descendant && !gone(descendant)) { try { process.kill(descendant, "SIGKILL"); } catch {} }
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 8000);
}

for (const operation of ["check", "pending"] as const) {
  test(`shutdown skips queued ${operation} admission while the relay lock is held`, async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "watch-queued-locked-shutdown-"));
    const root = join(sandbox, "root"), held = join(root, "watchers", "held"), queued = join(root, "watchers", "queued");
    const enqueued = join(sandbox, "enqueued"), failed = join(sandbox, "failed");
    for (const [id, dir, check, extra] of [
      ["held", held, `echo $$ > "$WATCH_DIR/check.pid"; /usr/bin/perl -e '$SIG{TERM}="IGNORE"; open my $f, ">", "$ENV{WATCH_DIR}/descendant.pid" or die $!; print $f $$; close $f; sleep 30' >/dev/null 2>&1 & wait`, {}],
      ["queued", queued, operation === "check" ? 'echo started > "$WATCH_DIR/started"' : "true",
        operation === "pending" ? { pending_check: 'echo started > "$WATCH_DIR/started"' } : {}],
    ] as const) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "watcher.json"), JSON.stringify(normalize({ id, title: id, mode: "notify", interval_s: 300, max_fires: 0, check, ...extra })));
      writeFileSync(join(dir, "state.json"), JSON.stringify({ status: "active", fires: 0, consecutive_failures: 0, next_at: 0 }));
    }
    const child = Bun.spawn([process.execPath, "-e", `
      import {existsSync,writeFileSync} from "node:fs";
      const {CheckSlots}=await import(${JSON.stringify(join(import.meta.dir, "../src/host.ts"))});
      const {tickOne}=await import(${JSON.stringify(join(import.meta.dir, "../src/runner.ts"))});
      const hold=async()=>{void tickOne("held"); while(!existsSync(${JSON.stringify(join(held, "descendant.pid"))}))await Bun.sleep(10);};
      const run=CheckSlots.prototype.run;
      CheckSlots.prototype.run=async function(fn,request){
        if(request.watcher==="queued" && request.operation===${JSON.stringify(operation)}){
          ${operation === "pending" ? "await hold();" : ""}
          const job=run.call(this,fn,request);
          writeFileSync(${JSON.stringify(enqueued)},"1");
          return job;
        }
        return run.call(this,fn,request);
      };
      ${operation === "check" ? "await hold();" : ""}
      void tickOne("queued").catch(error=>writeFileSync(${JSON.stringify(failed)},String(error)));
    `], { env: {
      ...process.env, BUN_INSPECT: undefined, ROBOB_TEST: "1", ROBOB_WATCH_ROOT: root, TOOLLOG_DIR: join(sandbox, "logs"),
      ROBOB_WATCH_LOAD_OVERRIDE: ".1", ROBOB_WATCH_SSD_PATH: "/dev", ROBOB_WATCH_CHECK_TIMEOUT_MS: "60000", ROBOB_WATCH_MAX_CONCURRENT: "1",
    }, stdout: "ignore", stderr: "ignore" });
    let pid: number | undefined, descendant: number | undefined, lock: Database | undefined;
    try {
      expect(await until(() => existsSync(enqueued), 3000)).toBe(true);
      pid = recordedPid(join(held, "check.pid")); descendant = recordedPid(join(held, "descendant.pid"));
      expect(!!pid && !!descendant).toBe(true);
      const state = readFileSync(join(queued, "state.json"), "utf8");
      lock = new Database(join(root, "relay-lock.sqlite")); lock.exec("BEGIN IMMEDIATE");
      child.kill("SIGTERM");
      expect(await Promise.race([child.exited, Bun.sleep(2000).then(() => "did not exit")])).toBe(0);
      expect(existsSync(failed)).toBe(false);
      expect(existsSync(join(queued, "started"))).toBe(false);
      expect(readFileSync(join(queued, "state.json"), "utf8")).toBe(state);
      expect(await until(() => gone(pid!) && gone(descendant!), 500)).toBe(true);
    } finally {
      if (lock) { lock.exec("ROLLBACK"); lock.close(); }
      if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
      if (pid && !gone(pid)) { try { process.kill(-pid, "SIGKILL"); } catch {} }
      if (descendant && !gone(descendant)) { try { process.kill(descendant, "SIGKILL"); } catch {} }
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 8000);
}

test("checks carry environment identity and retain their existing argv zero", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "watch-check-identity-"));
  try {
    const child = Bun.spawnSync([process.execPath, "-e", `
      const {normalize,runCheck}=await import(${JSON.stringify(join(import.meta.dir, "../src/lib.ts"))});
      const watcher=normalize({id:"identity",title:"Identity",mode:"notify",check:'printf "%s\\n" "$ROBOB_WATCH_CHECK" "$ROBOB_WATCH_TEST" "$0" > "$WATCH_DIR/identity"'});
      const rows=[];
      for(const extra of [{WATCH_RUN:"known-run"},{}]){
        const result=await runCheck(watcher,${JSON.stringify(sandbox)},extra);
        rows.push({code:result.code,lines:(await Bun.file(${JSON.stringify(join(sandbox, "identity"))}).text()).trim().split("\\n")});
      }
      console.log(JSON.stringify({pid:process.pid,rows}));
    `], { env: { ...process.env, BUN_INSPECT: undefined, ROBOB_TEST: "1", ROBOB_WATCH_ROOT: join(sandbox, "root"), TOOLLOG_DIR: join(sandbox, "logs") } });
    expect(child.stderr.toString()).toBe(""); expect(child.exitCode).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    expect(result.rows[0]).toEqual({ code: 0, lines: [`identity:known-run:${result.pid}`, "1", "/bin/zsh"] });
    expect(result.rows[1].code).toBe(0);
    expect(result.rows[1].lines[0]).toMatch(new RegExp(`^identity:[0-9a-f-]{36}:${result.pid}$`));
    expect(result.rows[1].lines.slice(1)).toEqual(["1", "/bin/zsh"]);
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});
