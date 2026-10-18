/**
 * Connects asks to the tracks built on it, without a layer cycle: policy and
 * core depend on asks, so they register into asks at startup instead.
 *
 * - Suggestion appliers: policy kinds through `appliersFor(policy)`, core
 *   kinds through `makeCoreAppliers`. Draft notes apply inside asks.
 * - The scribe's editor proposes through `AsksService.proposeSuggestion`, so
 *   its suggestions get the same bars, dedupe and acceptor as every author's.
 * - At startup, accepted suggestions left without an outcome apply.
 */
import { SuggestionId, type SuggestionTargetKind } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import { forkParked } from "../../../serverActivation.ts";
import * as RuleService from "../core/RuleService.ts";
import * as MissionService from "../MissionService.ts";
import { appliersFor } from "../policy/appliers.ts";
import * as PolicyService from "../policy/PolicyService.ts";
import { EDITOR_PROVENANCE } from "../scribe/ScribeService.ts";
import * as ScribeService from "../scribe/ScribeService.ts";
import * as MissionStore from "../store/MissionStore.ts";
import * as AsksService from "./AsksService.ts";
import { CORE_SUGGESTION_KINDS, makeCoreAppliers } from "./coreAppliers.ts";
import * as Ports from "./ports.ts";

const POLICY_SUGGESTION_KINDS = (
  Object.entries(Ports.SUGGESTION_OWNERS) as Array<[SuggestionTargetKind, string]>
).flatMap(([kind, owner]) => (owner === "policy" ? [kind] : []));

/** Registers the core and policy appliers; draft notes need none. */
export const registerSuggestionAppliers = Effect.gen(function* () {
  const registry = yield* Ports.SuggestionApplierRegistry;
  const store = yield* MissionStore.MissionStore;
  const missions = yield* MissionService.MissionService;
  const rules = yield* RuleService.RuleService;
  const schedules = yield* ScheduledTaskService.ScheduledTaskService;
  const policy = yield* PolicyService.PolicyService;

  yield* registry.register(
    CORE_SUGGESTION_KINDS,
    makeCoreAppliers({ store, missions, rules, schedules }),
  );
  yield* registry.register(POLICY_SUGGESTION_KINDS, appliersFor(policy).apply);
});

/** Sends the editor's suggestions through asks instead of straight to the store. */
export const routeEditorSuggestions = Effect.gen(function* () {
  const asks = yield* AsksService.AsksService;
  const scribe = yield* ScribeService.ScribeService;
  yield* scribe.routeSuggestions((missionId, draft) =>
    asks.proposeSuggestion(
      {
        missionId,
        targetKind: draft.targetKind,
        target: draft.target,
        title: draft.title,
        after: draft.after,
        diffText: draft.diffText,
        why: draft.why,
        evidence: draft.evidence,
        acceptor: draft.acceptor,
      },
      EDITOR_PROVENANCE,
      { id: SuggestionId.make(draft.id) },
    ),
  );
});

/**
 * Once the server is up, applies accepted suggestions a previous process left
 * without an outcome. Runs after the appliers register, so every kind applies.
 */
export const sweepPendingSuggestions = Effect.gen(function* () {
  const asks = yield* AsksService.AsksService;
  yield* forkParked(
    asks.applyPendingSuggestions.pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("missions asks: startup suggestion sweep failed", {
            cause: Cause.pretty(cause),
          }),
      ),
    ),
  );
});

export const asksWiringLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* registerSuggestionAppliers;
    yield* routeEditorSuggestions;
    yield* sweepPendingSuggestions;
  }),
);
