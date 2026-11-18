import * as Schema from "effect/Schema";

const Label = Schema.String.check(
  Schema.isMaxLength(160),
  Schema.isPattern(/^[a-zA-Z0-9_.:/#@%+-]*$/),
);

export const ClaudeApiErrorDetails = Schema.Struct({
  model: Schema.String.check(Schema.isMaxLength(4096)),
  host: Label,
  path: Schema.String.check(Schema.isMaxLength(256), Schema.isPattern(/^[a-zA-Z0-9_./%~+-]*$/)),
  status: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))),
  errorCode: Label,
  errorType: Label,
  errorText: Schema.String.check(Schema.isMaxLength(200)),
  attempt: Schema.Int.check(Schema.isGreaterThan(0)),
  resume: Schema.Boolean,
});
