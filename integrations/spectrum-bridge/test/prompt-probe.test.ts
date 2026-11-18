import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bounded, BoundedTimeout } from "../src/bounded.ts";
import { ControlError } from "../src/control.ts";
import { PromptProbeTracker } from "../src/prompt-probe.ts";
import { createToolLog, type LogLine } from "../src/toollog.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function setup(defer = false) {
  const root = mkdtempSync(join(tmpdir(), "probe-log-")); roots.push(root);
  let wall = Date.parse("2026-11-15T12:00:00Z"), clock = 0;
  const log = createToolLog({ root, now: () => wall, defer });
  const tracker = new PromptProbeTracker(log.write, () => wall, () => clock);
  return { log, tracker, advance: (ms: number) => { wall += ms; clock += ms; },
    lines: (flush = true) => { if (flush) log.flush(); return readFileSync(join(root, "2026-11-15.ndjson"), "utf8").trim().split("\n").map(l => JSON.parse(l) as LogLine); } };
}

test("bridge.stop drains the current minute without a test-side flush", async () => {
  const h = setup(true);
  h.tracker.start("thread-fixture", "prompt-a", Date.parse("2026-11-15T12:00:00Z")).complete(true);
  h.log.write({ component: "process", kind: "event", name: "bridge.stop" });
  await h.log.settled();
  expect(h.lines(false).filter(row => row.name === "router.prompt_probes")).toHaveLength(1);
  expect(h.lines(false).find(row => row.promptProbe)?.promptProbe).toMatchObject({ calls: 1, accepted: 1 });
});

test("an acceptance later than 24h still retains every outcome", async () => {
  const h = setup();
  h.tracker.start("thread-fixture", "prompt-a", Date.parse("2026-11-13T12:00:00Z")).complete(true);
  expect((await h.log.rollup("2026-11-15"))?.promptProbe).toMatchObject({ calls: 1, accepted: 1,
    msUntilAccepted: { count: 1, max: 172_800_000 } });
});

test("a sibling bounded timeout retains its existing cause bucket", async () => {
  const h = setup();
  h.log.write({ component: "router", kind: "error", name: "bridge.catch", ok: false,
    error: { tag: "router.catch49", cause: new BoundedTimeout(10_000) } });
  expect(h.lines()[0].error).toMatchObject({ name: "BoundedTimeout", code: "timeout", causeKey: "code.timeout" });
  const result = await h.log.rollup("2026-11-15");
  expect(result?.topCauses).toContainEqual({ tag: "router.catch49", causeKey: "code.timeout", count: 1 });
  expect(result?.countsByKind.error).toBe(1);
});

test("first accepted probe reports one sample with its send-to-acceptance time", () => {
  const h = setup();
  const probe = h.tracker.start("thread-fixture", "PRIVATE_PROMPT_ID", Date.parse("2026-11-15T11:59:59Z"));
  h.advance(25); probe.complete(true);
  const [row] = h.lines();
  expect(row.name).toBe("router.prompt_probes");
  expect(row.ids?.threadId).toBe("thread-fixture");
  expect(row.promptProbe).toMatchObject({ calls: 1, accepted: 1, notAcceptedYet: 0, attempts: [[1, 1]], msUntilAccepted: [[1025, 1]], elapsedMs: [[25, 1]] });
  expect(JSON.stringify(row)).not.toContain("PRIVATE_PROMPT_ID");
});

test("false then accepted has no catch and records two attempts, across a minute boundary", async () => {
  const h = setup(), sentAt = Date.parse("2026-11-15T12:00:00Z");
  h.tracker.start("thread-fixture", "prompt-a", sentAt).complete(false);
  h.advance(60_000);
  h.tracker.start("thread-fixture", "prompt-a", sentAt).complete(true);
  const rows = h.lines();
  expect(rows.map(r => r.name)).toEqual(["router.prompt_probes", "router.prompt_probes"]);
  const result = await h.log.rollup("2026-11-15");
  expect(result?.promptProbe).toMatchObject({ calls: 2, accepted: 1, notAcceptedYet: 1, timeout: 0, http: 0, transport: 0,
    attempts: { count: 1, p50: 2, max: 2 }, msUntilAccepted: { count: 1, p50: 60_000, max: 60_000 } });
  expect(result?.errorRate).toBe(0);
});

test("bounded timeout keeps exactly the 10s deadline and leaves the underlying operation alive", async () => {
  const gate = Promise.withResolvers<boolean>();
  let fire!: () => void;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
    expect(delay).toBe(10_000); fire = callback; return 123;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
  try {
    const outcome = bounded(gate.promise).catch(error => error);
    fire();
    expect(await outcome).toMatchObject({ name: "BoundedTimeout", boundMs: 10_000 });
    expect(clear).toHaveBeenCalledWith(123);
    gate.resolve(true);
    await expect(gate.promise).resolves.toBe(true);
  } finally { timer.mockRestore(); clear.mockRestore(); }
  await expect(bounded(Promise.resolve(false))).resolves.toBe(false);
});

