// @effect-diagnostics nodeBuiltinImport:off - content hashes and stable ids only need sha256.
import * as NodeCrypto from "node:crypto";

import type { MissionActor, MissionLink } from "@t3tools/contracts";

export const sha256 = (text: string): string =>
  NodeCrypto.createHash("sha256").update(text).digest("hex");

/**
 * What makes two posts with the same idempotency key the same post. Hashes
 * what the poster sent, not what the router derived (receipts, expanded
 * audiences), so a retry after the cast changed still matches.
 */
export const contentHashOf = (input: {
  readonly roomId: string;
  readonly kind: string;
  readonly summary: string;
  readonly body: string | null;
  readonly to: ReadonlyArray<MissionActor>;
  readonly workItemId: string | null;
  readonly links: ReadonlyArray<MissionLink>;
  readonly isCorrection: boolean;
}): string =>
  sha256(
    JSON.stringify([
      input.roomId,
      input.kind,
      input.summary,
      input.body ?? "",
      input.to,
      input.workItemId,
      input.links,
      input.isCorrection,
    ]),
  );
