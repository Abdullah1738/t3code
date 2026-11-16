import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { violations, unreviewed } from "./queryPlan.ts";
import type { Exception } from "./queryPlan.ts";
NodeTest.test("index scans and archive searches fail, bounded indexed lookups pass", () => {
  const q = {
    route: "discussion",
    sql: "SELECT json FROM ardud_kanban_messages WHERE discussion_id=? LIMIT 50",
  };
  NodeAssert.deepEqual(
    violations(q, [
      { detail: "SEARCH ardud_kanban_messages USING INDEX lookup (discussion_id=?)" },
    ]),
    [],
  );
  NodeAssert.equal(
    violations(q, [{ detail: "SCAN ardud_kanban_messages USING INDEX lookup" }]).length,
    1,
  );
  NodeAssert.equal(
    violations(q, [{ detail: "SEARCH cold USING INDEX lookup (thread_id=?)" }]).length,
    1,
  );
  NodeAssert.equal(violations(q, [{ detail: "USE TEMP B-TREE FOR ORDER BY" }]).length, 1);
  NodeAssert.deepEqual(
    unreviewed(
      q,
      ["SCAN ardud_kanban_messages"],
      [{ route: "other", pattern: ".*", reason: "not this route" }],
    ),
    ["SCAN ardud_kanban_messages"],
  );
});

NodeTest.test("waivers reject another statement and new planner findings", () => {
  const q = { route: "shell", sql: "SELECT 1", queryHash: "reviewed" };
  const allowed = [
    {
      route: "shell",
      queryHash: "reviewed",
      pattern: "^USE TEMP B-TREE FOR ORDER BY$",
      reason: "reviewed",
    },
  ];
  NodeAssert.deepEqual(unreviewed(q, ["USE TEMP B-TREE FOR ORDER BY"], allowed), []);
  NodeAssert.equal(
    unreviewed({ ...q, queryHash: "new" }, ["USE TEMP B-TREE FOR ORDER BY"], allowed).length,
    1,
  );
  NodeAssert.equal(unreviewed(q, ["USE TEMP B-TREE FOR GROUP BY"], allowed).length, 1);
});

NodeTest.test("stale exceptions still reject and name one reviewed statement", () => {
  const scan = "SCAN orchestration_v2_projection_threads USING INDEX thread_order";
  const sort = "USE TEMP B-TREE FOR ORDER BY";
  const group = "USE TEMP B-TREE FOR GROUP BY";
  const query = { route: "shell", sql: "SELECT 1", queryHash: "new" };
  const exceptions: Exception[] = [
    {
      route: "shell",
      queryHash: "reviewed",
      pattern: `^${scan}$`,
      reason: "reviewed scan",
    },
    {
      route: "shell",
      queryHash: "reviewed",
      pattern: `^${sort}$`,
      reason: "reviewed sort",
    },
  ];
  const stale = [
    "STALE EXCEPTION route=shell oldHash=reviewed newHash=new: SQL changed; diff the plans and re-review (see #1607)",
  ];
  const findings = [scan, sort];
  for (const row of [
    { name: "same findings, changed hash", query, findings, exceptions, expected: stale },
    {
      name: "exact hash passes",
      query: { ...query, queryHash: "reviewed" },
      findings,
      exceptions,
      expected: [],
    },
    {
      name: "new finding kind stays plain",
      query,
      findings: [...findings, group],
      exceptions,
      expected: [...findings, group],
    },
    {
      name: "new table stays plain",
      query,
      findings: ["SCAN orchestration_v2_projection_runs USING INDEX run_order", sort],
      exceptions,
      expected: ["SCAN orchestration_v2_projection_runs USING INDEX run_order", sort],
    },
    {
      name: "another route stays plain",
      query: { ...query, route: "other" },
      findings,
      exceptions,
      expected: findings,
    },
    {
      name: "missing current hash stays plain",
      query: { route: "shell", sql: "SELECT 1" },
      findings,
      exceptions,
      expected: findings,
    },
    {
      name: "do not combine old hashes",
      query,
      findings,
      exceptions: exceptions.map((e, i) => ({ ...e, queryHash: `old-${i}` })),
      expected: findings,
    },
    {
      name: "unhashed waivers still pass",
      query,
      findings,
      exceptions: exceptions.map((e) => ({ route: e.route, pattern: e.pattern, reason: e.reason })),
      expected: [],
    },
    { name: "no findings passes", query, findings: [], exceptions, expected: [] },
    {
      name: "exact hash with a new kind stays plain",
      query: { ...query, queryHash: "reviewed" },
      findings: [...findings, group],
      exceptions,
      expected: [group],
    },
  ]) {
    NodeAssert.deepEqual(
      unreviewed(row.query, row.findings, row.exceptions),
      row.expected,
      row.name,
    );
  }
});

