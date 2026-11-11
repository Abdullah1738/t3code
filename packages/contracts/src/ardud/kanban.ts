/**
 * Missions board (code name kanban): cards move through fixed stages, a
 * dispatcher starts agent threads for them from per-model pools, and
 * evaluators steer the work. Discussions are a chat store shared by owner,
 * card threads, evaluators and scripts.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  ForwardCompatibleOptional,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import { ChatFileAttachment, ChatImageAttachment } from "../chatAttachment.ts";
import { ModelSelection } from "../modelSelection.ts";

const kanbanId = <Brand extends string>(brand: Parameters<typeof Schema.brand<Brand>>[0]) =>
  TrimmedNonEmptyString.pipe(Schema.brand<Brand>(brand));

export const KanbanBoardId = kanbanId("KanbanBoardId");
export type KanbanBoardId = typeof KanbanBoardId.Type;
export const KanbanCardId = kanbanId("KanbanCardId");
export type KanbanCardId = typeof KanbanCardId.Type;
export const KanbanGoalId = kanbanId("KanbanGoalId");
export type KanbanGoalId = typeof KanbanGoalId.Type;
export const KanbanDiscussionId = kanbanId("KanbanDiscussionId");
export type KanbanDiscussionId = typeof KanbanDiscussionId.Type;
export const KanbanScriptId = kanbanId("KanbanScriptId");
export type KanbanScriptId = typeof KanbanScriptId.Type;
export const KanbanAutomationId = kanbanId("KanbanAutomationId");
export type KanbanAutomationId = typeof KanbanAutomationId.Type;

export const KANBAN_STAGES = [
  "todo",
  "working",
  "needs_review",
  "in_review",
  "completed",
  "deployed",
  "verified",
  "needs_owner",
] as const;
export const KanbanStage = Schema.Literals(KANBAN_STAGES);
export type KanbanStage = typeof KanbanStage.Type;

/** Stages that always have a live thread, and only the dispatcher moves a card into. */
export const KANBAN_THREAD_STAGES: ReadonlyArray<KanbanStage> = ["working", "in_review"];

export const KanbanActor = Schema.Union([
  Schema.TaggedStruct("owner", {}),
  /** A card's work or review thread. */
  Schema.TaggedStruct("thread", { threadId: ThreadId }),
  Schema.TaggedStruct("evaluator", { threadId: ThreadId }),
  Schema.TaggedStruct("script", { scriptId: KanbanScriptId }),
  Schema.TaggedStruct("system", { component: TrimmedNonEmptyString }),
]);
export type KanbanActor = typeof KanbanActor.Type;

/** Priority 1 is the most urgent, 4 the least; 5 is backlog. */
export const KanbanPriority = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }));
export type KanbanPriority = typeof KanbanPriority.Type;

/** A backlog card is never picked up; one with a thread is paused until it leaves. */
export const KANBAN_BACKLOG = 5;

export const KanbanLinkKind = Schema.Literals(["pr", "linear", "url"]);
export type KanbanLinkKind = typeof KanbanLinkKind.Type;

export const KanbanLink = Schema.Struct({
  kind: KanbanLinkKind,
  url: TrimmedNonEmptyString,
  label: Schema.NullOr(Schema.String),
  /** PR state as last checked on the work thread (syncPrs); null for other links, including PRs attached only as context. */
  state: Schema.NullOr(Schema.Literals(["open", "draft", "merged", "closed"])),
  checkedAt: Schema.NullOr(IsoDateTime),
});
export type KanbanLink = typeof KanbanLink.Type;

/** One review chain: each step's model reviews until clear, then the next step takes over. */
export const KanbanReviewChain = Schema.Struct({
  name: TrimmedNonEmptyString,
  steps: Schema.Array(ModelSelection),
});
export type KanbanReviewChain = typeof KanbanReviewChain.Type;

/** Why a board thread is paused: its last run died on a provider outage. */
export const KanbanThreadPause = Schema.Struct({
  at: IsoDateTime,
  message: Schema.String,
  /** The failed run this pause is for; a different run is a new outage. */
  runId: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type KanbanThreadPause = typeof KanbanThreadPause.Type;

/** Every thread the board started: card work/review threads and evaluators. */
export const KanbanThreadLink = Schema.Struct({
  threadId: ThreadId,
  boardId: KanbanBoardId,
  cardId: Schema.NullOr(KanbanCardId),
  role: Schema.Literals(["work", "review", "evaluator"]),
  /** Evaluator purpose: `discussion:<id>`, `stalled`, `completed`, `deployed`, `check`, `packets`, `setup`, `request`. */
  purpose: Schema.NullOr(Schema.String),
  discussionId: Schema.NullOr(KanbanDiscussionId),
  model: Schema.NullOr(ModelSelection),
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  /** Set while its model is out of usage or down; the board wakes the thread when a probe passes. */
  paused: Schema.NullOr(KanbanThreadPause).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type KanbanThreadLink = typeof KanbanThreadLink.Type;

/** One model a card's work may start on; the highest weight with room wins. */
export const KanbanCardModel = Schema.Struct({
  model: ModelSelection,
  weight: PositiveInt,
});
export type KanbanCardModel = typeof KanbanCardModel.Type;

/** Who does a subtask: the card's worker, its reviewer, an evaluator, or a board script. */
export const KanbanSubtaskOwner = Schema.Literals(["work", "review", "evaluator", "script"]);
export type KanbanSubtaskOwner = typeof KanbanSubtaskOwner.Type;

/**
 * One piece of a card's plan. Subtasks with the same step go in any order; a
 * step opens once every subtask in an earlier step is done or skipped.
 */
export const KanbanSubtask = Schema.Struct({
  /** `s1`, `s2`, ... in the order they were added. */
  id: TrimmedNonEmptyString,
  step: PositiveInt,
  text: Schema.String,
  owner: KanbanSubtaskOwner,
  /** For a script's subtask: the name of the board script that does it. Absent: any script on the card's board. */
  script: Schema.optional(Schema.String),
  state: Schema.Literals(["open", "done", "skipped"]),
  /** What was done, or why it was skipped. */
  note: Schema.NullOr(Schema.String),
  doneBy: Schema.NullOr(KanbanActor),
  doneAt: Schema.NullOr(IsoDateTime),
});
export type KanbanSubtask = typeof KanbanSubtask.Type;

const BlockId = TrimmedNonEmptyString;
const ChoiceOption = Schema.Struct({ id: TrimmedNonEmptyString, label: TrimmedNonEmptyString });

/**
 * Set on a big md, collapse or html block in a list read: the text field holds a short preview
 * and the full block comes from the message read by seq. Optional, so older decoders drop them
 * and show the preview as the block.
 */
const KanbanBlockStub = {
  truncated: Schema.optional(Schema.Boolean),
  /** UTF-8 size of the full text or html. */
  fullBytes: Schema.optional(NonNegativeInt),
};

const MdBlock = Schema.TaggedStruct("md", {
  text: Schema.String,
  ...KanbanBlockStub,
  /**
   * Set only by the reader, on the text that stands in for a block of a kind
   * this build doesn't know: the block as it was stored, so writing the card
   * or message back keeps it. Never sent in and never shown.
   */
  original: Schema.optional(Schema.Unknown),
});
const CollapseBlock = Schema.TaggedStruct("collapse", {
  title: TrimmedNonEmptyString,
  text: Schema.String,
  ...KanbanBlockStub,
});
const HtmlBlock = Schema.TaggedStruct("html", {
  html: Schema.String,
  title: Schema.NullOr(Schema.String),
  height: Schema.NullOr(PositiveInt),
  ...KanbanBlockStub,
});
/** Poll and pick render the same way; poll shows everyone's answers, pick is a decision. */
const ChoiceBlock = Schema.TaggedStruct("choice", {
  id: BlockId,
  style: Schema.Literals(["poll", "pick"]),
  question: TrimmedNonEmptyString,
  options: Schema.Array(ChoiceOption),
  multi: Schema.Boolean,
});
const CardBlock = Schema.TaggedStruct("card", { cardId: KanbanCardId });
const ImageBlock = Schema.TaggedStruct("image", {
  url: TrimmedNonEmptyString,
  alt: Schema.NullOr(Schema.String),
});
/** A file uploaded through the attachment store; the board keeps it under its own id. */
const AttachmentBlock = Schema.TaggedStruct("attachment", {
  attachment: Schema.Union([ChatImageAttachment, ChatFileAttachment]),
});

export const KanbanBlock = Schema.Union([
  MdBlock,
  CollapseBlock,
  HtmlBlock,
  ChoiceBlock,
  CardBlock,
  ImageBlock,
  AttachmentBlock,
]);
export type KanbanBlock = typeof KanbanBlock.Type;

/** What an ask can show beside its question: every discussion block but a pick (its options are their own field). */
export const KanbanAskBlock = Schema.Union([
  MdBlock,
  CollapseBlock,
  HtmlBlock,
  CardBlock,
  ImageBlock,
  AttachmentBlock,
]);
export type KanbanAskBlock = typeof KanbanAskBlock.Type;

/** What stands in for a block of a kind this build doesn't know. */
export const KANBAN_UNKNOWN_BLOCK_TEXT = "A part here can't be shown in this version of Robob.";

const blockTag = (raw: unknown): string | null =>
  typeof raw === "object" &&
  raw !== null &&
  "_tag" in raw &&
  typeof (raw as { _tag: unknown })._tag === "string"
    ? (raw as { _tag: string })._tag
    : null;

/**
 * A block as it is read back from a card or a message. A block of a kind this
 * build doesn't know (a newer server's) decodes as a line of text saying so,
 * in the same place, instead of failing: the indexes a field or an option
 * points at stay right, and the rest of the card or message still loads. The
 * stored block rides along as `original` and is what encodes back, so a build
 * that rewrites the card loses nothing. A block of a known kind is checked as
 * before. Blocks coming in are checked by `KanbanBlockInput`, which stays
 * closed.
 */
const readBlock = <S extends Schema.Top>(block: S, known: ReadonlyArray<string>) =>
  Schema.Unknown.pipe(
    Schema.decodeTo(
      block,
      SchemaTransformation.transform<S["Encoded"], unknown>({
        decode: (raw) => {
          const tag = blockTag(raw);
          return tag === null || known.includes(tag)
            ? (raw as S["Encoded"])
            : ({ _tag: "md", text: KANBAN_UNKNOWN_BLOCK_TEXT, original: raw } as S["Encoded"]);
        },
        encode: (encoded) => {
          const original =
            blockTag(encoded) === "md" ? (encoded as { original?: unknown }).original : undefined;
          return original === undefined ? encoded : original;
        },
      }),
    ),
  );

const KanbanBlockRead = readBlock(KanbanBlock, [
  "md",
  "collapse",
  "html",
  "choice",
  "card",
  "image",
  "attachment",
]);
const KanbanAskBlockRead = readBlock(KanbanAskBlock, [
  "md",
  "collapse",
  "html",
  "card",
  "image",
  "attachment",
]);

/**
 * Kinds with a ready layout and ready response parts. A kind is a label, not a
 * closed list: any other string is valid, and clients render every ask from
 * `kanbanAskResponse`, never by switching on its kind.
 */
export const KANBAN_ASK_PRESETS = [
  "question",
  "decision",
  "draft",
  "action",
  "change",
  "input",
  "secret",
  "file",
  "task",
  "signoff",
  "notice",
  "rank",
] as const;
export type KanbanAskPreset = (typeof KANBAN_ASK_PRESETS)[number];
/** @deprecated The same list under its first name. */
export const KANBAN_ASK_KINDS = KANBAN_ASK_PRESETS;
export const KanbanAskKind = Schema.String;
export type KanbanAskKind = string;

export const KanbanAskTextFormat = Schema.Literals(["markdown", "text"]);
export type KanbanAskTextFormat = typeof KanbanAskTextFormat.Type;

/** One answer to pick. Its id is also the option id of the ask's pick block. */
export const KanbanAskOption = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  /** What the option is. */
  detail: Schema.optional(Schema.String),
  recommended: Schema.optional(Schema.Boolean),
  /** What happens once it is picked, when the label doesn't say. */
  consequence: Schema.optional(Schema.String),
  /** Index into the ask's `blocks`: the picture or page that shows this option. */
  block: Schema.optional(NonNegativeInt),
});
export type KanbanAskOption = typeof KanbanAskOption.Type;

/** The exact text the agent will post or send, and where. */
export const KanbanAskDraft = Schema.Struct({
  text: Schema.String,
  format: KanbanAskTextFormat,
  /** Where it goes, e.g. "comment on PR #512". */
  target: Schema.optional(Schema.String),
});
export type KanbanAskDraft = typeof KanbanAskDraft.Type;

/** What will be done, where, the proof it is ready, how to undo it, and what happens after. */
export const KanbanAskAction = Schema.Struct({
  summary: Schema.String,
  command: Schema.optional(Schema.String),
  target: Schema.optional(Schema.String),
  evidence: Schema.optional(Schema.Array(Schema.String)),
  undo: Schema.optional(Schema.String),
  /** What the asker does once it is done, e.g. "Post the before and after on the Linear ticket". */
  then: Schema.optional(Schema.String),
});
export type KanbanAskAction = typeof KanbanAskAction.Type;

/** A text being replaced. Clients render before, after and a diff; the server only stores both. */
export const KanbanAskChange = Schema.Struct({
  label: Schema.String,
  before: Schema.String,
  after: Schema.String,
  format: KanbanAskTextFormat,
});
export type KanbanAskChange = typeof KanbanAskChange.Type;

/**
 * The types of value a field takes. A client shows a type it doesn't know as
 * text, so a newer server never breaks an older client.
 */
export const KANBAN_ASK_FIELD_TYPES = [
  "text",
  "longtext",
  "number",
  "date",
  "datetime",
  "toggle",
  "select",
  "rank",
  "file",
  "secret",
  "custom",
] as const;
export type KanbanAskFieldType = (typeof KANBAN_ASK_FIELD_TYPES)[number];

export const KanbanAskFieldOption = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
});
export type KanbanAskFieldOption = typeof KanbanAskFieldOption.Type;

