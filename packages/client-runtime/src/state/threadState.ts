import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { EMPTY_THREAD_HISTORY_META, type ThreadHistoryMeta } from "./threadHistoryMerge.ts";

export type EnvironmentThreadStatus =
  | "empty"
  | "cached"
  | "synchronizing"
  | "live"
  /** Confirmed by a `thread.deleted` event. Retained across navigation. */
  | "deleted"
  /**
   * The server answered "not found" for longer than the grace window (an HTTP
   * miss, not a delete event). Never retained: reopening the thread refetches.
   */
  | "not-found"
  | "no-access";

export interface EnvironmentThreadState {
  readonly data: Option.Option<OrchestrationV2ThreadProjection>;
  readonly status: EnvironmentThreadStatus;
  readonly error: Option.Option<string>;
  /**
   * Errors here are thread/history-local and must not be promoted into the environment
   * disconnect path.
   */
  readonly history: ThreadHistoryMeta;
}

export const EMPTY_ENVIRONMENT_THREAD_STATE: EnvironmentThreadState = {
  data: Option.none(),
  status: "empty",
  error: Option.none(),
  history: EMPTY_THREAD_HISTORY_META,
};
