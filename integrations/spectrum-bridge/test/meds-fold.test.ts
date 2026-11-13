import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { appendFold, foldMedsLine } from "../src/meds-fold.ts";
import { fakeFold, LINE } from "./meds-fold-fixture.ts";

const fixtures: ReturnType<typeof fakeFold>[] = [];
const fixture = (body?: string) => { const f = fakeFold(body); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0).reverse()) f.close(); });

test("appendFold adds the trimmed line to only the last text without mutating input", () => {
  const texts = ["first", "last"];
  expect(appendFold(texts, ` ${LINE}\n`)).toEqual(["first", `last\n\n${LINE}`]);
  expect(texts).toEqual(["first", "last"]);
  expect(appendFold(texts, "")).toBe(texts);
  expect(appendFold([], LINE)).toEqual([]);
});

test("line and logs carry counts and timing without health text", async () => {
  const f = fixture();
  const result = await foldMedsLine({ ...f.options, replyMode: "tool" });
  await Promise.resolve();
  expect(result).toMatchObject({ outcome: "appended", line: LINE });
  const logs = f.logs().filter(log => log.component === "meds-fold");
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({ name: "meds.fold.appended", props: { labels: 2, replyMode: "tool" } });
  expect(logs[0].durationMs).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(logs)).not.toContain("Test A");
});

test.each([
  ["empty", "", "empty"],
  ["exit", "process.exit(1)", "error"],
  ["junk", "console.log('PRIVATE HEALTH DATA')", "error"],
] as const)("%s leaves text unchanged and logs its outcome", async (_name, body, outcome) => {
  const f = fixture(body);
  const result = await foldMedsLine(f.options);
  expect(result.outcome).toBe(outcome);
  expect(appendFold(["reply"], result.line)).toEqual(["reply"]);
  await Promise.resolve();
  expect(f.logs().filter(log => log.name === `meds.fold.${outcome}`)).toHaveLength(1);
  expect(JSON.stringify(f.logs())).not.toContain("PRIVATE HEALTH DATA");
});

test("spawn errors fail open", async () => {
  const f = fixture();
  expect((await foldMedsLine({ ...f.options, cmd: ["/nonexistent/meds-fold-test"] })).outcome).toBe("error");
  expect(f.calls()).toBe(0);
});

test.each([
  ["Test A", 1], ["Test A, Test B", 2], ["Test A (note, detail), Test B", 2],
  ["Test A (note, more, detail), Test B (other, note)", 2],
  ["Test A (outer (inner, detail), note), Test B", 2],
] as const)("label boundaries: %s", async (labels, count) => {
  const f = fixture(`console.log(${JSON.stringify(`💊 Still need: ${labels}. Text me when done.`)})`);
  await foldMedsLine(f.options);
  await Promise.resolve();
  expect(f.logs().find(log => log.name === "meds.fold.appended")?.props.labels).toBe(count);
});

test("default 2 s deadline kills its own child and returns unchanged within 2.5 s", async () => {
  const f = fixture(`await Bun.sleep(5000); console.log(${JSON.stringify(LINE)})`);
  const start = performance.now();
  const result = await foldMedsLine(f.options);
  expect(result.outcome).toBe("timeout");
  expect(performance.now() - start).toBeLessThan(2500);
  expect(appendFold(["reply"], result.line)).toEqual(["reply"]);
  const pid = Number(readFileSync(f.pid, "utf8"));
  // A process exit notification, rather than a timing delay, confirms SIGKILL was reaped.
  await Bun.spawn([process.execPath, "-e", `try { process.kill(${pid}, 0); process.exit(1); } catch {}`], { stdout: "ignore", stderr: "ignore" }).exited.then(code => expect(code).toBe(0));
  expect(f.logs().some(log => log.name === "meds.fold.timeout")).toBe(true);
});

test("strips inherited and overridden WATCH_DIR/MEDS_NOW; argv keeps --fold first", async () => {
  const f = fixture(`if (process.env.WATCH_DIR || process.env.MEDS_NOW || process.argv[2] !== '--fold') process.exit(1); console.log(${JSON.stringify(LINE)})`);
  const previous = { WATCH_DIR: process.env.WATCH_DIR, MEDS_NOW: process.env.MEDS_NOW };
  try {
    process.env.WATCH_DIR = "private-override"; process.env.MEDS_NOW = "private-now";
    const result = await foldMedsLine({ ...f.options, cmd: [...f.options.cmd!, "--fold"], env: { WATCH_DIR: "other", MEDS_NOW: "other" } });
    expect(result.outcome).toBe("appended");
  } finally {
    for (const key of ["WATCH_DIR", "MEDS_NOW"] as const) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});
