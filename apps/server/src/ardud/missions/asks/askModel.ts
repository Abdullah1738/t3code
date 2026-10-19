/**
 * Owner asks: pure lifecycle rules.
 *
 * Owner direction: "Always wait for my answer. If a master can't decide wait
 * on it. Anything the answer blocks should wait on it, and anything it doesn't
 * and all other lanes should continue freely." So an ask has no default, no
 * deadline and no auto-answer; it names exactly what it blocks, and only those
 * records wait. Only the owner answers.
 */
import {
  isOwnerProvenance,
  type Ask,
  type AskId,
  type AnswerAskInput,
  type MissionActor,
  type MissionProvenance,
  type MissionRecordRef,
  type OpenAskInput,
} from "@t3tools/contracts";
import * as Result from "effect/Result";

import {
  callerActsAs,
  callerIsOwner,
  clipSummary,
  dedupeRefs,
  normalizeText,
  ok,
  recordKey,
  refuse,
  type MissionCaller,
  type Outcome,
  type Transition,
} from "./shared.ts";
import { optionCollision } from "./provenance.ts";

/** Fields that would let an ask resolve itself. Rejected wherever they appear. */
export const FORBIDDEN_ASK_KEYS: ReadonlyArray<string> = [
  "default",
  "defaultAnswer",
  "defaultOption",
  "defaultOptionId",
  "isDefault",
  "deadline",
  "answerBy",
  "expires",
  "expiresAt",
  "timeout",
  "timeoutMs",
  "autoAnswer",
  "autoApprove",
  "fallback",
  "fallbackOptionId",
  "assumeIfSilent",
];

const FORBIDDEN_KEY_SET = new Set(FORBIDDEN_ASK_KEYS.map((key) => key.toLowerCase()));

/** Phrases that make silence an answer. Matched on normalized text. */
const SILENCE_AS_ANSWER = [
  "unless you say otherwise",
  "unless told otherwise",
  "unless i hear otherwise",
  "unless i hear back",
  "unless you object",
  "if i dont hear back",
  "if i dont hear from you",
  "if you dont answer",
  "if you dont reply",
  "if you dont respond",
  "if there is no answer",
  "if no answer",
  "if no reply",
  "if no response",
  "if nobody answers",
  "by default i will",
  "will assume yes",
  "will assume no",
  "proceed by default",
];

const forbiddenKeysIn = (value: unknown): string[] => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.keys(value).filter((key) => FORBIDDEN_KEY_SET.has(key.toLowerCase()));
};

/**
 * Reject defaults and deadlines in the raw command before schema decoding
 * strips unknown keys, so an agent cannot believe it set one.
 */
export const rejectAskDefaults = (raw: unknown): Outcome<void> => {
  const found = new Set(forbiddenKeysIn(raw));
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    for (const key of forbiddenKeysIn(record["recommendation"])) found.add(`recommendation.${key}`);
    const options = record["options"];
    if (Array.isArray(options)) {
      options.forEach((option, index) => {
        for (const key of forbiddenKeysIn(option)) found.add(`options[${index}].${key}`);
      });
    }
  }
  if (found.size > 0) {
    return refuse(
      "invalid",
      `Asks have no default, deadline or auto-answer; they wait for the owner. Remove: ${[...found].join(", ")}.`,
    );
  }
  return ok(undefined);
};

// ardud missions: router (owner requests refuse the same phrases)
export const silencePhraseIn = (text: string): string | null => {
  const normalized = ` ${normalizeText(text)} `;
  for (const phrase of SILENCE_AS_ANSWER) {
    if (normalized.includes(` ${phrase} `)) return phrase;
  }
  return null;
};

/** Kinds an ask may hold. Holding the whole mission would stop every lane. */
const HOLDABLE_KINDS: ReadonlySet<MissionRecordRef["kind"]> = new Set([
  "work-item",
  "lane",
  "sub-mission",
  "milestone",
  "draft",
  "fork",
  "thread",
  "approval",
  "rule-change-request",
]);