/**
 * One value the owner fills in. The keys after `default` belong to one type
 * each: `unit`, `min`, `max` to number; `options` to select (the choices) and
 * rank (the items to order); `multi` to select; `accepts` and `maxFiles` to
 * file; `block` to custom.
 */
export const KanbanAskField = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: Schema.String,
  /** One of `KANBAN_ASK_FIELD_TYPES`. */
  type: Schema.String,
  required: Schema.optional(Schema.Boolean),
  hint: Schema.optional(Schema.String),
  /** What the field starts with; the same shape as its value. */
  default: Schema.optional(Schema.Json),
  unit: Schema.optional(Schema.String),
  min: Schema.optional(Schema.Finite),
  max: Schema.optional(Schema.Finite),
  options: Schema.optional(Schema.Array(KanbanAskFieldOption)),
  multi: Schema.optional(Schema.Boolean),
  /** Mime types (`image/*`, `application/pdf`) or extensions (`.csv`) a file field takes. */
  accepts: Schema.optional(Schema.Array(Schema.String)),
  maxFiles: Schema.optional(PositiveInt),
  /** A custom field: index into the ask's `blocks` of the html page that produces its value. */
  block: Schema.optional(NonNegativeInt),
});
export type KanbanAskField = typeof KanbanAskField.Type;

export const KanbanAskTaskStep = Schema.Struct({
  text: Schema.String,
  link: Schema.optional(Schema.String),
});
export type KanbanAskTaskStep = typeof KanbanAskTaskStep.Type;

/**
 * What the owner gives back, as parts that combine. Stored on asks whose
 * asker wrote them or whose kind is not one of the first five; read every ask
 * through `kanbanAskResponse`.
 */
export const KanbanAskRespond = Schema.Struct({
  /** Approve or reject, under these labels when given ("Deploy" / "Don't deploy"). */
  verdict: Schema.optional(
    Schema.Struct({
      approve: Schema.optional(Schema.String),
      reject: Schema.optional(Schema.String),
    }),
  ),
  /** Pick from the ask's `options`; `multi` on the ask says whether several. */
  choose: Schema.optional(
    Schema.Struct({
      min: Schema.optional(NonNegativeInt),
      max: Schema.optional(PositiveInt),
    }),
  ),
  /** A small form. */
  fields: Schema.optional(Schema.Array(KanbanAskField)),
  /** The exhibit he may edit before approving. Only "draft" today. */
  edit: Schema.optional(Schema.String),
  /** Steps he does himself; he answers done or couldn't. `proof` names the field that shows it. */
  task: Schema.optional(
    Schema.Struct({
      steps: Schema.Array(KanbanAskTaskStep),
      proof: Schema.optional(Schema.String),
    }),
  ),
  /** Nothing to decide: he only marks it seen. Never combined with another part. */
  ack: Schema.optional(Schema.Boolean),
});
export type KanbanAskRespond = typeof KanbanAskRespond.Type;

/** The verdicts this build writes. Read as a string: a newer build may add one. */
export const KANBAN_ASK_VERDICTS = [
  "approved",
  "rejected",
  "picked",
  "answered",
  "done",
  "cant",
  "acknowledged",
  "handed",
  "dropped",
] as const;
export const KanbanAskVerdict = Schema.String;
export type KanbanAskVerdict = string;

/** How an ask closed. Asks closed before typed asks existed have none. */
export const KanbanAskAnswer = Schema.Struct({
  verdict: KanbanAskVerdict,
  /** With `handed`: what the evaluator decided on the owner's behalf. */
  decision: Schema.optional(Schema.String),
  optionIds: Schema.optional(Schema.Array(Schema.String)),
  /** The answer in the answerer's own words. */
  text: Schema.optional(Schema.String),
  /** The owner's note for the agent that acts on the answer. Never saved as a rule. */
  note: Schema.optional(Schema.String),
  /** A draft ask: the text to post, as the owner left it. */
  finalDraft: Schema.optional(Schema.String),
  /** True when `finalDraft` differs from the draft the agent wrote. */
  draftEdited: Schema.optional(Schema.Boolean),
  /**
   * Field id to the value given. A file field holds the attachments the board
   * kept; a secret field holds `KANBAN_ASK_SECRET_PROVIDED`, never the value.
   */
  values: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  /** He handed it over with "every time": an evaluator was asked to take asks like it from now on. */
  always: Schema.optional(Schema.Boolean),
  /** The evaluator thread that "every time" started. */
  evaluatorThreadId: Schema.optional(ThreadId),
  by: KanbanActor,
  at: IsoDateTime,
});
export type KanbanAskAnswer = typeof KanbanAskAnswer.Type;

/**
 * A question for the owner. A blocking ask holds the card in Needs Owner; an
 * async one lets its work go on and can be made blocking later.
 *
 * Everything after `closedAt` is optional and absent on asks stored before
 * typed asks: read `kind`, `revision`, the changes and what he gives back
 * through `kanbanAskKind`, `kanbanAskRevision`, `kanbanAskChanges` and
 * `kanbanAskResponse`.
 */
export const KanbanOwnerAsk = Schema.Struct({
  /** `q1`, `q2`, ... per card; also the id of its pick block when it has options. */
  id: TrimmedNonEmptyString,
  /** The question. It must read alone: it is all an older client shows. */
  text: Schema.String,
  blocking: Schema.Boolean,
  by: KanbanActor,
  at: IsoDateTime,
  /** The card discussion message that asked it (its latest version, once edited); null when it wasn't posted. */
  seq: Schema.NullOr(PositiveInt),
  /** Set once answered or dropped. */
  closedAt: Schema.NullOr(IsoDateTime),
  /** A label for the layout; absent means "question". Behaviour comes from `kanbanAskResponse`. */
  kind: Schema.optional(KanbanAskKind),
  /** One short line saying what is being asked. */
  title: Schema.optional(Schema.String),
  /** Markdown: why it is asked and what the owner needs to know to answer without opening the card. */
  context: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(KanbanAskOption)),
  /** With options: several may be picked. */
  multi: Schema.optional(Schema.Boolean),
  draft: Schema.optional(KanbanAskDraft),
  action: Schema.optional(KanbanAskAction),
  /** One text being replaced, as first stored. New asks write `changes`. */
  change: Schema.optional(KanbanAskChange),
  /** The texts being replaced, e.g. one per file. */
  changes: Schema.optional(Schema.Array(KanbanAskChange)),
  /** What he gives back, when it isn't what the kind and contents imply. */
  respond: Schema.optional(KanbanAskRespond),
  /** Who it is for: absent means the owner. "evaluator" asks the board's evaluator instead. */
  to: Schema.optional(Schema.String),
  /** The facts the ask rests on (a head commit, a version). */
  basis: Schema.optional(Schema.String),
  /** Past this time the ask is stale and can't be answered until its asker renews it. */
  expiresAt: Schema.optional(IsoDateTime),
  /** Asks with the same key on a board are the same shape and can be answered together. */
  batchKey: Schema.optional(Schema.String),
  /** Bumped every time the agent edits the open ask. Absent means 0. */
  revision: Schema.optional(NonNegativeInt),
  revisedAt: Schema.optional(IsoDateTime),
  revisionNote: Schema.optional(Schema.String),
  /** The message that first asked it, kept once an edit moves `seq` to the new version. */
  firstSeq: Schema.optional(PositiveInt),
  /** Set when it closes through the answer path, a hand-over or a drop. */
  answer: Schema.optional(KanbanAskAnswer),
  /** The owner asked a clarifying question: the ask waits for the agent, not for him. */
  clarifyAskedAt: Schema.optional(IsoDateTime),
  /** It is with the evaluator: the owner handed it over, or it was asked `to` the evaluator. */
  handedAt: Schema.optional(IsoDateTime),
  /**
   * The owner put it away until this time. It stays open and keeps holding its
   * card, but leaves his count and list until the time passes, or until its
   * asker edits it or replies on it. Only the owner sets and clears it.
   */
  snoozedUntil: Schema.optional(IsoDateTime),
  /** Its asker ended a snooze early by editing or replying: it is back since then. */
  backFromSnoozeAt: Schema.optional(IsoDateTime),
  /** He handed it over with "every time"; copied to the answer when it closes. */
  handedAlways: Schema.optional(Schema.Boolean),
  /** The evaluator thread "every time" started; copied to the answer when it closes. */
  handedThreadId: Schema.optional(ThreadId),
  /**
   * Evidence and visuals shown with the ask: text, an html page, images and
   * files. On the card a big md, collapse or html body is a stub (`truncated`,
   * `fullBytes`); the single-ask read returns them whole. Absent means none.
   */
  blocks: Schema.optional(Schema.Array(KanbanAskBlockRead)),
});
export type KanbanOwnerAsk = typeof KanbanOwnerAsk.Type;

