import { annotateHttpAction } from "../observability/actionCorrelation.ts";
/**
 * Small HTTP surface for the Missions board, for scripts and local tools
 * (the board UI uses the WS RPC group). Every write acts as the owner, so it
 * needs the operate scope and his own session (`ownerWrite`); reads need the
 * read scope. A script's webhook run and opening a card's discussion are the
 * two writes that are not his: they need the operate scope only.
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  KanbanBlockInput,
  type KanbanBoard,
  KanbanBoardIcon,
  KanbanBoardIconImage,
  type KanbanCard,
  KanbanCardId,
  KanbanDiscussionId,
  KanbanDiscussionUpdateInput,
  KanbanError,
  KanbanPriority,
  KanbanScriptId,
  KanbanScriptTrigger,
  KanbanStage,
  ProviderOptionSelections,
  ProjectId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { modelSelectionResult, type ModelInput } from "./engine/defaults.ts";
import { KanbanService } from "./engine/KanbanService.ts";
import { requireOwner } from "./ownerGate.ts";
import { selectionRoutingEnabled } from "./engine/selectionSettings.ts";
import { KanbanScripts } from "./engine/ScriptService.ts";
import * as Asks from "./engine/asks.ts";
import { textProblem } from "./engine/text.ts";
import { stubMessage } from "./engine/messagePages.ts";
import * as BoardReplies from "./engine/boardReplies.ts";
import { jsonReply } from "../http/jsonReply.ts";

export const KANBAN_ROUTE_PREFIX = "/api/ardud/kanban";

const OWNER = { _tag: "owner" } as const;

const STATUS: Record<KanbanError["code"], number> = {
  "not-found": 404,
  conflict: 409,
  invalid: 400,
  denied: 403,
  failed: 500,
};

const json = (body: unknown, status = 200) => jsonReply(body, status);

/** What a refusal carries beside its code and message, for a client to act on without reading the words. */
const errorExtras = (error: KanbanError) => ({
  ...(error.reason === undefined ? {} : { reason: error.reason }),
  ...(error.revision === undefined ? {} : { revision: error.revision }),
});

const fail = (code: KanbanError["code"], detail: string) => new KanbanError({ code, detail });

const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const body = Effect.fn("KanbanHttp.body")(function* <S extends Schema.Top>(schema: S) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const text = yield* request.text.pipe(Effect.mapError(() => fail("invalid", "Unreadable body.")));
  const raw =
    text.trim().length === 0
      ? {}
      : yield* decodeJsonText(text).pipe(
          Effect.mapError(() => fail("invalid", "Body is not JSON.")),
        );
  return yield* Schema.decodeUnknownEffect(schema)(raw).pipe(
    Effect.mapError((error) => fail("invalid", error.message)),
  );
});

const param = Effect.fn("KanbanHttp.param")(function* (name: string) {
  const params = yield* HttpRouter.params;
  const value = params[name];
  if (value === undefined || value.length === 0) return yield* fail("invalid", `Missing ${name}.`);
  return value;
});

const query = Effect.fn("KanbanHttp.query")(function* (name: string) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  return Option.isSome(url) ? url.value.searchParams.get(name) : null;
});

const Text = Schema.optional(Schema.String);

export const ModelBody = Schema.Struct({
  model: Schema.String,
  instanceId: Text,
  provider: Text,
  effort: Text,
  variant: Text,
  options: Schema.optional(ProviderOptionSelections),
});

const CreateBoardBody = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  projectId: Schema.optional(Schema.NullOr(Schema.String)),
  managerModel: Schema.optional(ModelBody),
  evaluatorModel: Schema.optional(ModelBody),
  defaultCardModel: Schema.optional(ModelBody),
});

const CreateCardBody = Schema.Struct({
  prompt: Schema.String,
  model: Schema.optional(ModelBody),
  title: Text,
  description: Text,
  priority: Schema.optional(KanbanPriority),
  projects: Schema.optional(Schema.Array(Schema.String)),
  links: Schema.optional(Schema.Array(Schema.Struct({ url: Schema.String, label: Text }))),
  stage: Schema.optional(Schema.Literals(["todo", "needs_owner"])),
  question: Text,
  reviewChain: Text,
});

