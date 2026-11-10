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
  KANBAN_WAIT_CHECK_FAILURES,
  kanbanWait,
  kanbanWaitCheckFailing,
  kanbanWaitDeadlineMs,
  kanbanWaitExpired,
  kanbanWaitStale,
  kanbanWaiting,
  kanbanWithoutWait,
  type KanbanActor,
  type KanbanBoard,
  type KanbanCard,
  type KanbanCardEvent,
  type KanbanLink,
  type KanbanScript,
  type KanbanStage,
  type KanbanWait,
  type KanbanWaitKind,
  type ProjectId,
  type PullRequestCheck,
  type PullRequestDetail,
} from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/** How long each kind may hold before the card shows as stuck (shared with the clients). */
export const WAIT_LIMIT_MS = KANBAN_WAIT_LIMIT_MS;

/** The furthest ahead a `time` wait, or any wait's own deadline, may be set. */
export const WAIT_MAX_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How often one pull request is read from its host for the waits pointing at
 * it. Between reads the last reading stands, so a push or merge is seen at
 * most this long (plus a tick) after it happened.
 */
export const WAIT_PR_READ_MIN_MS = 3 * 60 * 1000;

/** Most pull requests read from their hosts in one pass; the rest go first in the next. */
export const WAIT_PR_READS_PER_PASS = 10;

/** How long one host read may take before it counts as failed. */
export const WAIT_PR_READ_TIMEOUT_MS = 15 * 1000;

/**
 * Whether the engine acts on waits: the tick resolves them, the planner and
 * card_claim skip waiting cards, script checks run and a pushed wake ends a
 * wait. False turns all of that off again: nothing ends a wait by itself and
 * the dispatcher would start a waiting To-Do or Needs Review card anyway, so
 * `checkWait` then refuses those stages and the tool says waits don't wake.
 */
export const WAITS_ENGINE_WIRED: boolean = true;

/**
 * Whether wait events are stored under their own kinds (`wait_set`,
 * `wait_cleared`, `wait_expired`). A client built before those kinds fails to
 * decode a card's whole history when it holds one, so its card page never
 * loads. While false they are stored as plain `edited` events, which every
 * client reads; their bodies ("Waiting for ...", "Wait ended: ...", "Wait
 * expired: ...") say what happened either way. Set true once no installed
 * client predates the tolerant decoder.
 */
export const WAIT_EVENT_KINDS_LIVE: boolean = false;

/**
 * How long a reviewed card whose wait ended may be kept from completing while its
 * evaluator, asked what to do next, has not finished that turn. Counted from the
 * card's last change, so an evaluator that never answers cannot hold it for good.
 */
export const WAIT_DECIDE_MS = 30 * 60 * 1000;

/** Stages where the engine as it is today leaves a thread-less card alone. */
const QUIET_STAGES: ReadonlySet<KanbanStage> = new Set([
  "in_review",
  "completed",
  "deployed",
  "needs_owner",
]);

export type WaitRole = "work" | "review" | "evaluator";

/**
 * One reading of a pull request: from the card's work thread (its tracked
 * PRs) or from the host through the wait PR reader.
 */
export interface WaitPrFacts {
  readonly url: string;
  readonly state: "open" | "draft" | "merged" | "closed";
  /** When the state and checks were read. Absent or null: undated, taken as current. */
  readonly at?: string | null | undefined;
  /** Its head commit, when the source knows it. Absent or null: unknown. */
  readonly head?: string | null | undefined;
  /** When the head was read, if not at `at` (a merged reading can carry another source's head). */
  readonly headAt?: string | null | undefined;
  /** Commits added since the wait's `sinceHead`, when the source counted them. */
  readonly commitsSince?: number | null | undefined;
  /** Checks on the head commit. Absent or null: none reported. */
  readonly checks?: "passing" | "failing" | "pending" | null | undefined;
}

export interface WaitFacts {
  readonly nowMs: number;
  /**
   * Every pull request the tick has a reading for, one per PR (`mergePrReadings`).
   * One not listed is unknown, not gone.
   */
  readonly prs: ReadonlyArray<WaitPrFacts>;
  /**
   * `prs` by `prKey` (`indexPrReadings`). A caller that checks many cards against
   * the same readings builds it once; without it each card scans `prs`.
   */
  readonly prsByKey?: ReadonlyMap<string, WaitPrFacts> | undefined;
  /** The board's cards by id. A card not in the map is gone. */
  readonly cards: ReadonlyMap<
    string,
    Pick<KanbanCard, "id" | "number" | "stage" | "settledAt" | "subtasks">
  >;
}

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

/**
 * One name per pull request, however its URL was written (a trailing slash,
 * /files, another letter case): host/repository#number. An URL that isn't a
 * pull request's is its own key.
 */
export function prKey(url: string): string {
  const link = parseChangeRequestUrl(url.trim());
  return link === null
    ? url.trim()
    : `${link.authority ?? link.host}/${link.repository}#${link.number}`;
}

