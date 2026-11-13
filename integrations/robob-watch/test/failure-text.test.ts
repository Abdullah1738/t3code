import { expect, test } from "bun:test";
import { escalationText, normalize } from "../src/lib.ts";

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
])("escalation describes %s", (last_error, expected) => {
  const text = escalationText(watcher, { status: "active", fires: 0, consecutive_failures: 5,
    failure_alerted: true, last_error }, 15);
  expect(text).toContain(expected);
  expect(text).not.toContain("blind");
});
