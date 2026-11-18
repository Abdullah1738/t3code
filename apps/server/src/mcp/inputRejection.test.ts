import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { inputRejection, excessArgumentRejection } from "./inputRejection.ts";

const schema = Schema.Struct({
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  view: Schema.Literals(["messages", "activity"]),
  items: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
  choice: Schema.optionalKey(
    Schema.Union([
      Schema.Literal("all"),
      Schema.Struct({ limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) }),
    ]),
  ),
  nullable: Schema.optionalKey(Schema.NullOr(Schema.String)),
  labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.Boolean)),
});

describe("input rejection details", () => {
  it.each([
    {
      name: "positive overflow",
      field: Schema.Finite,
      value: Number("1e400"),
      constraint: "a finite number",
    },
    {
      name: "negative overflow",
      field: Schema.Finite,
      value: Number("-1e400"),
      constraint: "a finite number",
    },
    { name: "NaN", field: Schema.Finite, value: NaN, constraint: "a finite number" },
    { name: "finite type", field: Schema.Finite, value: false, constraint: "a finite number" },
    {
      name: "multiple",
      field: Schema.Number.check(Schema.isMultipleOf(5)),
      value: 3,
      constraint: "a number that is a multiple of 5",
    },
    {
      name: "safe integer",
      field: Schema.Int,
      value: Number.MAX_SAFE_INTEGER + 1,
      constraint: "an integer",
    },
    {
      name: "static custom check",
      field: Schema.Number.check(
        Schema.makeFilter<number>(() => false, { expected: "a prime number" }),
      ),
      value: 4,
      constraint: "a prime number",
    },
    {
      name: "finite integer range",
      field: Schema.Finite.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 10 })),
      value: Infinity,
      constraint: "a finite integer from 1 to 10",
    },
  ])("$name keeps its numeric constraint", ({ field, value, constraint }) => {
    const payload = { field: value };
    const decoded = Schema.decodeUnknownResult(Schema.Struct({ field }))(payload);
    if (decoded._tag !== "Failure") throw new Error("expected invalid input");
    const result = inputRejection(decoded.failure.issue, payload);
    expect(result.invalidFields).toEqual(["field"]);
    expect(result.message).toContain(constraint);
    expect(result.message).toContain(
      `(got ${typeof value === "number" ? String(value) : typeof value})`,
    );
    expect(result.message.length).toBeLessThanOrEqual(300);
    expect(result.message).not.toMatch(/[\r\n]/);
  });

  it.each([false, true])(
    "retains excess siblings and deduplicates the safe path (nested=%s)",
    (nested) => {
      const fields = { a: 1, b: true, c: null, d: "private" };
      const struct = Schema.Struct({ known: Schema.optionalKey(Schema.String) });
      const strict = nested ? Schema.Struct({ options: struct }) : struct;
      const payload = nested ? { options: fields } : fields;
      const decoded = Schema.decodeUnknownResult(strict)(payload, {
        errors: "all",
        onExcessProperty: "error",
      });
      if (decoded._tag !== "Failure") throw new Error("expected invalid input");
      const result = inputRejection(decoded.failure.issue, payload);
      expect(result.invalidFields).toEqual([nested ? "options" : "input"]);
      for (const field of ["a", "b", "c"])
        expect(result.message).toContain(`${nested ? "options." : ""}${field} must be omitted`);
      expect(result.message).toContain("and 1 more");
      expect(result.message).not.toContain("private");
    },
  );
  it.each([
    {
      name: "string min",
      field: Schema.String.check(Schema.isMinLength(1)),
      value: "",
      constraint: "length of at least 1",
    },
    {
      name: "string max",
      field: Schema.String.check(Schema.isMaxLength(1)),
      value: "private",
      constraint: "length of at most 1",
    },
    {
      name: "string between",
      field: Schema.String.check(Schema.isBetweenLength(1, 3)),
      value: "private",
      constraint: "length between 1 and 3",
    },
    {
      name: "array min",
      field: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
      value: [],
      constraint: "length of at least 1",
    },
    {
      name: "array max",
      field: Schema.Array(Schema.String).check(Schema.isMaxLength(1)),
      value: ["private", "private"],
      constraint: "length of at most 1",
    },
    {
      name: "array between",
      field: Schema.Array(Schema.String).check(Schema.isBetweenLength(1, 3)),
      value: [],
      constraint: "length between 1 and 3",
    },
    {
      name: "size min",
      field: Schema.Struct({ size: Schema.Number }).check(Schema.isMinSize(1)),
      value: { size: 0 },
      constraint: "size of at least 1",
    },
    {
      name: "size max",
      field: Schema.Struct({ size: Schema.Number }).check(Schema.isMaxSize(1)),
      value: { size: 2 },
      constraint: "size of at most 1",
    },
    {
      name: "size between",
      field: Schema.Struct({ size: Schema.Number }).check(Schema.isBetweenSize(1, 3)),
      value: { size: 0 },
      constraint: "size between 1 and 3",
    },
    {
      name: "trimmed",
      field: Schema.String.check(Schema.isTrimmed()),
      value: " private ",
      constraint: "no leading or trailing whitespace",
    },
    {
      name: "pattern",
      field: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
      value: "private",
      constraint: "matching the RegExp ^\\d{4}-\\d{2}-\\d{2}$",
    },
  ])("$name keeps its constraint", ({ field, value, constraint }) => {
    const payload = { field: value };
    const decoded = Schema.decodeUnknownResult(Schema.Struct({ field }))(payload);
    if (decoded._tag !== "Failure") throw new Error("expected invalid input");
    const result = inputRejection(decoded.failure.issue, payload);
    expect(result.invalidFields).toEqual(["field"]);
    expect(result.message).toContain(constraint);
    expect(result.message).toContain(
      typeof value === "string" ? "got string" : Array.isArray(value) ? "got array" : "got object",
    );
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it.each([
    "id",
    "cardId",
    "card_id",
    "number",
    "cardNumber",
    "unexpected",
    "private_key",
    "line\nbreak",
    "x".repeat(400),
  ])("unknown key %s is described without logging it as a field", (key) => {
    const result = excessArgumentRejection(["card", "boardId", "events"], { [key]: "private" });
    expect(result?.invalidFields).toEqual(["input"]);
    expect(result?.message).toContain("must be omitted (got string)");
    expect(result?.message).not.toContain('private"');
    expect(result?.message.length).toBeLessThanOrEqual(300);
    expect(result?.message).not.toMatch(/[\r\n]/);
    if (["id", "cardId", "card_id", "number", "cardNumber"].includes(key))
      expect(result?.message).toContain('Did you mean "card"?');
  });

  it("bounds excess key counts and leaves valid keys alone", () => {
    expect(excessArgumentRejection(["card"], { card: "private" })).toBeUndefined();
    const result = excessArgumentRejection([], { a: 1, b: true, c: null, d: [], e: {} });
    expect(result?.message).toContain("and 2 more");
    expect(result?.invalidFields).toEqual(["input"]);
    expect(result?.message).not.toContain("got 1");
  });

  it.each([
    { input: { limit: 0 }, field: "limit", message: "an integer from 1 to 100 (got 0)" },
    { input: { limit: 1.5 }, field: "limit", message: "an integer from 1 to 100 (got 1.5)" },
    {
      input: { limit: "private" },
      field: "limit",
      message: "an integer from 1 to 100 (got string)",
    },
    { input: { view: "private" }, field: "view", message: '"messages" or "activity" (got string)' },
    { input: { items: [{ name: 200 }] }, field: "items.0.name", message: "a string (got number)" },
    {
      input: { choice: { limit: 0 } },
      field: "choice.limit",
      message: "an integer at least 1 (got 0)",
    },
    { input: { nullable: false }, field: "nullable", message: "a string or null (got boolean)" },
    {
      input: { labels: { private_key: "private" } },
      field: "labels",
      message: "a boolean (got string)",
    },
  ])("$field reports its constraint and value class", ({ input, field, message }) => {
    const payload = { limit: 10, view: "messages", ...input };
    const decoded = Schema.decodeUnknownResult(schema)(payload, { errors: "all" });
    if (decoded._tag !== "Failure") throw new Error("expected invalid input");
    const result = inputRejection(decoded.failure.issue, payload);
    expect(result.invalidFields).toEqual([field]);
    expect(result.message).toContain(message);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("limits detail and paths while counting remaining issues", () => {
    const many = Schema.Struct({
      a: Schema.String,
      b: Schema.String,
      c: Schema.String,
      d: Schema.String,
      e: Schema.String,
      f: Schema.String,
    });
    const decoded = Schema.decodeUnknownResult(many)({}, { errors: "all" });
    if (decoded._tag !== "Failure") throw new Error("expected invalid input");
    const result = inputRejection(decoded.failure.issue, {});
    expect(result.invalidFields).toEqual(["a", "b", "c", "d", "e"]);
    expect(result.message).toContain("and 3 more");
    expect(result.message.length).toBeLessThanOrEqual(300);
    expect(result.message).not.toMatch(/[\r\n]/);
  });
});
