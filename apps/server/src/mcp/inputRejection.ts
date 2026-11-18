import type * as SchemaAST from "effect/SchemaAST";
import type * as SchemaIssue from "effect/SchemaIssue";

const filtersOf = (
  checks: ReadonlyArray<SchemaAST.Check<unknown>> = [],
): ReadonlyArray<SchemaAST.Filter<unknown>> =>
  checks.flatMap((check) => (check._tag === "Filter" ? [check] : filtersOf(check.checks)));

function expected(ast: SchemaAST.AST | undefined): string {
  if (ast === undefined) return "a valid value";
  if (ast._tag === "Union") return [...new Set(ast.types.map(expected))].join(" or ");
  if (ast._tag === "Literal") return JSON.stringify(ast.literal);
  if (ast._tag === "Null") return "null";
  if (ast._tag === "Undefined") return "omitted";
  const checks = filtersOf(ast.checks);
  const representations = checks.flatMap((check) => check.annotations?.representation ?? []);
  let type =
    ast._tag === "Number"
      ? representations.some((r) => r.id === "effect/schema/isInt")
        ? "an integer"
        : "a number"
      : ast._tag === "String"
        ? "a string"
        : ast._tag === "Arrays"
          ? "an array"
          : ast._tag === "Objects"
            ? "an object"
            : ast._tag === "Boolean"
              ? "a boolean"
              : "a valid value";
  if (ast._tag !== "Number") {
    const constraints = checks.flatMap((check) => {
      const description = check.annotations?.expected;
      return typeof description === "string" ? [description.replace(/^a value\b/, type)] : [];
    });
    return constraints.length > 0 ? [...new Set(constraints)].join(" and ") : type;
  }
  for (const representation of representations) {
    const payload = representation.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) continue;
    const bounds = payload as Readonly<Record<string, unknown>>;
    const minimum = bounds.minimum ?? bounds.exclusiveMinimum;
    const maximum = bounds.maximum ?? bounds.exclusiveMaximum;
    const exclusiveMinimum = typeof bounds.exclusiveMinimum === "number";
    const exclusiveMaximum = typeof bounds.exclusiveMaximum === "number";
    if (
      typeof minimum === "number" &&
      typeof maximum === "number" &&
      !exclusiveMinimum &&
      !exclusiveMaximum
    )
      type += ` from ${minimum} to ${maximum}`;
    else {
      if (typeof minimum === "number")
        type += ` ${exclusiveMinimum ? "greater than" : "at least"} ${minimum}`;
      if (typeof maximum === "number")
        type += ` ${exclusiveMaximum ? "less than" : "at most"} ${maximum}`;
    }
  }
  return type;
}

function rejection(failures: ReadonlyMap<string, { field: string; message: string }>, hint = "") {
  const entries = [...failures.values()];
  const shown: string[] = [];
  for (const { message } of entries.slice(0, 3)) {
    if (
      `Invalid input: ${[...shown, message].join("; ")}; and ${entries.length} more.${hint}`
        .length > 300
    )
      break;
    shown.push(message);
  }
  if (shown.length === 0) {
    const message = entries[0]!.message;
    const actual = message.match(/\(got [^()]+\)$/)?.[0] ?? "";
    shown.push(`${message.slice(0, 255 - hint.length - actual.length)}… ${actual}`);
  }
  const more = entries.length - shown.length;
  return {
    code: "invalid_request" as const,
    message:
      `Invalid input: ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}.${hint}`.replace(
        /[\r\n]/g,
        " ",
      ),
    invalidFields: [...new Set(entries.map(({ field }) => field))].slice(0, 5),
  };
}