export const kanbanAskKind = (ask: Pick<KanbanOwnerAsk, "kind">): KanbanAskKind =>
  ask.kind ?? "question";
export const kanbanAskRevision = (ask: Pick<KanbanOwnerAsk, "revision">): number =>
  ask.revision ?? 0;
/** The texts an ask replaces, whichever way it stored them. */
export const kanbanAskChanges = (
  ask: Pick<KanbanOwnerAsk, "change" | "changes">,
): ReadonlyArray<KanbanAskChange> => ask.changes ?? (ask.change ? [ask.change] : []);

/** The id of the one field a plain question takes; its value is stored as the answer's `text`. */
export const KANBAN_ASK_ANSWER_FIELD = "answer";

/** What a secret field holds in a stored answer: that he gave it, never the value. */
export const KANBAN_ASK_SECRET_PROVIDED = { secret: true } as const;

/**
 * The owner's answer to an ask with secret fields, sent over the app's
 * private channel (WS `secrets.answerAsk`), never the board's HTTP routes.
 * `answer` is what the answer route takes, without the secret fields.
 * `secrets` maps a secret field's id to the value he typed: it goes to the
 * server's secret store, in memory, and the asking agent gets a one-use
 * secretRef for it. The card stores only `KANBAN_ASK_SECRET_PROVIDED`.
 */
export const KanbanAskSecretAnswerInput = Schema.Struct({
  cardId: KanbanCardId,
  askId: Schema.String,
  answer: Schema.Struct({
    verdict: Schema.String,
    optionIds: Schema.optional(Schema.Array(Schema.String)),
    text: Schema.optional(Schema.String),
    note: Schema.optional(Schema.String),
    finalDraft: Schema.optional(Schema.String),
    values: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
    /** The revision the client showed; a newer one refuses the answer. */
    revision: Schema.optional(Schema.Int),
  }),
  secrets: Schema.Record(Schema.String, Schema.String),
});
export type KanbanAskSecretAnswerInput = typeof KanbanAskSecretAnswerInput.Type;

/** The same reply as the answer route: where the card is now, and the ask as stored. */
export const KanbanAskSecretAnswerResult = Schema.Struct({
  card: Schema.Struct({ id: KanbanCardId, number: Schema.Number, stage: KanbanStage }),
  ask: Schema.NullOr(KanbanOwnerAsk),
});
export type KanbanAskSecretAnswerResult = typeof KanbanAskSecretAnswerResult.Type;

/** What the owner gives back on an ask, with every default filled in. */
export interface KanbanAskResponse {
  /** Approve or reject, under these labels. */
  readonly verdict: { readonly approve: string; readonly reject: string } | null;
  /** Pick `min` to `max` of these options. */
  readonly choose: {
    readonly options: ReadonlyArray<KanbanAskOption>;
    readonly multi: boolean;
    readonly min: number;
    readonly max: number;
  } | null;
  /** Values to fill in. A plain question is one required longtext field, `answer`. */
  readonly fields: ReadonlyArray<KanbanAskField>;
  /** The exhibit he may edit before approving. */
  readonly edit: "draft" | null;
  /** Steps he does himself, answered with done or couldn't. */
  readonly task: {
    readonly steps: ReadonlyArray<KanbanAskTaskStep>;
    readonly proof?: string | undefined;
  } | null;
  /** Nothing to decide: he marks it seen. */
  readonly ack: boolean;
}

type AskResponseFields = Pick<
  KanbanOwnerAsk,
  "kind" | "options" | "multi" | "draft" | "action" | "change" | "changes" | "respond"
>;

const chooseOf = (
  ask: Pick<KanbanOwnerAsk, "options" | "multi">,
  limits: { readonly min?: number | undefined; readonly max?: number | undefined } = {},
): KanbanAskResponse["choose"] => {
  const options = ask.options ?? [];
  if (options.length === 0) return null;
  const multi = ask.multi === true;
  const max = Math.min(limits.max ?? (multi ? options.length : 1), options.length);
  return { options, multi, min: Math.min(limits.min ?? 1, max), max };
};

/**
 * The response parts of any ask: the ones its asker wrote, or the ones its
 * kind and contents imply. An ask stored before typed asks (no kind, no
 * options) takes a free-text reply and nothing else. Clients render from
 * this and never switch on `kind` for behaviour.
 */
export const kanbanAskResponse = (ask: AskResponseFields): KanbanAskResponse => {
  const stored = ask.respond;
  if (stored !== undefined) {
    return {
      verdict: stored.verdict
        ? {
            approve: stored.verdict.approve ?? "Approve",
            reject: stored.verdict.reject ?? "Reject",
          }
        : null,
      choose: stored.choose ? chooseOf(ask, stored.choose) : null,
      fields: stored.fields ?? [],
      edit: stored.edit === "draft" && ask.draft !== undefined ? "draft" : null,
      task: stored.task ?? null,
      ack: stored.ack === true,
    };
  }
  const choose = chooseOf(ask);
  const exhibit =
    ask.draft !== undefined || ask.action !== undefined || kanbanAskChanges(ask).length > 0;
  return {
    // Options stand in for approve and reject, as the ask's pick block always showed them.
    verdict: choose === null && exhibit ? { approve: "Approve", reject: "Reject" } : null,
    choose,
    fields:
      choose === null && !exhibit
        ? [
            {
              id: KANBAN_ASK_ANSWER_FIELD as KanbanAskField["id"],
              label: "Your answer",
              type: "longtext",
              required: true,
            },
          ]
        : [],
    edit: ask.draft !== undefined ? "draft" : null,
    task: null,
    ack: false,
  };
};

/**
 * An ask answered in words alone: a plain question, and every ask the build
 * before typed asks made. Nothing to approve, pick, fill in, edit or do. Only
 * these are closed by a plain reply in the card's discussion, and only these
 * may be answered without saying which revision was read.
 */
export const kanbanAskIsFreeText = (ask: AskResponseFields): boolean => {
  const response = kanbanAskResponse(ask);
  return (
    response.verdict === null &&
    response.choose === null &&
    response.edit === null &&
    response.task === null &&
    !response.ack &&
    response.fields.length === 1 &&
    response.fields[0]!.id === KANBAN_ASK_ANSWER_FIELD
  );
};

/**
 * The start of the refusal an answer route gives when words alone were sent to
 * an ask that needs a verdict or a pick. Clients match on it to offer a reply
 * on the ask instead.
 */
export const KANBAN_ASK_WORDS_REFUSED = "can't be answered in words alone";

/**
 * Words alone can answer an ask with these response parts (the `answered`
 * verdict): there is no verdict to give and no pick he has to make, and there
 * is something words fill in (a field, or a pick he may leave empty). An
 * approval, a required pick, a task with nothing to fill in and a notice
 * never close on words: he says them in a reply on the ask, which stays open.
 */
export const kanbanResponseTakesWords = (response: KanbanAskResponse): boolean =>
  !response.ack &&
  response.verdict === null &&
  (response.choose === null || response.choose.min === 0) &&
  (response.fields.length > 0 || response.choose !== null);

/** `kanbanResponseTakesWords` for an ask. */
export const kanbanAskTakesWords = (ask: AskResponseFields): boolean =>
  kanbanResponseTakesWords(kanbanAskResponse(ask));

/** A notice: nothing to decide, he only marks it seen. Never blocking, never in the needs-owner count. */
export const kanbanAskIsNotice = (ask: {
  readonly respond?: { readonly ack?: boolean | undefined } | undefined;
}): boolean => ask.respond?.ack === true;

/** An open ask the owner is not expected to act on right now, and why. */
export const kanbanAskWaitsOn = (
  ask: Pick<KanbanOwnerAsk, "clarifyAskedAt" | "handedAt" | "closedAt">,
): "owner" | "agent" | "evaluator" | null =>
  ask.closedAt !== null
    ? null
    : ask.handedAt !== undefined
      ? "evaluator"
      : ask.clarifyAskedAt !== undefined
        ? "agent"
        : "owner";
/** Past its `expiresAt`: its asker must renew it before it can be answered. */
export const kanbanAskExpired = (ask: Pick<KanbanOwnerAsk, "expiresAt">, nowMs: number): boolean =>
  ask.expiresAt !== undefined && Date.parse(ask.expiresAt) <= nowMs;
/** Put away by the owner and not back yet. It is still his turn (`kanbanAskWaitsOn` says "owner"). */
export const kanbanAskSnoozed = (
  ask: Pick<KanbanOwnerAsk, "snoozedUntil" | "closedAt">,
  nowMs: number,
): boolean =>
  ask.closedAt === null && ask.snoozedUntil !== undefined && Date.parse(ask.snoozedUntil) > nowMs;
/**
 * When an open ask came back from a snooze: the time it was snoozed until, or
 * the earlier time its asker edited it or replied. Null when it was never
 * snoozed, is still snoozed, or the owner has acted on it since.
 */
export const kanbanAskBackFromSnooze = (
  ask: Pick<KanbanOwnerAsk, "snoozedUntil" | "backFromSnoozeAt" | "closedAt">,
  nowMs: number,
): string | null =>
  ask.closedAt !== null
    ? null
    : (ask.backFromSnoozeAt ??
      (ask.snoozedUntil !== undefined && Date.parse(ask.snoozedUntil) <= nowMs
        ? ask.snoozedUntil
        : null));

/**
 * One automatic retry on a card's current attempt. A failed run, or a reviewer that
 * ended without a verdict, is run again once before the card is flagged; this
 * records which, so the second failure of the same kind flags.
 */
export const KanbanCardRetry = Schema.Struct({
  /** What went wrong: the run failed, or a nudged reviewer still gave no verdict. */
  kind: Schema.Literals(["run_failed", "no_verdict"]),
  role: Schema.Literals(["work", "review"]),
  /** The failed run, so the same failure reported again isn't counted twice; null for no_verdict. */
  runId: Schema.NullOr(Schema.String),
  /** Why, in the provider's words or the board's. */
  reason: Schema.String,
  /** When the failure was seen; for a failed run the retry may start KANBAN_RETRY_BACKOFF_MS later. */
  at: IsoDateTime,
  /**
   * waiting: a failed run's one retry. The card went back to its queue with its
   * thread and no slot, isn't started before the backoff is over, and keeps the
   * record until the retried turn ends. restarted: a review with no verdict,
   * started again at once.
   */
  state: Schema.Literals(["waiting", "restarted"]),
});
export type KanbanCardRetry = typeof KanbanCardRetry.Type;

/**
 * How long a failed run's card waits in its queue before the dispatcher may start
 * it again, so a provider that just failed is not hit again at once. The card holds
 * no pool slot meanwhile.
 */
export const KANBAN_RETRY_BACKOFF_MS = 60_000;

/**
 * What a parked card can wait on: the board's own checks, or `script`, a
 * check one of the board's scripts answers. The built-in names are reserved.
 */
export const KANBAN_WAIT_KINDS = [
  "push",
  "merge",
  "ci",
  "owner_go",
  "card",
  "time",
  "script",
] as const;
export const KanbanWaitKind = Schema.Literals(KANBAN_WAIT_KINDS);
export type KanbanWaitKind = typeof KanbanWaitKind.Type;

/**
 * Why a card with no running thread sits where it is, as data: the board
 * checks it on every tick, wakes whoever acts next when it is over, and shows
 * it instead of "idle". A card has at most one. Stored only while it holds.
 */