export interface OpenAskCommand {
  readonly id: AskId;
  readonly input: OpenAskInput;
  readonly caller: MissionCaller;
  /** The identity it asks as (master role, lane); must be one the caller holds. */
  readonly askedBy: MissionActor;
  /** Asks already in this mission, for dedupe. */
  readonly existing: ReadonlyArray<Ask>;
  readonly now: string;
}

export const sameQuestion = (left: string, right: string): boolean =>
  normalizeText(left) === normalizeText(right);

export const openAsk = (command: OpenAskCommand): Outcome<Transition<Ask>> => {
  const { input, caller } = command;
  if (callerIsOwner(caller)) {
    return refuse("forbidden", "Asks are put to the owner; the owner answers them instead.");
  }
  if (!callerActsAs(caller, command.askedBy)) {
    return refuse("forbidden", "The caller does not hold the identity it asks as.");
  }
  for (const [field, text] of [
    ["question", input.question],
    ["context", input.context],
    ["costOfWaiting", input.costOfWaiting],
    ["recommendation.reason", input.recommendation?.reason ?? ""],
    ...input.options.map((option, index) => [`options[${index}].detail`, option.detail] as const),
  ] as const) {
    const phrase = silencePhraseIn(text);
    if (phrase !== null) {
      return refuse(
        "invalid",
        `Asks wait for the owner; "${phrase}" in ${field} makes silence an answer. Name what it blocks instead.`,
      );
    }
  }
  const blocks = dedupeRefs(input.blocks);
  if (blocks.length === 0) {
    return refuse(
      "invalid",
      "Name what this ask blocks (work items, lanes, sub-missions). Only those wait; everything else continues.",
    );
  }
  const unholdable = blocks.filter((ref) => !HOLDABLE_KINDS.has(ref.kind));
  if (unholdable.length > 0) {
    return refuse(
      "invalid",
      `An ask cannot hold ${unholdable.map(recordKey).join(", ")}; name the work items, lanes or sub-missions it blocks.`,
    );
  }
  const optionIds = new Set<string>();
  for (const option of input.options) {
    if (optionIds.has(option.id)) return refuse("invalid", `Duplicate option id ${option.id}.`);
    optionIds.add(option.id);
  }
  // He answers by naming an option; two options one reply could name are refused here.
  const collision = optionCollision(input.options);
  if (collision !== null) return refuse("invalid", collision);
  const recommendation = input.recommendation ?? null;
  if (
    recommendation !== null &&
    recommendation.optionId !== null &&
    !optionIds.has(recommendation.optionId)
  ) {
    return refuse(
      "invalid",
      `Recommended option ${recommendation.optionId} is not one of the options.`,
    );
  }
  const sameMission = command.existing.filter((ask) => ask.missionId === input.missionId);
  const duplicate = sameMission.find(
    (ask) => ask.status === "open" && sameQuestion(ask.question, input.question),
  );
  if (duplicate !== undefined) {
    return refuse("conflict", `Already asked and still open as ${duplicate.id}.`);
  }
  const priorAnswers = sameMission
    .filter((ask) => ask.status === "answered" && sameQuestion(ask.question, input.question))
    .map((ask) => ({ askId: ask.id, answer: ask.answer?.text ?? null }));

  const record: Ask = {
    id: command.id,
    missionId: input.missionId,
    subMissionId: input.subMissionId ?? null,
    askedBy: command.askedBy,
    question: input.question,
    context: input.context,
    options: input.options,
    recommendation,
    blocks,
    costOfWaiting: input.costOfWaiting,
    urgency: input.urgency ?? "normal",
    status: "open",
    answer: null,
    createdAt: command.now,
    updatedAt: command.now,
    ...(input.view === undefined ? {} : { view: input.view }),
  };
  return ok({
    record,
    events: [
      {
        kind: "ask.opened",
        actor: command.askedBy,
        provenance: caller.provenance,
        summary: clipSummary(`Ask: ${input.question}`),
        subject: askRef(record),
        payload: { blocks, priorAnswers },
      },
    ],
  });
};

