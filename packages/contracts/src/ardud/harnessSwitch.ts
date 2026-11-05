import * as Schema from "effect/Schema";
import { ThreadId } from "../baseSchemas.ts";

export const HarnessSwitchTranscript = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  lastTurns: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 }))),
});

export const HarnessSwitchThreadIds = Schema.Array(ThreadId);
