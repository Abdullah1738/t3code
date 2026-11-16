import { expect, test } from "bun:test";
import { errorInfo, toolError, toolLog } from "../src/toollog.ts";
import { useToolLogFixture } from "./toollog-fixture.ts";

const logs = useToolLogFixture();
const secret = "thread-private-id Private title bearer-token-123 Message text";

test("fixture replay classifies every error shape without unknown or private text", () => {
  const cases: Array<[unknown, string | number, string]> = [
    ...[301, 400, 401, 403, 404, 409, 429, 500, 502, 503, 504].map(status =>
      [{ status, message: secret }, status, `HTTP ${status}`] as [unknown, number, string]),
    ...["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT"].map(code =>
      [{ cause: { code, path: secret } }, code, code] as [unknown, string, string]),
    [new SyntaxError(secret), "decode", "SyntaxError"],
    [new URIError(secret), "decode", "URIError"],
    [{ name: "AssertionError", message: secret }, "decode", "AssertionError"],
    [{ name: "ZodError", issues: [{ message: secret }] }, "schema", "ZodError"],
    [{ name: "ValidationError", message: secret }, "schema", "ValidationError"],
    [new DOMException(secret, "AbortError"), "abort", "AbortError"],
    [new DOMException(secret, "TimeoutError"), "timeout", "TimeoutError"],
    [{ code: "ABORT_ERR", message: secret }, "abort", "ABORT_ERR"],
    [{ code: "ERR_CANCELED", message: secret }, "abort", "ERR_CANCELED"],
    [{ code: "ERR_SOCKET_CLOSED", message: secret }, "socket_closed", "ERR_SOCKET_CLOSED"],
    [{ cause: { code: "UND_ERR_SOCKET", message: secret } }, "socket_closed", "UND_ERR_SOCKET"],
    [{ code: "ConnectionClosed", message: secret }, "socket_closed", "ConnectionClosed"],
    [{ causeClass: "unknown", cause: { code: "ECONNREFUSED" } }, "ECONNREFUSED", "ECONNREFUSED"],
    [secret, "non_error", "String"], [123, "non_error", "Number"],
    [false, "non_error", "Boolean"], [null, "non_error", "Null"],
    [undefined, "non_error", "Undefined"], [Symbol(secret), "non_error", "Symbol"],
    [1n, "non_error", "BigInt"], [() => secret, "non_error", "Function"],
    [new Error(secret), "unclassified", "Error"],
    [new TypeError(secret), "unclassified", "TypeError"],
    [{ status: 999, code: secret, name: secret }, "unclassified", "Object"],
    [Object.defineProperty({}, "status", { get() { throw new Error(secret); } }), "unclassified", "Object"],
  ];
  for (const [error] of cases) toolError("telegram", "tg.attention.pendingRequests", { thread: secret, directory: secret }, error);
  const entries = logs.entries();
  expect(entries.map(row => [row.props?.cause, row.props?.detail])).toEqual(cases.map(([, cause, detail]) => [cause, detail]));
  expect(entries.filter(row => row.props?.cause === "unknown")).toHaveLength(0);
  for (const row of entries) {
    expect(String(row.props?.detail).length).toBeLessThanOrEqual(80);
    if (row.props?.cause === "unclassified") expect(row.props.errorClass).toBe(row.props.detail);
  }
  for (const part of secret.split(" ")) expect(logs.text()).not.toContain(part);
});

test("diagnostic fields reject arbitrary class names, details and legacy unknown", () => {
  const failures = [
    { name: secret, constructor: { name: secret }, message: secret },
    new (class extends Error {}) (secret),
    Object.create({ constructor: { name: secret } }),
    Object.assign(new Error(secret), { causeClass: "unclassified", detail: secret, errorClass: secret }),
  ];
  for (const failure of failures) toolError("telegram", "fixture.failed", undefined, failure);
  toolLog({ component: "telegram", kind: "error", name: "fixture.props", props: { cause: "unknown", detail: secret, errorClass: secret } });
  expect(logs.entries().at(-1)?.props).toBeUndefined();
  expect(logs.text()).not.toContain(secret);
});


test("known nested causes keep precedence and cycles stay bounded", () => {
  expect(errorInfo({ name: "ZodError", cause: { code: "ECONNRESET" } })).toEqual({ cause: "ECONNRESET", detail: "ECONNRESET" });
  expect(errorInfo({ status: 503, cause: new SyntaxError(secret) })).toEqual({ cause: 503, detail: "HTTP 503" });
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  expect(errorInfo(cycle)).toEqual({ cause: "unclassified", detail: "Object", errorClass: "Object" });
});