test("all five outcomes roll up once, every failure remains an error, and diagnostic text is reduced", async () => {
  const h = setup(), sentAt = Date.parse("2026-11-15T12:00:00Z");
  h.tracker.start("thread-fixture", "prompt-a", sentAt).complete(false);
  h.advance(100); h.tracker.start("thread-fixture", "prompt-a", sentAt).complete(true);
  for (const [id, error, ms] of [["timeout", new BoundedTimeout(10_000), 10_000],
    ["http", new ControlError(503, "unavailable"), 15], ["transport", new ControlError(0, "ECONNRESET"), 5]] as const) {
    const probe = h.tracker.start("thread-fixture", id, sentAt);
    h.advance(ms);
    const props = probe.failure(error);
    h.log.write({ component: "router", kind: "error", name: "bridge.catch", ok: false, props,
      error: { tag: "router.catch1", cause: error } });
    probe.failure(error); // A downstream transaction catch cannot count the same read twice.
  }
  const rows = h.lines();
  const errors = rows.filter(r => r.kind === "error");
  expect(errors).toHaveLength(3);
  expect(errors[0]).toMatchObject({ props: { causeKind: "timeout", boundMs: 10_000, elapsedMs: 10_000, attempt: 1, route: "/prompt-acceptance" },
    error: { name: "BoundedTimeout", causeKey: "prompt_acceptance_probe", code: "ETIMEDOUT", message: "[redacted]" } });
  expect(errors[1]).toMatchObject({ props: { causeKind: "http" }, error: { status: 503, code: "unavailable" } });
  expect(errors[2]).toMatchObject({ props: { causeKind: "transport" }, error: { status: 0, code: "ECONNRESET" } });
  const result = await h.log.rollup("2026-11-15");
  expect(result?.promptProbe).toMatchObject({ calls: 5, accepted: 1, notAcceptedYet: 1, timeout: 1, http: 1, transport: 1, httpByStatus: { "503": 1 },
    attempts: { count: 1, p50: 2, max: 2 }, msUntilAccepted: { count: 1, p50: 100, max: 100 }, byHour: { "12": { calls: 5 } } });
  expect(result?.countsByKind.error).toBe(3);
  expect(result?.errorRate).toBe(3 / 4);
  expect(result?.topErrorTags).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "BoundedTimeout", count: 1, causeKinds: { timeout: 1 } }),
    expect.objectContaining({ name: "ControlError", count: 2, causeKinds: { http: 1, transport: 1 } }),
  ]));
});

test("arbitrary thrown messages, codes and metadata cannot leak through probe failures", () => {
  const h = setup();
  const error = Object.assign(new Error("PRIVATE_PROMPT_TEXT"), { code: "PRIVATE_TOKEN" });
  const probe = h.tracker.start("thread-fixture", "PRIVATE_ID", 0);
  h.log.write({ component: "router", kind: "error", name: "bridge.catch", ok: false,
    props: { ...probe.failure(error), text: "PRIVATE_MESSAGE_TEXT", route: "https://private/?token=PRIVATE_TOKEN" },
    error: { tag: "router.catch1", cause: error } });
  const raw = JSON.stringify(h.lines());
  for (const value of ["PRIVATE_PROMPT_TEXT", "PRIVATE_TOKEN", "PRIVATE_ID", "PRIVATE_MESSAGE_TEXT", "https://private"]) expect(raw).not.toContain(value);
});

test.each([
  { label: "ControlError HTTP", error: new ControlError(503, "unavailable"), status: 503, kind: "http" },
  { label: "ControlError network", error: new ControlError(0), status: 0, kind: "transport" },
  { label: "ControlError invalid status", error: new ControlError(600), status: undefined, kind: "transport" },
  ...([
    [0, 0, "transport"], [100, 100, "http"], [401, 401, "http"], [503, 503, "http"], [599, 599, "http"],
    [99, undefined, "transport"], [600, undefined, "transport"], [503.5, undefined, "transport"],
    ["503", undefined, "transport"], [NaN, undefined, "transport"], [Infinity, undefined, "transport"], [undefined, undefined, "transport"],
  ] as const).map(([input, status, kind]) => ({
    label: `legacy status ${String(input)}`, error: Object.assign(new Error("PRIVATE_HTTP_BODY"), { status: input }), status, kind,
  })),
  { label: "throwing status getter", error: { get status() { throw new Error("PRIVATE_GETTER"); } }, status: undefined, kind: "transport" },
])("probe failure classifies both backend status shapes: $label", async ({ error, status, kind }) => {
  const h = setup();
  const props = h.tracker.start("thread-fixture", "prompt-a", 0).failure(error);
  h.log.write({ component: "router", kind: "error", name: "bridge.catch", ok: false, props,
    error: { tag: "router.catch1", cause: error } });
  const rows = h.lines(), caught = rows.find(row => row.error)!;
  expect(caught.props?.causeKind).toBe(kind);
  expect(caught.props?.status).toBe(status);
  expect(caught.error?.status).toBe(status);
  expect(JSON.stringify(rows)).not.toContain("PRIVATE_");
  const result = await h.log.rollup("2026-11-15");
  expect(result?.promptProbe).toMatchObject({ calls: 1, http: Number(kind === "http"), transport: Number(kind === "transport"),
    httpByStatus: kind === "http" ? { [String(status)]: 1 } : {} });
  expect(result?.topErrorTags[0].causeKinds).toEqual({ [kind]: 1 });
  expect(result?.countsByKind.error).toBe(1);
});
