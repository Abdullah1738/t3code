import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { recordRenderCounts, renderCounts } from "../src/log-render-store.ts";
import { createToolLog } from "../src/toollog.ts";

const day = new Date().toISOString().slice(0, 10);
const dirs: string[] = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), "render-store-")); dirs.push(root); return root; };
const line = { ts: `${day}T12:00:00Z`, tool: "imessage", component: "delivery-renderer", kind: "perf", name: "card.renders",
  props: { cardKind: "delivery" }, renders: { count: 1, histogram: [[7, 1]] } } as const;
function seed(root: string) {
  recordRenderCounts(root, { ...line, renders: { count: 1, histogram: [[7, 1]] } });
}
afterEach(() => dirs.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

test("only a missing counter file reads as zero", () => {
  const root = temp();
  expect(renderCounts(root, day)).toEqual({ count: 0, lines: [] });
  expect(renderCounts(join(root, "missing"), day)).toEqual({ count: 0, lines: [] });
  expect(() => renderCounts(root, "invalid")).toThrow("Invalid render counter day");
});

test.each(["corrupt", "empty", "directory", "symlink", "hardlink"])("%s counters report an error instead of zero", shape => {
  const root = temp();
  const path = join(root, `renders-${day}.sqlite`);
  if (shape === "corrupt" || shape === "empty") writeFileSync(path, shape === "corrupt" ? "PRIVATE +971501234567 https://private.test" : "");
  else if (shape === "directory") mkdirSync(path);
  else {
    const target = join(root, "private-target");
    writeFileSync(target, "PRIVATE");
    if (shape === "symlink") symlinkSync(target, path);
    else linkSync(target, path);
  }
  expect(() => renderCounts(root, day)).toThrow();
});

test("an exclusive writer cannot make a reader silently report zero", () => {
  const root = temp();
  seed(root);
  const lock = new Database(join(root, `renders-${day}.sqlite`));
  try {
    lock.exec("BEGIN EXCLUSIVE");
    expect(() => renderCounts(root, day)).toThrow("database is locked");
  } finally { lock.exec("ROLLBACK"); lock.close(); }
  expect(renderCounts(root, day).count).toBe(1);
});

test("a failed counter commit cannot acknowledge a successful CLI log", () => {
  const root = temp();
  seed(root);
  const lock = new Database(join(root, `renders-${day}.sqlite`));
  try {
    lock.exec("BEGIN EXCLUSIVE");
    const child = Bun.spawnSync([process.execPath, "src/cli.ts", "log-card-render", "--kind", "delivery", "--ms", "7", "--ok", "true"], {
      cwd: resolve(import.meta.dir, ".."), env: { PATH: process.env.PATH, HOME: root, TOOLLOG_DIR: root, NODE_ENV: "test" }, stdout: "pipe", stderr: "pipe",
    });
    expect(child.exitCode).toBe(1);
    expect(child.stdout.toString()).toBe("");
    expect(JSON.parse(child.stderr.toString())).toEqual({ error: "Render log unavailable" });
  } finally { lock.exec("ROLLBACK"); lock.close(); }
  expect(renderCounts(root, day).count).toBe(1);
});

test("rollups keep their cache and report reduced diagnostics when counters are corrupt", async () => {
  const root = temp();
  seed(root);
  const log = createToolLog({ root, now: () => Date.parse(`${day}T12:00:00Z`) });
  expect((await log.rollup(day))?.renderSourceCount).toBe(1);
  const cache = readFileSync(join(root, `rollup-${day}.json`), "utf8");
  writeFileSync(join(root, `renders-${day}.sqlite`), "PRIVATE +971501234567 https://private.test");
  expect(await log.rollup(day)).toBeUndefined();
  await log.tick();
  log.flush();
  expect(readFileSync(join(root, `rollup-${day}.json`), "utf8")).toBe(cache);
  const raw = readFileSync(join(root, `${day}.ndjson`), "utf8");
  const errors = raw.trim().split("\n").map(row => JSON.parse(row)).filter(row => row.error?.tag === "render.counters.read");
  expect(errors).toHaveLength(2);
  for (const sentinel of ["PRIVATE", "971501234567", "https://private"]) expect(raw).not.toContain(sentinel);
});