export const askRef = (ask: Pick<Ask, "id" | "question">): MissionRecordRef => ({
  kind: "ask",
  id: ask.id,
  label: ask.question,
});

export interface AnswerAskCommand {
  readonly ask: Ask;
  readonly input: AnswerAskInput;
  /** Set by the transport (app session) or by the verified iMessage inbound. */
  readonly provenance: MissionProvenance;
  /** Every ask in the mission, to work out which holds the answer releases. */
  readonly asks: ReadonlyArray<Ask>;
  readonly now: string;
}

export interface AskResolution extends Transition<Ask> {
  /** Records no other open ask holds any more; the router wakes their owners. */
  readonly released: ReadonlyArray<MissionRecordRef>;
}

const optionLabel = (ask: Ask, optionId: string | null): string | null =>
  optionId === null ? null : (ask.options.find((option) => option.id === optionId)?.label ?? null);

export const answerAsk = (command: AnswerAskCommand): Outcome<AskResolution> => {
  const { ask, input, provenance } = command;
  if (!isOwnerProvenance(provenance)) {
    return refuse("provenance-required", "Only the owner answers asks.");
  }
  if (provenance._tag === "owner-imessage" && provenance.inboundId !== input.inboundId) {
    return refuse("provenance-invalid", "The verified inbound does not match this answer.");
  }
  if (ask.id !== input.askId) return refuse("invalid", "Answer is for a different ask.");
  if (ask.status !== "open") return refuse("conflict", `Ask ${ask.id} is ${ask.status}.`);
  if (provenance._tag === "owner-imessage" && spentInbounds(ask).includes(provenance.inboundId)) {
    return refuse(
      "provenance-invalid",
      `iMessage ${provenance.inboundId} answered ask ${ask.id} before it was reopened; it does not answer it again.`,
    );
  }
  const text = input.text.trim();
  if (input.optionId !== null && optionLabel(ask, input.optionId) === null) {
    return refuse("invalid", `Option ${input.optionId} is not one of the ask's options.`);
  }
  if (input.optionId === null && text.length === 0) {
    return refuse("invalid", "Pick an option or write an answer.");
  }
  const record: Ask = {
    ...ask,
    status: "answered",
    answer: { optionId: input.optionId, text, provenance, answeredAt: command.now },
    updatedAt: command.now,
  };
  const released = releasedBy(ask, command.asks);
  const label = optionLabel(ask, input.optionId);
  return ok({
    record,
    released,
    events: [
      {
        kind: "ask.answered",
        actor: { _tag: "owner" },
        provenance,
        summary: clipSummary(
          `Answered ${ask.question}: ${[label, text].filter((part) => part && part.length > 0).join(" - ")}`,
        ),
        subject: askRef(ask),
        payload: {
          optionId: input.optionId,
          text,
          followedRecommendation: followedRecommendation(ask, input.optionId),
          released,
        },
      },
    ],
  });
};

const followedRecommendation = (ask: Ask, optionId: string | null): boolean | null =>
  ask.recommendation === null || ask.recommendation.optionId === null
    ? null
    : ask.recommendation.optionId === optionId;

export interface WithdrawAskCommand {
  readonly ask: Ask;
  readonly caller: MissionCaller;
  readonly reason: string;
  readonly asks: ReadonlyArray<Ask>;
  readonly now: string;
}