export function excessArgumentRejection(allowed: ReadonlyArray<string>, input: unknown) {
  if (input === null || typeof input !== "object") return;
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) return;
  const failures = new Map(
    unknown.map((key) => [
      key,
      {
        field: "input",
        message: `${JSON.stringify(key).slice(0, 64)} must be omitted (got ${actualClass((input as Record<string, unknown>)[key], undefined)})`,
      },
    ]),
  );
  const hint =
    allowed.includes("card") &&
    unknown.some((key) => ["id", "cardId", "card_id", "number", "cardNumber"].includes(key))
      ? ' Did you mean "card"? Pass card: "<card id>" or "#4421".'
      : "";
  // Unknown keys are caller-controlled strings, so only the parent path reaches analytics.
  return rejection(failures, hint);
}

const numeric = (ast: SchemaAST.AST | undefined): boolean =>
  ast?._tag === "Number" || (ast?._tag === "Union" && ast.types.some(numeric));

const actualClass = (value: unknown, ast: SchemaAST.AST | undefined) =>
  typeof value === "number" && numeric(ast)
    ? String(value)
    : value === null
      ? "null"
      : Array.isArray(value)
        ? "array"
        : value === undefined
          ? "missing"
          : typeof value;

function propertyAst(ast: SchemaAST.AST | undefined, key: PropertyKey): SchemaAST.AST | undefined {
  if (ast?._tag === "Objects") return ast.propertySignatures.find((p) => p.name === key)?.type;
  if (ast?._tag === "Arrays" && typeof key === "number") return ast.elements[key] ?? ast.rest[0];
  if (ast?._tag === "Union") {
    for (const member of ast.types) {
      const found = propertyAst(member, key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Only declared property names and array indices become paths; record keys can contain secrets. */
export function inputRejection(issue: SchemaIssue.Issue, input: unknown, hint?: string) {
  const failures = new Map<string, { field: string; message: string }>();
  const visit = (
    node: SchemaIssue.Issue,
    path: string,
    value: unknown,
    ast?: SchemaAST.AST,
    depth = 0,
  ): void => {
    if (depth > 64) return;
    if (node._tag === "Pointer") {
      for (const key of node.path) {
        const child = propertyAst(ast, key);
        value =
          value !== null && typeof value === "object" && Object.hasOwn(value, key)
            ? (value as Record<PropertyKey, unknown>)[key]
            : undefined;
        if (child === undefined) {
          if (node.issue._tag === "UnexpectedKey") {
            const field = path.slice(0, 64) || "input";
            const label = `${path ? `${path}.` : ""}${String(key)}`.slice(0, 64);
            failures.set(`unexpected:${JSON.stringify([path, key])}`, {
              field,
              message: `${label} must be omitted (got ${actualClass(value, undefined)})`,
            });
            return;
          }
          break;
        }
        if (
          (typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) ||
          typeof key === "number"
        )
          path = path ? `${path}.${String(key)}` : String(key);
        ast = child;
      }
      visit(node.issue, path, value, ast, depth + 1);
    } else if (node._tag === "Composite") {
      for (const child of node.issues) visit(child, path, value, node.ast, depth + 1);
    } else if (node._tag === "Encoding") visit(node.issue, path, value, ast, depth + 1);
    else if (node._tag === "AnyOf" && node.issues.some((child) => child._tag !== "InvalidType")) {
      // A union such as "all" | { limit } should report the failing object field.
      for (const child of node.issues.filter((child) => child._tag !== "InvalidType"))
        visit(child, path, value, node.ast, depth + 1);
    } else {
      const field = path.slice(0, 64) || "input";
      const schema = "ast" in node ? node.ast : ast;
      let constraint = expected(schema);
      if (node._tag === "MissingKey") constraint += " and present";
      if (node._tag === "UnexpectedKey") constraint = "omitted";
      if (node._tag === "Filter" && constraint === "a valid value") constraint = expected(ast);
      failures.set(field, {
        field,
        message: `${field} must be ${constraint} (got ${actualClass(value, schema)})`,
      });
    }
  };
  visit(issue, "", input);
  if (failures.size === 0)
    failures.set("input", { field: "input", message: "input must match the tool schema" });
  return rejection(failures, hint === undefined ? "" : ` ${hint.slice(0, 180)}`);
}
