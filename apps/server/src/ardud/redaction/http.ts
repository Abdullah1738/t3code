import { AuthEnvironmentMaintainScope, ThreadRedactionInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ThreadRedaction from "./ThreadRedaction.ts";

const decode = Schema.decodeUnknownEffect(ThreadRedactionInput);
const makeRoutes = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const service = yield* ThreadRedaction.ThreadRedaction;
  const handle = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
    if (session._tag === "None")
      return HttpServerResponse.jsonUnsafe({ error: "unauthorized" }, { status: 401 });
    if (!session.value.scopes.includes(AuthEnvironmentMaintainScope))
      return HttpServerResponse.jsonUnsafe({ error: "forbidden" }, { status: 403 });
    const input = yield* request.json.pipe(Effect.flatMap(decode), Effect.option);
    if (input._tag === "None")
      return HttpServerResponse.jsonUnsafe({ error: "invalid_request" }, { status: 400 });
    const result = yield* service.redactItem(input.value).pipe(Effect.result);
    return result._tag === "Success"
      ? HttpServerResponse.jsonUnsafe(result.success)
      : HttpServerResponse.jsonUnsafe(
          { error: result.failure.code, message: result.failure.message },
          {
            status:
              result.failure.code === "running" || result.failure.code === "maintenance_required"
                ? 409
                : 400,
          },
        );
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "redaction_failed" }, { status: 500 })),
    ),
  );
  return [HttpRouter.route("POST", "/api/ardud/control/threads/redact-item", handle)];
});
export const redactionRouteLayer = HttpRouter.addAll(makeRoutes);