/** The asker (or the owner) takes an open ask back; its holds lift. */
export const withdrawAsk = (command: WithdrawAskCommand): Outcome<AskResolution> => {
  const { ask, caller } = command;
  if (!callerIsOwner(caller) && !callerActsAs(caller, ask.askedBy)) {
    return refuse("forbidden", "Only the asker or the owner withdraws an ask.");
  }
  if (ask.status !== "open") return refuse("conflict", `Ask ${ask.id} is ${ask.status}.`);
  const record: Ask = { ...ask, status: "withdrawn", updatedAt: command.now };
  const released = releasedBy(ask, command.asks);
  return ok({
    record,
    released,
    events: [
      {
        kind: "ask.withdrawn",
        actor: callerIsOwner(caller) ? { _tag: "owner" } : ask.askedBy,
        provenance: caller.provenance,
        summary: clipSummary(`Withdrawn: ${ask.question}`),
        subject: askRef(ask),
        payload: { reason: command.reason, released },
      },
    ],
  });
};

export interface SupersedeAskCommand {
  readonly ask: Ask;
  readonly replacement: OpenAskCommand;
}

export interface Supersession {
  readonly superseded: Transition<Ask>;
  readonly replacement: Transition<Ask>;
}

/**
 * The asker rewrites an open ask. The old one is marked superseded and the new
 * one inherits everything it held, so nothing is released in between.
 */
export const supersedeAsk = (command: SupersedeAskCommand): Outcome<Supersession> => {
  const { ask, replacement } = command;
  if (!callerActsAs(replacement.caller, ask.askedBy)) {
    return refuse("forbidden", "Only the asker supersedes an ask.");
  }
  if (ask.status !== "open") return refuse("conflict", `Ask ${ask.id} is ${ask.status}.`);
  if (replacement.input.missionId !== ask.missionId) {
    return refuse("invalid", "A replacement ask stays in the same mission.");
  }
  const opened = openAsk({
    ...replacement,
    input: { ...replacement.input, blocks: [...ask.blocks, ...replacement.input.blocks] },
    existing: replacement.existing.filter((existing) => existing.id !== ask.id),
  });
  if (Result.isFailure(opened)) return Result.fail(opened.failure);
  const now = replacement.now;
  const superseded: Ask = { ...ask, status: "superseded", updatedAt: now };
  return ok({
    superseded: {
      record: superseded,
      events: [
        {
          kind: "ask.superseded",
          actor: ask.askedBy,
          provenance: replacement.caller.provenance,
          summary: clipSummary(`Superseded by ${replacement.id}: ${ask.question}`),
          subject: askRef(ask),
          payload: { supersededBy: replacement.id, released: [] },
        },
      ],
    },
    replacement: {
      record: opened.success.record,
      events: opened.success.events.map((event) => ({
        ...event,
        payload: { ...(event.payload as object), supersedes: ask.id },
      })),
    },
  });
};

export interface ReopenAskCommand {
  readonly ask: Ask;
  readonly provenance: MissionProvenance;
  readonly reason: string;
  readonly now: string;
}

/** The ask's answer epoch: 0 when opened, +1 on every reopen. */
export const askRevisionOf = (ask: Pick<Ask, "revision">): number => ask.revision ?? 0;

type AskClock = Pick<Ask, "revision" | "revisedAt" | "status" | "createdAt" | "updatedAt">;

/**
 * An open ask reopened before asks kept an epoch: no revision, but touched
 * after it opened. Only a reopen moves an open ask's updatedAt.
 */
const reopenedUnversioned = (ask: AskClock): boolean =>
  ask.revision === undefined &&
  ask.status === "open" &&
  Date.parse(ask.updatedAt) > Date.parse(ask.createdAt);

/** When the current epoch began; an answer's evidence must not predate it. */
export const askEpochOf = (ask: AskClock): string =>
  reopenedUnversioned(ask) ? ask.updatedAt : (ask.revisedAt ?? ask.createdAt);

/** Whether the ask was reopened, so its epoch allows no clock skew. */
export const askReopened = (ask: AskClock): boolean =>
  askRevisionOf(ask) > 0 || reopenedUnversioned(ask);

