import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";

export interface Delivery {
  threadId: ThreadId;
  messageId: string;
  commandId: string;
}

// Filled while planning under the orchestration lock; consumed only after a fresh commit.
// This also covers messages nested inside PR-watch and async-answer commands.
export const current = Context.Reference<Delivery[] | undefined>("MessageDeliveryObservation", {
  defaultValue: () => undefined,
});
