import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../../auth/http.ts";
import * as OpenCodeImporter from "./OpenCodeImporter.ts";

export const OPENCODE_IMPORT_RUN_PATH = "/api/ardud/opencode-import/run";

export const OpenCodeImportRunRequest = Schema.Struct({
  sinceDays: Schema.optional(Schema.Number),
  dryRun: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Number),
});

const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(OpenCodeImportRunRequest));

const authenticate = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(
        EnvironmentAuth.serverAuthCredentialReason(error),
        EnvironmentAuth.serverAuthDpopFailureReason(error),
      ),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
    return yield* failEnvironmentScopeRequired(AuthOrchestrationOperateScope);
  }
});

/** POST {sinceDays?, dryRun?, limit?} runs one import and returns its counts. */
export const openCodeImportRouteLayer = HttpRouter.add(
  "POST",
  OPENCODE_IMPORT_RUN_PATH,
  Effect.gen(function* () {
    yield* authenticate;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const text = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
    const body = yield* decodeRequest(text.trim().length === 0 ? "{}" : text).pipe(
      Effect.mapError((cause) => ({ _tag: "BadRequest" as const, message: String(cause) })),
    );
    const importer = yield* OpenCodeImporter.OpenCodeImporter;
    const result = yield* importer.run({
      ...(body.sinceDays === undefined ? {} : { sinceDays: body.sinceDays }),
      ...(body.limit === undefined ? {} : { limit: body.limit }),
      ...(body.dryRun === undefined ? {} : { dryRun: body.dryRun }),
    });
    return HttpServerResponse.jsonUnsafe(result);
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
      BadRequest: (error) =>
        Effect.succeed(HttpServerResponse.text(error.message, { status: 400 })),
    }),
    Effect.tapError((error) => Effect.logWarning("OpenCode import request failed", { error })),
    Effect.catch((error) =>
      Effect.succeed(
        HttpServerResponse.text(error instanceof Error ? error.message : String(error), {
          status: 500,
        }),
      ),
    ),
  ),
);
