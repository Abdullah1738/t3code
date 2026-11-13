import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("watcher failure alerts share a stable burst key across episodes; ordinary notices stay immediate", () => {
  const home = mkdtempSync(join(tmpdir(), "watcher-burst-"));
  try {
    mkdirSync(join(home, ".bun/bin"), { recursive: true });
    symlinkSync(process.execPath, join(home, ".bun/bin/bun"));
    const capture = join(home, "calls.jsonl");
    const stub = join(home, "telegram.ts");
    writeFileSync(stub, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2))+'\\n');`);
    const code = `const { alert } = await import(${JSON.stringify(join(import.meta.dir, "../src/lib.ts"))});
      const watcher = { id: 'health', title: 'Health' };
      for (const key of ['episode-1', 'episode-2']) {
        const result = await alert(watcher, 'check failed', key, 'error');
        if (!result.ok) throw new Error(result.detail);
      }
      const result = await alert(watcher, 'expired', 'expiry');
      if (!result.ok) throw new Error(result.detail);`;
    const child = Bun.spawnSync([process.execPath, "-e", code], { env: {
      HOME: home, PATH: "/usr/bin:/bin", ROBOB_TEST: "1", ROBOB_WATCH_TELEGRAM_CLI: stub,
    } });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const calls = readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.slice(-2)).toEqual(["--burst-key", "watcher-failure:health"]);
    expect(calls[1]!.slice(-2)).toEqual(["--burst-key", "watcher-failure:health"]);
    expect(calls[2]).not.toContain("--burst-key");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
