import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaParser from "effect/SchemaParser";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderOptionSelections } from "./model.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const ModelSelectionWire = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
});

const ModelSelectionSource = Schema.Struct({
  provider: Schema.optional(Schema.Unknown),
  instanceId: Schema.optional(Schema.Unknown),
  model: Schema.Unknown,
  options: Schema.optional(Schema.Unknown),
});

const modelSelectionSchema = (normalize: boolean) =>
  ModelSelectionSource.pipe(
    Schema.decodeTo(
      ModelSelectionWire,
      SchemaTransformation.transformEffect({
        decode: (raw) => {
          const instanceIdSource =
            raw.instanceId !== undefined
              ? raw.instanceId
              : typeof raw.provider === "string"
                ? raw.provider
                : undefined;
          const base: Record<string, unknown> = {
            instanceId: instanceIdSource,
            model: raw.model,
          };
          if (raw.options !== undefined) base.options = raw.options;
          // The target schema validates the result. Only executable options
          // need an earlier decode so normalization sees their canonical shape.
          if (!normalize || raw.options === undefined)
            return Effect.succeed(base as typeof ModelSelectionWire.Encoded);
          return Effect.gen(function* () {
            const decoded = yield* SchemaParser.decodeUnknownEffect(ModelSelectionWire)(base);
            const standard = standardModelSelection(decoded);
            if (
              (decoded.options ?? []).some(
                (o) =>
                  (o.id === "serviceTier" && o.value !== "default") ||
                  (o.id === "fastMode" && o.value === true),
              )
            ) {
              yield* Effect.logWarning("Standard mode enforced: fast model options replaced");
            }
            return standard;
          });
        },
        encode: (value: typeof ModelSelectionWire.Encoded) => {
          const base: Record<string, unknown> = {
            instanceId: value.instanceId,
            model: value.model,
          };
          if (value.options !== undefined) base.options = value.options;
          return Effect.succeed(base as typeof ModelSelectionSource.Encoded);
        },
      }),
    ),
  );
/** Recorded usage must retain the tier actually charged. Never use this for execution. */
export const RecordedModelSelection = modelSelectionSchema(false);
export const ModelSelection = modelSelectionSchema(true);
export type ModelSelection = typeof ModelSelection.Type;

/** Standard mode is mandatory, including when a catalog defaults to priority. */
export function standardModelSelection(
  selection: typeof ModelSelectionWire.Type,
  driver?: string,
): typeof ModelSelectionWire.Type {
  const codex = driver === "codex";
  const claude = driver === "claudeAgent";
  const options = (selection.options ?? []).map((option) =>
    option.id === "serviceTier"
      ? { ...option, value: "default" as const }
      : option.id === "fastMode"
        ? { ...option, value: false }
        : option,
  );
  if (codex && !options.some((o) => o.id === "serviceTier"))
    options.push({ id: "serviceTier", value: "default" });
  if (claude && !options.some((o) => o.id === "fastMode"))
    options.push({ id: "fastMode", value: false });
  return { ...selection, ...(options.length > 0 ? { options } : {}) };
}