const spentInbounds = (ask: Pick<Ask, "spentInboundIds">): ReadonlyArray<string> =>
  ask.spentInboundIds ?? [];

/**
 * The owner takes an answer back; the ask holds its records again. A new
 * epoch starts, and the iMessage that gave the old answer is spent for this
 * ask, so relaying it again cannot answer the reopened ask.
 */
export const reopenAsk = (command: ReopenAskCommand): Outcome<Transition<Ask>> => {
  const { ask, provenance } = command;
  if (!isOwnerProvenance(provenance)) {
    return refuse("provenance-required", "Only the owner reopens an ask.");
  }
  if (ask.status !== "answered") return refuse("conflict", `Ask ${ask.id} is ${ask.status}.`);
  const evidence = ask.answer?.provenance;
  const spent =
    evidence?._tag === "owner-imessage" && !spentInbounds(ask).includes(evidence.inboundId)
      ? [...spentInbounds(ask), evidence.inboundId]
      : spentInbounds(ask);
  const record: Ask = {
    ...ask,
    status: "open",
    answer: null,
    updatedAt: command.now,
    revision: askRevisionOf(ask) + 1,
    revisedAt: command.now,
    spentInboundIds: spent,
  };
  return ok({
    record,
    events: [
      {
        kind: "ask.reopened",
        actor: { _tag: "owner" },
        provenance,
        summary: clipSummary(`Reopened: ${ask.question}`),
        subject: askRef(ask),
        payload: { reason: command.reason, previousAnswer: ask.answer, epoch: record.revision },
      },
    ],
  });
};

// ---------------------------------------------------------------------------
// Holds: which records wait on which asks.

/** Open asks holding `ref`. Anything not listed in an open ask's `blocks` is free. */
export const asksHolding = (
  ref: Pick<MissionRecordRef, "kind" | "id">,
  asks: ReadonlyArray<Ask>,
): Ask[] => {
  const key = recordKey(ref);
  return asks.filter(
    (ask) => ask.status === "open" && ask.blocks.some((block) => recordKey(block) === key),
  );
};

/** Every held record key mapped to the open asks holding it. */
export const holdIndex = (asks: ReadonlyArray<Ask>): ReadonlyMap<string, ReadonlyArray<AskId>> => {
  const index = new Map<string, AskId[]>();
  for (const ask of asks) {
    if (ask.status !== "open") continue;
    for (const block of ask.blocks) {
      const key = recordKey(block);
      const held = index.get(key) ?? [];
      if (!held.includes(ask.id)) held.push(ask.id);
      index.set(key, held);
    }
  }
  return index;
};

/** "waiting on ask X" for a held record, or null when it is free to run. */
export const waitingOn = (
  ref: Pick<MissionRecordRef, "kind" | "id">,
  asks: ReadonlyArray<Ask>,
): string | null => {
  const holding = asksHolding(ref, asks);
  if (holding.length === 0) return null;
  return holding.map((ask) => `waiting on ask ${ask.id}: ${ask.question}`).join("; ");
};

/** Blocks of `ask` that no other open ask still holds once `ask` resolves. */
export const releasedBy = (ask: Ask, asks: ReadonlyArray<Ask>): MissionRecordRef[] => {
  const others = asks.filter((other) => other.id !== ask.id);
  return ask.blocks.filter((block) => asksHolding(block, others).length === 0);
};

/**
 * Share of answered asks with a recommendation that went the recommended way.
 * Above 90% the scribe may suggest a standing rule; the owner decides.
 */
export const recommendationFollowRate = (
  asks: ReadonlyArray<Ask>,
): { readonly answered: number; readonly followed: number } => {
  let answered = 0;
  let followed = 0;
  for (const ask of asks) {
    if (ask.status !== "answered" || ask.answer === null) continue;
    const verdict = followedRecommendation(ask, ask.answer.optionId);
    if (verdict === null) continue;
    answered += 1;
    if (verdict) followed += 1;
  }
  return { answered, followed };
};
