import * as Effect from "effect/Effect";
import * as Scheduler from "effect/Scheduler";

const configured = process.env.T3_KANBAN_TEST_MAX_OPS_BEFORE_YIELD;
const budget = configured === undefined ? undefined : Number(configured);
if (budget !== undefined && (!Number.isSafeInteger(budget) || budget <= 0)) {
  throw new Error("T3_KANBAN_TEST_MAX_OPS_BEFORE_YIELD must be a positive safe integer");
}

/** Apply only to the fixture-race sweep; an unset budget leaves the effect unchanged. */
export const withTestSchedulerBudget = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  budget === undefined
    ? effect
    : Effect.provideService(effect, Scheduler.MaxOpsBeforeYield, budget);
