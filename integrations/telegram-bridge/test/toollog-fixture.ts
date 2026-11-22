import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flushToolErrors, type LogEntry } from "../src/toollog.ts";

export type FixtureEntry = Omit<LogEntry, "ids" | "props"> & {
  ts: string;
  tool: string;
  ids?: Record<string, string>;
  props?: Record<string, string | number | boolean | null>;
};

export function useToolLogFixture() {
  let directory: string;
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.TOOLLOG_DIR;
    directory = mkdtempSync(join(tmpdir(), "telegram-toollog-test-"));
    process.env.TOOLLOG_DIR = directory;
  });
  afterEach(() => {
    flushToolErrors(Date.now(), true);
    if (previous === undefined) delete process.env.TOOLLOG_DIR;
    else process.env.TOOLLOG_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  const text = () => readdirSync(directory).filter(file => file.endsWith(".ndjson")).sort()
    .map(file => readFileSync(join(directory, file), "utf8")).join("");
  return {
    flushErrors: () => flushToolErrors(Date.now(), true),
    directory: () => directory,
    text,
    entries: () => text().split("\n").filter(Boolean).map(line => JSON.parse(line) as FixtureEntry),
  };
}
