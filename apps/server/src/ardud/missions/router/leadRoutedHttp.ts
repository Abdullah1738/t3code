/**
 * `GET /api/ardud/missions/lead-routed?threadId=<id>` -> `{ ok: true, routed }`
 *
 * Whether Robob's router takes a thread's questions and permission requests
 * to a lead (see `MissionRouter.leadRouted`). The Telegram bridge asks before
 * alerting the owner about a pending request, so lane threads and the threads
 * they delegated stay with their leads.
 */
import { AuthOrchestrationReadScope, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import { MissionRouter } from "./MissionRouter.ts";

const NO_STORE = { "cache-control": "no-store" } as const;

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: NO_STORE });

const refuse = (status: number, code: string, message: string) =>
  json({ ok: false, error: { code, message } }, status);

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

const makeRoutes = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const router = yield* MissionRouter;

  const leadRouted = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const session = yield* auth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(
        (error) => !EnvironmentAuth.isServerAuthCredentialError(error),
        (error) => Effect.die(error),
      ),
      Effect.option,
    );
    if (Option.isNone(session)) return refuse(401, "unauthorized", "Authentication required.");
    if (!session.value.scopes.includes(AuthOrchestrationReadScope)) {
      return refuse(403, "forbidden", `This token lacks the ${AuthOrchestrationReadScope} scope.`);
    }
    const url = HttpServerRequest.toURL(request);
    const raw = Option.isSome(url) ? (url.value.searchParams.get("threadId") ?? "") : "";
    const threadId = decodeThreadId(raw.trim());
    if (Option.isNone(threadId)) {
      return refuse(400, "invalid_request", "threadId is required.");
    }
    return json({ ok: true, routed: yield* router.leadRouted(threadId.value) });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("ardud missions lead-routed read failed", { cause }).pipe(
        Effect.as(refuse(500, "internal", "Robob could not read this thread's leads.")),
      ),
    ),
  );

  return [HttpRouter.route("GET", "/api/ardud/missions/lead-routed", leadRouted)] as const;
});

export const leadRoutedRouteLayer = HttpRouter.addAll(makeRoutes);