export const KanbanWait = Schema.Struct({
  /**
   * `push`: new commits on `pr`. `merge`: `pr` merged. `ci`: checks on `pr`
   * finished. `owner_go`: the owner answered open ask `ask`. `card`: card
   * `card` is done. `time`: `until` has passed. `script`: the board script
   * named `script` says so.
   */
  on: KanbanWaitKind,
  /** script: the board script that checks it, by name. */
  script: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** script: what the check is told, as the agent wrote it (a small JSON object). */
  args: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** push, merge, ci: the pull request's URL, as on the card's links. */
  pr: Schema.NullOr(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** card: the card it waits on. */
  card: Schema.NullOr(KanbanCardId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** owner_go: the open ask (q1, q2...) whose answer ends it. */
  ask: Schema.NullOr(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** time: when it ends. Any other kind: when it counts as stuck, instead of the kind's default. */
  until: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** push: the PR's head commit when the wait was set (the reviewed commit); a different head ends it. */
  sinceHead: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** One line: what exactly is awaited, for the board and the wake. */
  note: Schema.String,
  by: KanbanActor,
  at: IsoDateTime,
  /** Who is woken when it ends; null is whoever acts next in the card's stage. */
  wakeRole: Schema.NullOr(Schema.Literals(["work", "review", "evaluator"])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Set once when it ran past its limit: the card shows as stuck, and still wakes if the wait ends. */
  expiredAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** The check's latest one-line progress note ("CI 3 of 5 passed"), or null. */
  status: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /**
   * When a check last changed what the wait shows (its status, a failure, a failure
   * cleared). A check that changes nothing does not write the card, so this is not
   * the time of the latest check: a script's runs record that.
   */
  lastCheckedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Checks in a row that failed or gave no readable answer; 0 after one that answered. */
  failures: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /** Why the last check failed, while `failures` is above 0. */
  problem: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type KanbanWait = typeof KanbanWait.Type;

/** Failed checks in a row before a wait shows as "check failing". */
export const KANBAN_WAIT_CHECK_FAILURES = 3;

/** A wait whose check keeps failing: it still holds, but nothing can end it until the check works. */
export const kanbanWaitCheckFailing = (wait: Pick<KanbanWait, "failures">): boolean =>
  wait.failures >= KANBAN_WAIT_CHECK_FAILURES;

/** How long an evaluator has to decide what a card does once its wait ended. */
export const KANBAN_DECIDE_MS = 30 * 60 * 1000;

/** A card held for its evaluator: its wait ended in a way only the evaluator can take on. */
export const KanbanCardDeciding = Schema.Struct({
  /** When the wait ended. */
  since: IsoDateTime,
  /** What ended and why, in one line. */
  why: Schema.String,
  /** When the evaluator was told; null while the note is still on its way. */
  toldAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type KanbanCardDeciding = typeof KanbanCardDeciding.Type;

export const KanbanCard = Schema.Struct({
  id: KanbanCardId,
  boardId: KanbanBoardId,
  /** Per-board sequence, shown as #12. */
  number: PositiveInt,
  title: Schema.String,
  description: Schema.String,
  prompt: Schema.String,
  /** The card's flow, step by step: the work, its review and what comes after. */
  subtasks: Schema.Array(KanbanSubtask).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Highest subtask number ever handed out on this card, so a dropped id is never reused. */
  subtaskSeq: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  stage: KanbanStage,
  priority: KanbanPriority,
  goalId: Schema.NullOr(KanbanGoalId),
  projects: Schema.Array(TrimmedNonEmptyString),
  /** Model the work thread runs on. */
  model: ModelSelection,
  /**
   * Models the work may start on, highest weight first. A pool with room at
   * the top weight wins, ties at random. Empty means just `model`.
   */
  models: Schema.Array(KanbanCardModel).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** T3 project the card's threads run in; null uses the board default. */
  projectId: Schema.NullOr(ProjectId),
  links: Schema.Array(KanbanLink),
  blockedBy: Schema.Array(KanbanCardId),
  stalled: Schema.NullOr(
    Schema.Struct({ reason: Schema.String, by: KanbanActor, at: IsoDateTime }),
  ),
  /** Set while the card sits in Needs Owner. */
  question: Schema.NullOr(Schema.String),
  asks: Schema.Array(KanbanOwnerAsk).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Review chain name from the board; null uses the board default. */
  reviewChain: Schema.NullOr(TrimmedNonEmptyString),
  /** Position in the review chain while in review; reset when findings send it back. */
  reviewStep: NonNegativeInt,
  reviewRound: NonNegativeInt,
  activeThreadId: Schema.NullOr(ThreadId),
  activeRole: Schema.NullOr(Schema.Literals(["work", "review"])),
  /** Pool key (instance/model#level) the active thread holds a slot in. */
  activePool: Schema.NullOr(Schema.String),
  workThreadId: Schema.NullOr(ThreadId),
  reviewThreadId: Schema.NullOr(ThreadId),
  discussionId: Schema.NullOr(KanbanDiscussionId),
  /** Sent to the card's thread the next time the dispatcher starts or wakes it (findings, owner answer). */
  wakeNote: Schema.NullOr(Schema.String),
  /**
   * What the card waits on while no thread runs it. Absent on cards that wait
   * on nothing. A wait this build can't read (a kind a newer server added)
   * decodes as absent, so the board still loads.
   */
  wait: ForwardCompatibleOptional(KanbanWait),
  /**
   * Set when a wait ended and what the card does next is its evaluator's call.
   * Until that evaluator's turn ends (or KANBAN_DECIDE_MS passes) the card is not
   * started, claimed or completed. Absent on every other card; a build that does
   * not know the key drops it, and the card then carries on as it did before.
   */
  deciding: ForwardCompatibleOptional(KanbanCardDeciding),
  /** Set when the server nudged the active thread after a turn ended without a card move. */
  nudgedAt: Schema.NullOr(IsoDateTime),
  /**
   * Automatic retries used on the current attempt, at most one per kind. Absent on
   * most cards and on every card stored before retries existed. Cleared by a real
   * move, a turn that ends normally, a review verdict and a flag.
   */
  retries: Schema.optional(Schema.Array(KanbanCardRetry)),
  settledAt: Schema.NullOr(IsoDateTime),
  createdBy: KanbanActor,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  movedAt: IsoDateTime,
});
export type KanbanCard = typeof KanbanCard.Type;

/**
 * The retry a card is in the middle of, for a board to show "Retrying": a failed
 * run waiting in its queue to be started again, or the retried run that hasn't
 * ended. A flagged card is past retrying.
 */
export const kanbanRetrying = (
  card: Pick<KanbanCard, "retries" | "stalled" | "settledAt">,
): KanbanCardRetry | undefined =>
  card.stalled !== null || card.settledAt !== null ? undefined : card.retries?.at(-1);

/**
 * The time (epoch ms) before which the dispatcher must not start a card: the end
 * of a failed run's backoff. Null when the card waits on no retry. It says nothing
 * about a card that is running; the dispatcher only asks it of cards in a queue.
 */
export const kanbanRetryNotBefore = (card: Pick<KanbanCard, "retries">): number | null => {
  let notBefore: number | null = null;
  for (const retry of card.retries ?? []) {
    if (retry.state !== "waiting") continue;
    const at = Date.parse(retry.at);
    // A stamp that doesn't parse holds nothing back.
    if (!Number.isFinite(at)) continue;
    notBefore = Math.max(notBefore ?? 0, at + KANBAN_RETRY_BACKOFF_MS);
  }
  return notBefore;
};

/** The models a card's work may start on, highest weight first. */
export const kanbanCardModels = (card: KanbanCard): ReadonlyArray<KanbanCardModel> =>
  card.models.length > 0 ? card.models : [{ model: card.model, weight: 1 }];

export const kanbanOpenAsks = (card: Pick<KanbanCard, "asks">): ReadonlyArray<KanbanOwnerAsk> =>
  card.asks.filter((ask) => ask.closedAt === null);

/** A card in Needs Owner, or one with an open ask that doesn't block it yet. */
export const kanbanNeedsOwner = (card: Pick<KanbanCard, "asks" | "stage" | "settledAt">) =>
  card.settledAt === null && (card.stage === "needs_owner" || kanbanOpenAsks(card).length > 0);

type AskTurnFields = Pick<
  KanbanOwnerAsk,
  "closedAt" | "clarifyAskedAt" | "handedAt" | "expiresAt" | "snoozedUntil"
> & { readonly respond?: { readonly ack?: boolean | undefined } | undefined };

/**
 * An open ask that needs the owner now: his turn, not past its `expiresAt`,
 * not snoozed, and something to decide (a notice only wants to be seen).
 */
export const kanbanAskNeedsOwner = (ask: AskTurnFields, nowMs: number): boolean =>
  kanbanAskWaitsOn(ask) === "owner" &&
  !kanbanAskExpired(ask, nowMs) &&
  !kanbanAskSnoozed(ask, nowMs) &&
  !kanbanAskIsNotice(ask);

export interface KanbanAskTurns {
  /** His turn, and answerable. */
  readonly owner: number;
  /** He replied on these: they wait on their asker. */
  readonly agent: number;
  /** He handed these to the evaluator. */
  readonly evaluator: number;
  /** His turn, but past `expiresAt`: their asker must renew them. */
  readonly expired: number;
  /** His turn, but he put them away until later. */
  readonly snoozed: number;
  /** His to see, nothing to decide. */
  readonly notices: number;
}

/** A card's open asks, counted by whose turn they are. A settled card has none. */
export const kanbanAskTurns = (
  card: { readonly settledAt: string | null; readonly asks: ReadonlyArray<AskTurnFields> },
  nowMs: number,
): KanbanAskTurns => {
  const turns = { owner: 0, agent: 0, evaluator: 0, expired: 0, snoozed: 0, notices: 0 };
  if (card.settledAt !== null) return turns;
  for (const ask of card.asks) {
    const turn = kanbanAskWaitsOn(ask);
    if (turn === null) continue;
    if (turn !== "owner") turns[turn] += 1;
    else if (kanbanAskExpired(ask, nowMs)) turns.expired += 1;
    else if (kanbanAskSnoozed(ask, nowMs)) turns.snoozed += 1;
    else if (kanbanAskIsNotice(ask)) turns.notices += 1;
    else turns.owner += 1;
  }
  return turns;
};

/**
 * Whether a card counts in the "needs you" numbers: it has an ask the owner can
 * answer now, or it sits in Needs Owner with no open ask to decide (a hold set by hand).
 * A card whose open asks are all handed over, waiting on their asker, expired or
 * snoozed does not count, though a blocking one still holds it in Needs Owner.
 */
export const kanbanCardNeedsOwner = (
  card: {
    readonly stage: KanbanStage;
    readonly settledAt: string | null;
    readonly asks: ReadonlyArray<AskTurnFields>;
  },
  nowMs: number,
): boolean =>
  card.settledAt === null &&
  (card.asks.some((ask) => kanbanAskNeedsOwner(ask, nowMs)) ||
    (card.stage === "needs_owner" &&
      card.asks.every((ask) => ask.closedAt !== null || kanbanAskIsNotice(ask))));

/** The card's wait, or null. */
export const kanbanWait = (card: Pick<KanbanCard, "wait">): KanbanWait | null => card.wait ?? null;

/**
 * A wait left behind: the card was moved after it was set, so whoever moved
 * it took the card on. The board drops such a wait without waking anyone.
 */
export const kanbanWaitStale = (card: Pick<KanbanCard, "wait" | "movedAt">): boolean =>
  card.wait !== undefined && Date.parse(card.movedAt) > Date.parse(card.wait.at);

/**
 * A card parked on a wait. A card with a running thread is never waiting (the
 * thread is the truth), and neither is one moved since its wait was set.
 */
export const kanbanWaiting = (
  card: Pick<KanbanCard, "wait" | "activeThreadId" | "settledAt" | "movedAt">,
): boolean =>
  card.wait !== undefined &&
  card.activeThreadId === null &&
  card.settledAt === null &&
  !kanbanWaitStale(card);

/**
 * A card held for its evaluator after a wait ended (`deciding`). It is not
 * started, claimed or completed until the evaluator's turn ends, the card is
 * moved or parked again, or the time to decide runs out. A thread on the card,
 * a newer move or a new wait all mean somebody has taken it on. Without a clock
 * the time limit is not applied: the board's tick removes a hold that ran out.
 */
export const kanbanDeciding = (
  card: Pick<KanbanCard, "deciding" | "wait" | "activeThreadId" | "settledAt" | "movedAt">,
  nowMs?: number,
): boolean => {
  const deciding = card.deciding;
  if (deciding === undefined || card.wait !== undefined) return false;
  if (card.activeThreadId !== null || card.settledAt !== null) return false;
  const since = Date.parse(deciding.since);
  if (Date.parse(card.movedAt) > since) return false;
  return nowMs === undefined || nowMs - since < KANBAN_DECIDE_MS;
};

/** The card without its evaluator hold. */
export const kanbanWithoutDeciding = <C extends Pick<KanbanCard, "deciding">>(card: C): C => {
  if (card.deciding === undefined) return card;
  const { deciding: _deciding, ...rest } = card;
  return rest as C;
};

/** The card without its wait. */
export const kanbanWithoutWait = <C extends Pick<KanbanCard, "wait">>(card: C): C => {
  if (card.wait === undefined) return card;
  const { wait: _wait, ...rest } = card;
  return rest as C;
};

const WAIT_HOUR_MS = 60 * 60 * 1000;
const WAIT_DAY_MS = 24 * WAIT_HOUR_MS;

/**
 * How long a wait may hold with nothing happening before the card shows as
 * stuck, per kind. A `time` wait has no limit: it ends by itself.
 */
export const KANBAN_WAIT_LIMIT_MS: Readonly<Record<KanbanWaitKind, number | null>> = {
  push: 3 * WAIT_DAY_MS,
  merge: 2 * WAIT_DAY_MS,
  ci: 3 * WAIT_HOUR_MS,
  owner_go: 2 * WAIT_DAY_MS,
  card: 7 * WAIT_DAY_MS,
  time: null,
  script: 7 * WAIT_DAY_MS,
};

/** When a wait counts as stuck: its own `until` (not for `time`), else its kind's limit after it was set. Null: never. */
export const kanbanWaitDeadlineMs = (wait: KanbanWait): number | null => {
  if (wait.on === "time") return null;
  if (wait.until !== null) {
    const until = Date.parse(wait.until);
    if (Number.isFinite(until)) return until;
  }
  const limit = KANBAN_WAIT_LIMIT_MS[wait.on];
  const at = Date.parse(wait.at);
  return limit === null || !Number.isFinite(at) ? null : at + limit;
};

/** A wait that ran past its limit, whether or not the board has marked it yet. */
export const kanbanWaitExpired = (wait: KanbanWait, nowMs: number): boolean => {
  if (wait.expiredAt !== null) return true;
  const deadline = kanbanWaitDeadlineMs(wait);
  return deadline !== null && nowMs >= deadline;
};

/** The step the card is on: the first with an open subtask, or null when none is open. */
export const kanbanOpenStep = (card: Pick<KanbanCard, "subtasks">): number | null =>
  card.subtasks.reduce<number | null>(
    (step, subtask) =>
      subtask.state === "open" && (step === null || subtask.step < step) ? subtask.step : step,
    null,
  );

/** Open subtasks of the step the card is on, for one owner or all. */
export const kanbanStepSubtasks = (
  card: Pick<KanbanCard, "subtasks">,
  owner?: KanbanSubtask["owner"],
): ReadonlyArray<KanbanSubtask> => {
  const step = kanbanOpenStep(card);
  return card.subtasks.filter(
    (subtask) =>
      subtask.state === "open" &&
      subtask.step === step &&
      (owner === undefined || subtask.owner === owner),
  );
};

/**
 * True when the step a card is on needs the evaluator: it has an evaluator
 * subtask and nothing else but evaluator and script subtasks. A mixed step
 * still wakes the evaluator, for its own subtasks only.
 */
export const kanbanEvaluatorStep = (card: Pick<KanbanCard, "subtasks">): boolean => {
  const open = kanbanStepSubtasks(card);
  return (
    open.some((subtask) => subtask.owner === "evaluator") &&
    open.every((subtask) => subtask.owner === "evaluator" || subtask.owner === "script")
  );
};

/** True when the step a card is on is only board scripts' subtasks. */
export const kanbanScriptStep = (card: Pick<KanbanCard, "subtasks">): boolean => {
  const open = kanbanStepSubtasks(card);
  return open.length > 0 && open.every((subtask) => subtask.owner === "script");
};

/**
 * A todo card the dispatcher leaves alone because its step is the
 * evaluator's or a board script's. One with a wake note still goes back to
 * its worker: review findings and the owner's words have to reach it.
 */
export const kanbanWaitsOnEvaluator = (
  card: Pick<KanbanCard, "stage" | "wakeNote" | "subtasks">,
): boolean =>
  card.stage === "todo" &&
  card.wakeNote === null &&
  (kanbanEvaluatorStep(card) || kanbanScriptStep(card));

/** Stages past the work: a card here no longer blocks anything or waits on anything. */
export const KANBAN_DONE_STAGES: ReadonlySet<KanbanStage> = new Set([
  "completed",
  "deployed",
  "verified",
]);

/** The card fields the blocking graph reads: what a list read has to select to count what a card holds up. */
export type KanbanBlockingCard = Pick<
  KanbanCard,
  "id" | "stage" | "settledAt" | "priority" | "blockedBy"
>;

const isOpenCard = (card: Pick<KanbanCard, "stage" | "settledAt">) =>
  !KANBAN_DONE_STAGES.has(card.stage) && card.settledAt === null;

/**
 * A completed card whose evaluator merge subtask is still open: review has
 * passed, but its work isn't on ardud/main yet. Completed means review-passed;
 * the merge is a later evaluator subtask.
 */
export const kanbanAwaitsMerge = (card: Pick<KanbanCard, "stage" | "subtasks">): boolean =>
  card.stage === "completed" &&
  card.subtasks.some(
    (subtask) =>
      subtask.state === "open" &&
      (subtask.owner === "evaluator" || subtask.owner === "script") &&
      // A merge action starts a clause ("merge router.ts into ...", "...; merge; deploy ...");
      // a check that only mentions a merge ("blocker's merge subtask") doesn't.
      /(?:^|[;:,.]\s*|\b(?:and|then)\s+)merge\b/i.test(subtask.text),
  );

/**
 * The first unfinished card holding `card` up, or undefined. A blocker on the
 * same work thread is no block, since that thread does both in order, unless
 * it can't go on itself: stalled, in the backlog, waiting on the owner or the
 * evaluator, or held up in turn. A completed blocker still holds while its
 * merge subtask is open; deployed and verified blockers never do.
 */
export function kanbanHeldUpBy(
  card: KanbanCard,
  byId: ReadonlyMap<string, KanbanCard>,
  thread: string | null = card.workThreadId,
): KanbanCard | undefined {
  // `path` is the chain being walked; meeting a card on it again is a loop, and nothing in a loop goes.
  const heldUp = (waiter: KanbanCard, path: Set<string>): KanbanCard | undefined => {
    for (const id of waiter.blockedBy) {
      const blocker = byId.get(id);
      if (blocker === undefined) continue;
      const done = KANBAN_DONE_STAGES.has(blocker.stage);
      if (done && !kanbanAwaitsMerge(blocker)) continue;
      if (thread === null || blocker.workThreadId !== thread) return blocker;
      // Same thread: it carries the blocker's commits on its own branch, so a finished blocker isn't held.
      if (done) continue;
      if (
        blocker.stalled !== null ||
        blocker.priority === KANBAN_BACKLOG ||
        blocker.stage === "needs_owner" ||
        kanbanWaitsOnEvaluator(blocker) ||
        path.has(blocker.id)
      ) {
        return blocker;
      }
      path.add(blocker.id);
      const deeper = heldUp(blocker, path);
      path.delete(blocker.id);
      if (deeper !== undefined) return blocker;
    }
    return undefined;
  };
  return heldUp(card, new Set([card.id]));
}

export interface KanbanBlocking {
  /** Open cards it holds up, the whole chain: if C waits on B and B waits on A, A holds up two. */
  readonly holds: number;
  /** The most urgent priority among the card and every open card it holds up. */
  readonly urgency: number;
}

/** A waiting To-Do card gains one priority step for every this long it has been startable. */
export const KANBAN_AGING_STEP_MS = 3 * 24 * 60 * 60 * 1000;
/** Most priority steps waiting alone can add. */
export const KANBAN_AGING_MAX_STEPS = 2;
/** Open cards a card must hold up (the whole chain) to gain one priority step, then two. */
export const KANBAN_FANOUT_STEPS: ReadonlyArray<number> = [10, 100];
/**
 * Fan-out and waiting never lift a card above this priority. P1 stays what the
 * owner marked P1, or what holds a P1 card up.
 */
export const KANBAN_BOOST_FLOOR = 2;

export interface KanbanSchedule extends KanbanBlocking {
  /**
   * The priority the card is picked at: `urgency`, lifted one step per
   * KANBAN_FANOUT_STEPS threshold its `holds` reaches and one step per
   * KANBAN_AGING_STEP_MS it has waited, never above KANBAN_BOOST_FLOOR.
   */
  readonly rank: number;
  /** Steps `holds` earned (0 to KANBAN_FANOUT_STEPS.length), before the floor. */
  readonly fanoutSteps: number;
  /** Steps waiting earned (0 to KANBAN_AGING_MAX_STEPS), before the floor. */
  readonly agingSteps: number;
  /**
   * Since when a To-Do card has had nothing unfinished to wait on: its last move, or
   * the last move of its latest finished blocker. Null for a card outside To-Do or
   * one that still waits on an unfinished card, which doesn't age.
   */
  readonly waitingSince: string | null;
}

export interface KanbanScheduleOptions {
  /**
   * The clock waiting is measured against. Left out, it is the newest `updatedAt` on
   * the board, so the same cards always give the same order.
   */
  readonly nowMs?: number | undefined;
  /**
   * Memory the exact `holds` count may use, in 32-bit words. Past it, the rest of the
   * counts are upper bounds (a card reached along two paths counts twice).
   */
  readonly maxWords?: number | undefined;
}

/** Default memory for exact counts: 64 MB, enough for about 20,000 open linked cards. */
const SCHEDULE_MAX_WORDS = 16_000_000;

const popcount = (word: number): number => {
  let v = word - ((word >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

/**
 * The blocking graph of a board, walked once: for every open card, how many open
 * cards it holds up (the whole chain) and the most urgent priority among them.
 * Done and settled cards are left out, and a backlog card waiting on another doesn't
 * count: nobody is going to do it.
 *
 * Cards in a loop of blocks are one group (Tarjan), and the groups come out waiters
 * first, so each group's set of held-up cards is the union of the sets of the groups
 * right behind it. The sets are bitsets: the cost is cards plus edges, times one
 * word per 32 open cards for each edge.
 */
function blockingGraph<C extends KanbanBlockingCard>(cards: ReadonlyArray<C>, maxWords: number) {
  const open: Array<C> = [];
  const index = new Map<string, number>();
  for (const card of cards) {
    if (!isOpenCard(card) || index.has(card.id)) continue;
    index.set(card.id, open.length);
    open.push(card);
  }
  const n = open.length;
  // Edges run blocker -> waiter, stored per blocker.
  const start = new Int32Array(n + 1);
  for (const waiter of open) {
    if (waiter.priority === KANBAN_BACKLOG) continue;
    for (const id of waiter.blockedBy) {
      const blocker = index.get(id);
      if (blocker !== undefined) start[blocker + 1] = (start[blocker + 1] ?? 0) + 1;
    }
  }
  for (let i = 0; i < n; i += 1) start[i + 1] = (start[i + 1] ?? 0) + (start[i] ?? 0);
  const targets = new Int32Array(start[n] ?? 0);
  const fill = start.slice(0, n);
  for (let w = 0; w < n; w += 1) {
    const waiter = open[w]!;
    if (waiter.priority === KANBAN_BACKLOG) continue;
    for (const id of waiter.blockedBy) {
      const blocker = index.get(id);
      if (blocker === undefined) continue;
      targets[fill[blocker]!] = w;
      fill[blocker] = fill[blocker]! + 1;
    }
  }

  // Tarjan's strongly connected components, with its own stack: a chain of blocks
  // can be thousands of cards long.
  const seenAt = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const group = new Int32Array(n).fill(-1);
  const onStack = new Uint8Array(n);
  const stack = new Int32Array(n);
  const callNode = new Int32Array(n);
  const callEdge = new Int32Array(n);
  let stackSize = 0;
  let counter = 0;
  let groups = 0;
  let depth = 0;
  const enter = (v: number) => {
    seenAt[v] = counter;
    low[v] = counter;
    counter += 1;
    stack[stackSize] = v;
    stackSize += 1;
    onStack[v] = 1;
    callNode[depth] = v;
    callEdge[depth] = start[v]!;
    depth += 1;
  };
  for (let root = 0; root < n; root += 1) {
    if (seenAt[root] !== -1) continue;
    enter(root);
    while (depth > 0) {
      const v = callNode[depth - 1]!;
      const edge = callEdge[depth - 1]!;
      if (edge < start[v + 1]!) {
        callEdge[depth - 1] = edge + 1;
        const w = targets[edge]!;
        if (seenAt[w] === -1) enter(w);
        else if (onStack[w] === 1 && seenAt[w]! < low[v]!) low[v] = seenAt[w]!;
        continue;
      }
      depth -= 1;
      if (low[v] === seenAt[v]) {
        for (;;) {
          stackSize -= 1;
          const member = stack[stackSize]!;
          onStack[member] = 0;
          group[member] = groups;
          if (member === v) break;
        }
        groups += 1;
      }
      if (depth > 0) {
        const parent = callNode[depth - 1]!;
        if (low[v]! < low[parent]!) low[parent] = low[v]!;
      }
    }
  }

  // Members per group. Group ids are in the order Tarjan closed them: every group a
  // group holds up has a smaller id, so one pass in id order sees waiters first.
  const memberStart = new Int32Array(groups + 1);
  for (let v = 0; v < n; v += 1) memberStart[group[v]! + 1] = memberStart[group[v]! + 1]! + 1;
  for (let g = 0; g < groups; g += 1) memberStart[g + 1] = memberStart[g + 1]! + memberStart[g]!;
  const members = new Int32Array(n);
  const memberFill = memberStart.slice(0, groups);
  for (let v = 0; v < n; v += 1) {
    const g = group[v]!;
    members[memberFill[g]!] = v;
    memberFill[g] = memberFill[g]! + 1;
  }

  const words = (n + 31) >>> 5;
  let wordsLeft = maxWords;
  /** Cards each group holds up beyond itself; null for a group that holds none, or past the memory limit. */
  const reach: Array<Uint32Array | null> = Array.from({ length: groups }, () => null);
  const held = new Int32Array(groups);
  const exact = new Uint8Array(groups).fill(1);
  /** The most urgent priority in the group, and among the cards it holds up. */
  const own = new Int32Array(groups).fill(KANBAN_BACKLOG);
  const below = new Int32Array(groups).fill(KANBAN_BACKLOG);
  const lastUnion = new Int32Array(groups).fill(-1);
  for (let g = 0; g < groups; g += 1) {
    let set: Uint32Array | null = null;
    let sum = 0;
    let isExact = true;
    for (let m = memberStart[g]!; m < memberStart[g + 1]!; m += 1) {
      const v = members[m]!;
      const priority = open[v]!.priority;
      if (priority < own[g]!) own[g] = priority;
      for (let edge = start[v]!; edge < start[v + 1]!; edge += 1) {
        const child = group[targets[edge]!]!;
        if (child === g || lastUnion[child] === g) continue;
        lastUnion[child] = g;
        const urgent = Math.min(own[child]!, below[child]!);
        if (urgent < below[g]!) below[g] = urgent;
        const size = memberStart[child + 1]! - memberStart[child]!;
        sum += held[child]! + size;
        if (exact[child] === 0) isExact = false;
        if (!isExact) continue;
        if (set === null) {
          if (wordsLeft < words) {
            isExact = false;
            continue;
          }
          wordsLeft -= words;
          set = new Uint32Array(words);
        }
        const theirs = reach[child];
        if (theirs) for (let i = 0; i < words; i += 1) set[i] = set[i]! | theirs[i]!;
        for (let c = memberStart[child]!; c < memberStart[child + 1]!; c += 1) {
          const bit = members[c]!;
          set[bit >>> 5] = set[bit >>> 5]! | (1 << (bit & 31));
        }
      }
    }
    if (isExact && set !== null) {
      let count = 0;
      for (let i = 0; i < words; i += 1) count += popcount(set[i]!);
      held[g] = count;
      reach[g] = set;
    } else if (!isExact) {
      // An upper bound: every open card but this group's own.
      held[g] = Math.min(sum, n - (memberStart[g + 1]! - memberStart[g]!));
      exact[g] = 0;
    }
  }

  return {
    open,
    /** What the card at `open[v]` holds up: the others in its loop, and everything behind it. */
    of: (v: number): KanbanBlocking => {
      const g = group[v]!;
      const card = open[v]!;
      return {
        holds: held[g]! + (memberStart[g + 1]! - memberStart[g]!) - 1,
        // A backlog card stays at the bottom whatever waits on it; only the owner takes it out.
        urgency: card.priority === KANBAN_BACKLOG ? KANBAN_BACKLOG : Math.min(own[g]!, below[g]!),
      };
    },
  };
}

/**
 * What each open card holds up. Done and settled cards are left out, and a
 * backlog card waiting on another doesn't count: nobody is going to do it.
 * The one count of "unblocks": the dispatcher schedules by it, and the board's
 * To-Do order, the ask feed and the Needs-you list all show it.
 */
export function kanbanBlocking(
  cards: ReadonlyArray<KanbanBlockingCard>,
): Map<string, KanbanBlocking> {
  const graph = blockingGraph(cards, SCHEDULE_MAX_WORDS);
  return new Map(graph.open.map((card, v) => [card.id as string, graph.of(v)]));
}

/**
 * The clock of a caller that has none: the newest stamp on any of the board's
 * cards. It never runs ahead of the real time, so nothing ages or comes due early;
 * on a board nothing has touched for a while it runs behind. The dispatcher passes
 * the real time instead.
 */
export function kanbanBoardClock(cards: ReadonlyArray<Pick<KanbanCard, "updatedAt">>): number {
  let newest = "";
  for (const card of cards) if (card.updatedAt > newest) newest = card.updatedAt;
  return newest === "" ? 0 : Date.parse(newest);
}

/**
 * How every open card on a board is ranked for pick-up, from one pass over the
 * blocking graph. A card's rank starts at its urgency (its own priority, or that of
 * the most urgent card it holds up) and is lifted, never above KANBAN_BOOST_FLOOR:
 * one step when it holds up 10 open cards and two at 100, and one step for every
 * 3 days a To-Do card has been startable, at most two.
 */
export function kanbanSchedule(
  cards: ReadonlyArray<KanbanCard>,
  options: KanbanScheduleOptions = {},
): Map<string, KanbanSchedule> {
  const graph = blockingGraph(cards, options.maxWords ?? SCHEDULE_MAX_WORDS);
  const byId = new Map(cards.map((card) => [card.id as string, card]));
  const nowMs = options.nowMs ?? kanbanBoardClock(cards);
  const result = new Map<string, KanbanSchedule>();
  graph.open.forEach((card, v) => {
    const blocking = graph.of(v);
    // A card parked on a wait is not startable: it gathers no age while parked. When
    // the wait ends it keeps its `movedAt`, so the time it was parked counts from then on.
    let waitingSince: string | null =
      card.stage === "todo" && !kanbanWaiting(card) && !kanbanDeciding(card, nowMs)
        ? card.movedAt
        : null;
    if (waitingSince !== null) {
      for (const id of card.blockedBy) {
        const blocker = byId.get(id);
        if (blocker === undefined) continue;
        if (!KANBAN_DONE_STAGES.has(blocker.stage) || kanbanAwaitsMerge(blocker)) {
          waitingSince = null;
          break;
        }
        if (blocker.movedAt > waitingSince) waitingSince = blocker.movedAt;
      }
    }
    const waited = waitingSince === null ? 0 : nowMs - Date.parse(waitingSince);
    // A stamp that doesn't parse ages nothing, rather than poisoning the order with NaN.
    const agingSteps = Number.isFinite(waited)
      ? Math.max(0, Math.min(KANBAN_AGING_MAX_STEPS, Math.floor(waited / KANBAN_AGING_STEP_MS)))
      : 0;
    const fanoutSteps = KANBAN_FANOUT_STEPS.filter((least) => blocking.holds >= least).length;
    const rank =
      blocking.urgency <= KANBAN_BOOST_FLOOR || card.priority === KANBAN_BACKLOG
        ? blocking.urgency
        : Math.max(KANBAN_BOOST_FLOOR, blocking.urgency - fanoutSteps - agingSteps);
    result.set(card.id, { ...blocking, rank, fanoutSteps, agingSteps, waitingSince });
  });
  return result;
}

/**
 * The order todo cards get picked up in: best rank first (see kanbanSchedule:
 * a card holding up an urgent card is as urgent as that card, and holding up
 * many cards or waiting for days lifts it); then the one holding up the most
 * other cards; then the one waiting longest. The dispatcher uses it and the
 * board's To-Do column shows it.
 */
export function kanbanPickOrder(
  cards: ReadonlyArray<KanbanCard>,
  options: KanbanScheduleOptions = {},
) {
  const schedule = kanbanSchedule(cards, options);
  const of = (card: KanbanCard) => schedule.get(card.id) ?? { holds: 0, rank: card.priority };
  return (a: KanbanCard, b: KanbanCard) => {
    const x = of(a);
    const y = of(b);
    return (
      x.rank - y.rank ||
      y.holds - x.holds ||
      a.movedAt.localeCompare(b.movedAt) ||
      a.number - b.number
    );
  };
}

export interface KanbanCardFlow {
  /** Open cards that can't start until this one is done, the whole chain. */
  readonly unblocks: number;
  /** The priority it is picked at; see kanbanSchedule. Its own priority for a done card. */
  readonly rank: number;
  /**
   * A To-Do card nothing on the card itself keeps from starting (the board's pause
   * and pools aside). False while it is parked on a wait, and, when the caller
   * passes a clock, while it waits out a failed run's backoff.
   */
  readonly ready: boolean;
  /** The unfinished cards it lists as blockers, including one its own work thread does first. */
  readonly waitsOn: ReadonlyArray<KanbanCard>;
  /** The card actually holding it up, if any; see kanbanHeldUpBy. */
  readonly heldUpBy: KanbanCard | undefined;
}

/**
 * What a board shows about one card's place in the queue. `schedule` is
 * kanbanSchedule of the same cards, built once per board. `nowMs` lets `ready`
 * see a failed run's backoff; without it only the card's own state counts.
 */
export function kanbanCardFlow(
  card: KanbanCard,
  byId: ReadonlyMap<string, KanbanCard>,
  schedule: ReadonlyMap<string, KanbanSchedule>,
  nowMs?: number,
): KanbanCardFlow {
  const entry = schedule.get(card.id);
  const open = isOpenCard(card);
  const waitsOn = open
    ? card.blockedBy.flatMap((id) => {
        const blocker = byId.get(id);
        return blocker !== undefined &&
          (!KANBAN_DONE_STAGES.has(blocker.stage) || kanbanAwaitsMerge(blocker))
          ? [blocker]
          : [];
      })
    : [];
  const heldUpBy = open ? kanbanHeldUpBy(card, byId) : undefined;
  return {
    unblocks: entry?.holds ?? 0,
    rank: entry?.rank ?? card.priority,
    ready:
      open &&
      card.stage === "todo" &&
      card.activeThreadId === null &&
      card.stalled === null &&
      card.priority !== KANBAN_BACKLOG &&
      !kanbanWaitsOnEvaluator(card) &&
      !kanbanWaiting(card) &&
      !kanbanDeciding(card, nowMs) &&
      (nowMs === undefined || (kanbanRetryNotBefore(card) ?? 0) <= nowMs) &&
      heldUpBy === undefined,
    waitsOn,
    heldUpBy,
  };
}

export const KANBAN_CARD_EVENT_KINDS = [
  "created",
  "moved",
  "edited",
  "linked",
  "flagged",
  "comment",
  "thread",
  "review",
  "subtask",
  /** A wait was set, ended (the body says why), was cleared by hand, or ran past its limit. */
  "wait_set",
  "wait_cleared",
  "wait_expired",
  /** A kind this build doesn't know, written by a newer server. Never written. */
  "other",
] as const;
const KnownCardEventKind = Schema.Literals(KANBAN_CARD_EVENT_KINDS);
type KnownCardEventKind = typeof KnownCardEventKind.Type;
const isCardEventKind = Schema.is(KnownCardEventKind);

/**
 * A card event's kind. A kind this build doesn't know decodes as "other"
 * instead of failing: a client older than its server still loads a card's
 * history when the server adds a kind. A build from before this (its list was
 * closed) fails the whole card read on an unknown kind, so a new kind is only
 * written once those builds are gone.
 */
export const KanbanCardEventKind = Schema.String.pipe(
  Schema.decodeTo(
    KnownCardEventKind,
    SchemaTransformation.transform<KnownCardEventKind, string>({
      decode: (raw) => (isCardEventKind(raw) ? raw : "other"),
      encode: (kind) => kind,
    }),
  ),
);
export type KanbanCardEventKind = typeof KanbanCardEventKind.Type;

export const KanbanCardEvent = Schema.Struct({
  id: NonNegativeInt,
  cardId: KanbanCardId,
  at: IsoDateTime,
  actor: KanbanActor,
  kind: KanbanCardEventKind,
  fromStage: Schema.NullOr(KanbanStage),
  toStage: Schema.NullOr(KanbanStage),
  body: Schema.NullOr(Schema.String),
  /** Review events: the commit the reviewer reviewed, when it said. Null otherwise. */
  head: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type KanbanCardEvent = typeof KanbanCardEvent.Type;

export const KanbanGoal = Schema.Struct({
  id: KanbanGoalId,
  boardId: KanbanBoardId,
  name: TrimmedNonEmptyString,
  status: Schema.Literals(["active", "done"]),
  /** Scribe's current status, at most 15 minutes old while the goal moves. */
  now: Schema.NullOr(Schema.Struct({ text: Schema.String, at: IsoDateTime })),
  /** Numbered story for a non-technical reader, oldest first. */
  story: Schema.Array(Schema.Struct({ at: IsoDateTime, text: Schema.String })),
  createdAt: IsoDateTime,
});
export type KanbanGoal = typeof KanbanGoal.Type;

export const KanbanPool = Schema.Struct({
  /** `instanceId/model#level`, or `instanceId/model` for a model with no level. */
  key: TrimmedNonEmptyString,
  model: ModelSelection,
  slots: NonNegativeInt,
});
export type KanbanPool = typeof KanbanPool.Type;

/** View-only grouping of similar cards, written by the scribe. */
export const KanbanGroup = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  summary: Schema.String,
  cardIds: Schema.Array(KanbanCardId),
  updatedAt: IsoDateTime,
});
export type KanbanGroup = typeof KanbanGroup.Type;

export const KanbanInstructions = Schema.Struct({
  modelRouting: Schema.String,
  reviewerRouting: Schema.String,
  escalation: Schema.String,
});
export type KanbanInstructions = typeof KanbanInstructions.Type;

/** Icons a board can show; each client draws them from its own icon set. */
export const KANBAN_BOARD_ICONS = [
  "briefcase",
  "rocket",
  "code",
  "shield",
  "chart",
  "bot",
  "wallet",
  "flask",
  "server",
  "globe",
  "users",
  "wrench",
  "book",
  "bolt",
  "home",
  "heart",
  "target",
  "box",
  "database",
  "bug",
  "brain",
  "coins",
  "plane",
  "leaf",
] as const;
export const KanbanBoardIcon = Schema.Literals(KANBAN_BOARD_ICONS);
export type KanbanBoardIcon = typeof KanbanBoardIcon.Type;

/** Board summaries carry the image to every client, so it stays a small inline picture. */
export const KANBAN_BOARD_IMAGE_MAX = 40_000;
export const KanbanBoardIconImage = Schema.String.check(
  Schema.isMaxLength(KANBAN_BOARD_IMAGE_MAX),
  Schema.isPattern(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/),
);

/**
 * A board's first setup: the setup evaluator backfills the wiki while card work
 * is held. Null on boards that never ran one (existing rows decode as null).
 */
export const KanbanBoardSetup = Schema.Struct({
  status: Schema.Literals(["running", "done"]),
  discussionId: KanbanDiscussionId,
  threadId: ThreadId,
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type KanbanBoardSetup = typeof KanbanBoardSetup.Type;

export const KanbanBoardPause = Schema.Struct({
  reason: TrimmedNonEmptyString,
  keep: Schema.Array(KanbanCardId),
  at: IsoDateTime,
  by: Schema.String,
});
export type KanbanBoardPause = typeof KanbanBoardPause.Type;

export const KanbanBoard = Schema.Struct({
  id: KanbanBoardId,
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  /** A name from KANBAN_BOARD_ICONS; stored as text so a retired name still decodes. */
  icon: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** An uploaded picture (data URL); shown before the named icon. */
  iconImage: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  defaultProjectId: Schema.NullOr(ProjectId),
  /** Writes titles, descriptions, goal stories and groups. */
  managerModel: ModelSelection,
  evaluatorModel: ModelSelection,
  defaultCardModel: ModelSelection,
  reviewChains: Schema.Array(KanbanReviewChain),
  defaultReviewChain: Schema.NullOr(TrimmedNonEmptyString),
  instructions: KanbanInstructions,
  setup: Schema.NullOr(KanbanBoardSetup).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  pause: Schema.NullOr(KanbanBoardPause).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  createdAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type KanbanBoard = typeof KanbanBoard.Type;

/** The board's icon, or null when it has none or one this build doesn't know. */
export const kanbanBoardIcon = (board: KanbanBoard): KanbanBoardIcon | null =>
  KANBAN_BOARD_ICONS.find((name) => name === board.icon) ?? null;

// Preserve poster text until the board service has checked it, rather than
// letting TrimmedNonEmptyString erase control characters during decoding.
const RawBoardText = Schema.toType(TrimmedNonEmptyString);
export const KanbanBlockInput = Schema.Union([
  Schema.TaggedStruct("md", { text: Schema.String }),
  Schema.TaggedStruct("collapse", { title: RawBoardText, text: Schema.String }),
  Schema.TaggedStruct("html", {
    html: Schema.String,
    title: Schema.NullOr(Schema.String),
    height: Schema.NullOr(PositiveInt),
  }),
  Schema.TaggedStruct("choice", {
    id: BlockId,
    style: Schema.Literals(["poll", "pick"]),
    question: RawBoardText,
    options: Schema.Array(Schema.Struct({ id: TrimmedNonEmptyString, label: RawBoardText })),
    multi: Schema.Boolean,
  }),
  Schema.TaggedStruct("card", { cardId: KanbanCardId }),
  Schema.TaggedStruct("image", { url: TrimmedNonEmptyString, alt: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct("attachment", {
    attachment: Schema.Union([ChatImageAttachment, ChatFileAttachment]),
  }),
]);

export const KanbanAnswer = Schema.Struct({
  blockId: TrimmedNonEmptyString,
  by: KanbanActor,
  choice: Schema.Array(TrimmedNonEmptyString),
  /** His own words, for a pick; null when he only picked options. */
  text: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  at: IsoDateTime,
});
export type KanbanAnswer = typeof KanbanAnswer.Type;

export const KanbanMessage = Schema.Struct({
  discussionId: KanbanDiscussionId,
  seq: PositiveInt,
  author: KanbanActor,
  /** Display name at post time ("Evaluator", "U1-U4 union reader", "Cert check"). */
  authorName: Schema.String,
  blocks: Schema.Array(KanbanBlockRead),
  answers: Schema.Array(KanbanAnswer),
  createdAt: IsoDateTime,
  /** Set on a message that belongs to one ask's discussion (`q1`, ... on the discussion's card). */
  askId: Schema.optional(Schema.String),
  /**
   * Set on a message that is the ask itself, as asked (0) or as edited: the
   * revision it shows. Below the ask's own revision, it is an older version.
   * A reply on the ask carries `askId` without it, and so do messages from
   * before this field.
   */
  askRevision: Schema.optional(NonNegativeInt),
});
export type KanbanMessage = typeof KanbanMessage.Type;

/**
 * One ask as the Needs-you page reads it: the ask with its card, what the card
 * holds up, and the ask's own discussion.
 */
export const KanbanAskFeedItem = Schema.Struct({
  boardId: KanbanBoardId,
  boardSlug: Schema.String,
  boardName: Schema.String,
  cardId: KanbanCardId,
  cardNumber: PositiveInt,
  /** `<board slug>:<number>`, the form the HTTP routes take. */
  cardRef: Schema.String,
  cardTitle: Schema.String,
  stage: KanbanStage,
  priority: KanbanPriority,
  discussionId: Schema.NullOr(KanbanDiscussionId),
  /** Open cards this card holds up, the whole chain (`kanbanBlocking(...).holds`): what the dispatcher schedules by. */
  blocks: NonNegativeInt,
  ask: KanbanOwnerAsk,
  /** `ask.kind` and `ask.revision` with their defaults applied. */
  kind: KanbanAskKind,
  revision: NonNegativeInt,
  /** Whose turn it is on an open ask; null once closed. */
  waitsOn: Schema.NullOr(Schema.Literals(["owner", "agent", "evaluator"])),
  expired: Schema.Boolean,
  /** True while the owner has it put away (`ask.snoozedUntil` is still ahead). */
  snoozed: Schema.optional(Schema.Boolean),
  /** Set on an open ask that came back from a snooze and he has not acted on since: when it came back. */
  backFromSnoozeAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  /** The message that asked it and every message posted on the ask, oldest first. Big blocks are stubs. */
  messages: Schema.Array(KanbanMessage),
});
export type KanbanAskFeedItem = typeof KanbanAskFeedItem.Type;

export const KanbanAskFeed = Schema.Struct({
  at: IsoDateTime,
  open: Schema.Array(KanbanAskFeedItem),
  /** Asks closed since the `closed` time asked for, newest first; empty when none was asked for. */
  closed: Schema.Array(KanbanAskFeedItem),
});
export type KanbanAskFeed = typeof KanbanAskFeed.Type;

export const KanbanParticipant = Schema.Struct({
  actor: KanbanActor,
  name: Schema.String,
  lastReadSeq: NonNegativeInt,
  /** Heartbeat-driven; typing while in the future. */
  typingUntil: Schema.NullOr(IsoDateTime),
  /** Agent was asked to reply here; "nudged" after one reminder at turn end. */
  owes: Schema.NullOr(Schema.Literals(["asked", "nudged"])),
  /** A turn-end reminder held by the board pause, to be retried after release. */
  deferred: Schema.optional(Schema.Boolean),
  /** Stable ID for retrying one deferred reminder after an ambiguous send. */
  deferredKey: Schema.optional(Schema.String),
});
export type KanbanParticipant = typeof KanbanParticipant.Type;

export const KanbanDiscussion = Schema.Struct({
  id: KanbanDiscussionId,
  boardId: KanbanBoardId,
  /** Set for a card's own discussion; channels have none. */
  cardId: Schema.NullOr(KanbanCardId),
  title: Schema.String,
  /** Channel evaluator thread (its work lives there). */
  evaluatorThreadId: Schema.NullOr(ThreadId),
  participants: Schema.Array(KanbanParticipant),
  lastSeq: NonNegativeInt,
  lastMessageAt: Schema.NullOr(IsoDateTime),
  createdBy: KanbanActor,
  createdAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  /** Set when the owner names it; the server stops writing titles for it then. */
  titleEditedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** The owner put it away; a new message from anyone else brings it back. */
  settledAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Hidden until then, or until someone else posts. */
  snoozedUntil: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** The owner pinned it: listed first and never settled automatically. */
  pinnedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** When the owner last brought it back (unsettle, unsnooze or unpin); the idle day before auto-settle restarts here. */
  reopenedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type KanbanDiscussion = typeof KanbanDiscussion.Type;

export const KanbanScriptTrigger = Schema.Union([
  Schema.TaggedStruct("schedule", {
    everyMs: Schema.NullOr(PositiveInt),
    cron: Schema.NullOr(Schema.String),
    /** The zone a cron line runs in (the server's), filled on read; null when unknown. */
    timeZone: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  Schema.TaggedStruct("event", {
    event: Schema.Literals(["card.created", "card.moved", "message.posted"]),
  }),
  Schema.TaggedStruct("webhook", {}),
  Schema.TaggedStruct("manual", {}),
]);
export type KanbanScriptTrigger = typeof KanbanScriptTrigger.Type;

export const KanbanScript = Schema.Struct({
  id: KanbanScriptId,
  boardId: KanbanBoardId,
  name: TrimmedNonEmptyString,
  /** Absolute path; run by extension (.ts/.js with bun, .py with python3, .sh with bash, .zsh with zsh). */
  path: TrimmedNonEmptyString,
  trigger: KanbanScriptTrigger,
  enabled: Schema.Boolean,
  createdBy: KanbanActor,
  createdAt: IsoDateTime,
  lastRun: Schema.NullOr(
    Schema.Struct({
      startedAt: IsoDateTime,
      endedAt: Schema.NullOr(IsoDateTime),
      exitCode: Schema.NullOr(Schema.Int),
    }),
  ),
});
export type KanbanScript = typeof KanbanScript.Type;

export const KanbanScriptRun = Schema.Struct({
  id: NonNegativeInt,
  scriptId: KanbanScriptId,
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  exitCode: Schema.NullOr(Schema.Int),
  /** Last 64KB of combined stdout/stderr. */
  output: Schema.String,
  trigger: Schema.String,
});
export type KanbanScriptRun = typeof KanbanScriptRun.Type;

export const KanbanAutomation = Schema.Struct({
  id: KanbanAutomationId,
  boardId: KanbanBoardId,
  name: TrimmedNonEmptyString,
  /** Backing scheduled task; its runs are the automation's history. */
  scheduledTaskId: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  createdAt: IsoDateTime,
});
export type KanbanAutomation = typeof KanbanAutomation.Type;

export const KanbanWikiPage = Schema.Struct({
  boardId: KanbanBoardId,
  slug: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  body: Schema.String,
  updatedAt: IsoDateTime,
  updatedBy: KanbanActor,
});
export type KanbanWikiPage = typeof KanbanWikiPage.Type;

export const KanbanErrorCode = Schema.Literals([
  "not-found",
  "conflict",
  "invalid",
  "denied",
  "failed",
]);
export type KanbanErrorCode = typeof KanbanErrorCode.Type;

/**
 * Why a `denied` was refused, when a client can do better than show the detail.
 * `not_owner_device`: the session is a paired device, but not one the owner
 * paired as his own. It has to be paired again from an owner device.
 */
export const KanbanDeniedReason = Schema.Literals(["not_owner_device"]);
export type KanbanDeniedReason = typeof KanbanDeniedReason.Type;

export class KanbanError extends Schema.TaggedError<KanbanError>()("KanbanError", {
  code: KanbanErrorCode,
  detail: Schema.String,
  reason: Schema.optionalKey(KanbanDeniedReason),
  /**
   * The revision an ask is at now, on the refusal of an answer that gave none
   * (`invalid`) or an older one (`conflict`). The detail says it in words too.
   */
  revision: Schema.optionalKey(NonNegativeInt),
}) {
  override get message(): string {
    return `Missions board ${this.code}: ${this.detail}`;
  }
}

/** Live state of a card's active thread, joined from orchestration. */
export const KanbanThreadState = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  running: Schema.Boolean,
  /** Waiting on its own built-in question, which nobody sees; running is false then. */
  needsInput: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  lastActivityAt: Schema.NullOr(IsoDateTime),
});
export type KanbanThreadState = typeof KanbanThreadState.Type;

/**
 * A board thread as the Threads view lists it: the link plus its card and live
 * state. `running` comes from the thread's real state, not from whether the
 * link has ended, so an idle persistent evaluator is not shown as running.
 */
export const KanbanThreadRow = Schema.Struct({
  threadId: ThreadId,
  boardId: KanbanBoardId,
  role: Schema.Literals(["work", "review", "evaluator"]),
  purpose: Schema.NullOr(Schema.String),
  cardId: Schema.NullOr(KanbanCardId),
  cardNumber: Schema.NullOr(PositiveInt),
  cardTitle: Schema.NullOr(Schema.String),
  discussionId: Schema.NullOr(KanbanDiscussionId),
  model: Schema.NullOr(ModelSelection),
  title: Schema.NullOr(Schema.String),
  running: Schema.Boolean,
  lastActivityAt: Schema.NullOr(IsoDateTime),
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
});
export type KanbanThreadRow = typeof KanbanThreadRow.Type;

export const KanbanBoardSnapshot = Schema.Struct({
  board: KanbanBoard,
  cards: Schema.Array(KanbanCard),
  goals: Schema.Array(KanbanGoal),
  pools: Schema.Array(KanbanPool),
  groups: Schema.Array(KanbanGroup),
  threads: Schema.Array(KanbanThreadState),
  /**
   * The board feed sends its first frame before reading thread state, which waits on the
   * orchestration store: `threads` is then empty and each active thread's state follows as
   * a `thread` change. Absent or false means `threads` is complete.
   */
  threadsPending: Schema.optionalKey(Schema.Boolean),
  /** Unread owner messages per discussion. */
  unread: Schema.Array(Schema.Struct({ discussionId: KanbanDiscussionId, count: NonNegativeInt })),
});
export type KanbanBoardSnapshot = typeof KanbanBoardSnapshot.Type;

/** A board with the counts a board list shows, so the list needs no board feeds. */
export const KanbanBoardSummary = Schema.Struct({
  board: KanbanBoard,
  /** Unsettled cards waiting on the owner. */
  needsOwner: NonNegativeInt,
  /** Unsettled cards a thread is working on. */
  running: NonNegativeInt,
  /** Unread owner messages across the board's discussions. */
  unread: NonNegativeInt,
  /** Every thread the board started; thread lists leave them out, the board shows them. */
  threadIds: Schema.Array(ThreadId),
});
export type KanbanBoardSummary = typeof KanbanBoardSummary.Type;

/**
 * A board in one board list update. The stream's first list is whole. After
 * that a null board is unchanged since the stream's previous list and
 * threadIds holds only the threads started since then, so a count change
 * resends neither board pictures nor every thread id.
 */
export const KanbanBoardListEntry = Schema.Struct({
  boardId: KanbanBoardId,
  board: Schema.NullOr(KanbanBoard),
  needsOwner: NonNegativeInt,
  running: NonNegativeInt,
  unread: NonNegativeInt,
  threadIds: Schema.Array(ThreadId),
});
export type KanbanBoardListEntry = typeof KanbanBoardListEntry.Type;

export const KanbanChange = Schema.Union([
  // `by`: who saved the card, when the save came from a move. Script listeners need it to skip a script's own moves.
  Schema.TaggedStruct("card", { card: KanbanCard, by: Schema.optional(KanbanActor) }),
  Schema.TaggedStruct("cardRemoved", { cardId: KanbanCardId }),
  Schema.TaggedStruct("goal", { goal: KanbanGoal }),
  Schema.TaggedStruct("pools", { pools: Schema.Array(KanbanPool) }),
  Schema.TaggedStruct("board", { board: KanbanBoard }),
  Schema.TaggedStruct("groups", { groups: Schema.Array(KanbanGroup) }),
  Schema.TaggedStruct("thread", { thread: KanbanThreadState }),
  Schema.TaggedStruct("discussion", { discussion: KanbanDiscussion }),
  Schema.TaggedStruct("message", { message: KanbanMessage }),
  Schema.TaggedStruct("script", { script: KanbanScript }),
  Schema.TaggedStruct("scriptRun", { run: KanbanScriptRun }),
]);
export type KanbanChange = typeof KanbanChange.Type;
