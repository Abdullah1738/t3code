import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseCommand } from "../../telegram-bridge/src/cli.ts";
import { notify } from "../checks/robob-stall/check.mjs";

test("shared watcher sends preserve dash-prefixed values through the bridge parsers", () => {
  const home = mkdtempSync(join(tmpdir(), "watcher-notifier-args-"));
  try {
    mkdirSync(join(home, ".bun/bin"), { recursive: true });
    symlinkSync(process.execPath, join(home, ".bun/bin/bun"));
    const calls = join(home, "calls.ndjson");
    const stub = (bridge: string) => {
      const file = join(home, `${bridge}.ts`);
      writeFileSync(file, `import { parseCommand } from ${JSON.stringify(resolve(import.meta.dir, "../..", bridge, "src/cli.ts"))};
        import { appendFileSync } from 'node:fs';
        appendFileSync(${JSON.stringify(calls)}, JSON.stringify(parseCommand(process.argv.slice(2))) + '\\n');`);
      return file;
    };
    const db = join(home, "bridge.sqlite");
    const connection = new Database(db);
    connection.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO kv VALUES ('route', '{"id":"fixture-session","generation":1}');`);
    connection.close();
    const code = `const { wake, wakeChat, imessage, telegram } = await import(${JSON.stringify(resolve(import.meta.dir, "../src/lib.ts"))});
      for (const text of ['-', '--', '- notice', '--key=mail text', '- first\\n-- second=value']) {
        for (const result of [await wake('--source', text, '--key'), await wakeChat('moni', '--source', text, '--key'),
          await imessage(text, '--key'), await telegram('--source', text, '--key', 'attention', '--burst')]) {
          if (!result.ok) throw new Error(result.out);
        }
      }`;
    const result = Bun.spawnSync([process.execPath, "-e", code], { env: {
      HOME: home, PATH: process.env.PATH, ROBOB_TEST: "1", TOOLLOG_DIR: join(home, "logs"),
      ROBOB_WATCH_BRIDGE_DB: db, ROBOB_WATCH_SPECTRUM_CLI: stub("spectrum-bridge"),
      ROBOB_WATCH_TELEGRAM_CLI: stub("telegram-bridge"),
    } });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const delivered = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(delivered.map(command => command.body.text)).toEqual(
      ["-", "--", "- notice", "--key=mail text", "- first\n-- second=value"].flatMap(text => Array(4).fill(text)),
    );
    for (const command of delivered.filter(command => command.path === "/notify")) {
      expect(command.body.dedupeKey).toBe("--key");
      expect(command.body.burstKey).toBe("--burst");
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("stall notices pass dash-prefixed summaries to the real Telegram parser", () => {
  const text = "-- severe stall\n- details";
  notify({ text, key: "--stall", kind: "alert" }, (_bin, args) => {
    expect(parseCommand(args.slice(1)).body?.text).toBe(text);
    return JSON.stringify({ id: `notify:${"a".repeat(64)}`, created: true });
  });
});
