import {
  MissionId,
  ThreadId,
  type ModelSelection,
  type MissionProvenance,
  type SuccessionMove,
  type Suggestion,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as MissionService from "../MissionService.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { modelKey } from "./models.ts";
import * as PolicyService from "./PolicyService.ts";
import * as PolicyStore from "./PolicyStore.ts";
import {
  PolicyHandoff,
  PolicySampler,
  PolicySuccession,
  PolicySuggestions,
  PolicyThreads,
} from "./ports.ts";

/** Test-only helpers for the policy service: fake thread, succession and suggestion ports. */

export interface FakeThread {
  exists: boolean;
  idle: boolean;
  modelSelection: ModelSelection | null;
}

export const OWNER: MissionProvenance = {
  _tag: "owner-app",
  surface: "web",
  sessionId: "session-1",
};
export const SYSTEM: MissionProvenance = { _tag: "system", component: "test" };
export const agent = (threadId: string): MissionProvenance => ({
  _tag: "agent",
  threadId: ThreadId.make(threadId),
  roleId: null,
});

export const CRPKO = MissionId.make("crpko");
export const JUNO = MissionId.make("juno");
export const SIDE = MissionId.make("side");

export const makePorts = () => {
  const threads = new Map<string, FakeThread>();
  const setModelCalls: Array<{ threadId: string; model: string }> = [];
  const proposals: Array<Suggestion> = [];
  const moves: ReadonlyArray<SuccessionMove> = [
    { what: "schedules", moved: 1, failed: 0, supported: true },
    { what: "children", moved: 0, failed: 0, supported: false },
  ];
  const launches: Array<{ from: string; title: string; threadId: string; model: string }> = [];
  const briefs: Array<{ threadId: string; text: string; key: string }> = [];
  const subscriptionMoves: Array<{ missionId: string; from: string; to: string }> = [];
  const layer = Layer.mergeAll(
    Layer.succeed(
      PolicyHandoff,
      PolicyHandoff.of({
        launch: (input) =>
          Effect.sync(() => {
            const threadId = ThreadId.make(`thread-launched-${launches.length + 1}`);
            threads.set(threadId, {
              exists: true,
              idle: true,
              modelSelection: input.modelSelection,
            });
            launches.push({
              from: input.from,
              title: input.title,
              threadId,
              model: modelKey(input.modelSelection),
            });
            return threadId;
          }),
        brief: (threadId, text, key) =>
          Effect.sync(() => {
            briefs.push({ threadId, text, key });
          }),
        moveSubscriptions: (missionId, from, to) =>
          Effect.sync(() => {
            subscriptionMoves.push({ missionId, from, to });
            return { what: "subscriptions", moved: 2, failed: 0, supported: true } as const;
          }),
      }),
    ),
    Layer.succeed(
      PolicyThreads,
      PolicyThreads.of({
        view: (threadId) =>
          Effect.sync(() => {
            const thread = threads.get(threadId);
            return thread
              ? { threadId, ...thread }
              : { threadId, exists: false, idle: false, modelSelection: null };
          }),
        setModel: (threadId, modelSelection) =>
          Effect.sync(() => {
            const thread = threads.get(threadId);
            if (thread) thread.modelSelection = modelSelection;
            setModelCalls.push({ threadId, model: modelKey(modelSelection) });
          }),
      }),
    ),
    Layer.succeed(PolicySuccession, PolicySuccession.of({ move: () => Effect.succeed(moves) })),
    Layer.succeed(
      PolicySuggestions,
      PolicySuggestions.of({
        propose: (suggestion) =>
          Effect.sync(() => {
            proposals.push(suggestion);
          }),
      }),
    ),
    Layer.succeed(
      PolicySampler,
      PolicySampler.of({
        sample: () =>
          Effect.succeed({ used: 3, capacity: 10, window: "day", resetsAt: null, runOutAt: null }),
      }),
    ),
  );
  return { threads, setModelCalls, proposals, moves, launches, briefs, subscriptionMoves, layer };
};

export const testLayer = (
  ports: ReturnType<typeof makePorts>["layer"],
  options: Partial<PolicyService.PolicyOptions> = {},
) =>
  PolicyService.makeLayer(options).pipe(
    Layer.provideMerge(PolicyStore.layer),
    Layer.provideMerge(MissionService.layer),
    Layer.provideMerge(ports),
    Layer.provideMerge(MissionStore.layer),
    Layer.provideMerge(Sqlite.layerMemory),
  );