const MoveBody = Schema.Struct({ to: KanbanStage, note: Text, question: Text });

const PostBody = Schema.Struct({
  text: Text,
  blocks: Schema.optional(Schema.Array(KanbanBlockInput)),
});

const TitleBody = Schema.Struct({ title: Schema.String });

const DiscussionPatchBody = KanbanDiscussionUpdateInput.mapFields(Struct.omit(["discussionId"]));

const AnswerBody = Schema.Struct({
  seq: Schema.Int,
  blockId: Schema.String,
  choice: Schema.Array(Schema.String),
  text: Schema.optional(Schema.NullOr(Schema.String)),
});

// Which verdicts an ask takes depends on its response parts: the engine checks.
const AskVerdict = Schema.String;
const AskAnswerFields = {
  verdict: AskVerdict,
  optionIds: Schema.optional(Schema.Array(Schema.String)),
  text: Text,
  /** For the agent that acts on the answer. Never saved as a rule. */
  note: Text,
};
const AskAnswerBody = Schema.Struct({
  ...AskAnswerFields,
  /** A draft ask: the text to post, as the owner left it. */
  finalDraft: Text,
  /** Field id to value, for an ask with fields. A file field takes the uploads' attachments. */
  values: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  /** The revision the client showed; a newer one answers with 409. */
  revision: Schema.optional(Schema.Int),
});
const AskBatchBody = Schema.Struct({
  ...AskAnswerFields,
  items: Schema.Array(
    Schema.Struct({
      card: Schema.String,
      askId: Schema.String,
      revision: Schema.optional(Schema.Int),
    }),
  ),
});
const AskHandBody = Schema.Struct({
  action: Schema.optional(Schema.Literals(["hand", "take_back"])),
  /** With hand: also ask an evaluator to take asks like this one from now on. */
  always: Schema.optional(Schema.Boolean),
  /** With always: what the owner said, passed to that evaluator word for word. */
  text: Text,
});
const AskSnoozeBody = Schema.Struct({
  /** ISO time to put the ask away until; null takes the snooze off. */
  until: Schema.NullOr(Schema.String),
});
const AskSnoozeBatchBody = Schema.Struct({
  until: Schema.NullOr(Schema.String),
  items: Schema.Array(Schema.Struct({ card: Schema.String, askId: Schema.String })),
});
/** At most this many asks in one batch answer. */
const ASK_BATCH_MAX = 50;

const BoardBody = Schema.Struct({
  name: Text,
  icon: Schema.optional(Schema.NullOr(KanbanBoardIcon)),
  iconImage: Schema.optional(Schema.NullOr(KanbanBoardIconImage)),
  projectId: Schema.optional(Schema.NullOr(Schema.String)),
  managerModel: Schema.optional(ModelBody),
  evaluatorModel: Schema.optional(ModelBody),
  defaultCardModel: Schema.optional(ModelBody),
  reviewChains: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, steps: Schema.Array(ModelBody) })),
  ),
  defaultReviewChain: Schema.optional(Schema.NullOr(Schema.String)),
});

const PoolBody = Schema.Struct({
  model: ModelBody,
  slots: Schema.optional(Schema.Number),
  replaces: Schema.optional(Schema.String),
});

const ScriptBody = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  trigger: KanbanScriptTrigger,
  enabled: Schema.optional(Schema.Boolean),
});

const ScriptPatchBody = Schema.Struct({ enabled: Schema.Boolean });

/** A webhook sender calls the run route with `trigger: "webhook"`. */
const RunBody = Schema.Struct({ trigger: Schema.optional(Schema.Literals(["manual", "webhook"])) });

const EvaluatorBody = Schema.Struct({
  kind: Schema.Literals(["setup", "request", "stalled", "completed", "deployed", "check"]),
  text: Text,
});

