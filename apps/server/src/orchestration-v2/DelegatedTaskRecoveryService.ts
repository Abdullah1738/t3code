import type { OrchestrationV2AppThread, OrchestrationV2ProviderFailure, OrchestrationV2Run } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class DelegatedTaskRecoveryService extends Context.Service<DelegatedTaskRecoveryService, {
  readonly shouldResume: (input: {
    readonly thread: OrchestrationV2AppThread;
    readonly run: OrchestrationV2Run;
    readonly failure: OrchestrationV2ProviderFailure;
  }) => Effect.Effect<boolean>;
}>()("t3/DelegatedTaskRecoveryService") {}

export const layer = Layer.succeed(DelegatedTaskRecoveryService, {
  shouldResume: Effect.fn("DelegatedTaskRecoveryService.shouldResume")(function* ({ thread, run, failure }) {
    return thread.lineage?.relationshipToParent === "subagent" && thread.forkedFrom?.type === "node" &&
      failure.category === "transient" && failure.message.startsWith("Claude gave up after repeated API errors.") &&
      run.transientRecovery === undefined && thread.archivedAt === null && thread.deletedAt === null;
  }),
});
