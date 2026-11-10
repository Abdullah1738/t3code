import type {
  OrchestrationV2AppThread,
  OrchestrationV2ProviderFailure,
  OrchestrationV2Run,
  OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ProjectionStoreV2Error } from "./ProjectionStore.ts";

export type LoadDelegatedTask = () => Effect.Effect<
  Pick<OrchestrationV2Subagent, "id" | "origin" | "childThreadId"> | undefined,
  ProjectionStoreV2Error
>;

export class DelegatedTaskRecoveryService extends Context.Service<
  DelegatedTaskRecoveryService,
  {
    readonly shouldResume: (input: {
      readonly thread: OrchestrationV2AppThread;
      readonly run: OrchestrationV2Run;
      readonly failure: OrchestrationV2ProviderFailure;
      readonly loadDelegatedTask?: LoadDelegatedTask;
    }) => Effect.Effect<boolean>;
  }
>()("t3/orchestration-v2/DelegatedTaskRecoveryService") {}

export const layer = Layer.succeed(DelegatedTaskRecoveryService, {
  shouldResume: Effect.fn("DelegatedTaskRecoveryService.shouldResume")(function* ({
    thread,
    run,
    failure,
    loadDelegatedTask,
  }: Parameters<DelegatedTaskRecoveryService["Service"]["shouldResume"]>[0]) {
    if (
      thread.lineage?.relationshipToParent !== "subagent" ||
      thread.forkedFrom?.type !== "node" ||
      failure.category !== "transient" ||
      !failure.message.startsWith("Claude gave up after repeated API errors.") ||
      run.transientRecovery !== undefined ||
      thread.archivedAt !== null ||
      thread.deletedAt !== null
    )
      return false;
    if (run.delegatedTaskId !== undefined) return true;
    // Initial and older child runs may predate the run's delegated-task link.
    if (loadDelegatedTask === undefined) return false;
    const task = yield* Effect.result(loadDelegatedTask());
    return (
      task._tag === "Success" &&
      task.success?.origin === "app_owned" &&
      task.success.id === thread.forkedFrom.nodeId &&
      task.success.childThreadId === thread.id
    );
  }),
});
