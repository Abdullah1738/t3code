import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http";
export const actionIdAttributes = (value: unknown): Record<string, string> =>
  typeof value === "string" && /^[a-zA-Z0-9:_-]{1,128}$/.test(value) ? { "action.id": value } : {};
export const annotateHttpAction = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  yield* Effect.annotateCurrentSpan(actionIdAttributes(request.headers["x-robob-action-id"]));
});
