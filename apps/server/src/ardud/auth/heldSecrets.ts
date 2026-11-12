/**
 * Values the owner typed into a board ask's secret field, waiting for the
 * agent that asked. They are held in this process's memory and nowhere else:
 * nothing here is written to disk, so a server restart drops every one of
 * them and the agent's attempt to use its ref fails as "unavailable".
 *
 * A held value is handed out once, through `SecretRequests.consume`, to the
 * thread it was given to, within a day of being typed.
 */
import { SecretRef, SecretRequestError, type ProjectId, type ThreadId } from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a ref must be unguessable; Effect's Random is not.
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export const HELD_SECRET_TTL_MS = 24 * 60 * 60 * 1000;
/** Values waiting at once. Past it a new one is refused, so memory stays bounded. */
export const HELD_SECRET_MAX = 64;
export const HELD_SECRET_MAX_CHARS = 16 * 1024;

/**
 * The thread a tool call that takes a secretRef runs in. The tool's transport
 * sets it from the calling session; it is never read from the tool's input.
 * Null (the default) is a caller that is no thread, which no held value is for.
 */
export const SecretRedeemer = Context.Reference<ThreadId | null>("ardud/SecretRedeemer", {
  defaultValue: () => null,
});

interface Held {
  readonly projectId: ProjectId | null;
  readonly value: string;
  readonly savedAt: number;
  readonly redeemableBy: (threadId: ThreadId) => Effect.Effect<boolean>;
}

export interface HoldInput {
  /** The project the asking card's threads run in; a ref is not usable from another. */
  readonly projectId: ProjectId | null;
  readonly value: string;
  /** Whether this thread is the one the value was given to. Checked when the ref is used. */
  readonly redeemableBy: (threadId: ThreadId) => Effect.Effect<boolean>;
}

export interface HeldSecrets {
  readonly hold: (
    input: HoldInput,
  ) => Effect.Effect<{ readonly ref: SecretRef; readonly expiresAtMs: number }, SecretRequestError>;
  /** Forgets a value whose answer did not go through. */
  readonly discard: (ref: SecretRef) => Effect.Effect<void>;
  /**
   * The value behind a held ref, removed as it is returned. None when the ref
   * is not held here (the caller then looks in the saved request store).
   */
  readonly take: (input: {
    readonly ref: SecretRef;
    readonly projectId: ProjectId;
  }) => Effect.Effect<Option.Option<string>, SecretRequestError>;
  readonly sweep: Effect.Effect<void>;
  /** How many values are waiting. For tests and metrics; never the values. */
  readonly size: Effect.Effect<number>;
}

export const makeHeldSecrets = (): HeldSecrets => {
  const held = new Map<string, Held>();

  const dropExpired = (now: number) => {
    for (const [ref, entry] of held) {
      if (now - entry.savedAt > HELD_SECRET_TTL_MS) held.delete(ref);
    }
  };

  const hold: HeldSecrets["hold"] = Effect.fn("HeldSecrets.hold")(function* (input) {
    const now = yield* Clock.currentTimeMillis;
    dropExpired(now);
    if (held.size >= HELD_SECRET_MAX) {
      return yield* new SecretRequestError({ reason: "store_failed" });
    }
    const ref = SecretRef.make(`secret-ref:${NodeCrypto.randomBytes(16).toString("hex")}`);
    held.set(ref, {
      projectId: input.projectId,
      value: input.value,
      savedAt: now,
      redeemableBy: input.redeemableBy,
    });
    return { ref, expiresAtMs: now + HELD_SECRET_TTL_MS };
  });

  const take: HeldSecrets["take"] = Effect.fn("HeldSecrets.take")(function* (input) {
    const entry = held.get(input.ref);
    if (entry === undefined) return Option.none<string>();
    if ((yield* Clock.currentTimeMillis) - entry.savedAt > HELD_SECRET_TTL_MS) {
      held.delete(input.ref);
      return yield* new SecretRequestError({ reason: "ref_expired" });
    }
    if (entry.projectId !== null && entry.projectId !== input.projectId) {
      return yield* new SecretRequestError({ reason: "ref_unavailable" });
    }
    const redeemer = yield* SecretRedeemer;
    // A wrong caller is refused and the value stays for the right one.
    if (redeemer === null || !(yield* entry.redeemableBy(redeemer))) {
      return yield* new SecretRequestError({ reason: "ref_other_thread" });
    }
    // One use. Checked again: the answer above may have waited on the board.
    if (!held.delete(input.ref)) {
      return yield* new SecretRequestError({ reason: "ref_unavailable" });
    }
    return Option.some(entry.value);
  });

  return {
    hold,
    take,
    discard: (ref) => Effect.sync(() => void held.delete(ref)),
    sweep: Clock.currentTimeMillis.pipe(Effect.map(dropExpired)),
    size: Effect.sync(() => held.size),
  };
};
