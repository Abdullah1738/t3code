import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolLog, type LogLine } from "../src/toollog.ts";

export async function captureLogs(action: () => Promise<void>): Promise<LogLine[]> {
  const previous = process.env.TOOLLOG_DIR;
  // settled() waits for rollups, but call aggregation needs an explicit flush.
  toolLog.flush();
  await toolLog.settled();
  const root = mkdtempSync(join(tmpdir(), "imessage-log-fixture-"));
  process.env.TOOLLOG_DIR = root;
  try {
    await action();
    toolLog.flush();
    await toolLog.settled();
    const lines = readdirSync(root).filter(file => file.endsWith(".ndjson")).flatMap(file =>
      readFileSync(join(root, file), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as LogLine));
    if (process.env.TOOLLOG_SAMPLE_FILE) appendFileSync(process.env.TOOLLOG_SAMPLE_FILE, lines.map(line => JSON.stringify(line) + "\n").join(""));
    return lines;
  } finally {
    toolLog.flush();
    await toolLog.settled();
    if (previous === undefined) delete process.env.TOOLLOG_DIR; else process.env.TOOLLOG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}
