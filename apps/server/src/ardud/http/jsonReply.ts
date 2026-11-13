import { HttpServerResponse } from "effect/http";
import * as Effect from "effect/Effect";
import { jsonExceedsBudget, REPLY_TOO_LARGE, ReplyTooLarge } from "./replyBudget.ts";

export const checkJsonReply = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flatMap((value) =>
      jsonExceedsBudget(value) ? Effect.die(new ReplyTooLarge()) : Effect.succeed(value),
    ),
  );

/** Detail routes must reject before JSON.stringify, not just before socket encoding. */
export const jsonReply = (body: unknown, status = 200) =>
  jsonExceedsBudget(body)
    ? HttpServerResponse.jsonUnsafe(
        { ok: false, error: "reply_too_large", message: REPLY_TOO_LARGE },
        { status: 413, headers: { "cache-control": "no-store", "x-robob-reply-rejected": "true" } },
      )
    : HttpServerResponse.jsonUnsafe(body, { status, headers: { "cache-control": "no-store" } });
