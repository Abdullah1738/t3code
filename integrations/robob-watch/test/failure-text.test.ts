import { expect, test } from "bun:test";
import { BUSY_ALERT_AFTER_MS, escalationText, failureSources, normalize, shouldEscalate, shouldNotifyFailure, shouldPause, type State } from "../src/lib.ts";

const watcher = normalize({ id: "source-test", title: "Source test", check: "true", mode: "wake", context: "Check the sources." });

test("busy notices and escalation use the dependency's own twenty-minute fuse", () => {
  const started = Date.parse("2026-11-16T00:00:00Z");
  const state: State = { status: "active", fires: 0, consecutive_failures: 10, failure_alerted: false,
    failing_since: new Date(started-60*60_000).toISOString(), dependency_busy: { dependency: "msgs", since: new Date(started).toISOString() } };
  for (const elapsed of [0, BUSY_ALERT_AFTER_MS-1, BUSY_ALERT_AFTER_MS]) {
    expect(shouldNotifyFailure(watcher, state, false, started+elapsed)).toBe(elapsed === BUSY_ALERT_AFTER_MS);
    expect(shouldEscalate(watcher, state, started+elapsed)).toBe(elapsed === BUSY_ALERT_AFTER_MS);
    expect(shouldPause(watcher, state, false, started+elapsed)).toBe(false);
  }
  const text = escalationText(watcher, state, 20);
  expect(text).toContain("Dependency msgs has been busy for 20 min");
  expect(text).toContain("Don't edit the watcher");
  expect(text).toContain("daemon.log");
  expect(text).toContain("silent for more than 30 min");
  expect(text).toContain("robob-watch resume source-test");
});

test.each([
  ['exit 1: inbox-triage source failure: {"outlook": "TimeoutExpired"}', "failing sources: outlook"],
  ['exit 1: source failure: {"outlook": "TLS", "gmail": "timeout"}', "failing sources: outlook, gmail"],
  ['exit 1: source failure: {\n"outlook": "TLS"\n}', "failing sources: outlook"],
  ["exit 1: connection lost", "its check is failing"],
  ['exit 1: truncated {"outlook":', "its check is failing"],
  ['exit 1: {}', "its check is failing"],
  ['exit 1: {"code": 1}', "its check is failing"],
  ['exit 1: ["outlook"]', "its check is failing"],
  ['exit 1: {"outlook": null}', "its check is failing"],
  ['exit 1: {"outlook": false}', "its check is failing"],
  ['exit 1: {"outlook": ["timeout"]}', "its check is failing"],
  ['exit 1: {"outlook": "timeout {detail}"}', "failing sources: outlook"],
])("escalation describes %s", (last_error, expected) => {
  const text = escalationText(watcher, { status: "active", fires: 0, consecutive_failures: 5,
    failure_alerted: true, last_error }, 15);
  expect(text).toContain(expected);
  expect(text).not.toContain("blind");
});

test("source summaries stay bounded even with many long source names", () => {
  const errors = Object.fromEntries(Array.from({ length: 100 }, (_, n) => ["source" + n + "x".repeat(1000), "timeout"]));
  const sources = failureSources(JSON.stringify(errors));
  expect(sources.length).toBeGreaterThan(0);
  expect(sources.length).toBeLessThanOrEqual(16);
  expect(sources.every(source => source.length <= 64)).toBe(true);
  expect(JSON.stringify(sources).length).toBeLessThan(1200);
});
