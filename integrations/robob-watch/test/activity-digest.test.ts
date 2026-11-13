import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clip, MAX_WAKE, normalize, wakeText } from "../src/lib.ts";

const dir = mkdtempSync(join(tmpdir(), "activity-digest-unicode-"));
const source = join(import.meta.dir, "../watchers/activity-digest/summarize.py");
const watcher = normalize({ id: "activity-digest", title: "Activity digest", check: "true", mode: "wake", context: "Read the digest." });
const state = { status: "active" as const, fires: 0, consecutive_failures: 0, failure_alerted: false };

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function summarize(name: string, raw: string) {
  const path = join(dir, `${name}.md`);
  const result = Bun.spawnSync(["/usr/bin/python3", source, path], { stdin: new TextEncoder().encode(raw) });
  expect(result.exitCode).toBe(0);
  const output = result.stdout.toString();
  const saved = readFileSync(path, "utf8");
  // Use both production clipping boundaries, including JavaScript string length.
  const delivered = clip(wakeText(watcher, output, state), MAX_WAKE);
  return { path, output, saved, delivered };
}

const cases = [
  ["ascii", "x".repeat(400), true],
  ["bmp", "\u754c".repeat(400), true],
  ["supplementary", "\u{1f680}".repeat(400), false],
  ["combining", "e\u0301".repeat(200), true],
  ["zwj", "\u{1f469}\u200d\u{1f4bb}".repeat(80), true],
  ["mixed", "A\u{1f680}".repeat(200), false],
] as const;

for (const [name, body, inline] of cases) {
  test(`digest preserves every counted item through runner clipping: ${name}`, () => {
    const raw = Array.from({ length: 10 }, (_, i) => `- 2026-11-10 10:17 · source${i % 2} · item-${i} ${body}`).join("\n");
    const result = summarize(name, raw);
    expect(result.saved).toContain("Activity log: 10 unreported entries");
    expect(result.saved.match(/^- /gm)).toHaveLength(10);
    for (const group of result.saved.split(/^## /m).slice(1)) {
      const count = Number(/^source\d \((\d+)\)/.exec(group)![1]);
      expect(group.match(/^- /gm)).toHaveLength(count);
    }
    if (inline) {
      expect(result.output).toBe(result.saved);
      expect(result.delivered).toContain("Activity log: 10 unreported entries");
      expect(result.delivered.match(/^- /gm)).toHaveLength(10);
      for (let i = 0; i < 10; i++) expect(result.delivered).toContain(`item-${i} `);
    } else {
      expect(result.saved.length).toBeGreaterThan(6000);
      expect(result.output).toBe(`Activity digest: ${result.path}\n`);
      expect(result.delivered).toContain(result.path);
      expect(result.delivered).not.toContain("Activity log:");
      for (let i = 0; i < 10; i++) expect(result.saved).toContain(`item-${i} `);
    }
    expect(result.delivered).not.toContain("...[truncated]");
  });
}

for (const units of [5500, 5501]) {
  test(`digest uses UTF-16 units at the inline budget boundary: ${units}`, () => {
    const raw = "- 2026-11-10 10:17 · noon · item ";
    const base = summarize(`base-${units}`, raw);
    const padding = units - base.saved.length;
    const result = summarize(`boundary-${units}`, raw + "\u{1f680}".repeat(Math.floor(padding / 2)) + "x".repeat(padding % 2));
    expect(result.saved.length).toBe(units);
    if (units === 5500) {
      expect(result.output).toBe(result.saved);
      expect(result.delivered.match(/^- /gm)).toHaveLength(1);
    } else {
      expect(result.output).toBe(`Activity digest: ${result.path}\n`);
      expect(result.delivered).toContain(result.path);
    }
    expect(result.delivered).not.toContain("...[truncated]");
  });
}
