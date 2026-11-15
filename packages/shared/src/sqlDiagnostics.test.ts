import { describe, expect, it } from "vite-plus/test";
import {
  makeSqlDiagnostics,
  normalizeSql,
  sqlFingerprint,
  sqlParameterOffsets,
  SQL_STATEMENT_MAX_BYTES,
} from "./sqlDiagnostics.ts";

describe("SQL diagnostics", () => {
  it.each([
    ["SELECT * FROM t WHERE x = 'private'", "SELECT * FROM t WHERE x = 'other''value'"],
    ["SELECT 12, .5, 1e-3, 0xAB, X'ff'", "SELECT 98, 0.2, 2E+5, 0xCD, X'aa'"],
    ["SELECT ?1, :private, @private, $private::suffix(value)", "SELECT ?, :other, @other, $other"],
    ["SELECT :🐈private, @private$name, $private::🐈(private)", "SELECT ?, ?, ?"],
    ["SELECT :private::private(private), @private::private(private), $private::", "SELECT ?, ?, ?"],
    ["SELECT 1_000, 1_0.2_0e-1_0, x'', X'0123'", "SELECT 2_000, 2_0.3_0e+2_0, X'ab', x'cafe'"],
    ["SELECT true, false, NULL", "SELECT 1, 0, 10"],
    ["SELECT * FROM t WHERE x = -10", "SELECT * FROM t WHERE x = 50"],
    [
      "SELECT x * -1, y + +2 FROM t WHERE z BETWEEN -3 AND -4",
      "SELECT x * 5, y + 6 FROM t WHERE z BETWEEN 7 AND 8",
    ],
    ["SELECT/* user text */ x -- more user text\nFROM t", "SELECT x FROM t"],
    ["SELECT 'unterminated private", "SELECT 'other"],
  ])("fingerprints value changes identically: %s", (first, second) => {
    expect(sqlFingerprint(normalizeSql(first))).toBe(sqlFingerprint(normalizeSql(second)));
    expect(normalizeSql(first)).not.toContain("private");
  });

  it.each([
    "SELECT DISTINCT VALUE",
    "SELECT ALL VALUE",
    "SELECT x FROM t WHERE VALUE",
    "SELECT sum(x) FROM t HAVING VALUE",
    "SELECT * FROM t JOIN u ON VALUE",
    "SELECT x IS VALUE FROM t",
    "SELECT x IS DISTINCT FROM VALUE FROM t",
    "SELECT x IS NOT DISTINCT FROM VALUE FROM t",
    "SELECT x IS NOT VALUE FROM t",
    "SELECT x LIKE VALUE FROM t",
    "SELECT x GLOB VALUE FROM t",
    "SELECT x REGEXP VALUE FROM t",
    "SELECT x MATCH VALUE FROM t",
    "SELECT x LIKE y ESCAPE VALUE FROM t",
    "SELECT sum(x) OVER (ORDER BY x ROWS VALUE PRECEDING) FROM t",
    "SELECT sum(x) OVER (ORDER BY x RANGE VALUE PRECEDING) FROM t",
    "SELECT sum(x) OVER (ORDER BY x GROUPS VALUE PRECEDING) FROM t",
  ])("normalizes numeric signs at expression boundaries: %s", (sql) => {
    expect(normalizeSql(sql.replace("VALUE", "+10"))).toBe(
      normalizeSql(sql.replace("VALUE", "20")),
    );
  });

  it.each(
    ["->", "->>"].flatMap((operator) =>
      [
        ["-1", "0"],
        ["+1", "2"],
        ["-1_0", "20"],
        ["-1e0", "2e0"],
        ["-0x1", "0x2"],
      ].map(([first, second]) => [operator, first, second] as const),
    ),
  )("normalizes signed JSON operands: %s %s", (operator, first, second) => {
    expect(normalizeSql(`SELECT '[1,2]' ${operator} ${first}`)).toBe(
      normalizeSql(`SELECT '[3,4]' ${operator} ${second}`),
    );
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
    ["CR inside comment", "\rprivate_comment\n"],
    ["CR at EOF", "\rprivate_comment"],
    ["Unicode separator", "\u2028private_comment\n"],
  ])("strips SQLite line comments through %s", (_label, ending) => {
    expect(normalizeSql("SELECT 1 -- public" + ending)).toBe("SELECT ?");
  });

  it.each([
    'PRAGMA temp_store_directory = "/private/customer-directory"',
    'PRAGMA temp_store_directory("/private/customer-directory")',
    'PRAGMA main.temp_store_directory = "/private/customer-directory"',
    'pragma "main"."temp_store_directory"("/private/customer-directory")',
    "PRAGMA temp_store_directory = '/private/customer-directory'",
    "PRAGMA temp_store_directory = `private_directory`",
    "PRAGMA temp_store_directory = [private_directory]",
    "PRAGMA temp_store_directory = private_directory",
    'SELECT 1; PRAGMA temp_store_directory = "/private/customer-directory"',
    'EXPLAIN PRAGMA temp_store_directory = "/private/customer-directory"',
    'EXPLAIN QUERY PLAN PRAGMA main.temp_store_directory("/private/customer-directory")',
    'EXPLAIN /* prefix */ PRAGMA "main"."temp_store_directory" = private_directory',
  ])("strips PRAGMA arguments regardless of quoting: %s", (sql) => {
    expect(normalizeSql(sql)).not.toContain("private");
    expect(sqlParameterOffsets(normalizeSql(sql)).length).toBeGreaterThan(0);
  });

  it.each([
    'CREATE TABLE t(x TEXT DEFAULT "private-value")',
    "CREATE TABLE t(x TEXT DEFAULT private_value)",
    "CREATE TABLE t(x TEXT DEFAULT 'private-value')",
    "CREATE TABLE t(x TEXT DEFAULT `private-value`)",
    "CREATE TABLE t(x TEXT DEFAULT [private-value])",
    'CREATE TABLE t(x TEXT DEFAULT ("private-value"))',
    'CREATE TABLE t(x TEXT DEFAULT ((("private-value"))) NOT NULL, y TEXT)',
    "CREATE TABLE t(x TEXT DEFAULT (printf('%s', 'private-value')))",
    'CREATE TEMP TABLE t(x TEXT DEFAULT "private-value")',
    'ALTER TABLE t ADD COLUMN x TEXT DEFAULT "private-value"',
    'EXPLAIN CREATE TABLE t(x TEXT DEFAULT "private-value")',
    "CREATE TABLE t(x INTEGER DEFAULT -123)",
    "CREATE TABLE t(x INTEGER DEFAULT +0xAB)",
    "CREATE TABLE t(x BLOB DEFAULT X'cafe')",
    "CREATE TABLE t(x TEXT DEFAULT NULL)",
    "CREATE TABLE t(x TEXT DEFAULT CURRENT_TIMESTAMP)",
  ])("strips SQLite column defaults: %s", (sql) => {
    const normalized = normalizeSql(sql);
    expect(normalized).not.toContain("private");
    expect(normalized).toContain("DEFAULT ?");
    expect(normalized).toContain("x ");
    expect(normalizeSql(normalized)).toBe(normalized);
  });

  it.each([
    'ATTACH DATABASE "/private/customer.sqlite" AS "private_schema"',
    "ATTACH DATABASE private_filename AS private_schema",
    "ATTACH '/private/customer.sqlite' AS private_schema",
    'ATTACH DATABASE "/private/customer.sqlite" AS [private_schema] KEY "private_key"',
    'EXPLAIN ATTACH DATABASE "/private/customer.sqlite" AS private_schema',
    "DETACH private_schema",
    'DETACH DATABASE "private_schema"',
    "EXPLAIN DETACH private_schema",
  ])("strips SQLite attachment value expressions: %s", (sql) => {
    expect(normalizeSql(sql)).not.toContain("private");
    expect(normalizeSql(normalizeSql(sql))).toBe(normalizeSql(sql));
  });

  it.each([
    "CREATE VIRTUAL TABLE ft USING fts5(body, tokenize=\"unicode61 tokenchars 'private'\")",
    "CREATE VIRTUAL TABLE ft USING fts5(body, tokenize='private')",
    "CREATE VIRTUAL TABLE ft USING fts5(body, content=private_table)",
    "CREATE VIRTUAL TABLE ft USING fts5(body, content=`private_table`)",
    "CREATE VIRTUAL TABLE ft USING fts5(body, content=[private_table])",
    'CREATE VIRTUAL TABLE ft USING fts5("private_column", prefix="2 3")',
    'CREATE VIRTUAL TABLE IF NOT EXISTS main.ft USING fts5(body, content="private_table")',
    'CREATE VIRTUAL TABLE ft USING fts4(body, tokenize=unicode61 "tokenchars=private")',
    "CREATE VIRTUAL TABLE ft USING fts3(body, tokenize=porter private)",
    'CREATE VIRTUAL TABLE ft USING custom_module(option(nested("private")), private)',
    'EXPLAIN CREATE VIRTUAL TABLE ft USING fts5(body, content="private_table")',
    "CREATE TEMP VIRTUAL TABLE ft USING custom_module(private)",
    'CREATE VIRTUAL TABLE ft USING fts3(body; "private")',
    'CREATE VIRTUAL TABLE ft USING fts4(body; tokenize="private")',
    'CREATE VIRTUAL TABLE ft USING fts5(body; content="private")',
    'CREATE VIRTUAL TABLE ft USING custom_module(option(nested; "private"))',
    'CREATE VIRTUAL TABLE ft USING custom_module(body;; "private")',
    'CREATE VIRTUAL TABLE ft USING custom_module(body;\uFEFF"private")',
    "CREATE VIRTUAL TABLE ft USING custom_module(body; \"private\"); SELECT 'private'",
    'EXPLAIN CREATE VIRTUAL TABLE ft USING custom_module(body; "private")',
  ])("redacts opaque virtual-table module arguments: %s", (sql) => {
    const normalized = normalizeSql(sql);
    expect(normalized).not.toContain("private");
    expect(normalized).toContain("USING ");
    expect(normalized).toContain("( ? )");
    expect(normalizeSql(normalized)).toBe(normalized);
  });

  it.each(
    [
      'PRAGMA temp_store_directory = "private"',
      'PRAGMA main.temp_store_directory("private")',
      'CREATE TABLE t(x TEXT DEFAULT "private")',
      'CREATE TEMP TABLE t(x TEXT DEFAULT "private")',
      'ALTER TABLE t ADD COLUMN x TEXT DEFAULT "private"',
      'ATTACH DATABASE "private" AS "private"',
      'DETACH DATABASE "private"',
      'CREATE VIRTUAL TABLE ft USING fts5(body, content="private")',
    ].flatMap((sql) =>
      ["\uFEFF", " \t\uFEFF\uFEFF", "-- header\n\uFEFF"].map((prefix) => [prefix, sql] as const),
    ),
  )("recognizes SQLite BOM whitespace before contextual statements: %s%s", (prefix, sql) => {
    expect(normalizeSql(prefix + sql)).toBe(normalizeSql(sql));
    expect(normalizeSql(prefix + sql)).not.toContain("private");
  });

  it.each([
    'SELECT 1;\uFEFFPRAGMA temp_store_directory = "private"',
    'EXPLAIN \uFEFFPRAGMA temp_store_directory = "private"',
    'EXPLAIN QUERY PLAN \uFEFFPRAGMA temp_store_directory = "private"',
  ])("recognizes BOM whitespace at later token boundaries: %s", (sql) => {
    expect(normalizeSql(sql)).not.toContain("private");
    expect(normalizeSql(sql)).toBe(normalizeSql(sql.replaceAll("\uFEFF", "")));
  });

  it.each([
    ['\0PRAGMA temp_store_directory = "private"', ""],
    ['SELECT 1\0PRAGMA temp_store_directory = "private"', "SELECT ?"],
    ['PRAGMA user_version = 1\0"private"', "PRAGMA user_version = ?"],
    ["-- public\0private", ""],
    ["SELECT 'public\0private'", "SELECT ?"],
    [
      'CREATE VIRTUAL TABLE ft USING fts5(body)\0"private"',
      "CREATE VIRTUAL TABLE ft USING fts5 ( ? )",
    ],
  ])("omits text beyond SQLite's NUL terminator: %s", (sql, expected) => {
    expect(normalizeSql(sql)).toBe(expected);
  });

  it.each([
    'SELECT ? AS "has ? space"',
    'SELECT ? AS "escaped"" ? name"',
    "SELECT ? AS [has ? space]",
    "SELECT ? AS `has ? space`",
  ])("counts parameters outside quoted identifiers: %s", (sql) => {
    expect(sqlParameterOffsets(normalizeSql(sql)).length).toBe(1);
  });

  it("retains SQLite identifiers, operators and the complete query shape", () => {
    expect(normalizeSql("INSERT INTO t DEFAULT VALUES")).toBe("INSERT INTO t DEFAULT VALUES");
    expect(normalizeSql('SELECT "a""b", `col`, [table] FROM t WHERE id1 >= 10')).toBe(
      'SELECT "a""b" , `col` , [table] FROM t WHERE id1 >= ?',
    );
    expect(sqlFingerprint(normalizeSql("SELECT x FROM t"))).not.toBe(
      sqlFingerprint(normalizeSql("SELECT y FROM t")),
    );
  });

  it("emits text and a plan request once, bounds both sets, and restarts per boot", () => {
    const diagnostics = makeSqlDiagnostics();
    const text = "SELECT " + '"é\\" , '.repeat(10_000);
    const first = diagnostics.statement("first", text)!;
    expect(new TextEncoder().encode(JSON.stringify(first)).byteLength).toBeLessThan(
      SQL_STATEMENT_MAX_BYTES,
    );
    expect(first["sql.statement.truncated"]).toBe(true);
    expect(diagnostics.statement("first", text)).toBeUndefined();
    expect(diagnostics.plan("first")).toMatchObject({ "sql.plan.mode": "disposable-copy" });
    expect(diagnostics.plan("first")).toBeUndefined();
    for (let index = 1; index < 2_000; index++) {
      expect(diagnostics.statement(String(index), "SELECT ?")).toBeDefined();
      expect(diagnostics.plan(String(index))).toBeDefined();
    }
    expect(diagnostics.statement("overflow", "SELECT ?")).toBeUndefined();
    expect(diagnostics.plan("overflow")).toBeUndefined();
    expect(makeSqlDiagnostics().statement("first", "SELECT ?")).toBeDefined();
  });
});
