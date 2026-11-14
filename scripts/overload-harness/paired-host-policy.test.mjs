import { expect, it } from "vite-plus/test";
import { classifyCommand } from "./paired-host-policy.mjs";
it.each([
  "date -u",
  "date",
  "pwd",
  "true",
  "git status --short",
  "git rev-parse HEAD",
  "git diff --stat",
  "sleep 30",
  "sleep 0.25",
])("accepts the complete audited form %s", (command) =>
  expect(classifyCommand(command)).toBe("light"),
);
it.each([
  "opaque-db-work; date -u",
  "date -u; opaque-db-work",
  "date -u && opaque-db-work",
  "date -u | opaque-db-work",
  "echo date -u",
  'bash -c "date -u"',
  "python3 opaque.py",
  "sleep 1; python3 opaque.py",
  "sleep $(opaque)",
  "node script.mjs && git status --short",
  null,
  {},
])("keeps opaque or compound input %j unclassified", (command) =>
  expect(classifyCommand(command)).toBe("unclassified"),
);
it.each([
  "node scripts/overload-harness/paired-run.mjs",
  "node --cpu-prof script.js",
  "sqlite-disk-wait",
])("recognizes excluded jobs %s", (command) =>
  expect(classifyCommand(command)).toBe("benchmark/sqlite/disk/profiling"),
);
