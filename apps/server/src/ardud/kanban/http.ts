/**
 * Small HTTP surface for the Missions board, for scripts and local tools
 * (the board UI uses the WS RPC group). Every write acts as the owner, so it
 * needs the operate scope; reads need the read scope.
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  KanbanBlock,
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
  ModelSelection,
  ProjectId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { modelSelectionOf } from "./engine/defaults.ts";
import { KanbanService } from "./engine/KanbanService.ts";
import { KanbanScripts } from "./engine/ScriptService.ts";

export const KANBAN_ROUTE_PREFIX = "/api/ardud/kanban";

const OWNER = { _tag: "owner" } as const;
const NO_STORE = { "cache-control": "no-store" } as const;

const STATUS: Record<KanbanError["code"], number> = {
  "not-found": 404,
  conflict: 409,
  invalid: 400,
  denied: 403,
  failed: 500,
};

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: NO_STORE });

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

const ModelBody = Schema.Struct({
  model: Schema.String,
  instanceId: Text,
  variant: Text,
});

const CreateBoardBody = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  projectId: Schema.optional(Schema.NullOr(Schema.String)),
  managerModel: Schema.optional(ModelSelection),
  evaluatorModel: Schema.optional(ModelSelection),
  defaultCardModel: Schema.optional(ModelSelection),
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

const PostBody = Schema.Struct({ text: Text, blocks: Schema.optional(Schema.Array(KanbanBlock)) });

const TitleBody = Schema.Struct({ title: Schema.String });

const DiscussionPatchBody = KanbanDiscussionUpdateInput.mapFields(Struct.omit(["discussionId"]));

const AnswerBody = Schema.Struct({
  seq: Schema.Int,
  blockId: Schema.String,
  choice: Schema.Array(Schema.String),
  text: Schema.optional(Schema.NullOr(Schema.String)),
});

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

    const authenticate = Effect.fn("KanbanHttp.authenticate")(function* (
      scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
    ) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      // Token checks only read; keep them off the writer like the board reads.
      const session = yield* auth
        .authenticateHttpRequest(request)
        .pipe(
          NodeSqliteClient.readOnly,
          Effect.mapError(() => fail("denied", "A valid bearer token is required.")),
        );
      if (!session.scopes.includes(scope)) {
        return yield* fail("denied", `This token lacks the ${scope} scope.`);
      }
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
        const snapshot = yield* service.snapshot(board.id);
        const card = snapshot.cards.find((entry) => entry.number === number);
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

    const handle = <R>(
      effect: Effect.Effect<HttpServerResponse.HttpServerResponse, KanbanError, R>,
    ) =>
      effect.pipe(
        Effect.catchTags({
          KanbanError: (error) =>
            Effect.succeed(
              json(
                { ok: false, error: { code: error.code, message: error.detail } },
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

    const createBoard = write(
      Effect.gen(function* () {
        const input = yield* body(CreateBoardBody);
        const projectId = input.projectId ? ProjectId.make(input.projectId) : null;
        const board = yield* service.ensureBoard({
          slug: input.slug,
          name: input.name,
          defaultProjectId: projectId,
          ...(input.managerModel ? { managerModel: input.managerModel } : {}),
          ...(input.evaluatorModel ? { evaluatorModel: input.evaluatorModel } : {}),
          ...(input.defaultCardModel ? { defaultCardModel: input.defaultCardModel } : {}),
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
        return yield* service.snapshot(board.id);
      }),
    );

    const createCard = write(
      Effect.gen(function* () {
        const board: KanbanBoard = yield* boardOf(yield* param("board"));
        const { model, ...input } = yield* body(CreateCardBody);
        return yield* service.createCard(
          board.id,
          { ...input, ...(model ? { model: modelSelectionOf(model) } : {}) },
          OWNER,
        );
      }),
    );

    const updateBoard = write(
      Effect.gen(function* () {
        const board = yield* boardOf(yield* param("board"));
        const input = yield* body(BoardBody);
        return yield* service.updateBoard(board.id, {
          ...(input.name ? { name: input.name } : {}),
          ...(input.icon !== undefined ? { icon: input.icon } : {}),
          ...(input.iconImage !== undefined ? { iconImage: input.iconImage } : {}),
          ...(input.projectId !== undefined
            ? { defaultProjectId: input.projectId ? ProjectId.make(input.projectId) : null }
            : {}),
          ...(input.managerModel ? { managerModel: modelSelectionOf(input.managerModel) } : {}),
          ...(input.evaluatorModel
            ? { evaluatorModel: modelSelectionOf(input.evaluatorModel) }
            : {}),
          ...(input.defaultCardModel
            ? { defaultCardModel: modelSelectionOf(input.defaultCardModel) }
            : {}),
          ...(input.reviewChains
            ? {
                reviewChains: input.reviewChains.map((chain) => ({
                  name: chain.name,
                  steps: chain.steps.map(modelSelectionOf),
                })),
              }
            : {}),
          ...(input.defaultReviewChain !== undefined
            ? { defaultReviewChain: input.defaultReviewChain }
            : {}),
        });
      }),
    );

    const setPool = write(
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
        return yield* service.setPool(board.id, modelSelectionOf(input.model), input.slots, {
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

    const moveCard = write(
      Effect.gen(function* () {
        const card = yield* cardOf(yield* param("card"));
        const input = yield* body(MoveBody);
        return yield* service.moveCard(card.id, input.to, "owner", OWNER, {
          note: input.note ?? null,
          question: input.question ?? null,
        });
      }),
    );

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

    const createDiscussion = write(
      Effect.gen(function* () {
        const board = yield* boardOf(yield* param("board"));
        const input = yield* body(TitleBody);
        return yield* service.createDiscussion(board.id, input.title, OWNER);
      }),
    );

    const updateDiscussion = write(
      Effect.gen(function* () {
        const id = KanbanDiscussionId.make(yield* param("discussion"));
        const input = yield* body(DiscussionPatchBody);
        return yield* service.updateDiscussion(id, input, OWNER);
      }),
    );

    const listMessages = read(
      Effect.gen(function* () {
        const id = KanbanDiscussionId.make(yield* param("discussion"));
        const after = Number(yield* query("afterSeq"));
        return yield* service.messages(
          id,
          Number.isInteger(after) && after > 0 ? { afterSeq: after } : {},
        );
      }),
    );

    const postMessage = write(
      Effect.gen(function* () {
        const id = KanbanDiscussionId.make(yield* param("discussion"));
        const input = yield* body(PostBody);
        const blocks = [
          ...(input.text?.trim() ? [{ _tag: "md" as const, text: input.text }] : []),
          ...(input.blocks ?? []),
        ];
        if (blocks.length === 0) return yield* fail("invalid", "Nothing to post.");
        return yield* service.post(id, OWNER, blocks);
      }),
    );

    const answer = write(
      Effect.gen(function* () {
        const id = KanbanDiscussionId.make(yield* param("discussion"));
        const input = yield* body(AnswerBody);
        return yield* service.answer(id, input.seq, input.blockId, input.choice, OWNER, input.text ?? null);
      }),
    );

    const startEvaluator = write(
      Effect.gen(function* () {
        const board = yield* boardOf(yield* param("board"));
        const input = yield* body(EvaluatorBody);
        const purpose =
          input.kind === "setup" || input.kind === "request"
            ? { kind: input.kind, text: input.text ?? "" }
            : { kind: input.kind };
        // setup/request already carry their text in purpose; only sweeps pass it separately.
        const sweepText = input.kind === "setup" || input.kind === "request" ? undefined : input.text;
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

    const registerScript = write(
      Effect.gen(function* () {
        const board = yield* boardOf(yield* param("board"));
        const input = yield* body(ScriptBody);
        return yield* scripts.register({ ...input, boardId: board.id }, OWNER);
      }),
    );

    const scriptId = Effect.map(param("script"), (id) => KanbanScriptId.make(id));

    const patchScript = write(
      Effect.gen(function* () {
        const id = yield* scriptId;
        const input = yield* body(ScriptPatchBody);
        return yield* scripts.setEnabled(id, input.enabled);
      }),
    );

    const runScript = write(
      Effect.gen(function* () {
        const id = yield* scriptId;
        const input = yield* body(RunBody);
        // The app runs scripts over the socket, so a bare HTTP call is a webhook.
        return yield* scripts.run(id, input.trigger ?? "webhook");
      }),
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
      HttpRouter.route("PATCH", `${p}/discussions/:discussion`, handle(updateDiscussion)),
      HttpRouter.route("GET", `${p}/discussions/:discussion/messages`, handle(listMessages)),
      HttpRouter.route("POST", `${p}/discussions/:discussion/messages`, handle(postMessage)),
      HttpRouter.route("POST", `${p}/discussions/:discussion/answer`, handle(answer)),
    ];
  }),
);
