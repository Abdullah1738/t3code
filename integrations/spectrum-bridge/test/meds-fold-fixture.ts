import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FoldOptions } from "../src/meds-fold.ts";

export const LINE = "💊 Still need: Test A, Test B. Text me when done.";
export const HOLD_FOLD = `import { watch, existsSync } from 'node:fs';
  import { dirname } from 'node:path';
  await new Promise(resolve => {
    const gate = process.env.FOLD_GATE;
    const watcher = watch(dirname(gate), () => { if (existsSync(gate)) { watcher.close(); resolve(); } });
    if (existsSync(gate)) { watcher.close(); resolve(); }
  }); console.log(${JSON.stringify(LINE)});`;
export function fakeFold(body = `console.log(${JSON.stringify(LINE)})`) {
  const root = mkdtempSync(join(tmpdir(), "meds-fold-"));
  const marker = join(root, "calls");
  const pid = join(root, "pid");
  const script = join(root, "hook.ts");
  writeFileSync(script, `import { appendFileSync, writeFileSync } from 'node:fs';
    appendFileSync(${JSON.stringify(marker)}, 'run\\n');
    writeFileSync(${JSON.stringify(pid)}, String(process.pid));
    ${body}`);
  const gate = join(root, "release");
  const options: FoldOptions = { cmd: [process.execPath, script], env: { FOLD_GATE: gate } };
  const previousLog = process.env.TOOLLOG_DIR;
  process.env.TOOLLOG_DIR = join(root, "logs");
  return {
    options, pid, root,
    started: () => new Promise<void>(resolve => {
      const watcher = watch(root, () => { if (existsSync(marker)) { watcher.close(); resolve(); } });
      if (existsSync(marker)) { watcher.close(); resolve(); }
    }),
    release: () => writeFileSync(gate, "go"),
    calls: () => { try { return readFileSync(marker, "utf8").trim().split("\n").length; } catch { return 0; } },
    logs: () => {
      try { return readdirSync(join(root, "logs")).filter(file => file.endsWith(".ndjson"))
        .flatMap(file => readFileSync(join(root, "logs", file), "utf8").trim().split("\n").map(line => JSON.parse(line))); }
      catch { return []; }
    },
    close: () => {
      if (previousLog === undefined) delete process.env.TOOLLOG_DIR;
      else process.env.TOOLLOG_DIR = previousLog;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
