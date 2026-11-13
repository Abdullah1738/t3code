import { expect, test } from "bun:test";
import { escalationText, failureSources, normalize } from "../src/lib.ts";

const watcher = normalize({ id: "source-test", title: "Source test", check: "true", mode: "wake", context: "Check the sources." });

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
