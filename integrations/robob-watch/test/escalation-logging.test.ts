import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);

test.each([
  { name: "wake succeeds", wakeCode: 0, sendCode: 0, ok: true, via: "wake", spawnFails: false },
  { name: "wake fails and fallback succeeds", wakeCode: 1, sendCode: 0, ok: true, via: "imessage-send", spawnFails: false },
  { name: "wake and fallback fail", wakeCode: 1, sendCode: 1, ok: false, via: "none", spawnFails: false },
  { name: "bridge helper cannot start", wakeCode: 0, sendCode: 0, ok: false, via: "none", spawnFails: true },
])("failure escalation logs delivery when $name", ({ wakeCode, sendCode, ok, via, spawnFails }) => {
  const home = mkdtempSync(join(tmpdir(), "escalation-log-"));
  try {
    mkdirSync(join(home, ".bun/bin"), { recursive: true });
    if (spawnFails) writeFileSync(join(home, ".bun/bin/bun"), "unexecutable fixture", { mode: 0o600 });
    else symlinkSync(process.execPath, join(home, ".bun/bin/bun"));
    const dbPath = join(home, "bridge.sqlite");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT); INSERT INTO kv VALUES ('route', '{\"id\":\"ses_fixture\"}')");
    db.close();
    const stub = join(home, "spectrum.ts");
    const capture = join(home, "calls.jsonl");
    writeFileSync(stub, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2))+"\\n"); console.log("PRIVATE_BRIDGE_OUTPUT"); process.exit(process.argv[2] === "wake" ? ${wakeCode} : ${sendCode});`);
    const key = "PRIVATE_ESCALATION_KEY";
    const program = `const { escalate, normalize, saveState, watcherDir } = await import(${JSON.stringify(join(import.meta.dir, "../src/lib.ts"))});
      const {mkdirSync,writeFileSync}=await import('node:fs');
      const watcher = normalize({ id: "escalation-fixture", title: "PRIVATE_TITLE", check: "true", context: "PRIVATE_CONTEXT", mode: "wake", chat: "another-chat" });
      const state = { status: "active", fires: 0, consecutive_failures: 5, failure_alerted: true,
        failing_since: new Date(Date.now() - 16 * 60000).toISOString(), last_error: 'exit 1: source failure: {"outlook": "PRIVATE_CHECK_ERROR"}' };
      mkdirSync(watcherDir(watcher.id),{recursive:true});
      writeFileSync(watcherDir(watcher.id)+'/watcher.json',JSON.stringify(watcher));saveState(watcher.id,state);
      try { console.log(JSON.stringify(await escalate(watcher, state, ${JSON.stringify(key)}))); }
      catch { console.log(JSON.stringify({ error: true })); }`;
    const logs = join(home, "logs");
    const child = Bun.spawnSync([process.execPath, "-e", program], { env: {
      HOME: home, PATH: "/usr/bin:/bin", ROBOB_TEST: "1", TOOLLOG_DIR: logs,
      ROBOB_WATCH_ROOT: join(home, 'watchers-root'),
      ROBOB_WATCH_SPECTRUM_CLI: stub, ROBOB_WATCH_BRIDGE_DB: dbPath,
    } });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toMatchObject({ ok, via });
    if (!spawnFails) {
      const calls = readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]).filter(args => args[0] !== "wake-status");
      expect(calls).toHaveLength(wakeCode ? 2 : 1);
      for (const args of calls) {
        const text = args.find(arg => arg.startsWith("--text="))!.slice(7);
        expect(text).toContain("failing sources: outlook");
        expect(text).not.toContain("blind");
      }
    }
    const raw = readdirSync(logs).filter(name => name.endsWith(".ndjson")).map(name => readFileSync(join(logs, name), "utf8")).join("");
    const rows = raw.trim().split("\n").map(line => JSON.parse(line));
    const sent = rows.filter(row => row.name === "wake.sent");
    expect(sent).toHaveLength(1);
    const inbound = "wake:" + createHash("sha256").update(key).digest("hex");
    expect(sent[0]).toMatchObject({ tool: "watchers", component: "wakes", kind: ok ? "perf" : "error", ok,
      ids: { watcher: "escalation-fixture", chat: digest("owner"), key: digest(inbound) } });
    expect(sent[0].durationMs).toBeGreaterThanOrEqual(0);
    if (!ok) expect(sent[0].error).toEqual({ tag: "wake.delivery_failed", message: "wake.delivery_failed" });
    expect(raw).not.toContain("PRIVATE");
    expect(raw).not.toContain("another-chat");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
