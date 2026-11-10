/**
 * Card waits: a card with no running thread says, as data, what it is waiting
 * on. Everything here is pure. The tick gathers the facts (PR states, the
 * other cards, the clock), calls `resolveWait` per waiting card and applies
 * what comes back; the tool validates with `checkWait` and builds with
 * `newWait`.
 */
import {
  KANBAN_DONE_STAGES,
  KANBAN_WAIT_LIMIT_MS,
  kanbanAwaitsMerge,
  kanbanEvaluatorStep,
  kanbanOpenAsks,
  kanbanScriptStep,
  kanbanWait,
  kanbanWaitDeadlineMs,
  kanbanWaitExpired,
  kanbanWaitStale,
  kanbanWaiting,
  kanbanWithoutWait,
  type KanbanActor,
  type KanbanCard,
  type KanbanCardEvent,
  type KanbanStage,
  type KanbanWait,
  type KanbanWaitKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** How long each kind may hold before the card shows as stuck (shared with the clients). */
export const WAIT_LIMIT_MS = KANBAN_WAIT_LIMIT_MS;

/** The furthest ahead a `time` wait, or any wait's own deadline, may be set. */
export const WAIT_MAX_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * False until the tick calls `resolveWait` and the planner skips waiting cards
 * (`waitHoldsDispatch`). While false nothing ends a wait by itself and the
 * dispatcher would start a waiting To-Do or Needs Review card anyway, so
 * `checkWait` refuses those stages and the tool says waits don't wake yet.
 */
export const WAITS_ENGINE_WIRED = false;

/** Stages where the engine as it is today leaves a thread-less card alone. */
const QUIET_STAGES: ReadonlySet<KanbanStage> = new Set([
  "in_review",
  "completed",
  "deployed",
  "needs_owner",
]);

export type WaitRole = "work" | "review" | "evaluator";

/** What the tick knows about one pull request. */
export interface WaitPrFacts {
  readonly url: string;
  readonly state: "open" | "draft" | "merged" | "closed";
  /** Its head commit, when the source knows it. Absent or null: unknown. */
  readonly head?: string | null | undefined;
  /** Commits added since the wait's `sinceHead`, when the source counted them. */
  readonly commitsSince?: number | null | undefined;
  /** Checks on the head commit. Absent or null: none reported. */
  readonly checks?: "passing" | "failing" | "pending" | null | undefined;
}

export interface WaitFacts {
  readonly nowMs: number;
  /** Every pull request the tick has a reading for, by URL. One not listed is unknown, not gone. */
  readonly prs: ReadonlyArray<WaitPrFacts>;
  /** The board's cards by id. A card not in the map is gone. */
  readonly cards: ReadonlyMap<
    string,
    Pick<KanbanCard, "id" | "number" | "stage" | "settledAt" | "subtasks">
  >;
}

export type WaitVerdict =
  | { readonly over: false }
  | {
      readonly over: true;
      /** `met`: what it waited for happened. `failed`: it ended the bad way. `moot`: it can't happen any more. */
      readonly outcome: "met" | "failed" | "moot";
      /** One sentence, fit for a wake note. */
      readonly reason: string;
    };

const HOLD: WaitVerdict = { over: false };
const over = (outcome: "met" | "failed" | "moot", reason: string): WaitVerdict => ({
  over: true,
  outcome,
  reason,
});

/** "trading-core#544" from a pull request URL; the URL itself when it isn't one. */
export function prName(url: string): string {
  const match = /\/([^/]+)\/(?:pull|pulls|merge_requests)\/(\d+)/.exec(url);
  return match ? `${match[1]}#${match[2]}` : url;
}

const shortSha = (sha: string) => sha.trim().slice(0, 7);

/** Two readings of one commit: agents write short shas, hosts report full ones. */
export function sameCommit(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x.length < 7 || y.length < 7) return x === y;
  return x.startsWith(y) || y.startsWith(x);
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** What a wait is waiting for, to finish "waiting on ...". */
export function waitTarget(wait: KanbanWait, cards?: WaitFacts["cards"]): string {
  switch (wait.on) {
    case "push":
      return `the author to push to ${wait.pr === null ? "the PR" : prName(wait.pr)}`;
    case "merge":
      return `${wait.pr === null ? "the PR" : prName(wait.pr)} to merge`;
    case "ci":
      return `CI on ${wait.pr === null ? "the PR" : prName(wait.pr)}`;
    case "owner_go":
      return `the owner's answer${wait.ask === null ? "" : ` to ${wait.ask}`}`;
    case "card": {
      const target = wait.card === null ? undefined : cards?.get(wait.card);
      return target ? `card #${target.number}` : "another card";
    }
    case "time":
      return wait.until === null ? "a set time" : `${wait.until}`;
  }
}

function prVerdict(wait: KanbanWait, pr: WaitPrFacts): WaitVerdict {
  const name = prName(pr.url);
  const head = pr.head ?? null;
  const at = head === null ? "" : ` at ${shortSha(head)}`;
  switch (wait.on) {
    case "push": {
      if (pr.state === "merged") return over("moot", `${name} merged while this waited for a push`);
      if (pr.state === "closed")
        return over("moot", `${name} was closed while this waited for a push`);
      // Without both commits there is nothing to compare; the wait holds until it expires.
      if (head === null || wait.sinceHead === null || sameCommit(head, wait.sinceHead)) return HOLD;
      const count = pr.commitsSince ?? null;
      return over(
        "met",
        count !== null && count > 0
          ? `The author pushed ${plural(count, "commit")} to ${name} (head ${shortSha(head)})`
          : `The author pushed to ${name}: its head moved from ${shortSha(wait.sinceHead)} to ${shortSha(head)}`,
      );
    }
    case "merge":
      if (pr.state === "merged") return over("met", `${name} merged`);
      if (pr.state === "closed") return over("failed", `${name} was closed without merging`);
      return HOLD;
    case "ci":
      if (pr.state === "merged") return over("moot", `${name} merged while this waited for CI`);
      if (pr.state === "closed") return over("moot", `${name} was closed while this waited for CI`);
      if (pr.checks === "passing") return over("met", `CI passed on ${name}${at}`);
      if (pr.checks === "failing") return over("failed", `CI failed on ${name}${at}`);
      return HOLD;
    default:
      return HOLD;
  }
}

/**
 * Whether the card's wait is over, and why. Facts the tick has no reading for
 * (a PR it could not read) never end a wait: unknown is not done.
 */
export function waitSatisfied(
  card: Pick<KanbanCard, "wait" | "asks">,
  facts: WaitFacts,
): WaitVerdict {
  const wait = kanbanWait(card);
  if (wait === null) return HOLD;
  switch (wait.on) {
    case "push":
    case "merge":
    case "ci": {
      const pr = wait.pr === null ? undefined : facts.prs.find((entry) => entry.url === wait.pr);
      return pr === undefined ? HOLD : prVerdict(wait, pr);
    }
    case "owner_go": {
      if (wait.ask === null) return HOLD;
      const ask = card.asks.find((entry) => entry.id === wait.ask);
      if (ask === undefined) return over("moot", `Question ${wait.ask} is no longer on the card`);
      return ask.closedAt === null
        ? HOLD
        : over("met", `Question ${ask.id} was answered or dropped`);
    }
    case "card": {
      if (wait.card === null) return HOLD;
      const target = facts.cards.get(wait.card);
      if (target === undefined) return over("moot", "The card it waited on is gone");
      if (target.settledAt !== null) return over("met", `Card #${target.number} is settled`);
      // Like blockedBy: completed still holds while its merge subtask is open.
      if (KANBAN_DONE_STAGES.has(target.stage) && !kanbanAwaitsMerge(target)) {
        return over("met", `Card #${target.number} is done`);
      }
      return HOLD;
    }
    case "time": {
      const until = wait.until === null ? Number.NaN : Date.parse(wait.until);
      // A time wait with no readable time can never end by itself, so it ends now.
      if (!Number.isFinite(until)) return over("moot", "The wait had no time set");
      return facts.nowMs >= until ? over("met", "The time you set has passed") : HOLD;
    }
  }
}

/** When the wait counts as stuck, or null for one that can't. */
export const waitDeadlineMs = kanbanWaitDeadlineMs;

/**
 * A wait that held past its limit with nothing happening. It keeps holding and
 * still ends normally; the card just stops hiding behind it.
 */
export const waitExpired = (card: Pick<KanbanCard, "wait">, nowMs: number): boolean => {
  const wait = kanbanWait(card);
  return wait !== null && kanbanWaitExpired(wait, nowMs);
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** "3d", "5h", "40m": how long something has gone on. */
export function waitedFor(sinceIso: string, nowMs: number): string {
  const ms = Math.max(0, nowMs - Date.parse(sinceIso));
  if (!Number.isFinite(ms)) return "a while";
  if (ms >= DAY_MS) return `${Math.floor(ms / DAY_MS)}d`;
  if (ms >= HOUR_MS) return `${Math.floor(ms / HOUR_MS)}h`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m`;
}

type WaitingFields = Pick<KanbanCard, "wait" | "activeThreadId" | "settledAt" | "movedAt">;

// What a waiting card means for the rest of the engine. A waiting card keeps
// its stage: none of these move it, and only `resolveWait` ends the wait.

/** The planner and card_claim skip it: a waiting card is not started or taken. */
export const waitHoldsDispatch = (card: WaitingFields) => kanbanWaiting(card);

/** No quiet-thread nudge and no evaluator reminder for it. */
export const waitSkipsNudge = (card: WaitingFields) => kanbanWaiting(card);

/** Not idle and not stalled in any count or sweep, until the wait runs past its limit. */
export const waitHidesIdle = (card: WaitingFields, nowMs: number) =>
  kanbanWaiting(card) && !waitExpired(card, nowMs);

/**
 * A waiting card holds no pool slot. `poolThreads` counts cards with an active
 * thread and pool, and a wait is only ever set on a card with neither; this
 * names a card that breaks that, or returns null.
 */
export function waitSlotProblem(
  card: Pick<KanbanCard, "wait" | "number" | "activeThreadId" | "activePool">,
): string | null {
  if (card.wait === undefined) return null;
  if (card.activeThreadId !== null) return `card #${card.number} has a wait and a running thread`;
  if (card.activePool !== null) return `card #${card.number} has a wait and holds a pool slot`;
  return null;
}

/** The card event a wait change writes. */
export interface WaitEvent {
  readonly kind: Extract<KanbanCardEvent["kind"], "wait_set" | "wait_cleared" | "wait_expired">;
  readonly body: string;
  readonly fromStage: KanbanStage | null;
  readonly toStage: KanbanStage | null;
}

/** Who to wake, and how. The card patch already carries a worker's or reviewer's wake. */
export type WaitWake =
  /** The card is back in To-Do with the note as its wake note: the dispatcher wakes its worker. */
  | { readonly to: "work"; readonly note: string }
  /** The card is back in Needs Review with the note as its wake note: the dispatcher starts its reviewer. */
  | { readonly to: "review"; readonly note: string }
  /** The card stays put: send the text to the card discussion's evaluator. */
  | { readonly to: "evaluator"; readonly text: string }
  /** Nobody: whoever acts next already heard (the asker got the owner's answer, the board completes the card). */
  | { readonly to: "none"; readonly why: string };

export interface WaitContext {
  /** Steps in the card's review chain (`chainFor(board, card)?.steps.length ?? 1`). */
  readonly chainLength: number;
}

const reviewFinished = (card: Pick<KanbanCard, "reviewStep">, chainLength: number) =>
  card.reviewStep >= Math.max(chainLength, 1);

/**
 * Who acts next on a card in its stage: the worker in To-Do (unless the step
 * is the evaluator's or a script's), the reviewer for a card in or awaiting
 * review whose chain hasn't passed, the evaluator for everything else.
 */
export function nextActor(
  card: Pick<KanbanCard, "stage" | "reviewStep" | "subtasks">,
  ctx: WaitContext,
): WaitRole {
  switch (card.stage) {
    case "todo":
    case "working":
      return kanbanEvaluatorStep(card) || kanbanScriptStep(card) ? "evaluator" : "work";
    case "needs_review":
      return "review";
    case "in_review":
      return reviewFinished(card, ctx.chainLength) ? "evaluator" : "review";
    default:
      return "evaluator";
  }
}

/** A worker or reviewer can only be woken where it has something to go back to. */
function wakeRoleFor(card: KanbanCard, wait: KanbanWait, ctx: WaitContext): WaitRole {
  const role = wait.wakeRole ?? nextActor(card, ctx);
  const open = card.stage === "todo" || card.stage === "needs_review" || card.stage === "in_review";
  if (role === "work" && !(open || card.stage === "working")) return "evaluator";
  if (role === "review" && !open) return "evaluator";
  return role;
}

const joinNotes = (...parts: ReadonlyArray<string | null>) =>
  parts.filter((part): part is string => part !== null && part.trim() !== "").join("\n\n");

const quoted = (note: string) => (note.trim() ? ` ("${note.trim()}")` : "");

/** Every state-tracked PR on the card has landed, reading the tick's facts over the stored states. */
function prsLandWith(card: Pick<KanbanCard, "links">, facts: WaitFacts): boolean {
  return card.links
    .filter((link) => link.kind === "pr" && link.state !== null)
    .every((link) => {
      const state = facts.prs.find((pr) => pr.url === link.url)?.state ?? link.state;
      return state === "merged" || state === "closed";
    });
}

export interface WaitEnd {
  readonly card: KanbanCard;
  readonly event: WaitEvent;
  readonly wake: WaitWake;
}

/**
 * Ends a card's wait: the wait comes off, and whoever acts next is woken with
 * the reason. Returns the card to save, the event to log and the wake to send.
 */
export function endWait(
  card: KanbanCard,
  verdict: Extract<WaitVerdict, { over: true }>,
  facts: WaitFacts,
  ctx: WaitContext,
  at: string,
): WaitEnd {
  const wait = kanbanWait(card);
  const cleared: KanbanCard = { ...kanbanWithoutWait(card), updatedAt: at };
  if (wait === null) {
    return {
      card,
      event: { kind: "wait_cleared", body: verdict.reason, fromStage: null, toStage: null },
      wake: { to: "none", why: "the card had no wait" },
    };
  }
  const was = `It was waiting on ${waitTarget(wait, facts.cards)}${quoted(wait.note)}.`;
  const event = (toStage: KanbanStage): WaitEvent => ({
    kind: "wait_cleared",
    body: verdict.reason,
    fromStage: card.stage === toStage ? null : card.stage,
    toStage: card.stage === toStage ? null : toStage,
  });
  // The asker of an owner question gets the answer from the ask itself.
  if (wait.on === "owner_go" && wait.wakeRole === null) {
    return {
      card: cleared,
      event: event(card.stage),
      wake: { to: "none", why: "the owner's answer already went to whoever asked" },
    };
  }
  // A reviewed card whose last PR just merged is completed by the board's own PRs-landed step.
  if (
    wait.on === "merge" &&
    wait.wakeRole === null &&
    verdict.outcome === "met" &&
    card.stage === "in_review" &&
    reviewFinished(card, ctx.chainLength) &&
    prsLandWith(card, facts)
  ) {
    return {
      card: cleared,
      event: event(card.stage),
      wake: { to: "none", why: "the board moves the card on now that its PRs landed" },
    };
  }
  const role = wakeRoleFor(card, wait, ctx);
  if (role === "work") {
    const note = `${verdict.reason}. ${was} Carry on with card #${card.number}.`;
    return {
      card: {
        ...cleared,
        stage: "todo",
        wakeNote: joinNotes(card.wakeNote, note),
        movedAt: card.stage === "todo" ? card.movedAt : at,
      },
      event: event("todo"),
      wake: { to: "work", note },
    };
  }
  if (role === "review") {
    const note = `${verdict.reason}. ${was} Review card #${card.number} again from its current head.`;
    return {
      card: {
        ...cleared,
        stage: "needs_review",
        // New commits restart the chain; otherwise the step it was on runs again.
        reviewStep:
          wait.on === "push" ? 0 : Math.min(card.reviewStep, Math.max(ctx.chainLength, 1) - 1),
        wakeNote: joinNotes(card.wakeNote, note),
        movedAt: card.stage === "needs_review" ? card.movedAt : at,
      },
      event: event("needs_review"),
      wake: { to: "review", note },
    };
  }
  return {
    card: cleared,
    event: event(card.stage),
    wake: {
      to: "evaluator",
      text: `Card #${card.number} (${card.title || "untitled"}, in ${card.stage}) is no longer waiting: ${verdict.reason}. ${was} Take its next step, or set a new wait with card_wait if it still has to hold.`,
    },
  };
}

/**
 * Marks a wait that ran past its limit, once. The wait stays (it can still end
 * normally); the card shows as stuck and the evaluator is told why.
 */
export function expireWait(card: KanbanCard, facts: WaitFacts, at: string): WaitEnd | null {
  const wait = kanbanWait(card);
  if (wait === null || wait.expiredAt !== null || !kanbanWaitExpired(wait, facts.nowMs))
    return null;
  const waited = `Waited ${waitedFor(wait.at, facts.nowMs)} on ${waitTarget(wait, facts.cards)} with no change${quoted(wait.note)}`;
  return {
    card: { ...card, wait: { ...wait, expiredAt: at }, updatedAt: at },
    event: { kind: "wait_expired", body: waited, fromStage: null, toStage: null },
    wake: {
      to: "evaluator",
      text: `Card #${card.number} (${card.title || "untitled"}, in ${card.stage}) is stuck: ${waited.charAt(0).toLowerCase()}${waited.slice(1)}. Chase it, set a new wait with card_wait, or clear the wait and move the card on.`,
    },
  };
}

export type WaitStep =
  /** No wait, or a thread runs the card: nothing to do. */
  | { readonly _tag: "none" }
  /** Still waiting. */
  | { readonly _tag: "hold" }
  /** The wait is over: save the card, log the event, send the wake. */
  | ({ readonly _tag: "end" } & WaitEnd)
  /** The wait ran past its limit: save the card, log the event, tell the evaluator. */
  | ({ readonly _tag: "expire" } & WaitEnd);

/**
 * The one call the tick makes per card, after its PR sync: what to do about
 * the card's wait right now. Ending wins over expiring.
 */
export function resolveWait(
  card: KanbanCard,
  facts: WaitFacts,
  ctx: WaitContext,
  at: string,
): WaitStep {
  if (card.wait !== undefined && card.activeThreadId === null && kanbanWaitStale(card)) {
    // Someone moved the card after the wait was set: they have it now.
    return {
      _tag: "end",
      card: { ...kanbanWithoutWait(card), updatedAt: at },
      event: {
        kind: "wait_cleared",
        body: `The card was moved to ${card.stage} while it waited on ${waitTarget(card.wait, facts.cards)}`,
        fromStage: null,
        toStage: null,
      },
      wake: { to: "none", why: "whoever moved the card has it" },
    };
  }
  if (!kanbanWaiting(card)) return { _tag: "none" };
  const verdict = waitSatisfied(card, facts);
  if (verdict.over) return { _tag: "end", ...endWait(card, verdict, facts, ctx, at) };
  const expired = expireWait(card, facts, at);
  return expired === null ? { _tag: "hold" } : { _tag: "expire", ...expired };
}

/** Cards whose wait is on `cardId`, for a caller that knows that card just finished. */
export const waitersOn = (
  cards: ReadonlyArray<KanbanCard>,
  cardId: string,
): ReadonlyArray<KanbanCard> =>
  cards.filter(
    (card) => kanbanWaiting(card) && card.wait?.on === "card" && card.wait.card === cardId,
  );

/** What card_wait asks for, with the PR and card already found. */
export interface WaitRequest {
  readonly on: KanbanWaitKind;
  readonly note: string;
  /** push, merge, ci: the PR's URL. */
  readonly pr?: string | null | undefined;
  /** card: the card to wait on. */
  readonly card?:
    | Pick<KanbanCard, "id" | "number" | "stage" | "settledAt" | "subtasks">
    | null
    | undefined;
  /** owner_go: the open ask's id. */
  readonly ask?: string | null | undefined;
  readonly until?: string | null | undefined;
  /** push: the commit that was reviewed. */
  readonly sinceHead?: string | null | undefined;
  readonly wakeRole?: WaitRole | null | undefined;
}

export type WaitCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "invalid" | "denied"; readonly reason: string };

const bad = (reason: string): WaitCheck => ({ ok: false, code: "invalid", reason });
const denied = (reason: string): WaitCheck => ({ ok: false, code: "denied", reason });

/** A thread clears only its own stalled flag; the owner, evaluators and the board clear any. */
export const mayClearFlag = (card: Pick<KanbanCard, "stalled">, actor: KanbanActor): boolean => {
  const by = card.stalled?.by;
  if (by === undefined || actor._tag !== "thread") return true;
  return by._tag === "thread" && by.threadId === actor.threadId;
};

/**
 * The PR link on a card that `ref` names: its URL, "#544", "544" or
 * "trading-core#544". Null when none matches; "ambiguous" when several do.
 */
export function findPrLink(
  card: Pick<KanbanCard, "links">,
  ref: string,
): KanbanCard["links"][number] | "ambiguous" | null {
  const prs = card.links.filter((link) => link.kind === "pr");
  const wanted = ref.trim();
  const exact = prs.find((link) => link.url === wanted);
  if (exact !== undefined) return exact;
  const match = /^(?:([\w.-]+)#|#)?(\d+)$/.exec(wanted);
  if (match === null) return null;
  const [, repo, number] = match;
  const found = prs.filter((link) => {
    const name = prName(link.url);
    if (name === link.url) return false;
    const [linkRepo, linkNumber] = name.split("#");
    return linkNumber === number && (repo === undefined || repo === linkRepo);
  });
  return found.length === 0 ? null : found.length === 1 ? found[0]! : "ambiguous";
}

/** Why a wait can't be set on a card as asked, or ok. */
export function checkWait(
  card: KanbanCard,
  request: WaitRequest,
  actor: KanbanActor,
  nowMs: number,
  wired: boolean = WAITS_ENGINE_WIRED,
): WaitCheck {
  const n = `card #${card.number}`;
  if (card.settledAt !== null) return denied(`${n} is settled`);
  if (card.stage === "verified") return denied(`${n} is verified: nothing left to wait for`);
  if (card.activeThreadId !== null) {
    return denied(
      `${n} has a running thread, so it isn't waiting. Set the wait once the thread has handed the card on`,
    );
  }
  // A wait takes over a stalled flag, but only one its setter could clear (the card_flag rule).
  if (!mayClearFlag(card, actor)) {
    return denied(`${n} was flagged stalled by someone else; only they can change or clear it`);
  }
  if (!wired && !QUIET_STAGES.has(card.stage)) {
    return denied(
      `${n} is in ${card.stage}, where the dispatcher would start it anyway: waits there are not honoured yet. For To-Do use blockedBy (card_edit); for the rest use card_flag with the reason`,
    );
  }
  if (!request.note.trim()) return bad("a wait needs a one-line note: what exactly is awaited");
  let until: number | null = null;
  if (request.until != null) {
    until = Date.parse(request.until);
    if (!Number.isFinite(until)) return bad(`until is not a time: ${request.until}`);
    if (until <= nowMs) return bad("until is in the past");
    if (until - nowMs > WAIT_MAX_AHEAD_MS) return bad("until is more than 30 days ahead");
  }
  switch (request.on) {
    case "push":
    case "merge":
    case "ci": {
      const prs = card.links.filter((link) => link.kind === "pr");
      if (prs.length === 0) return bad(`${n} has no pull request link: attach it first (links)`);
      if (!request.pr) {
        return bad(`say which pull request: ${prs.map((link) => prName(link.url)).join(", ")}`);
      }
      const link = prs.find((entry) => entry.url === request.pr);
      if (link === undefined) {
        return bad(
          `${n} has no pull request ${prName(request.pr)}; it has ${prs.map((entry) => prName(entry.url)).join(", ")}`,
        );
      }
      if (link.state === "merged" || link.state === "closed") {
        return bad(`${prName(link.url)} is already ${link.state}: nothing to wait for`);
      }
      if (request.on === "push" && !request.sinceHead?.trim()) {
        return bad(
          "a push wait needs head: the commit that was reviewed (the PR's head sha now), so the board can tell when it moves",
        );
      }
      return { ok: true };
    }
    case "owner_go": {
      const open = kanbanOpenAsks(card);
      if (!request.ask) {
        return bad(
          open.length === 0
            ? "an owner_go wait points at an open question: ask it first with card_ask, then pass its id (q1, q2...) as ask"
            : `say which open question: ${open.map((ask) => ask.id).join(", ")}`,
        );
      }
      if (!open.some((ask) => ask.id === request.ask)) {
        return bad(
          `${n} has no open question ${request.ask}: ask the owner with card_ask first, then wait on its id`,
        );
      }
      return { ok: true };
    }
    case "card": {
      if (!request.card) return bad("say which card to wait on (waitsOn)");
      if (request.card.id === card.id) return bad("a card can't wait on itself");
      if (request.card.settledAt !== null) {
        return bad(`card #${request.card.number} is already settled: nothing to wait for`);
      }
      if (KANBAN_DONE_STAGES.has(request.card.stage) && !kanbanAwaitsMerge(request.card)) {
        return bad(`card #${request.card.number} is already done: nothing to wait for`);
      }
      return { ok: true };
    }
    case "time":
      return until === null ? bad("a time wait needs until") : { ok: true };
  }
}

/** A time as the board stores every timestamp (UTC), whatever zone it was written in. */
const utcIso = (time: string | null | undefined): KanbanWait["until"] => {
  const ms = time == null ? Number.NaN : Date.parse(time);
  return Number.isFinite(ms) ? DateTime.formatIso(DateTime.makeUnsafe(ms)) : null;
};

/** The wait to store for a checked request. */
export function newWait(request: WaitRequest, by: KanbanActor, at: string): KanbanWait {
  const onPr = request.on === "push" || request.on === "merge" || request.on === "ci";
  return {
    on: request.on,
    pr: onPr ? ((request.pr ?? null) as KanbanWait["pr"]) : null,
    card: request.on === "card" ? (request.card?.id ?? null) : null,
    ask: request.on === "owner_go" ? ((request.ask ?? null) as KanbanWait["ask"]) : null,
    until: utcIso(request.until),
    sinceHead: request.on === "push" ? (request.sinceHead?.trim() ?? null) : null,
    note: request.note.trim(),
    by,
    at: at as KanbanWait["at"],
    wakeRole: request.wakeRole ?? null,
    expiredAt: null,
  };
}

/** The event body for a wait that was set: "Waiting on trading-core#544 to merge: note". */
export const waitSetBody = (wait: KanbanWait, cards?: WaitFacts["cards"]) =>
  `Waiting on ${waitTarget(wait, cards)}${wait.note.trim() ? `: ${wait.note.trim()}` : ""}`;
