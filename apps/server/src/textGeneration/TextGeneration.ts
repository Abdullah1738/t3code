import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Analytics from "../ardud/analytics/Analytics.ts";
import * as Layer from "effect/Layer";
import type { ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { TextGenerationError } from "@t3tools/contracts";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGenerationAnalytics from "./TextGenerationAnalytics.ts";
import * as ThreadTitleLinks from "./ThreadTitleLinks.ts";

export type {
  BranchNameGenerationInput,
  BranchNameGenerationResult,
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
  JsonGenerationInput,
  PrContentGenerationInput,
  PrContentGenerationResult,
  ReviewGuideGenerationInput,
  ReviewGuideGenerationResult,
  ThreadTitleGenerationInput,
  ThreadTitleGenerationResult,
} from "@t3tools/provider-core/server/textGeneration";

export class TextGeneration extends Context.Service<TextGeneration, ProviderTextGeneration>()(
  "t3/textGeneration/TextGeneration",
) {}

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateReviewGuide"
  | "generateJson";

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance["textGeneration"], TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance.textGeneration)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const analytics = yield* Effect.serviceOption(Analytics.Analytics);
  // Retain the optional sink for later calls; observeOperation owns the span.
  const observe = Effect.fnUntraced(function* <A, E, R>(
    operation: string,
    provider: string,
    boardId: string | undefined,
    effect: Effect.Effect<A, E, R>,
  ) {
    const observed = TextGenerationAnalytics.observeOperation(operation, provider, boardId, effect);
    return yield* Option.isSome(analytics)
      ? observed.pipe(Effect.provideService(Analytics.Analytics, analytics.value))
      : observed;
  });
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  return TextGeneration.of({
    generateCommitMessage: (input) =>
      resolveInstance(registry, "generateCommitMessage", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) =>
          observe(
            "generateCommitMessage",
            input.modelSelection.instanceId,
            undefined,
            textGeneration.generateCommitMessage(input),
          ),
        ),
      ),
    generatePrContent: (input) =>
      resolveInstance(registry, "generatePrContent", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) =>
          observe(
            "generatePrContent",
            input.modelSelection.instanceId,
            undefined,
            textGeneration.generatePrContent(input),
          ),
        ),
      ),
    generateBranchName: (input) =>
      resolveInstance(registry, "generateBranchName", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) =>
          observe(
            "generateBranchName",
            input.modelSelection.instanceId,
            undefined,
            textGeneration.generateBranchName(input),
          ),
        ),
      ),
    generateReviewGuide: (input) =>
      resolveInstance(registry, "generateReviewGuide", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) =>
          observe(
            "generateReviewGuide",
            input.modelSelection.instanceId,
            undefined,
            textGeneration.generateReviewGuide(input),
          ),
        ),
      ),
    generateJson: (input) =>
      resolveInstance(registry, "generateJson", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) =>
          textGeneration.generateJson
            ? observe(
                input.operationLabel ? `generateJson:${input.operationLabel}` : "generateJson",
                input.modelSelection.instanceId,
                input.boardId,
                textGeneration.generateJson(input),
              )
            : Effect.fail(
                new TextGenerationError({
                  operation: "generateJson",
                  detail: `Provider instance '${input.modelSelection.instanceId}' has no JSON generation.`,
                }),
              ),
        ),
      ),
    generateThreadTitle: (input) =>
      resolveInstance(registry, "generateThreadTitle", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) =>
          Effect.gen(function* () {
            const linkedContext =
              input.linkedContext ??
              (yield* ThreadTitleLinks.resolveThreadTitleLinks(input).pipe(
                Effect.provideService(
                  SourceControlProviderRegistry.SourceControlProviderRegistry,
                  sourceControl,
                ),
              ));
            return yield* observe(
              "generateThreadTitle",
              input.modelSelection.instanceId,
              input.boardId,
              textGeneration.generateThreadTitle({ ...input, linkedContext }),
            );
          }),
        ),
      ),
  });
});

export const layer = Layer.effect(TextGeneration, make);