const timeOf = (iso: string | null | undefined): number | null => {
  const ms = iso == null ? Number.NaN : Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

/** An undated reading counts as older than any dated one. */
const fresher = (a: WaitPrFacts, b: WaitPrFacts): boolean =>
  (timeOf(a.at) ?? -Infinity) >= (timeOf(b.at) ?? -Infinity);

/**
 * One reading per pull request from several sources (the work thread's
 * tracked PRs, the wait PR reader). State and checks come from the fresher
 * reading. So does the head, unless only the older one knows it: then the head
 * is carried over with its own time, since a thread that doesn't watch the PR
 * has a fresh state and no head.
 */
export function mergePrReadings(
  ...sources: ReadonlyArray<ReadonlyArray<WaitPrFacts>>
): ReadonlyArray<WaitPrFacts> {
  const byKey = new Map<string, WaitPrFacts>();
  for (const reading of sources.flat()) {
    const key = prKey(reading.url);
    const held = byKey.get(key);
    if (held === undefined) {
      byKey.set(key, reading);
      continue;
    }
    const [top, other] = fresher(reading, held) ? [reading, held] : [held, reading];
    byKey.set(
      key,
      (top.head ?? null) === null && (other.head ?? null) !== null
        ? { ...top, head: other.head, headAt: other.headAt ?? other.at ?? null }
        : top,
    );
  }
  return [...byKey.values()];
}

/** One reading per pull request, by `prKey`: built once for a pass over many waiting cards. */
export function indexPrReadings(
  readings: ReadonlyArray<WaitPrFacts>,
): ReadonlyMap<string, WaitPrFacts> {
  return new Map(mergePrReadings(readings).map((reading) => [prKey(reading.url), reading]));
}

/**
 * A reading taken before the wait was set says nothing about what happened
 * since: a cached head from before the review would look like a push.
 */
const readBefore = (readAt: string | null | undefined, wait: KanbanWait): boolean => {
  const read = timeOf(readAt);
  const set = timeOf(wait.at);
  return read !== null && set !== null && read < set;
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** What a wait is waiting for, as a noun phrase: "trading-core#544 to merge". */
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
    case "script":
      return `the ${wait.script ?? "board"} script's check`;
  }
}

// The check contract. A check is given plain JSON (`WaitCheckInput`) and
// answers hold, wake or fail (`WaitAnswer`). The board's own checks below and
// a board script's check answer the same thing, and one function applies it.

/** Who a wake goes to; `none` ends the wait and tells nobody. */
export type WaitWakeTo = WaitRole | "none";

/** What a check is given. A board script gets an array of these on stdin. */
export interface WaitCheckInput {
  /** The wait as stored. */
  readonly wait: KanbanWait;
  readonly card: {
    readonly id: string;
    readonly number: number;
    readonly title: string;
    readonly stage: KanbanStage;
    readonly links: ReadonlyArray<Pick<KanbanLink, "kind" | "url" | "label" | "state">>;
    readonly blockedBy: ReadonlyArray<string>;
    /** Who acts next on the card once nothing holds it. */
    readonly next: WaitRole;
  };
  readonly facts: {
    /** The time of this check. */
    readonly now: string;
    /** A reading for each pull request the wait or the card points at; one not listed is unknown. */
    readonly prs: ReadonlyArray<WaitPrFacts>;
    /** The cards the wait or `blockedBy` name; one not listed is gone. */
    readonly cards: ReadonlyArray<{
      readonly id: string;
      readonly number: number;
      readonly stage: KanbanStage;
      /** Settled, or in a done stage with no merge left open. */
      readonly done: boolean;
    }>;
    /** The card's questions to the owner. */
    readonly asks: ReadonlyArray<{ readonly id: string; readonly open: boolean }>;
  };
  /** The wait's `args`; an empty object when it has none. */
  readonly args: Readonly<Record<string, unknown>>;
}

/** The longest status, note or reason kept from an answer. */
export const WAIT_STATUS_MAX = 200;
export const WAIT_NOTE_MAX = 2000;