export const kanbanRouteLayer = HttpRouter.addAll(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const service = yield* KanbanService;
    const scripts = yield* KanbanScripts;

    const modelOf = (input: ModelInput, apply: boolean) => {
      const result = modelSelectionResult(input, apply);
      return result.kind === "conflict"
        ? Effect.fail(fail("invalid", result.reason))
        : Effect.succeed(result.selection);
    };

    const authenticate = Effect.fn("KanbanHttp.authenticate")(function* (
      scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
    ) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      // Token checks only read; keep them off the writer like the board reads.
      const session = yield* auth.authenticateHttpRequest(request).pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(() => fail("denied", "A valid bearer token is required.")),
      );
      if (!session.scopes.includes(scope)) {
        return yield* fail("denied", `This token lacks the ${scope} scope.`);
      }
      return session;
    });

    /** A board by id or slug. */
    const boardOf = Effect.fn("KanbanHttp.boardOf")(function* (ref: string) {
      const boards = yield* service.boards;
      const board = boards.find((entry) => entry.id === ref || entry.slug === ref);
      if (!board) return yield* fail("not-found", `No board ${ref}.`);
      return board;
    });

    /** A card by id, or `<board>:<number>`. */
    const cardOf = Effect.fn("KanbanHttp.cardOf")(function* (ref: string) {
      const split = ref.lastIndexOf(":");
      if (split > 0 && /^\d+$/.test(ref.slice(split + 1))) {
        const board = yield* boardOf(ref.slice(0, split));
        const number = Number(ref.slice(split + 1));
        const card = yield* service.cardByNumber(board.id, number);
        if (!card) return yield* fail("not-found", `No card #${number} on ${board.slug}.`);
        return card;
      }
      return (yield* service.card(KanbanCardId.make(ref))).card;
    });

    const read = <A, R>(effect: Effect.Effect<A, KanbanError, R>) =>
      authenticate(AuthOrchestrationReadScope).pipe(
        Effect.andThen(effect),
        Effect.map((value) => json(value)),
      );
    const write = <A, R>(effect: Effect.Effect<A, KanbanError, R>) =>
      authenticate(AuthOrchestrationOperateScope).pipe(
        Effect.andThen(effect),
        Effect.map((value) => json(value)),
      );
    /**
     * A write as the owner: his words, his picks and answers, and every change
     * the board records or applies as his (cards, discussions, boards, pools,
     * scripts, evaluators). The operate scope is not enough (see
     * `ownerGate.ts`): the session itself must carry the owner claim.
     */
    const ownerWrite = <A, R>(effect: Effect.Effect<A, KanbanError, R>) =>
      authenticate(AuthOrchestrationOperateScope).pipe(
        Effect.flatMap(requireOwner),
        Effect.andThen(effect),
        Effect.map((value) => json(value)),
      );

    const handle = <R>(
      effect: Effect.Effect<HttpServerResponse.HttpServerResponse, KanbanError, R>,
    ) =>
      annotateHttpAction.pipe(
        Effect.andThen(effect),
        Effect.catchTags({
          KanbanError: (error) =>
            Effect.succeed(
              json(
                {
                  ok: false,
                  error: {
                    code: error.code,
                    message: error.detail,
                    ...errorExtras(error),
                  },
                },
                STATUS[error.code],
              ),
            ),
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("kanban request failed", { cause }).pipe(
            Effect.as(
              json({ ok: false, error: { code: "failed", message: "Internal error." } }, 500),
            ),
          ),
        ),
      );

    const listBoards = read(service.boards);

    const createBoard = ownerWrite(
      Effect.gen(function* () {
        const input = yield* body(CreateBoardBody);
        const projectId = input.projectId ? ProjectId.make(input.projectId) : null;
        const apply = yield* selectionRoutingEnabled;
        const managerModel = input.managerModel
          ? yield* modelOf(input.managerModel, apply)
          : undefined;
        const evaluatorModel = input.evaluatorModel
          ? yield* modelOf(input.evaluatorModel, apply)
          : undefined;
        const defaultCardModel = input.defaultCardModel
          ? yield* modelOf(input.defaultCardModel, apply)
          : undefined;
        const board = yield* service.ensureBoard({
          slug: input.slug,
          name: input.name,
          defaultProjectId: projectId,
          ...(managerModel ? { managerModel } : {}),
          ...(evaluatorModel ? { evaluatorModel } : {}),
          ...(defaultCardModel ? { defaultCardModel } : {}),
        });
        if (projectId && board.defaultProjectId !== projectId) {
          return yield* service.updateBoard(board.id, { defaultProjectId: projectId });
        }
        return board;
      }),
    );

    const getBoard = read(
      Effect.gen(function* () {
        const board = yield* boardOf(yield* param("board"));
        const after = Number(yield* query("after"));
        const requested = Number(yield* query("limit"));
        if (
          !Number.isSafeInteger(after) ||
          after < 0 ||
          !Number.isSafeInteger(requested) ||
          requested < 0
        )
          return yield* fail("invalid", "after and limit must be nonnegative integers.");
        const limit = Math.min(
          requested || BoardReplies.BOARD_PAGE_LIMIT,
          BoardReplies.BOARD_PAGE_MAX,
        );
        const snapshot = yield* service.replySnapshot(board.id, { after, limit: limit + 1 });
        const hasMore = snapshot.cards.length > limit;
        const cards = snapshot.cards.slice(0, limit);
        return {
          ...BoardReplies.compactBoard({ ...snapshot, cards }),
          page: { limit, hasMore, nextAfter: hasMore ? cards.at(-1)!.number : null },
        };
      }),
    );

    const createCard = ownerWrite(
      Effect.gen(function* () {
        const board: KanbanBoard = yield* boardOf(yield* param("board"));
        const { model, ...input } = yield* body(CreateCardBody);
        const apply = model ? yield* selectionRoutingEnabled : false;
        const selected = model ? yield* modelOf(model, apply) : undefined;
        return yield* service.createCard(
          board.id,
          { ...input, ...(selected ? { model: selected } : {}) },
          OWNER,
        );
      }),
    );

    const updateBoard = ownerWrite(
      Effect.gen(function* () {
        const board = yield* boardOf(yield* param("board"));
        const input = yield* body(BoardBody);
        const apply = yield* selectionRoutingEnabled;
        const managerModel = input.managerModel
          ? yield* modelOf(input.managerModel, apply)
          : undefined;
        const evaluatorModel = input.evaluatorModel
          ? yield* modelOf(input.evaluatorModel, apply)
          : undefined;
        const defaultCardModel = input.defaultCardModel
          ? yield* modelOf(input.defaultCardModel, apply)
          : undefined;
        const reviewChains = input.reviewChains
          ? yield* Effect.forEach(input.reviewChains, (chain) =>
              Effect.forEach(chain.steps, (step) => modelOf(step, apply)).pipe(
                Effect.map((steps) => ({ name: chain.name, steps })),
              ),
            )
          : undefined;
        return yield* service.updateBoard(board.id, {
          ...(input.name ? { name: input.name } : {}),
          ...(input.icon !== undefined ? { icon: input.icon } : {}),
          ...(input.iconImage !== undefined ? { iconImage: input.iconImage } : {}),
          ...(input.projectId !== undefined
            ? { defaultProjectId: input.projectId ? ProjectId.make(input.projectId) : null }
            : {}),
          ...(managerModel ? { managerModel } : {}),
          ...(evaluatorModel ? { evaluatorModel } : {}),
          ...(defaultCardModel ? { defaultCardModel } : {}),
          ...(reviewChains ? { reviewChains } : {}),
          ...(input.defaultReviewChain !== undefined
            ? { defaultReviewChain: input.defaultReviewChain }
            : {}),
        });
      }),
    );

    const setPool = ownerWrite(
      Effect.gen(function* () {
        const board = yield* boardOf(yield* param("board"));
        const input = yield* body(PoolBody);
        // A level change (replaces) may leave slots out to keep the pool's count.
        const slotsOk =
          input.slots === undefined
            ? input.replaces !== undefined
            : Number.isInteger(input.slots) && input.slots >= 0;
        if (!slotsOk) {
          return yield* fail("invalid", "slots must be a whole number, 0 or more.");
        }
        const apply = yield* selectionRoutingEnabled;
        const model = yield* modelOf(input.model, apply);
        return yield* service.setPool(board.id, model, input.slots, {
          replaces: input.replaces,
        });
      }),
    );

    const getCard = read(
      Effect.gen(function* () {
        const card: KanbanCard = yield* cardOf(yield* param("card"));
        return yield* service.card(card.id);
      }),
    );

    const moveCard = ownerWrite(
      Effect.gen(function* () {
        const card = yield* cardOf(yield* param("card"));
        const input = yield* body(MoveBody);
        return yield* service.moveCard(card.id, input.to, "owner", OWNER, {
          note: input.note ?? null,
          question: input.question ?? null,
        });
      }),
    );

    // Not an owner write: the board opens a card's discussion as itself.
    const cardDiscussion = write(
      Effect.gen(function* () {
        const card = yield* cardOf(yield* param("card"));
        return yield* service.cardDiscussion(card.id);
      }),
    );

    const listDiscussions = read(
      Effect.gen(function* () {
        const board = yield* boardOf(yield* param("board"));
        return yield* service.discussions(board.id);
      }),
    );

    const createDiscussion = ownerWrite(
      Effect.gen(function* () {
        const board = yield* boardOf(yield* param("board"));
        const input = yield* body(TitleBody);
        return yield* service.createDiscussion(board.id, input.title, OWNER);
      }),
    );

    const updateDiscussion = ownerWrite(
      Effect.gen(function* () {
        const id = KanbanDiscussionId.make(yield* param("discussion"));
        const input = yield* body(DiscussionPatchBody);
        return yield* service.updateDiscussion(id, input, OWNER);
      }),
    );

    const listMessages = read(
      Effect.gen(function* () {
        const id = KanbanDiscussionId.make(yield* param("discussion"));
        const cursor = (value: string | null) => {
          const number = Number(value);
          return value !== null && Number.isInteger(number) && number > 0 ? number : undefined;
        };
        const afterSeq = cursor(yield* query("afterSeq"));
        const beforeSeq = cursor(yield* query("beforeSeq"));
        const limit = cursor(yield* query("limit"));
        return yield* service.messages(id, {
          ...(afterSeq === undefined ? {} : { afterSeq }),
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
          ...(limit === undefined ? {} : { limit }),
        });
      }),
    );

    const getMessage = read(
      Effect.gen(function* () {
        const id = KanbanDiscussionId.make(yield* param("discussion"));
        const seq = Number(yield* param("seq"));
        if (!Number.isInteger(seq) || seq <= 0)
          return yield* fail("invalid", "seq must be a positive whole number.");
        return yield* service.message(id, seq);
      }),
    );

    const postMessage = ownerWrite(
      Effect.gen(function* () {
        const id = KanbanDiscussionId.make(yield* param("discussion"));
        const input = yield* body(PostBody);
        const problem = textProblem([["message", input.text]]);
        if (problem) return yield* fail("invalid", problem);
        const blocks = [
          ...(input.text?.trim() ? [{ _tag: "md" as const, text: input.text }] : []),
          ...(input.blocks ?? []),
        ];
        if (blocks.length === 0) return yield* fail("invalid", "Nothing to post.");
        return yield* service.post(id, OWNER, blocks);
      }),
    );

    const answer = ownerWrite(
      Effect.gen(function* () {
        const id = KanbanDiscussionId.make(yield* param("discussion"));
        const input = yield* body(AnswerBody);
        return yield* service.answer(
          id,
          input.seq,
          input.blockId,
          input.choice,
          OWNER,
          input.text ?? null,
        );
      }),
    );

    /** `closed`: an ISO time, or a window back from now such as `24h` or `7d`. */
    const closedSince = Effect.fn("KanbanHttp.closedSince")(function* (value: string | null) {
      if (value === null || value.trim() === "") return undefined;
      const window = /^(\d{1,4})([hd])$/.exec(value.trim());
      if (window) {
        const hours = Number(window[1]) * (window[2] === "d" ? 24 : 1);
        return DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { hours }));
      }
      const time = DateTime.make(value.trim());
      if (Option.isNone(time)) {
        return yield* fail("invalid", "closed must be an ISO time or a window like 24h or 7d.");
      }
      return DateTime.formatIso(time.value);
    });

    const askOf = (card: KanbanCard, askId: string) => {
      const ask = card.asks.find((entry) => entry.id === askId);
      return {
        card: { id: card.id, number: card.number, stage: card.stage },
        ask: ask ?? null,
      };
    };

    const listAsks = read(
      Effect.gen(function* () {
        const ref = yield* query("board");
        const board = ref ? yield* boardOf(ref) : null;
        return yield* service.askFeed({
          boardId: board?.id,
          closedSince: yield* closedSince(yield* query("closed")),
        });
      }),
    );

    const getAsk = read(
      Effect.gen(function* () {
        const card = yield* cardOf(yield* param("card"));
        return yield* service.askDetail(card.id, yield* param("ask"));
      }),
    );

    const answerAsk = ownerWrite(
      Effect.gen(function* () {
        const card = yield* cardOf(yield* param("card"));
        const askId = yield* param("ask");
        const input = yield* body(AskAnswerBody);
        const result = yield* service.answerAsk(card.id, askId, input, OWNER);
        return askOf(result.card, askId);
      }),
    );

    // Each ask is answered on its own: one stale or closed ask doesn't hold back the rest.
    const answerAsks = ownerWrite(
      Effect.gen(function* () {
        const { items, ...answer } = yield* body(AskBatchBody);
        if (items.length === 0) return yield* fail("invalid", "items is empty.");
        if (items.length > ASK_BATCH_MAX) {
          return yield* fail("invalid", `At most ${ASK_BATCH_MAX} asks in one batch.`);
        }
        // One answer fits several asks only when they take the same thing back.
        let shape: string | null = null;
        const results = yield* Effect.forEach(items, (item) =>
          Effect.gen(function* () {
            const card = yield* cardOf(item.card);
            const open = Asks.findOpenAsk(card, item.askId);
            if (open) {
              const own = Asks.batchShape(open);
              if (own === null) {
                return yield* fail(
                  "invalid",
                  `${item.askId} on card #${card.number} takes more than one answer can give several asks: answer it on its own.`,
                );
              }
              shape ??= own;
              if (own !== shape) {
                return yield* fail(
                  "invalid",
                  `${item.askId} on card #${card.number} doesn't take the same answer as the first ask in the batch: answer it on its own.`,
                );
              }
            }
            const result = yield* service.answerAsk(
              card.id,
              item.askId,
              { ...answer, revision: item.revision },
              OWNER,
            );
            return {
              card: item.card,
              askId: item.askId,
              ok: true as const,
              stage: result.card.stage,
            };
          }).pipe(
            Effect.catchTags({
              KanbanError: (error) =>
                Effect.succeed({
                  card: item.card,
                  askId: item.askId,
                  ok: false as const,
                  error: { code: error.code, message: error.detail, ...errorExtras(error) },
                }),
            }),
          ),
        );
        return { answered: results.filter((result) => result.ok).length, results };
      }),
    );

    const replyOnAsk = ownerWrite(
      Effect.gen(function* () {
        const card = yield* cardOf(yield* param("card"));
        const askId = yield* param("ask");
        const input = yield* body(PostBody);
        const problem = textProblem([["message", input.text]]);
        if (problem) return yield* fail("invalid", problem);
        const blocks = [
          ...(input.text?.trim() ? [{ _tag: "md" as const, text: input.text }] : []),
          ...(input.blocks ?? []),
        ];
        if (blocks.length === 0) return yield* fail("invalid", "Nothing to post.");
        return stubMessage(yield* service.replyOnAsk(card.id, askId, OWNER, blocks, "owner"));
      }),
    );

    const handAsk = ownerWrite(
      Effect.gen(function* () {
        const card = yield* cardOf(yield* param("card"));
        const askId = yield* param("ask");
        const input = yield* body(AskHandBody);
        const action = input.action ?? "hand";
        const always = action === "hand" && input.always === true;
        if (!always) return askOf(yield* service.handAsk(card.id, askId, action, OWNER), askId);
        const words = input.text?.trim() ?? "";
        const problem =
          textProblem([["text", words]]) ??
          (words.length > Asks.ASK_LIMITS.note
            ? `text is at most ${Asks.ASK_LIMITS.note} characters.`
            : null);
        if (problem) return yield* fail("invalid", problem);
        const board = yield* boardOf(card.boardId);
        const handed = yield* service.handAsk(card.id, askId, "hand", OWNER, true);
        const ask = handed.asks.find((entry) => entry.id === askId);
        if (!ask) return askOf(handed, askId);
        // The hand-over stands whether or not the evaluator starts: it is a second step,
        // outside the hand-over's board write.
        const started = yield* service
          .startEvaluator(board.id, {
            kind: "request",
            text: Asks.alwaysText(handed, `${board.slug}:${handed.number}`, ask, words),
          })
          .pipe(
            Effect.map((threadId) => ({ threadId, error: null })),
            Effect.catchTags({
              KanbanError: (error) => Effect.succeed({ threadId: null, error: error.detail }),
            }),
          );
        if (started.threadId === null) {
          return {
            ...askOf(handed, askId),
            evaluator: { started: false, threadId: null, error: started.error },
          };
        }
        const noted = yield* service.noteHandEvaluator(card.id, askId, started.threadId);
        return {
          ...askOf(noted, askId),
          evaluator: { started: true, threadId: started.threadId, error: null },
        };
      }),
    );

    const snoozeAsk = ownerWrite(
      Effect.gen(function* () {
        const card = yield* cardOf(yield* param("card"));
        const askId = yield* param("ask");
        const input = yield* body(AskSnoozeBody);
        return askOf(yield* service.snoozeAsk(card.id, askId, input.until, OWNER), askId);
      }),
    );

    // Each ask is snoozed on its own: one that can't be doesn't hold back the rest.
    const snoozeAsks = ownerWrite(
      Effect.gen(function* () {
        const { items, until } = yield* body(AskSnoozeBatchBody);
        if (items.length === 0) return yield* fail("invalid", "items is empty.");
        if (items.length > ASK_BATCH_MAX) {
          return yield* fail("invalid", `At most ${ASK_BATCH_MAX} asks in one batch.`);
        }
        const results = yield* Effect.forEach(items, (item) =>
          Effect.gen(function* () {
            const card = yield* cardOf(item.card);
            yield* service.snoozeAsk(card.id, item.askId, until, OWNER);
            return { card: item.card, askId: item.askId, ok: true as const };
          }).pipe(
            Effect.catchTags({
              KanbanError: (error) =>
                Effect.succeed({
                  card: item.card,
                  askId: item.askId,
                  ok: false as const,
                  error: { code: error.code, message: error.detail, ...errorExtras(error) },
                }),
            }),
          ),
        );
        return { snoozed: results.filter((result) => result.ok).length, results };
      }),
    );

    const startEvaluator = ownerWrite(
      Effect.gen(function* () {
        const board = yield* boardOf(yield* param("board"));
        const input = yield* body(EvaluatorBody);
        const purpose =
          input.kind === "setup" || input.kind === "request"
            ? { kind: input.kind, text: input.text ?? "" }
            : { kind: input.kind };
        // setup/request already carry their text in purpose; only sweeps pass it separately.
        const sweepText =
          input.kind === "setup" || input.kind === "request" ? undefined : input.text;
        const threadId = yield* service.startEvaluator(board.id, purpose, sweepText);
        return { threadId };
      }),
    );

    const listScripts = read(
      Effect.gen(function* () {
        const board = yield* boardOf(yield* param("board"));
        return yield* scripts.scripts(board.id);
      }),
    );

    const registerScript = ownerWrite(
      Effect.gen(function* () {
        const board = yield* boardOf(yield* param("board"));
        const input = yield* body(ScriptBody);
        return yield* scripts.register({ ...input, boardId: board.id }, OWNER);
      }),
    );

    const scriptId = Effect.map(param("script"), (id) => KanbanScriptId.make(id));

    const patchScript = ownerWrite(
      Effect.gen(function* () {
        const id = yield* scriptId;
        const input = yield* body(ScriptPatchBody);
        return yield* scripts.setEnabled(id, input.enabled);
      }),
    );

    // Not an owner write: a webhook sender holds the operate scope and nothing
    // more. Only a manual run (which also runs a script that is off) is the owner's.
    const runScript = authenticate(AuthOrchestrationOperateScope).pipe(
      Effect.flatMap((session) =>
        Effect.gen(function* () {
          const id = yield* scriptId;
          const input = yield* body(RunBody);
          if (input.trigger === "manual") yield* requireOwner(session);
          // The app runs scripts over the socket, so a bare HTTP call is a webhook.
          return yield* scripts.run(id, input.trigger ?? "webhook");
        }),
      ),
      Effect.map((value) => json(value)),
    );

    const listRuns = read(
      Effect.gen(function* () {
        const id = yield* scriptId;
        const limit = Number(yield* query("limit"));
        return yield* scripts.runs(id, Number.isInteger(limit) && limit > 0 ? limit : 20);
      }),
    );

    const p = KANBAN_ROUTE_PREFIX;
    return [
      HttpRouter.route("GET", `${p}/boards`, handle(listBoards)),
      HttpRouter.route("POST", `${p}/boards`, handle(createBoard)),
      HttpRouter.route("GET", `${p}/boards/:board`, handle(getBoard)),
      HttpRouter.route("PATCH", `${p}/boards/:board`, handle(updateBoard)),
      HttpRouter.route("POST", `${p}/boards/:board/pools`, handle(setPool)),
      HttpRouter.route("POST", `${p}/boards/:board/cards`, handle(createCard)),
      HttpRouter.route("GET", `${p}/boards/:board/discussions`, handle(listDiscussions)),
      HttpRouter.route("POST", `${p}/boards/:board/discussions`, handle(createDiscussion)),
      HttpRouter.route("POST", `${p}/boards/:board/evaluators`, handle(startEvaluator)),
      HttpRouter.route("GET", `${p}/boards/:board/scripts`, handle(listScripts)),
      HttpRouter.route("POST", `${p}/boards/:board/scripts`, handle(registerScript)),
      HttpRouter.route("PATCH", `${p}/scripts/:script`, handle(patchScript)),
      HttpRouter.route("POST", `${p}/scripts/:script/run`, handle(runScript)),
      HttpRouter.route("GET", `${p}/scripts/:script/runs`, handle(listRuns)),
      HttpRouter.route("GET", `${p}/cards/:card`, handle(getCard)),
      HttpRouter.route("POST", `${p}/cards/:card/move`, handle(moveCard)),
      HttpRouter.route("POST", `${p}/cards/:card/discussion`, handle(cardDiscussion)),
      HttpRouter.route("GET", `${p}/asks`, handle(listAsks)),
      HttpRouter.route("POST", `${p}/asks/answer`, handle(answerAsks)),
      HttpRouter.route("POST", `${p}/asks/snooze`, handle(snoozeAsks)),
      HttpRouter.route("GET", `${p}/cards/:card/asks/:ask`, handle(getAsk)),
      HttpRouter.route("POST", `${p}/cards/:card/asks/:ask/answer`, handle(answerAsk)),
      HttpRouter.route("POST", `${p}/cards/:card/asks/:ask/reply`, handle(replyOnAsk)),
      HttpRouter.route("POST", `${p}/cards/:card/asks/:ask/hand`, handle(handAsk)),
      HttpRouter.route("POST", `${p}/cards/:card/asks/:ask/snooze`, handle(snoozeAsk)),
      HttpRouter.route("PATCH", `${p}/discussions/:discussion`, handle(updateDiscussion)),
      HttpRouter.route("GET", `${p}/discussions/:discussion/messages`, handle(listMessages)),
      HttpRouter.route("POST", `${p}/discussions/:discussion/messages`, handle(postMessage)),
      HttpRouter.route("GET", `${p}/discussions/:discussion/messages/:seq`, handle(getMessage)),
      HttpRouter.route("POST", `${p}/discussions/:discussion/answer`, handle(answer)),
    ];
  }),
);
