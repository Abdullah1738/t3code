import * as Context from "effect/Context";

/** Request-local signal survives the toolkit's internal error scrubbing. */
export class ReplyRejection extends Context.Service<ReplyRejection, { exceeded: boolean }>()(
  "t3/ardud/http/ReplyRejection",
) {}
