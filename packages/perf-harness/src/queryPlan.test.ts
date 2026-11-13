import { test } from "node:test";
import assert from "node:assert/strict";
import { violations, unreviewed } from "./queryPlan.ts";
test("index scans and archive searches fail, bounded indexed lookups pass", () => {
  const q = {
    route: "discussion",
    sql: "SELECT json FROM ardud_kanban_messages WHERE discussion_id=? LIMIT 50",
  };
  assert.deepEqual(
    violations(q, [
      { detail: "SEARCH ardud_kanban_messages USING INDEX lookup (discussion_id=?)" },
    ]),
    [],
  );
  assert.equal(
    violations(q, [{ detail: "SCAN ardud_kanban_messages USING INDEX lookup" }]).length,
    1,
  );
  assert.equal(
    violations(q, [{ detail: "SEARCH cold USING INDEX lookup (thread_id=?)" }]).length,
    1,
  );
  assert.equal(violations(q, [{ detail: "USE TEMP B-TREE FOR ORDER BY" }]).length, 1);
  assert.deepEqual(
    unreviewed(
      q,
      ["SCAN ardud_kanban_messages"],
      [{ route: "other", pattern: ".*", reason: "not this route" }],
    ),
    ["SCAN ardud_kanban_messages"],
  );
});

test("waivers reject another statement and new planner findings", () => {
  const q = { route: "shell", sql: "SELECT 1", queryHash: "reviewed" };
  const allowed = [
    {
      route: "shell",
      queryHash: "reviewed",
      pattern: "^USE TEMP B-TREE FOR ORDER BY$",
      reason: "reviewed",
    },
  ];
  assert.deepEqual(unreviewed(q, ["USE TEMP B-TREE FOR ORDER BY"], allowed), []);
  assert.equal(
    unreviewed({ ...q, queryHash: "new" }, ["USE TEMP B-TREE FOR ORDER BY"], allowed).length,
    1,
  );
  assert.equal(unreviewed(q, ["USE TEMP B-TREE FOR GROUP BY"], allowed).length, 1);
});
