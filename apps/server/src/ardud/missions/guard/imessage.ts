/**
 * The iMessage bridge relays what the owner (or Moni) typed. It runs on its
 * own `spectrum-bridge` component credential. Outside every mission, a control
 * send or answer from it speaks for the owner when it names an inbound
 * iMessage that verifies through the shared inbound ledger (a real message he
 * typed; a relay must carry exactly its text). A thread in a mission never
 * takes the bridge's word as his: sends and answers there are the bridge's own
 * and the send guard judges them as such (a knock). The owner reaches a
 * mission from iMessage through his agent and the mission CLI (an owner
 * request, an answer, a decision), never by relaying into its threads.
 *
 * One iMessage is one action per place: the first write records it with its
 * command, and a retry of that same action returns the recorded result
 * instead of acting again (`inboundActions.ts`). Every other credential
 * (Telegram's included) stays a system session.
 */
import type { MissionId, MissionProvenance, ProviderApprovalDecision } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { componentProvenance, type OriginSession } from "../core/provenance.ts";
import { checkSend } from "../router/guardHook.ts";
import type { SendSender } from "../router/model.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { inboundLedger, type InboundAttempt } from "./inboundActions.ts";

/** The component credential the iMessage bridge runs on. */
export const IMESSAGE_BRIDGE = "spectrum-bridge";

export type OwnerIMessage = Extract<MissionProvenance, { _tag: "owner-imessage" }>;

/**
 * How long after the owner typed it a message may still be relayed as his.
 * The bridge holds messages while the thread is busy, so a turn may run a
 * while before it relays; later than this, it speaks as itself.
 */
const RELAY_WINDOW_MINUTES = 60;

const asTyped = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim();

/** Whether a control session is the iMessage bridge's own credential. */
export const isBridgeSession = (session: OriginSession) =>
  session.origin?._tag === "component" && session.origin.component === IMESSAGE_BRIDGE;

/** Who asks the router about a target's membership; only the target's mission matters. */
const MEMBERSHIP_PROBE: SendSender = {
  _tag: "session",
  sessionId: `component:${IMESSAGE_BRIDGE}`,
  subject: IMESSAGE_BRIDGE,
};

/** An iMessage verified as one owner action, or the replay of the one it already was. */
export interface OwnerAction {
  readonly provenance: OwnerIMessage;
  /** The command the action runs as. A retry reuses the first attempt's. */
  readonly commandId: string;
  /** What the first attempt answered, once it finished; null until then. */
  readonly result: unknown;
  /** Records what the action answered, so a retry returns it. */
  readonly finish: (result: unknown) => Effect.Effect<void>;
}

interface Claim {
  readonly session: OriginSession;
  readonly inboundId: string | undefined;
  readonly threadId: string;
  /** The command id this attempt would run as. */
  readonly commandId: string;
}

/**
 * The owner provenance a bridge write carries, or null when it speaks as
 * itself. Built once from the services present: the shared inbound ledger
 * and the mission store (without one, every thread counts as a mission's and
 * nothing is his).
 */
export const optionalIMessageOwner = Effect.gen(function* () {
  const ledger = yield* inboundLedger;
  const missions = yield* Effect.serviceOption(MissionStore.MissionStore);

  /**
   * The missions a thread belongs to, as the router sees it (masters, lanes,
   * added members and created children) plus the store's own records. The
   * router's check has no side effects.
   */
  const missionsOf = (store: MissionStore.MissionStore["Service"], threadId: string) =>
    Effect.gen(function* () {
      const target = ThreadId.make(threadId);
      const recorded = yield* store.missionsOfThread(target);
      const decision = yield* checkSend({
        path: "control-api",
        targetThreadId: target,
        from: MEMBERSHIP_PROBE,
      });
      const ids = new Set<MissionId>(recorded);
      if (decision._tag !== "not-member") ids.add(decision.missionId);
      return [...ids];
    });

  /** A thread outside every mission; when unsure, it is a mission's. */
  const outsideMissions = (threadId: string) =>
    Option.isNone(missions)
      ? Effect.succeed(false)
      : missionsOf(missions.value, threadId).pipe(
          Effect.map((ids) => ids.length === 0),
          Effect.orElseSucceed(() => false),
        );

  const act = (
    claim: Claim,
    attempt: Omit<InboundAttempt, "caller" | "inboundId" | "commandId">,
  ): Effect.Effect<OwnerAction | null> => {
    const inboundId = claim.inboundId;
    const caller = componentProvenance(claim.session);
    if (!isBridgeSession(claim.session) || inboundId === undefined || caller === null) {
      return Effect.succeed(null);
    }
    return Effect.gen(function* () {
      if (!(yield* outsideMissions(claim.threadId))) {
        yield* Effect.logInfo(
          "missions guard: a mission thread never takes a relay as the owner's word",
          { inboundId, threadId: claim.threadId },
        );
        return null;
      }
      const redeemed = yield* ledger.redeem({
        ...attempt,
        caller,
        inboundId,
        commandId: claim.commandId,
      });
      const action: OwnerAction = {
        provenance: redeemed.provenance,
        commandId: redeemed.commandId ?? claim.commandId,
        result: redeemed._tag === "replay" ? redeemed.result : null,
        finish: redeemed._tag === "replay" ? () => Effect.void : redeemed.finish,
      };
      return action;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logInfo("missions guard: iMessage not verified, the bridge speaks as itself", {
          inboundId,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );
  };

  const windowStart = (at?: DateTime.DateTime) =>
    DateTime.now.pipe(
      Effect.map((now) => {
        const floor = DateTime.subtract(now, { minutes: RELAY_WINDOW_MINUTES });
        return DateTime.formatIso(at === undefined ? floor : DateTime.max(at, floor));
      }),
    );

  return {
    /**
     * A message relayed into a thread outside every mission: his text alone,
     * with nothing attached and no restart of the running turn.
     */
    relay: (
      claim: Claim & {
        readonly text: string;
        readonly attachments: number;
        readonly mode: string | undefined;
      },
    ) =>
      claim.attachments > 0 || (claim.mode !== undefined && claim.mode !== "auto")
        ? Effect.succeed(null)
        : act(claim, {
            subject: `thread:${claim.threadId}`,
            action: "relay",
            payload: { text: asTyped(claim.text) },
            what: "A relayed message",
            notBefore: () => windowStart().pipe(Effect.map((at) => ({ at }))),
            fits: (inbound) =>
              asTyped(inbound.text) === asTyped(claim.text)
                ? null
                : "match the relayed text exactly",
          }),
    /**
     * An answer to a runtime request on a thread outside every mission. A new
     * one verifies only while the request is pending, after it opened (no
     * slack) and within the relay window; a request that already changed
     * state only replays the recorded action.
     */
    answer: (
      claim: Claim & {
        readonly requestId: string;
        readonly open: boolean;
        readonly askedAt: DateTime.DateTime;
        readonly decision: ProviderApprovalDecision | undefined;
        readonly answers: Readonly<Record<string, unknown>> | undefined;
        readonly dismissed: boolean;
      },
    ) =>
      act(claim, {
        subject: `request:${claim.threadId}:${claim.requestId}`,
        action: "respond",
        payload: {
          decision: claim.decision ?? null,
          answers: claim.answers ?? null,
          dismissed: claim.dismissed,
        },
        what: "An answer",
        replayOnly: !claim.open,
        notBefore: () => windowStart(claim.askedAt).pipe(Effect.map((at) => ({ at, skewMs: 0 }))),
      }),
  };
});

export type IMessageOwner = Effect.Success<typeof optionalIMessageOwner>;
