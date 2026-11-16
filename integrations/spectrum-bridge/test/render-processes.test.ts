import { expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createToolLog } from "../src/toollog.ts";
import { renderCounts } from "../src/log-render-store.ts";

const day = () => new Date().toISOString().slice(0, 10);
async function cli(root: string, extra: string[] = [], logged = true) {
  const { BUN_INSPECT, ...env } = process.env;
  const values = new Map([["--kind", "delivery"], ["--chat", "owner"], ["--ms", "7"], ["--ok", "true"]]);
  for (let i = 0; i < extra.length; i += 2) values.set(extra[i]!, extra[i + 1]!);
  const child = Bun.spawn([process.execPath, "src/cli.ts", "log-card-render", ...[...values].flat()], {
    cwd: resolve(import.meta.dir, ".."), env: { ...env, NODE_ENV: "test", TOOLLOG_DIR: root }, stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (logged) {
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({ logged: true });
  } else {
    expect({ code, stdout }).toEqual({ code: 1, stdout: "" });
    expect(JSON.parse(stderr)).toEqual({ error: "Render log unavailable" });
  }
}
function rows(root: string) {
  return readdirSync(root).filter(file => file.endsWith(".ndjson")).flatMap(file =>
    readFileSync(join(root, file), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)));
}

test("independent renderer CLIs share exact counters, retain only failed/slow rows, and refresh both rollup readers", async () => {
  const parent = mkdtempSync(join(tmpdir(), "render-processes-"));
  const root = join(parent, "imessage");
  const date = day();
  try {
    // These are three fresh Bun runtimes, matching the Python renderers' logging path.
    for (let i = 0; i < 3; i++) await cli(root);
    expect(rows(root)).toEqual([]);
    expect(renderCounts(root, date)).toMatchObject({ count: 3,
      lines: [{ component: "delivery-renderer", ids: { chat: "owner" }, renders: { count: 3, histogram: [[7, 3]] } }] });
    let now = Date.now();
    const log = createToolLog({ root, now: () => now });
    expect((await log.rollup(date))?.countsByName["card.render"]).toBe(3);
    const rawBytes = statSync(join(root, `${date}.ndjson`)).size;
    await Promise.all(Array.from({ length: 8 }, () => cli(root)));
    expect(statSync(join(root, `${date}.ndjson`)).size).toBe(rawBytes);
    now += 3_600_000;
    await log.tick();
    const cached = JSON.parse(readFileSync(join(root, `rollup-${date}.json`), "utf8"));
    expect(cached.countsByName["card.render"]).toBe(11);
    expect(cached.renderSourceCount).toBe(11);
    expect(cached.recordedRows).toBe(0);
    await cli(root, ["--ok", "false", "--outcome", "fallback", "--failure-code", "preview_missing"]);
    await cli(root, ["--ms", "1501"]);
    const privateValue = "+971501234567 /private/PRIVATE https://private.test/?token=PRIVATE";
    await cli(root, ["--chat", privateValue]);
    expect(rows(root).filter(row => row.name === "card.render")).toHaveLength(2);
    expect(JSON.stringify(rows(root)) + JSON.stringify(renderCounts(root, date))).not.toContain("PRIVATE");
    expect(renderCounts(root, date).count).toBe(12);
    const stored = readFileSync(join(root, `renders-${date}.sqlite`));
    for (const sentinel of ["PRIVATE", "971501234567", "https://private"]) expect(stored.includes(Buffer.from(sentinel))).toBe(false);
    const rollup = await log.rollup(date);
    expect(rollup?.byComponent["delivery-renderer"]["card.render"]).toMatchObject({ count: 14, ok: 13, failed: 1 });
    expect(rollup?.cardRenderFailures).toEqual({ preview_missing: 1 });
    const reader = Bun.spawn(["python3", "-I", "-c", "import sys,json; sys.path.insert(0,sys.argv[1]); import toollog; print(json.dumps(toollog.rollup('imessage',sys.argv[2])))",
      resolve(import.meta.dir, "../../local-helpers/libexec/toollog"), date], {
      env: { ...process.env, TOOLLOG_ROOT: parent }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout] = await Promise.all([reader.exited, new Response(reader.stdout).text()]);
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.byComponent["delivery-renderer"]["card.render"]).toMatchObject({ count: 14, ok: 13, failed: 1 });
    expect(result.recordedRows).toBe(2);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, `renders-${date}.sqlite`)).mode & 0o777).toBe(0o600);
  } finally { rmSync(parent, { recursive: true, force: true }); }
}, 20_000);

test("counter files are retained for 30 days and symlinks cannot redirect writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "render-retention-"));
  try {
    const old = "2000-01-01";
    writeFileSync(join(root, `renders-${old}.sqlite`), "fixture");
    const target = join(root, "private-target");
    writeFileSync(target, "PRIVATE");
    symlinkSync(target, join(root, `renders-${day()}.sqlite`));
    await cli(root, [], false);
    expect(readFileSync(target, "utf8")).toBe("PRIVATE");
    expect(readdirSync(root)).not.toContain(`renders-${old}.sqlite`);
    expect(rows(root)).toMatchObject([{ component: "logger", error: { tag: "render.counters.write" } }, { component: "cli" }]);
    expect(JSON.stringify(rows(root))).not.toContain("PRIVATE");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("local log command commits counters before returning its acknowledgement", async () => {
  const root = mkdtempSync(join(tmpdir(), "render-ack-"));
  const { BUN_INSPECT, ...env } = process.env;
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { runLocalCommand } from "./src/cli.ts";
      import { renderCounts } from "./src/log-render-store.ts";
      const result = await runLocalCommand({ command: "log-card-render", kind: "delivery", durationMs: 7, ok: true });
      console.log(JSON.stringify({ result, count: renderCounts(process.env.TOOLLOG_DIR, new Date().toISOString().slice(0, 10)).count }));
    `], { cwd: resolve(import.meta.dir, ".."), env: { ...env, TOOLLOG_DIR: root, NODE_ENV: "test" }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({ result: { logged: true }, count: 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.each([true, false].flatMap(ok => ["ok", "fallback", "failed"].flatMap(outcome => [7, 1501].map(ms => ({ ok, outcome, ms })))))
  ("capped render acknowledgement matches retention: ok=$ok outcome=$outcome ms=$ms", async ({ ok, outcome, ms }) => {
    const root = mkdtempSync(join(tmpdir(), "render-cap-"));
    const path = join(root, `${day()}.ndjson`);
    const cap = 50 * 1024 * 1024;
    const retained = !ok || ms > 1000;
    try {
      writeFileSync(path, "");
      truncateSync(path, cap);
      await cli(root, ["--ok", String(ok), "--outcome", outcome, "--ms", String(ms)], retained);
      const tail = Buffer.alloc(statSync(path).size - cap);
      const fd = openSync(path, "r");
      try { expect(readSync(fd, tail, 0, tail.length, cap)).toBe(tail.length); }
      finally { closeSync(fd); }
      const names = tail.toString().trim().split("\n").map(row => JSON.parse(row).name);
      expect(names).toEqual(retained ? ["log.degraded", "card.render"] : ["log.degraded", "bridge.catch"]);
      expect(renderCounts(root, day()).count).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
