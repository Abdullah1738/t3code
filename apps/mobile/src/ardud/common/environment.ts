import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { FeedFailure } from "@t3tools/client-runtime/ardud/common";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../../connection/catalog";

/**
 * The server the board and iMessage screens read from: the phone is paired to
 * one server, so the first enabled connection.
 */
export const pairedEnvironmentIdAtom = Atom.make((get): EnvironmentId | null => {
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    return environmentId;
  }
  return null;
}).pipe(Atom.withLabel("mobile-paired-environment-id"));

export function usePairedEnvironmentId(): EnvironmentId | null {
  return useAtomValue(pairedEnvironmentIdAtom);
}

/** A feed's read failure and how to retry it; `failure` is unset while it reads fine. */
export interface FeedState {
  readonly failure: FeedFailure | undefined;
  readonly retry: () => void;
}