NodeTest.test("stale archive exceptions require the same recorded history tables", () => {
  const finding = "Interactive query references history/archive";
  const exceptions: Exception[] = [
    {
      route: "shell",
      queryHash: "reviewed",
      pattern: `^${finding}$`,
      historyTables: [
        "ardud_archive.ardud_turn_items",
        "ardud_base.orchestration_v2_projection_turn_items",
      ],
      reason: "reviewed history lookup",
    },
  ];
  for (const row of [
    {
      name: "same tables",
      sql: "SELECT * FROM ardud_archive.ardud_turn_items UNION ALL SELECT * FROM ardud_base.orchestration_v2_projection_turn_items",
      stale: true,
    },
    {
      name: "reordered repeated tables, case insensitive",
      sql: "SELECT * FROM ARDUD_BASE.orchestration_v2_projection_turn_items UNION ALL SELECT * FROM ardud_archive.ardud_turn_items UNION ALL SELECT * FROM ardud_archive.ardud_turn_items",
      stale: true,
    },
    {
      name: "ordinary string values before and after table references",
      sql: "SELECT 'value', 'it''s a value' FROM ardud_archive.ardud_turn_items JOIN ardud_base.orchestration_v2_projection_turn_items ON 1=1 WHERE 'value' = 'value'",
      stale: true,
    },
    {
      name: "apostrophe in a line comment before string values and history references",
      sql: "-- Repeats the index's predicate.\nSELECT 'pending' FROM ardud_archive.ardud_turn_items JOIN ardud_base.orchestration_v2_projection_turn_items ON 1=1 WHERE 'completed' = 'completed'",
      stale: true,
    },
    {
      name: "new history table",
      sql: "SELECT * FROM ardud_archive.ardud_turn_items UNION ALL SELECT * FROM ardud_base.orchestration_v2_projection_turn_items UNION ALL SELECT * FROM ardud_history_messages",
      stale: false,
    },
    {
      name: "different archive table",
      sql: "SELECT * FROM ardud_archive.messages UNION ALL SELECT * FROM ardud_base.orchestration_v2_projection_turn_items",
      stale: false,
    },
    {
      name: "missing history table",
      sql: "SELECT * FROM ardud_archive.ardud_turn_items",
      stale: false,
    },
  ]) {
    const query = { route: "shell", sql: row.sql, queryHash: "new" };
    NodeAssert.deepEqual(
      unreviewed(query, [finding], exceptions),
      row.stale
        ? [
            "STALE EXCEPTION route=shell oldHash=reviewed newHash=new: SQL changed; diff the plans and re-review (see #1607)",
          ]
        : [finding],
      row.name,
    );
    NodeAssert.deepEqual(
      unreviewed(
        query,
        [finding],
        exceptions.map((e) => ({
          route: e.route,
          queryHash: e.queryHash,
          pattern: e.pattern,
          reason: e.reason,
        })),
      ),
      [finding],
      `${row.name}: no table evidence stays plain`,
    );
  }
});

