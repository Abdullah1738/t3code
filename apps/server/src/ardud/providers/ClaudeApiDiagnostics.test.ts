import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as Diagnostics from "./ClaudeApiDiagnostics.ts";

describe("Claude API diagnostics", () => {
  it.each(["claude-opus-5-5[1m]", "vendor/claude-opus-5-5:extended"])(
    "retains requested model ids: %s",
    (model) => {
      assert.equal(
        Diagnostics.details({ environment: {}, model, attempt: 1, resume: false }).model,
        model,
      );
    },
  );
  it("scrubs secrets before truncation and excludes endpoint credentials, queries and fragments", () => {
    const environment = {
      ANTHROPIC_API_KEY: "opaque-private-key",
      ANTHROPIC_BASE_URL:
        "https://user:password@router.test/v1?api_key=opaque-private-key#fragment",
    };
    const error = Diagnostics.details({
      environment,
      model: "claude-opus-5-5",
      status: 404,
      body: {
        error: {
          code: "model_not_found",
          type: "not_found_error",
          token: 'escaped"private',
          message: `opaque-private-key Bearer private-bearer https://host.test/v1?secret=private-query ${"x".repeat(300)}`,
        },
      },
      attempt: 3,
      resume: true,
    });
    assert.equal(error.host, "router.test");
    assert.equal(error.path, "/v1");
    assert.equal(error.errorCode, "model_not_found");
    assert.equal(error.errorType, "not_found_error");
    assert.equal(error.errorText.length, 200);
    const text = JSON.stringify(error);
    for (const value of [
      "opaque-private-key",
      "private-bearer",
      "private-query",
      "escaped",
      "password",
      "fragment",
      "?",
    ])
      assert.notInclude(text, value);
    const notice = Diagnostics.describe(
      makeProviderFailure({ message: "Claude API failed" }),
      error,
    );
    for (const value of ["HTTP 404", "model_not_found", "claude-opus-5-5", "router.test/v1"])
      assert.include(notice.message, value);
  });

  it.each(
    [
      { name: "plain", secret: "private-opaque-value" },
      { name: "quote", secret: 'private-quote-"value' },
      { name: "backslash", secret: "private-backslash-\\value" },
      { name: "quote and backslash", secret: 'private-both-"\\value' },
      { name: "control characters", secret: "private-control-\n\tvalue" },
    ].flatMap((credential) =>
      ["object", "formatted JSON", "nested JSON"].map((form) => ({ ...credential, form })),
    ),
  )("scrubs decoded $name credentials in $form bodies", ({ secret, form }) => {
    const body = {
      error: {
        code: "model_not_found",
        message: form === "nested JSON" ? JSON.stringify({ echo: secret }) : `echo ${secret}`,
      },
    };
    const error = Diagnostics.details({
      environment: { ANTHROPIC_AUTH_TOKEN: secret },
      model: "claude-opus-5-5",
      status: 404,
      body: form === "formatted JSON" ? `API Error: 404 ${JSON.stringify(body, null, 2)}` : body,
      attempt: 1,
      resume: false,
    });
    assert.equal(error.errorCode, "model_not_found");
    assert.include(error.errorText, "echo");
    assert.include(error.errorText, "[REDACTED]");
    const failure = makeProviderFailure({
      message: `API Error: 404 ${JSON.stringify(body)}`,
    });
    assert.include(failure.message, "private-");
    const notice = Diagnostics.describe(failure, error);
    for (const output of [error.errorText, JSON.stringify(error), notice.message]) {
      assert.notInclude(output, secret);
      assert.notInclude(output, "private-");
    }
  });

  it.each([
    {
      body: 'API Error: 404 {"error":{"code":"model_not_found","type":"not_found_error"}} (retry)',
      code: "model_not_found",
      type: "not_found_error",
    },
    {
      body: { error: { code: "model_not_found", type: "not_found_error" } },
      code: "model_not_found",
      type: "not_found_error",
    },
    {
      body: 'API Error: 404 {"error":"model_not_found"}',
      code: "model_not_found",
      type: "unknown",
    },
    { body: { error: "model_not_found" }, code: "model_not_found", type: "unknown" },
    {
      body: { code: "model_not_found", type: "not_found_error" },
      code: "model_not_found",
      type: "not_found_error",
    },
    {
      body: { error: "model_not_found", type: "not_found_error" },
      code: "model_not_found",
      type: "not_found_error",
    },
    { body: { error: { type: "not_found_error" } }, code: "sdk_fallback", type: "not_found_error" },
    { body: "HTTP 404", code: "sdk_fallback", type: "unknown" },
  ])("extracts body codes from native error forms: $body", ({ body, code, type }) => {
    const error = Diagnostics.details({
      environment: {},
      model: "claude-opus-5-5",
      status: 404,
      body,
      errorCode: "sdk_fallback",
      attempt: 1,
      resume: false,
    });
    assert.equal(error.errorCode, code);
    assert.equal(error.errorType, type);
    assert.include(
      Diagnostics.describe(makeProviderFailure({ message: "API failed" }), error).message,
      code,
    );
  });

  it("removes query strings from relative request paths in the excerpt", () => {
    const error = Diagnostics.details({
      environment: {},
      model: "claude-opus-5-5",
      body: "POST /v1/messages?request=private-query failed",
      attempt: 1,
      resume: false,
    });
    assert.equal(error.errorText, "POST /v1/messages failed");
  });

  it.each(
    [0, 4095, 4096, 8192].flatMap((length) =>
      ["claude-opus-5-5", `claude-${"m".repeat(4090)}`].map((model) => ({ length, model })),
    ),
  )("keeps notice fields when the failure has $length characters", ({ length, model }) => {
    const error = Diagnostics.details({
      environment: { ANTHROPIC_BASE_URL: "https://router.test/v1" },
      model,
      status: 404,
      body: { error: "model_not_found" },
      attempt: 1,
      resume: false,
    });
    const notice = Diagnostics.describe(
      makeProviderFailure({ message: "x".repeat(length) }),
      error,
    );
    for (const value of ["HTTP 404", "model_not_found", model.slice(0, 512), "router.test/v1"])
      assert.include(notice.message, value);
    assert.isAtMost(notice.message.length, 4096);
  });

  it("never logs an invalid base URL", () => {
    const error = Diagnostics.details({
      environment: { ANTHROPIC_BASE_URL: "not a URL private-value" },
      model: "claude-opus-5-5",
      status: 503,
      attempt: 1,
      resume: false,
    });
    assert.equal(error.host, "unknown");
    assert.notInclude(JSON.stringify(error), "private-value");
  });

  it("shows Claude's nested cause without changing the generic provider mapper", () => {
    const cause = {
      cause: Cause.fail({
        cause: Object.assign(new Error("connection closed api_key=private-key"), {
          code: "ECONNRESET",
        }),
      }),
    };
    assert.equal(makeProviderFailure({ cause }).message, "Provider turn failed.");
    const fields = Diagnostics.queryCause(cause, {});
    assert.include(fields.message!, "ECONNRESET");
    assert.include(fields.message!, "connection closed");
    assert.notInclude(fields.message!, "private-key");
    const cyclic = { cause: undefined as unknown };
    cyclic.cause = cyclic;
    assert.deepEqual(Diagnostics.queryCause(cyclic, {}), {});
  });
});
