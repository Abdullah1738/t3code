/**
 * Board scripts: what runs them, when they are due, and how they talk to the
 * board. A script prints one JSON object per line with a `kanban` key to add
 * a card, post in a discussion, resize a pool, tick its subtask (`subtask`),
 * hand one back to the evaluator (`handback`) or move a card to completed,
 * deployed or verified (`move`); every other line is plain output.
 *
 * Waits use an object under `kanban`: `{"kanban":{"wait":{...}}}` answers the
 * check of a card that waits on this script (it has `result`) or parks a card
 * (it has `on`), and `{"kanban":{"wake":{...}}}` ends any card's wait.
 */
import {
  KanbanWaitKind,
  ProviderOptionSelections,
  type KanbanActor,
  type KanbanCard,
  type KanbanChange,
  type KanbanDiscussion,
  type KanbanScript,
  type KanbanScriptTrigger,
} from "@t3tools/contracts";
import * as Cron from "effect/Cron";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as Waits from "./waits.ts";

/** What a run keeps of its output. */
export const OUTPUT_TAIL_BYTES = 64 * 1024;

const INTERPRETERS: Readonly<Record<string, string>> = {
  ".ts": "bun",
  ".js": "bun",
  ".py": "python3",
  ".sh": "bash",
  ".zsh": "zsh",
};

/** The program that runs the script, by extension; null for one we don't run. */
export const interpreterFor = (path: string): string | null => {
  const dot = path.lastIndexOf(".");
  if (dot <= path.lastIndexOf("/")) return null;
  return INTERPRETERS[path.slice(dot).toLowerCase()] ?? null;
};

// Cron.next throws when a line parses but never matches, like "0 0 30 2 *".
const nextCronMs = (cron: Cron.Cron, fromMs: number): number | null => {
  try {
    return Cron.next(cron, fromMs).getTime();
  } catch {
    return null;
  }
};

/** Why a cron line can't schedule a script, or null. Runs in the server's time zone. */
export const cronProblem = (expression: string, nowMs: number): string | null => {
  if (expression.trim().split(/\s+/).length !== 5) {
    return `"${expression}" needs five fields: minute, hour, day, month, weekday.`;
  }
  const cron = Cron.parse(expression);
  if (Result.isFailure(cron)) return `"${expression}" is not a cron line.`;
  if (nextCronMs(cron.success, nowMs) === null) return `"${expression}" never comes round.`;
  return null;
};

/** When a scheduled script runs next, counted from its last start (or creation). */
export const nextRunAt = (trigger: KanbanScriptTrigger, fromMs: number): number | null => {
  if (trigger._tag !== "schedule") return null;
  if (trigger.everyMs !== null) return fromMs + trigger.everyMs;
  if (trigger.cron === null) return null;
  const cron = Cron.parse(trigger.cron);
  return Result.isSuccess(cron) ? nextCronMs(cron.success, fromMs) : null;
};

/** Whether a schedule says to run. Whether it runs now is the caller's: one at a time. */
export const isDue = (script: KanbanScript, nowMs: number) => {
  if (!script.enabled) return false;
  const from = Date.parse(script.lastRun?.startedAt ?? script.createdAt);
  const next = nextRunAt(script.trigger, from);
  return next !== null && next <= nowMs;
};

const CardCommand = Schema.Struct({
  kanban: Schema.Literal("card"),
  prompt: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  priority: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 }))),
  projects: Schema.optional(Schema.Array(Schema.String)),
  links: Schema.optional(
    Schema.Array(Schema.Struct({ url: Schema.String, label: Schema.optional(Schema.String) })),
  ),
});

const PostCommand = Schema.Struct({
  kanban: Schema.Literal("post"),
  text: Schema.String,
  /** A discussion id; or `card`, the number of a card on this board. */
  discussion: Schema.optional(Schema.String),
  card: Schema.optional(Schema.Int),
});

