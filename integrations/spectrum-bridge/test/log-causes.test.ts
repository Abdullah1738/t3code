import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolLog, cardKind, logCardRender } from "../src/toollog.ts";
import { renderCounts } from "../src/log-render-store.ts";
import { captureLogs } from "./log-fixture.ts";
import { parseLocalCommand, runLocalCommand } from "../src/cli.ts";
import { bounded } from "../src/router.ts";
import { toolError } from "../src/toollog.ts";

const day = "2026-11-14";
const privateText = "+971501234567 /Users/private/PRIVATE.pdf https://private.test/?token=PRIVATE";

test("bounded timeout carries code.timeout through the log and rollup", async () => {
  const rows = await captureLogs(async () => {
    try { await bounded(new Promise<never>(() => {}), 0); }
    catch (error) {
      expect(error).toMatchObject({ name: "TimeoutError", code: "timeout" });
      toolError("router", "router.catch1", error);
    }
  });
  expect(rows.find(row => row.error?.tag === "router.catch1")?.error)
    .toMatchObject({ name: "TimeoutError", code: "timeout", causeKey: "code.timeout" });
});

test.each([false, true])("generic causes survive every sanitization pass, defer=%s", async defer => {
  const root = mkdtempSync(join(tmpdir(), "log-causes-"));
  try {
    const log = createToolLog({ root, defer, now: () => Date.parse(`${day}T12:00:00Z`) });
    const cases: [object, string][] = [
      [{ code: "ECONNRESET" }, "code.ECONNRESET"],
      [{ errno: -61 }, "errno.-61"],
      [{ cause: { code: "ENOENT" } }, "code.ENOENT"],
      [{ code: privateText, cause: { code: "ETIMEDOUT" } }, "code.ETIMEDOUT"],
      [{ status: 503 }, "http.5xx"],
      [{ code: "http_401:PRIVATE" }, "http.4xx"],
      [{ code: privateText, errno: privateText, causeKey: privateText }, "prompt_acceptance_probe"],
    ];
    for (const [metadata] of cases) log.write({ component: "router", kind: "error", name: "bridge.catch", site: "src/router.ts:994",
      error: { tag: "router.catch1", cause: Object.assign(new Error(privateText), metadata) } });
    log.write({ component: "router", kind: "error", name: "bridge.catch", error: { tag: "router.catch49", cause: privateText } });
    log.flush();
    const raw = readFileSync(join(root, `${day}.ndjson`), "utf8");
    const rows = raw.trim().split("\n").map(row => JSON.parse(row));
    expect(rows.slice(0, -1).map(row => row.error.causeKey)).toEqual(cases.map(([, key]) => key));
    expect(rows.at(-1).error.causeKey).toBe("background_watch");
    expect(rows[0].site).toBe("src/router.ts:994");
    const result = await log.rollup(day);
    expect(result?.topCauses).toHaveLength(cases.length + 1);
    for (const text of [raw, JSON.stringify(result)]) for (const secret of ["PRIVATE", "971501234567", "/Users/private", "https://private"]) expect(text).not.toContain(secret);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fast renders aggregate exactly; fallback, failed and slow renders retain context", async () => {
  const root = mkdtempSync(join(tmpdir(), "render-counts-"));
  let now = Date.parse(`${day}T12:00:00Z`);
  try {
    const log = createToolLog({ root, now: () => now });
    const write = (ok: boolean, durationMs: number, outcome: string, failureCode: string) => log.write({
      component: "delivery-renderer", kind: "perf", name: "card.render", durationMs, ok,
      ids: { chat: "owner" }, props: { cardKind: "delivery", outcome, failureCode, attempt: 1 },
    });
    for (let i = 0; i < 250; i++) write(true, 10, "ok", "none");
    write(false, 20, "fallback", "preview_missing");
    write(false, 30, "failed", "render_exception");
    write(true, 1_501, "ok", "none");
    now += 86400_000;
    write(true, 11, "ok", "none");
    log.flush();
    const rows = readFileSync(join(root, `${day}.ndjson`), "utf8").trim().split("\n").map(row => JSON.parse(row));
    expect(rows.filter(row => row.name === "card.render")).toHaveLength(3);
    expect(rows.filter(row => row.name === "card.renders")).toHaveLength(0);
    expect(renderCounts(root, day).count).toBe(250);
    const result = await log.rollup(day);
    expect(result?.byComponent["delivery-renderer"]["card.render"]).toMatchObject({ count: 253, ok: 251, failed: 2, durationMs: { p50: 10, max: 1501 } });
    expect(result?.cardRenderFailures).toEqual({ preview_missing: 1, render_exception: 1 });
    expect((await log.rollup("2026-11-15"))?.countsByName["card.render"]).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("renderer CLI logs enums and rejects private failure codes; chat is reduced before logging", async () => {
  const rows = await captureLogs(async () => {
    await runLocalCommand(parseLocalCommand(["log-card-render", "--kind", "delivery", "--ms", "22", "--ok", "false", "--chat", privateText,
      "--outcome", "fallback", "--failure-code", "preview_missing", "--attempt", "2"]));
    logCardRender("fixture", "ride", 1500, true, { chat: "moni" });
  });
  expect(rows[0]).toMatchObject({ ids: { chat: "other" }, ok: false, durationMs: 22,
    props: { cardKind: "delivery", outcome: "fallback", failureCode: "preview_missing", attempt: 2 } });
  expect(rows[1].ids?.chat).toBe("moni");
  expect(JSON.stringify(rows)).not.toContain("PRIVATE");
  for (const value of [privateText, "ECONNRESET", "PRIVATE_TOKEN"]) expect(() => parseLocalCommand([
    "log-card-render", "--kind", "delivery", "--ms", "1", "--ok", "false", "--failure-code", value,
  ])).toThrow();
  for (const [value, kind] of [["delivery-PRIVATE", "delivery"], ["q-PRIVATE", "quick"], ["ride-PRIVATE", "ride"], ["secret-PRIVATE", "secure_form"], ["https://forms.test/_secret/PRIVATE", "secure_form"]]) expect(cardKind(value)).toBe(kind);
});


test.each(["turn.end", "bridge.stop"])("%s drains fast render counts before automatic rollups or shutdown", async name => {
  const root = mkdtempSync(join(tmpdir(), "render-stop-"));
  try {
    const log = createToolLog({ root, defer: true, now: () => Date.parse(`${day}T12:00:00Z`) });
    log.write({ component: "cards", kind: "perf", name: "card.render", ok: true, durationMs: 8,
      props: { cardKind: "quick", outcome: "ok" } });
    log.write({ component: "router", kind: "event", name });
    await log.settled();
    const rows = readFileSync(join(root, `${day}.ndjson`), "utf8").trim().split("\n").map(row => JSON.parse(row));
    expect(rows[0].name).toBe(name);
    expect(renderCounts(root, day).count).toBe(1);
    if (name === "turn.end") expect(JSON.parse(readFileSync(join(root, `rollup-${day}.json`), "utf8")).countsByName["card.render"]).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fresh short-lived writers cannot bypass the cap with singleton success summaries", () => {
  const root = mkdtempSync(join(tmpdir(), "render-cap-"));
  try {
    createToolLog({ root, now: () => Date.parse(`${day}T12:00:00Z`) }).write({ component: "fixture", kind: "event", name: "fixture.start" });
    for (let i = 0; i < 3; i++) {
      const log = createToolLog({ root, capBytes: 1, now: () => Date.parse(`${day}T12:00:00Z`) });
      for (const [ok, durationMs] of [[true, 8], [false, 8], [true, 1501]] as const) log.write({
        component: "quick-renderer", kind: "perf", name: "card.render", ok, durationMs,
        props: { cardKind: "quick", outcome: ok ? "ok" : "failed", failureCode: ok ? "none" : "render_exception", attempt: 1 },
      });
      log.flush();
    }
    const rows = readFileSync(join(root, `${day}.ndjson`), "utf8").trim().split("\n").map(row => JSON.parse(row));
    expect(rows.filter(row => row.name === "card.renders")).toHaveLength(0);
    expect(rows.filter(row => row.name === "card.render")).toHaveLength(6);
    expect(rows.filter(row => row.name === "log.degraded")).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