export const WaitAnswer = Schema.Union([
  /** Still waiting. `status` is one line the board shows ("CI 3 of 5 passed"). */
  Schema.Struct({
    result: Schema.Literal("hold"),
    status: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  /**
   * Over: the wait comes off and `to` is woken with `note`. Without `to` it is
   * the wait's own wakeRole, else whoever acts next on the card. `restart`
   * starts a reviewer at the first review step instead of the one it was on.
   */
  Schema.Struct({
    result: Schema.Literal("wake"),
    to: Schema.optional(Schema.NullOr(Schema.Literals(["work", "review", "evaluator", "none"]))),
    note: Schema.String,
    restart: Schema.optional(Schema.Boolean),
  }),
  /** The check could not tell. Shown as a problem; never wakes and never drops the wait. */
  Schema.Struct({ result: Schema.Literal("fail"), reason: Schema.String }),
]);
export type WaitAnswer = typeof WaitAnswer.Type;

/** A check: the board's own are these functions; a board script answers the same over stdout. */
export type WaitChecker = (input: WaitCheckInput) => WaitAnswer;

const decodeAnswerResult = Schema.decodeUnknownResult(WaitAnswer);

/** An answer from outside (a script's line). Anything unreadable is a failed check, which holds. */
export function decodeAnswer(value: unknown): WaitAnswer {
  const decoded = decodeAnswerResult(value);
  return Result.isSuccess(decoded)
    ? decoded.success
    : { result: "fail", reason: "The check's answer could not be read" };
}

const HOLD: WaitAnswer = { result: "hold" };
const wake = (
  note: string,
  extra: { readonly to?: WaitWakeTo | null; readonly restart?: boolean } = {},
): WaitAnswer => ({ result: "wake", note, ...extra });

const inputPr = (input: WaitCheckInput, url: string): WaitPrFacts | undefined => {
  const key = prKey(url);
  return mergePrReadings(input.facts.prs.filter((entry) => prKey(entry.url) === key))[0];
};

/** Every state-tracked PR on the card has landed, by this check's readings over the stored states. */
const prsLanded = (input: WaitCheckInput): boolean =>
  input.card.links
    .filter((link) => link.kind === "pr" && link.state !== null)
    .every((link) => {
      const state = inputPr(input, link.url)?.state ?? link.state;
      return state === "merged" || state === "closed";
    });

/**
 * push, merge and ci. A PR nobody could read holds: unknown is not done. An
 * ending the wait did not ask for (closed, merged under a push wait) goes to
 * the evaluator, who decides what the card does now.
 */
const prCheck: WaitChecker = (input) => {
  const { wait, card } = input;
  if (wait.pr === null) return HOLD;
  const pr = inputPr(input, wait.pr);
  if (pr === undefined) return HOLD;
  // Merged can't be undone, so an old reading of it still stands; anything else may have changed.
  if (pr.state !== "merged" && readBefore(pr.at, wait)) return HOLD;
  const name = prName(pr.url);
  // A head read before the wait was set is no head at all.
  const head = readBefore(pr.headAt ?? pr.at, wait) ? null : (pr.head ?? null);
  const at = head === null ? "" : ` at ${shortSha(head)}`;
  const evaluator = { to: "evaluator" } as const;
  switch (wait.on) {
    case "push": {
      if (pr.state === "merged") {
        return wake(`${name} merged while this waited for a push`, evaluator);
      }
      if (pr.state === "closed") {
        return wake(`${name} was closed while this waited for a push`, evaluator);
      }
      // Without both commits there is nothing to compare; the wait holds until it expires.
      if (head === null || wait.sinceHead === null || sameCommit(head, wait.sinceHead)) return HOLD;
      const count = pr.commitsSince ?? null;
      const inReview = card.stage === "needs_review" || card.stage === "in_review";
      return wake(
        count !== null && count > 0
          ? `The author pushed ${plural(count, "commit")} to ${name} (head ${shortSha(head)})`
          : `The author pushed to ${name}: its head moved from ${shortSha(wait.sinceHead)} to ${shortSha(head)}`,
        // New commits get a fresh review from the first step, even when the last one had passed.
        { to: wait.wakeRole ?? (inReview ? "review" : null), restart: true },
      );
    }
    case "merge":
      if (pr.state === "closed") return wake(`${name} was closed without merging`, evaluator);
      if (pr.state !== "merged") return HOLD;
      // A reviewed card whose last PR just merged is completed by the board's own PRs-landed step.
      return wait.wakeRole === null &&
        card.stage === "in_review" &&
        card.next === "evaluator" &&
        prsLanded(input)
        ? wake(`${name} merged`, { to: "none" })
        : wake(`${name} merged`);
    case "ci":
      if (pr.state === "merged") return wake(`${name} merged while this waited for CI`, evaluator);
      if (pr.state === "closed") {
        return wake(`${name} was closed while this waited for CI`, evaluator);
      }
      if (pr.checks === "passing") return wake(`CI passed on ${name}${at}`);
      // Failed CI goes to whoever would fix it: the next actor, like a pass.
      if (pr.checks === "failing") return wake(`CI failed on ${name}${at}`);
      return HOLD;
    default:
      return HOLD;
  }
};

/** The asker of an owner question gets the answer from the ask itself, so by default nobody is woken. */
const ownerGoCheck: WaitChecker = ({ wait, facts }) => {
  if (wait.ask === null) return HOLD;
  const ask = facts.asks.find((entry) => entry.id === wait.ask);
  const to = wait.wakeRole ?? "none";
  if (ask === undefined) return wake(`Question ${wait.ask} is no longer on the card`, { to });
  return ask.open ? HOLD : wake(`Question ${ask.id} was answered or dropped`, { to });
};

/** Like blockedBy: a completed card still holds while its merge subtask is open. */
const cardCheck: WaitChecker = ({ wait, facts }) => {
  if (wait.card === null) return HOLD;
  const target = facts.cards.find((entry) => entry.id === wait.card);
  if (target === undefined) return wake("The card it waited on is gone", { to: "evaluator" });
  return target.done ? wake(`Card #${target.number} is done`) : HOLD;
};

const timeCheck: WaitChecker = ({ wait, facts }) => {
  const until = wait.until === null ? Number.NaN : Date.parse(wait.until);
  // A time wait with no readable time can never end by itself, so it ends now.
  if (!Number.isFinite(until)) return wake("The wait had no time set", { to: "evaluator" });
  return Date.parse(facts.now) >= until ? wake("The time you set has passed") : HOLD;
};

/** The board's own checks, by the name a wait's `on` gives. These names are reserved. */
export const WAIT_CHECKS: ReadonlyMap<string, WaitChecker> = new Map<string, WaitChecker>([
  ["push", prCheck],
  ["merge", prCheck],
  ["ci", prCheck],
  ["owner_go", ownerGoCheck],
  ["card", cardCheck],
  ["time", timeCheck],
]);

/**
 * The name a wait's check is looked up by: its kind for the board's own, and
 * `script:<name>` for a board script, so a script can never stand in for a
 * built-in whatever it is called.
 */
export const waitCheckName = (wait: Pick<KanbanWait, "on" | "script">): string =>
  wait.on === "script" ? `script:${wait.script ?? ""}` : wait.on;

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
// its stage: none of these move it, and only an answer to its check ends the wait.

/** The planner and card_claim skip it: a waiting card is not started or taken. */
export const waitHoldsDispatch = (card: WaitingFields) => kanbanWaiting(card);

/** No quiet-thread nudge and no evaluator reminder for it. */
export const waitSkipsNudge = (card: WaitingFields) => kanbanWaiting(card);

/** Not idle and not stalled in any count or sweep, until the wait runs past its limit or its check keeps failing. */
export const waitHidesIdle = (card: WaitingFields, nowMs: number) =>
  kanbanWaiting(card) &&
  !waitExpired(card, nowMs) &&
  !(card.wait !== undefined && kanbanWaitCheckFailing(card.wait));

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

type WaitEventKind = Extract<KanbanCardEvent["kind"], "wait_set" | "wait_cleared" | "wait_expired">;

/** The kind a wait event is stored under: its own, or a plain edit (see `WAIT_EVENT_KINDS_LIVE`). */
export const waitEventKind = (
  kind: WaitEventKind,
  live: boolean = WAIT_EVENT_KINDS_LIVE,
): KanbanCardEvent["kind"] => (live ? kind : "edited");

/** "for trading-core#544 to merge", "until 2026-11-14T05:00:00.000Z": finishes "waiting ...". */
export const waitingFor = (wait: KanbanWait, cards?: WaitFacts["cards"]): string =>
  wait.on === "time" && wait.until !== null
    ? `until ${wait.until}`
    : `for ${waitTarget(wait, cards)}`;

// What a wait event says in the card's history. Each reads as a full line by
// itself, since an older client shows it as a plain edit.

/** A wait that ended, with why: "Wait ended: trading-core#544 merged". */
export const waitEndedBody = (reason: string) => `Wait ended: ${reason}`;

/** A wait someone cleared with card_wait clear. */
export const waitClearedBody = (wait: KanbanWait, cards?: WaitFacts["cards"]) =>
  waitEndedBody(`cleared by hand (was waiting ${waitingFor(wait, cards)})`);

/** The card event a wait change writes. */
export interface WaitEvent {
  readonly kind: KanbanCardEvent["kind"];
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

/**
 * The readings a check gets: what the caller read for the PRs the wait or the
 * card points at, and for a PR it read nothing about, the state on the card's
 * own link, which the tick keeps current.
 */
function inputReadings(
  prLinks: ReadonlyArray<KanbanLink>,
  facts: Pick<WaitFacts, "prs" | "prsByKey">,
  keys: ReadonlySet<string>,
): ReadonlyArray<WaitPrFacts> {
  const byKey = facts.prsByKey;
  const read =
    byKey === undefined
      ? mergePrReadings(facts.prs.filter((reading) => keys.has(prKey(reading.url))))
      : [...keys].flatMap((key) => byKey.get(key) ?? []);
  const known = new Set(read.map((reading) => prKey(reading.url)));
  return [
    ...read,
    ...mergePrReadings(
      prLinks.flatMap((link) =>
        link.state === null || known.has(prKey(link.url))
          ? []
          : [{ url: link.url, state: link.state, at: link.checkedAt }],
      ),
    ),
  ];
}

/** What a check is given for one waiting card; null when the card has no wait. */
export function checkInput(
  card: KanbanCard,
  facts: WaitFacts,
  ctx: WaitContext,
): WaitCheckInput | null {
  const wait = kanbanWait(card);
  if (wait === null) return null;
  const prLinks = card.links.filter((link) => link.kind === "pr");
  const keys = new Set([
    ...prLinks.map((link) => prKey(link.url)),
    ...(wait.pr === null ? [] : [prKey(wait.pr)]),
  ]);
  const named = [...new Set([...(wait.card === null ? [] : [wait.card]), ...card.blockedBy])];
  return {
    wait,
    card: {
      id: card.id,
      number: card.number,
      title: card.title,
      stage: card.stage,
      links: card.links.map(({ kind, url, label, state }) => ({ kind, url, label, state })),
      blockedBy: card.blockedBy,
      next: nextActor(card, ctx),
    },
    facts: {
      now: DateTime.formatIso(DateTime.makeUnsafe(facts.nowMs)),
      prs: inputReadings(prLinks, facts, keys),
      cards: named.flatMap((id) => {
        const target = facts.cards.get(id);
        return target === undefined
          ? []
          : [
              {
                id: target.id,
                number: target.number,
                stage: target.stage,
                done:
                  target.settledAt !== null ||
                  (KANBAN_DONE_STAGES.has(target.stage) && !kanbanAwaitsMerge(target)),
              },
            ];
      }),
      asks: card.asks.map((ask) => ({ id: ask.id, open: ask.closedAt === null })),
    },
    args: wait.args ?? {},
  };
}

const joinNotes = (...parts: ReadonlyArray<string | null>) =>
  parts.filter((part): part is string => part !== null && part.trim() !== "").join("\n\n");

const quoted = (note: string) => (note.trim() ? ` ("${note.trim()}")` : "");

const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export interface WaitEnd {
  readonly card: KanbanCard;
  readonly event: WaitEvent;
  readonly wake: WaitWake;
}

/**
 * Ends a card's wait on a wake answer: the wait comes off and whoever the
 * answer names (else the wait's wakeRole, else the next actor) is woken with
 * the reason. Returns the card to save, the event to log and the wake to send.
 * A worker or reviewer can only be woken where it has something to go back to;
 * anywhere else the wake goes to the evaluator.
 */
export function endWait(
  card: KanbanCard,
  answer: Extract<WaitAnswer, { result: "wake" }>,
  facts: Pick<WaitFacts, "cards">,
  ctx: WaitContext,
  at: string,
): WaitEnd {
  const wait = kanbanWait(card);
  const reason =
    oneLine(answer.note, WAIT_NOTE_MAX).replace(/[.\s]+$/, "") || "Its check said the wait is over";
  const cleared: KanbanCard = { ...kanbanWithoutWait(card), updatedAt: at };
  const event = (toStage: KanbanStage): WaitEvent => ({
    kind: waitEventKind("wait_cleared"),
    body: waitEndedBody(reason),
    fromStage: card.stage === toStage ? null : card.stage,
    toStage: card.stage === toStage ? null : toStage,
  });
  if (wait === null) {
    return { card, event: event(card.stage), wake: { to: "none", why: "the card had no wait" } };
  }
  const was = `It was waiting ${waitingFor(wait, facts.cards)}${quoted(wait.note)}.`;
  const asked = answer.to ?? wait.wakeRole ?? nextActor(card, ctx);
  if (asked === "none") {
    return { card: cleared, event: event(card.stage), wake: { to: "none", why: reason } };
  }
  const open = card.stage === "todo" || card.stage === "needs_review" || card.stage === "in_review";
  const role: WaitRole =
    (asked === "work" && !(open || card.stage === "working")) || (asked === "review" && !open)
      ? "evaluator"
      : asked;
  if (role === "work") {
    const note = `${reason}. ${was} Carry on with card #${card.number}.`;
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
    const note = `${reason}. ${was} Review card #${card.number} again from its current head.`;
    return {
      card: {
        ...cleared,
        stage: "needs_review",
        // The round stays: it counts findings rounds, and the third one escalates to the evaluator.
        reviewStep:
          answer.restart === true ? 0 : Math.min(card.reviewStep, Math.max(ctx.chainLength, 1) - 1),
        wakeNote: joinNotes(card.wakeNote, note),
        movedAt: card.stage === "needs_review" ? card.movedAt : at,
      },
      event: event("needs_review"),
      wake: { to: "review", note },
    };
  }
  // The dispatcher starts a To-Do card as soon as nothing holds it, so its worker hears why too.
  const startsAnyway = card.stage === "todo" && nextActor(card, ctx) === "work";
  return {
    card: startsAnyway
      ? {
          ...cleared,
          wakeNote: joinNotes(
            card.wakeNote,
            `${reason}. ${was} The evaluator has been told: check the card still makes sense before you carry on.`,
          ),
        }
      : cleared,
    event: event(card.stage),
    wake: {
      to: "evaluator",
      text: `Card #${card.number} (${card.title || "untitled"}, in ${card.stage}) is no longer waiting: ${reason}. ${was} ${
        startsAnyway
          ? "The dispatcher will start its worker again; flag or move the card if it should not run."
          : "Take its next step, or set a new wait with card_wait if it still has to hold."
      }`,
    },
  };
}

/**
 * Marks a wait that ran past its limit, once. The wait stays (it can still end
 * normally); the card shows as stuck and the evaluator is told why.
 */
export function expireWait(
  card: KanbanCard,
  facts: Pick<WaitFacts, "nowMs" | "cards">,
  at: string,
): WaitEnd | null {
  const wait = kanbanWait(card);
  if (wait === null || wait.expiredAt !== null || !kanbanWaitExpired(wait, facts.nowMs))
    return null;
  const waited = `waited ${waitedFor(wait.at, facts.nowMs)} ${waitingFor(wait, facts.cards)} with no change${quoted(wait.note)}`;
  return {
    card: { ...card, wait: { ...wait, expiredAt: at as KanbanWait["at"] }, updatedAt: at },
    event: {
      kind: waitEventKind("wait_expired"),
      body: `Wait expired: ${waited}`,
      fromStage: null,
      toStage: null,
    },
    wake: {
      to: "evaluator",
      text: `Card #${card.number} (${card.title || "untitled"}, in ${card.stage}) is stuck: ${waited}. Chase it, set a new wait with card_wait, or clear the wait and move the card on.`,
    },
  };
}

export type WaitStep =
  /** No wait, or a thread runs the card: nothing to do. */
  | { readonly _tag: "none" }
  /** Still waiting. `save` is the card when the check's status or failure count changed, else null. */
  | { readonly _tag: "hold"; readonly save: KanbanCard | null }
  /** The wait is over: save the card, log the event, send the wake. */
  | ({ readonly _tag: "end" } & WaitEnd)
  /** The wait ran past its limit: save the card, log the event, tell the evaluator. */
  | ({ readonly _tag: "expire" } & WaitEnd)
  /** Its check failed several times in a row: save the card, log the event, tell the evaluator. */
  | ({ readonly _tag: "failing" } & WaitEnd);

/**
 * Applies a check's answer to a waiting card, whoever gave it: one of the
 * board's own checks, a board script's check, or a wake a script pushed.
 * Ending wins over expiring. `stamp` also records the time of an answer that
 * changed nothing; a caller that checks every tick leaves it off, so a quiet
 * wait costs no writes.
 */
export function applyAnswer(
  card: KanbanCard,
  answer: WaitAnswer,
  facts: Pick<WaitFacts, "nowMs" | "cards">,
  ctx: WaitContext,
  at: string,
  options: { readonly stamp?: boolean } = {},
): WaitStep {
  const wait = kanbanWait(card);
  if (wait === null || !kanbanWaiting(card)) return { _tag: "none" };
  const checkedAt = at as KanbanWait["at"];
  if (answer.result === "wake") return { _tag: "end", ...endWait(card, answer, facts, ctx, at) };
  if (answer.result === "fail") {
    const failures = wait.failures + 1;
    const problem = oneLine(answer.reason, WAIT_STATUS_MAX) || "The check failed";
    const failed: KanbanCard = {
      ...card,
      wait: { ...wait, failures, problem, lastCheckedAt: checkedAt },
      updatedAt: at,
    };
    if (failures === KANBAN_WAIT_CHECK_FAILURES) {
      const waiting = waitingFor(wait, facts.cards);
      return {
        _tag: "failing",
        card: failed,
        event: {
          kind: waitEventKind("wait_expired"),
          body: `Wait check failing: ${failures} failures in a row while waiting ${waiting}: ${problem}`,
          fromStage: null,
          toStage: null,
        },
        wake: {
          to: "evaluator",
          text: `Card #${card.number} (${card.title || "untitled"}, in ${card.stage}) is waiting ${waiting} and its check has failed ${failures} times in a row: ${problem}. Nothing can end this wait until the check works: fix it, set another wait with card_wait, or clear the wait and move the card on.`,
        },
      };
    }
    const expired = expireWait(failed, facts, at);
    return expired === null ? { _tag: "hold", save: failed } : { _tag: "expire", ...expired };
  }
  const status = answer.status == null ? null : oneLine(answer.status, WAIT_STATUS_MAX) || null;
  const changed = status !== wait.status || wait.failures !== 0 || wait.problem !== null;
  const held: KanbanCard =
    changed || options.stamp === true
      ? {
          ...card,
          wait: { ...wait, status, failures: 0, problem: null, lastCheckedAt: checkedAt },
          updatedAt: at,
        }
      : card;
  const expired = expireWait(held, facts, at);
  if (expired !== null) return { _tag: "expire", ...expired };
  return { _tag: "hold", save: held === card ? null : held };
}

/**
 * The one call the tick makes per card, after its PR sync: what to do about
 * the card's wait right now. It looks the wait's check up by name, gives it
 * the input and applies the answer; there is no other path. A wait whose
 * check is not in `checks` (a board script's: the script pass answers those)
 * holds here and can still expire.
 */
export function resolveWait(
  card: KanbanCard,
  facts: WaitFacts,
  ctx: WaitContext,
  at: string,
  checks: ReadonlyMap<string, WaitChecker> = WAIT_CHECKS,
): WaitStep {
  if (card.wait !== undefined && card.activeThreadId === null && kanbanWaitStale(card)) {
    // Someone moved the card after the wait was set: they have it now.
    return {
      _tag: "end",
      card: { ...kanbanWithoutWait(card), updatedAt: at },
      event: {
        kind: waitEventKind("wait_cleared"),
        body: waitEndedBody(
          `the card was moved to ${card.stage} while it waited ${waitingFor(card.wait, facts.cards)}`,
        ),
        fromStage: null,
        toStage: null,
      },
      wake: { to: "none", why: "whoever moved the card has it" },
    };
  }
  const input = kanbanWaiting(card) ? checkInput(card, facts, ctx) : null;
  if (input === null) return { _tag: "none" };
  const check = checks.get(waitCheckName(input.wait));
  if (check === undefined) {
    const expired = expireWait(card, facts, at);
    return expired === null ? { _tag: "hold", save: null } : { _tag: "expire", ...expired };
  }
  let answer: WaitAnswer;
  try {
    answer = decodeAnswer(check(input));
  } catch (error) {
    answer = { result: "fail", reason: `The check threw: ${String(error)}` };
  }
  return applyAnswer(card, answer, facts, ctx, at);
}

/**
 * A card whose links have caught up with what a host said: a PR link the board
 * tracks takes a merged or closed reading. No work thread watches an outside
 * author's PR, so without this the board's PRs-landed step would never see the
 * merge that just ended the card's wait.
 */
export function withLandedLinks(
  card: KanbanCard,
  readings: ReadonlyArray<WaitPrFacts>,
  at: string,
): KanbanCard {
  const byKey = new Map(mergePrReadings(readings).map((reading) => [prKey(reading.url), reading]));
  let changed = false;
  const links = card.links.map((link) => {
    if (link.kind !== "pr" || link.state === null) return link;
    const state = byKey.get(prKey(link.url))?.state;
    if ((state !== "merged" && state !== "closed") || state === link.state) return link;
    changed = true;
    return { ...link, state, checkedAt: at as KanbanLink["checkedAt"] };
  });
  return changed ? { ...card, links, updatedAt: at } : card;
}

/** The answer the board's own check gives a card right now; null when its check isn't one of them. */
export function waitSatisfied(
  card: KanbanCard,
  facts: WaitFacts,
  ctx: WaitContext,
): WaitAnswer | null {
  const input = checkInput(card, facts, ctx);
  const check = input === null ? undefined : WAIT_CHECKS.get(waitCheckName(input.wait));
  return input === null || check === undefined ? null : check(input);
}

// Reading pull requests for waits. A card's work thread tracks its own PRs; a
// wait can point at one no thread watches (an outside author's PR, a parent
// PR), so the tick asks the wait PR reader (`waitPrs.ts`) for those.

const FAILED_CHECKS: ReadonlySet<PullRequestCheck["status"]> = new Set([
  "failure",
  "cancelled",
  "action-required",
]);

/**
 * One word for a PR's checks, by the rule the PR watch uses: any failed,
 * cancelled or action-required check fails it; otherwise the required checks
 * decide (all of them when none is marked required), pending while one still
 * runs. Null when nothing was reported.
 */
export function checksSummary(
  checks: ReadonlyArray<Pick<PullRequestCheck, "status" | "required">>,
): "passing" | "failing" | "pending" | null {
  if (checks.length === 0) return null;
  if (checks.some((check) => FAILED_CHECKS.has(check.status))) return "failing";
  const required = checks.filter((check) => check.required === true);
  const gate = required.length > 0 ? required : checks;
  return gate.some((check) => check.status === "pending") ? "pending" : "passing";
}

/** A host's answer about one PR as a reading, dated when the host was asked. */
export function readingFromDetail(
  url: string,
  detail: Pick<PullRequestDetail, "state" | "isDraft" | "headSha" | "checks" | "observedAt">,
  nowMs: number,
): WaitPrFacts {
  return {
    url,
    state: detail.state === "open" && detail.isDraft ? "draft" : detail.state,
    at: DateTime.formatIso(DateTime.makeUnsafe(detail.observedAt ?? nowMs)),
    head: detail.headSha ?? null,
    checks: checksSummary(detail.checks),
  };
}

/** One pull request the waits on a board need a reading for. */
export interface WaitPrRequest {
  readonly url: string;
  /** A project whose host account can read it: a waiting card's own, else the board's default. */
  readonly projectId: ProjectId | null;
  /** A push wait points at it: a reading without a head can't end that. */
  readonly needsHead: boolean;
  /** The work threads' own reading of it this pass, when one tracks it. */
  readonly live: WaitPrFacts | null;
}

/**
 * The distinct pull requests the board's open waits need a reading for: one
 * request per PR however many cards wait on it, with what the work threads
 * already know. A built-in wait needs its own PR; a script wait needs every
 * PR its card links, head and checks included, since its check is given them
 * all.
 */
export function waitPrRequests(
  cards: Iterable<KanbanCard>,
  board: Pick<KanbanBoard, "defaultProjectId">,
  live: ReadonlyArray<WaitPrFacts> = [],
): ReadonlyArray<WaitPrRequest> {
  const liveByKey = new Map(mergePrReadings(live).map((reading) => [prKey(reading.url), reading]));
  const byKey = new Map<string, WaitPrRequest>();
  for (const card of cards) {
    const wait = kanbanWaiting(card) ? kanbanWait(card) : null;
    if (wait === null) continue;
    const byScript = wait.on === "script";
    const urls = byScript
      ? card.links.flatMap((link) => (link.kind === "pr" ? [link.url as string] : []))
      : wait.pr === null
        ? []
        : [wait.pr as string];
    for (const url of urls) {
      const key = prKey(url);
      const held = byKey.get(key);
      byKey.set(key, {
        url: held?.url ?? url,
        projectId: held?.projectId ?? card.projectId ?? board.defaultProjectId,
        needsHead: (held?.needsHead ?? false) || byScript || wait.on === "push",
        live: liveByKey.get(key) ?? null,
      });
    }
  }
  return [...byKey.values()];
}

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
  /** script: the name asked for, and the board's scripts called that. */
  readonly script?:
    | {
        readonly name: string;
        readonly found: ReadonlyArray<Pick<KanbanScript, "name" | "enabled">>;
      }
    | null
    | undefined;
  /** script: what the check is told. */
  readonly args?: Readonly<Record<string, unknown>> | null | undefined;
}

/** The most a wait's `args` may hold, as JSON text. */
export const WAIT_ARGS_MAX = 2000;

/** How often a board script checks its waits when no wait asks otherwise (`args.everyMs`), and the bounds on asking. */
export const WAIT_SCRIPT_EVERY_MS = 5 * 60 * 1000;
export const WAIT_SCRIPT_EVERY_MIN_MS = 60 * 1000;
export const WAIT_SCRIPT_EVERY_MAX_MS = 6 * 60 * 60 * 1000;

/** The waiting cards a board script checks: those whose wait names it. */
export const scriptWaiters = (
  cards: Iterable<KanbanCard>,
  script: Pick<KanbanScript, "name">,
): ReadonlyArray<KanbanCard> =>
  [...cards].filter(
    (card) => kanbanWaiting(card) && card.wait?.on === "script" && card.wait.script === script.name,
  );

/**
 * How long a script rests between check runs: the shortest `args.everyMs` any
 * of its waits asks for, kept within the bounds; the default when none asks.
 */
export function scriptCheckEveryMs(cards: ReadonlyArray<Pick<KanbanCard, "wait">>): number {
  const asked = cards.flatMap((card) => {
    const every = card.wait?.args?.everyMs;
    return typeof every === "number" && Number.isFinite(every) ? [every] : [];
  });
  if (asked.length === 0) return WAIT_SCRIPT_EVERY_MS;
  return Math.min(WAIT_SCRIPT_EVERY_MAX_MS, Math.max(WAIT_SCRIPT_EVERY_MIN_MS, Math.min(...asked)));
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
    case "script": {
      const name = request.script?.name.trim() ?? "";
      if (!name) {
        return bad(
          "a script wait names the board script that checks it (script); for the board's own checks use on: push, merge, ci, owner_go, card or time",
        );
      }
      const found = request.script?.found ?? [];
      if (found.length === 0) return bad(`this board has no script named ${name}`);
      if (found.length > 1) {
        return bad(`this board has ${found.length} scripts named ${name}: rename one first`);
      }
      if (!found[0]!.enabled) return bad(`the ${name} script is turned off`);
      const args = request.args ?? null;
      if (args !== null) {
        if (JSON.stringify(args).length > WAIT_ARGS_MAX) {
          return bad(`args is too big: keep it under ${WAIT_ARGS_MAX} characters of JSON`);
        }
        const every = args.everyMs;
        if (every !== undefined && !(typeof every === "number" && Number.isFinite(every))) {
          return bad("args.everyMs is how often to check, in milliseconds: a number");
        }
      }
      return { ok: true };
    }
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
    script:
      request.on === "script"
        ? ((request.script?.found[0]?.name ?? null) as KanbanWait["script"])
        : null,
    args: request.on === "script" ? (request.args ?? null) : null,
    status: null,
    lastCheckedAt: null,
    failures: 0,
    problem: null,
  };
}

/** The event body for a wait that was set: "Waiting for trading-core#544 to merge: note". */
export const waitSetBody = (wait: KanbanWait, cards?: WaitFacts["cards"]) =>
  `Waiting ${waitingFor(wait, cards)}${wait.note.trim() ? `: ${wait.note.trim()}` : ""}`;