/** Resizes one of the board's pools, e.g. to pace usage. It never adds a pool. */
const PoolCommand = Schema.Struct({
  kanban: Schema.Literal("pool"),
  /** Model id as the board's pools list it, e.g. "opus/claude-opus-5-5". */
  model: Schema.String,
  instanceId: Schema.optional(Schema.String),
  /** The pool's level, e.g. "max"; needed when the board runs the model at several levels. */
  variant: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
  options: Schema.optional(ProviderOptionSelections),
  slots: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

/** Marks a subtask this script owns done, or skipped with a note. */
const SubtaskCommand = Schema.Struct({
  kanban: Schema.Literal("subtask"),
  /** A card number on the script's board. */
  card: Schema.Int,
  subtask: Schema.String,
  state: Schema.Literals(["done", "skipped"]),
  note: Schema.optional(Schema.String),
});

/** Hands a subtask this script owns back to the card's evaluator with what failed; wakes it once. */
const HandBackCommand = Schema.Struct({
  kanban: Schema.Literal("handback"),
  card: Schema.Int,
  subtask: Schema.String,
  note: Schema.String,
});

/** Moves a card to completed, deployed or verified, with a note for its history. */
const MoveCommand = Schema.Struct({
  kanban: Schema.Literal("move"),
  card: Schema.Int,
  to: Schema.Literals(["completed", "deployed", "verified"]),
  note: Schema.optional(Schema.String),
});

export const ScriptCommand = Schema.Union([
  CardCommand,
  PostCommand,
  PoolCommand,
  SubtaskCommand,
  HandBackCommand,
  MoveCommand,
]);
export type ScriptCommand = typeof ScriptCommand.Type;
export type CardCommand = typeof CardCommand.Type;
export type PostCommand = typeof PostCommand.Type;
export type PoolCommand = typeof PoolCommand.Type;
export type SubtaskCommand = typeof SubtaskCommand.Type;
export type HandBackCommand = typeof HandBackCommand.Type;
export type MoveCommand = typeof MoveCommand.Type;

const decodeCommand = Schema.decodeUnknownResult(ScriptCommand);

/** A card on the script's board: its number, as 12 or "#12". */
const CardNumber = Schema.Union([Schema.Int, Schema.String]);
const cardNumberOf = (ref: number | string): number | null => {
  const number = typeof ref === "number" ? ref : Number(/^\s*#?(\d+)\s*$/.exec(ref)?.[1]);
  return Number.isInteger(number) && number > 0 ? number : null;
};

const WakeTo = Schema.Literals(["work", "review", "evaluator", "none"]);

/** Ends the card's wait, whatever it waits on, and wakes `to` (left out: whoever acts next). */
const WakeLine = Schema.Struct({
  card: CardNumber,
  note: Schema.String,
  to: Schema.optional(Schema.NullOr(WakeTo)),
  restart: Schema.optional(Schema.Boolean),
});

/** Parks a card on a wait: the fields card_wait takes. */
const ParkLine = Schema.Struct({
  card: CardNumber,
  on: KanbanWaitKind,
  note: Schema.String,
  pr: Schema.optional(Schema.NullOr(Schema.String)),
  /** For `card`: the number of the card to wait on. */
  waitsOn: Schema.optional(Schema.NullOr(CardNumber)),
  ask: Schema.optional(Schema.NullOr(Schema.String)),
  until: Schema.optional(Schema.NullOr(Schema.String)),
  head: Schema.optional(Schema.NullOr(Schema.String)),
  wakeRole: Schema.optional(Schema.NullOr(Schema.Literals(["work", "review", "evaluator"]))),
  script: Schema.optional(Schema.NullOr(Schema.String)),
  args: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
});

const decodeWake = Schema.decodeUnknownResult(WakeLine);
const decodePark = Schema.decodeUnknownResult(ParkLine);

/** What a script printed about waits, with the card's number read. */
export type WaitLine =
  /** Its answer for a card that waits on this script. */
  | { readonly _tag: "answer"; readonly card: number; readonly answer: Waits.WaitAnswer }
  /** A wake pushed to a card, whatever it waits on. */
  | {
      readonly _tag: "wake";
      readonly card: number;
      readonly answer: Extract<Waits.WaitAnswer, { result: "wake" }>;
    }
  | {
      readonly _tag: "park";
      readonly card: number;
      readonly waitsOn: number | null;
      readonly request: Omit<typeof ParkLine.Type, "card" | "waitsOn">;
    };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A `{"kanban":{...}}` line: the wait line it is, or why it isn't one. */
const waitLineOf = (body: Readonly<Record<string, unknown>>): WaitLine | string => {
  if (isRecord(body.wake)) {
    const wake = decodeWake(body.wake);
    if (Result.isFailure(wake)) return `a wake needs card and note: ${wake.failure.message}`;
    const card = cardNumberOf(wake.success.card);
    if (card === null) return `"${wake.success.card}" is not a card number`;
    const { note, to, restart } = wake.success;
    return {
      _tag: "wake",
      card,
      answer: {
        result: "wake",
        note,
        ...(to == null ? {} : { to }),
        ...(restart === undefined ? {} : { restart }),
      },
    };
  }
  if (!isRecord(body.wait)) return "it needs a wait or a wake";
  if ("result" in body.wait) {
    const { card: ref, ...answer } = body.wait;
    const card = typeof ref === "number" || typeof ref === "string" ? cardNumberOf(ref) : null;
    if (card === null) return 'a wait answer names its card: 12 or "#12"';
    // An answer nobody can read is a failed check: the card holds and shows the problem.
    return { _tag: "answer", card, answer: Waits.decodeAnswer(answer) };
  }
  const park = decodePark(body.wait);
  if (Result.isFailure(park)) {
    return `a wait needs card, on and note (or result, to answer a check): ${park.failure.message}`;
  }
  const { card: ref, waitsOn, ...request } = park.success;
  const card = cardNumberOf(ref);
  if (card === null) return `"${ref}" is not a card number`;
  const target = waitsOn == null ? null : cardNumberOf(waitsOn);
  if (waitsOn != null && target === null) return `"${waitsOn}" is not a card number`;
  return { _tag: "park", card, waitsOn: target, request };
};

export interface ParsedOutput {
  readonly commands: ReadonlyArray<ScriptCommand>;
  /** Wait answers, pushed wakes and parks, in the order printed. */
  readonly waits: ReadonlyArray<WaitLine>;
  /** Lines that looked like commands but weren't valid. */
  readonly errors: ReadonlyArray<string>;
  /** Everything else the script printed. */
  readonly text: string;
}

const COMMAND_LINE = /^\s*\{.*"kanban"\s*:/;

export const parseOutput = (stdout: string): ParsedOutput => {
  const commands: Array<ScriptCommand> = [];
  const waits: Array<WaitLine> = [];
  const errors: Array<string> = [];
  const text: Array<string> = [];
  stdout.split("\n").forEach((line, index) => {
    if (!COMMAND_LINE.test(line)) {
      text.push(line);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      errors.push(`Line ${index + 1} is not valid JSON.`);
      return;
    }
    if (isRecord(value) && isRecord(value.kanban)) {
      const line = waitLineOf(value.kanban);
      if (typeof line === "string") errors.push(`Line ${index + 1}: ${line}`);
      else waits.push(line);
      return;
    }
    const decoded = decodeCommand(value);
    if (Result.isSuccess(decoded)) commands.push(decoded.success);
    else errors.push(`Line ${index + 1}: ${decoded.failure.message}`);
  });
  return { commands, waits, errors, text: text.join("\n").trim() };
};

/**
 * The card a script's card already exists as, so a script that runs every few
 * minutes can print the same card each time. Matched by link URL, or by title
 * among open cards when it has no links.
 */
export const duplicateOf = (
  cards: ReadonlyArray<KanbanCard>,
  command: CardCommand,
): KanbanCard | null => {
  const urls = new Set((command.links ?? []).map((link) => link.url.trim()));
  if (urls.size > 0) {
    return cards.find((card) => card.links.some((link) => urls.has(link.url))) ?? null;
  }
  const title = command.title?.trim();
  if (!title) return null;
  return cards.find((card) => card.settledAt === null && card.title === title) ?? null;
};

/**
 * Why a run can't be trusted as a wait check, or null for a clean exit. A run
 * that broke is a failed check for every card it was asked about and printed
 * nothing for: they hold, and count one more failure.
 */
export const checkRunProblem = (
  name: string,
  result: {
    readonly exitCode: number | null;
    readonly timedOut: boolean;
    readonly overflow: boolean;
    readonly spawnError: string | null;
  },
  timeoutMs: number,
): string | null => {
  if (result.spawnError !== null) return `The ${name} script didn't start: ${result.spawnError}`;
  if (result.timedOut) {
    return `The ${name} script timed out after ${Math.round(timeoutMs / 60_000)} minutes`;
  }
  if (result.overflow) return `The ${name} script printed too much and was stopped`;
  return result.exitCode === 0 ? null : `The ${name} script exited with code ${result.exitCode}`;
};

/** The last `bytes` of `text`, cut at a line start when one is near. */
export const tail = (text: string, bytes = OUTPUT_TAIL_BYTES) => {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= bytes) return text;
  const cut = buffer.subarray(buffer.length - bytes).toString("utf8");
  const newline = cut.indexOf("\n");
  return newline >= 0 && newline < 1024 ? cut.slice(newline + 1) : cut;
};

export type BoardEventName = (KanbanScriptTrigger & { readonly _tag: "event" })["event"];

export interface BoardEvent {
  readonly name: BoardEventName;
  /** Who caused it; scripts never fire on what a script did. */
  readonly by: KanbanActor | null;
  /** What the script gets as JSON in KANBAN_EVENT. */
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Text past this is cut before it goes into a script's environment. */
const EVENT_TEXT_LIMIT = 16 * 1024;

const cardPayload = (card: KanbanCard) => ({
  cardId: card.id,
  number: card.number,
  title: card.title,
  stage: card.stage,
  priority: card.priority,
  links: card.links.map((link) => link.url),
});

/**
 * Turns board changes into script events. A card is new or moved by the
 * stage last seen for it, so it starts from the stages already on the board.
 */
export const eventTracker = (stages: Iterable<readonly [string, KanbanCard["stage"]]>) => {
  const seen = new Map(stages);
  return (change: KanbanChange): BoardEvent | null => {
    switch (change._tag) {
      case "card": {
        const card = change.card;
        const before = seen.get(card.id);
        seen.set(card.id, card.stage);
        if (before === undefined) {
          return { name: "card.created", by: card.createdBy, payload: cardPayload(card) };
        }
        if (before === card.stage) return null;
        return {
          name: "card.moved",
          by: change.by ?? null,
          payload: { ...cardPayload(card), from: before },
        };
      }
      case "cardRemoved":
        seen.delete(change.cardId);
        return null;
      case "message": {
        const message = change.message;
        // An answer publishes its message again, with the answer on it.
        if (message.answers.length > 0) return null;
        const text = message.blocks
          .flatMap((block) => (block._tag === "md" ? [block.text] : []))
          .join("\n\n");
        return {
          name: "message.posted",
          by: message.author,
          payload: {
            discussionId: message.discussionId,
            seq: message.seq,
            author: message.authorName,
            text: text.length > EVENT_TEXT_LIMIT ? `${text.slice(0, EVENT_TEXT_LIMIT)}...` : text,
          },
        };
      }
      default:
        return null;
    }
  };
};

/** The KANBAN_EVENT value a script gets for `event`. */
export const eventJson = (boardId: string, event: BoardEvent) =>
  JSON.stringify({ event: event.name, boardId, ...event.payload });

/**
 * Whether a script runs for an event. Never for what a script did, its own or
 * another's, so two scripts can't keep waking each other.
 */
export const listensTo = (script: KanbanScript, event: BoardEvent) =>
  script.enabled &&
  script.trigger._tag === "event" &&
  script.trigger.event === event.name &&
  event.by?._tag !== "script";

/** A discussion a script opened or posted in. */
export const isScriptDiscussion = (discussion: KanbanDiscussion) =>
  discussion.createdBy._tag === "script" ||
  discussion.participants.some((participant) => participant.actor._tag === "script");