NodeTest.test("uncertain history identifier syntax keeps plain rejections", () => {
  const finding = "Interactive query references history/archive";
  const sql =
    "SELECT * FROM ardud_archive.ardud_turn_items AS old JOIN ardud_base.orchestration_v2_projection_turn_items AS base ON 1=1";
  const exceptions: Exception[] = [
    {
      route: "shell",
      queryHash: "reviewed",
      pattern: `^${finding}$`,
      reason: "reviewed history lookup",
      historyTables: [
        "ardud_archive.ardud_turn_items",
        "ardud_base.orchestration_v2_projection_turn_items",
      ],
    },
  ];
  const cases = [
    ["unquoted new table", "ardud_archive.messages"],
    ["double-quoted table", 'ardud_archive."messages"'],
    ["double-quoted schema", '"ardud_archive".messages'],
    ["double-quoted schema and table", '"ardud_archive"."messages"'],
    ["escaped double quote", 'ardud_archive."mess""ages"'],
    ["backtick table", "ardud_archive.`messages`"],
    ["backtick schema", "`ardud_archive`.messages"],
    ["backtick schema and table", "`ardud_archive`.`messages`"],
    ["escaped backtick", "ardud_archive.`mess``ages`"],
    ["bracket table", "ardud_archive.[messages]"],
    ["bracket schema", "[ardud_archive].messages"],
    ["bracket schema and table", "[ardud_archive].[messages]"],
    ["single-quoted table", "ardud_archive.'messages'"],
    ["single-quoted schema", "'ardud_archive'.messages"],
    ["single-quoted complete table name", "'ardud_archive.ardud_turn_items extra'"],
    ["escaped single quote in complete name", "'ardud_archive.ardud_turn_items''extra'"],
    ["space before dot", "ardud_archive .messages"],
    ["space after dot", "ardud_archive. messages"],
    ["spaces around dot", "ardud_archive . messages"],
    ["newline around dot", "ardud_archive\n.\nmessages"],
    ["comment around dot", "ardud_archive/**/./**/messages"],
    ["qualified history view", "other.ardud_history_turn_items"],
    ["qualified history view with space", "other . ardud_history_turn_items"],
    ["quoted history view", '"ardud_history_messages"'],
    ["dollar suffix", "ardud_archive.ardud_turn_items$extra"],
    ["unicode suffix", "ardud_archive.ardud_turn_itemsé"],
    ["quoted known table", 'ardud_archive."ardud_turn_items"'],
  ];
  for (const [name, table] of cases) {
    const query = { route: "shell", queryHash: "new", sql: `${sql} JOIN ${table} AS extra ON 1=1` };
    NodeAssert.deepEqual(unreviewed(query, [finding], exceptions), [finding], name);
    NodeAssert.deepEqual(
      unreviewed({ ...query, queryHash: "reviewed" }, [finding], exceptions),
      [],
      `${name}: exact-hash acceptance unchanged`,
    );
  }
  const viewExceptions = exceptions.map((e) => ({
    ...e,
    historyTables: ["ardud_history_turn_items"],
  }));
  for (const [name, table] of [
    ["qualified view", "other.ardud_history_turn_items"],
    ["space around view qualifier", "other . ardud_history_turn_items"],
    ["block comment before view", "other./*table*/ardud_history_turn_items"],
    ["line comment before view", "other. -- table\n ardud_history_turn_items"],
    ["repeated line comments", "other. -- first\n -- second\n ardud_history_turn_items"],
    ["quoted known view", 'other."ardud_history_turn_items"'],
    ["single-quoted known view", "'ardud_history_turn_items'"],
    ["single-quoted qualified view", "other.'ardud_history_turn_items'"],
    ["single-quoted view qualifier", "'other'.ardud_history_turn_items"],
    ["single-quoted qualifier and view", "'other'.'ardud_history_turn_items'"],
    ["single-quoted view containing space", "'ardud_history_turn_items extra'"],
    ["single-quoted view containing dot", "'other.ardud_history_turn_items'"],
    ["escaped single quote in view", "'ardud_history_turn_items''extra'"],
    ["single-quoted dollar view suffix", "'ardud_history_turn_items$extra'"],
    ["single-quoted unicode view suffix", "'ardud_history_turn_itemsé'"],
    ["dollar view suffix", "ardud_history_turn_items$extra"],
    ["unicode view suffix", "ardud_history_turn_itemsé"],
  ]) {
    NodeAssert.deepEqual(
      unreviewed(
        {
          route: "shell",
          queryHash: "new",
          sql: `SELECT * FROM ardud_history_turn_items JOIN ${table} AS extra ON 1=1`,
        },
        [finding],
        viewExceptions,
      ),
      [finding],
      name,
    );
  }
});
