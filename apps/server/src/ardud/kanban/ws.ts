import {
  KANBAN_WS_METHODS as M,
  KanbanError,
  type KanbanBoardUpdateInput,
  type KanbanCardPatchInput,
  type KanbanDiscussionUpdateInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { BoardPatch, KanbanServiceShape } from "./engine/KanbanService.ts";
import type { KanbanScriptsShape } from "./engine/ScriptService.ts";

const OWNER = { _tag: "owner" } as const;

const definedOnly = <T extends object>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };

const SCRIPT_RUNS_PAGE = 20;

type ScriptId = Parameters<KanbanScriptsShape["runs"]>[0];

/** WS handlers for the board UI. Every write runs as the owner (the operate scope gates it). */
export const makeKanbanWsHandlers = (service: KanbanServiceShape, scripts: KanbanScriptsShape) => {
  const patchCard = Effect.fn("KanbanWs.patchCard")(function* (input: KanbanCardPatchInput) {
    const { cardId, stage, stalled, comment, ...fields } = input;
    let card = (yield* service.card(cardId)).card;
    const edits = definedOnly(fields);
    if (Object.keys(edits).length > 0 || comment) {
      card = yield* service.editCard(cardId, { ...edits, ...(comment ? { comment } : {}) }, OWNER);
    }
    if (stalled === false && card.stalled) card = yield* service.flagCard(cardId, null, OWNER);
    if (stage && stage !== card.stage)
      card = yield* service.moveCard(cardId, stage, "owner", OWNER);
    return card;
  });

  const updateBoard = (input: KanbanBoardUpdateInput) => {
    const { boardId, ...patch } = input;
    return service.updateBoard(boardId, definedOnly(patch) as BoardPatch);
  };

  return {
    [M.boards]: () => service.boardSummaries,
    [M.subscribe]: (input: { readonly boardId: Parameters<KanbanServiceShape["watch"]>[0] }) =>
      service.watch(input.boardId),
    [M.card]: (input: { readonly cardId: Parameters<KanbanServiceShape["card"]>[0] }) =>
      service.card(input.cardId),
    [M.discussions]: (input: {
      readonly boardId: Parameters<KanbanServiceShape["discussions"]>[0];
    }) => service.discussions(input.boardId),
    [M.threads]: (input: { readonly boardId: Parameters<KanbanServiceShape["threads"]>[0] }) =>
      service.threads(input.boardId),
    [M.owner]: (input: { readonly threadId: string }) => service.caller(input.threadId),
    [M.messages]: (input: {
      readonly discussionId: Parameters<KanbanServiceShape["messages"]>[0];
      readonly afterSeq?: number | undefined;
      readonly limit?: number | undefined;
    }) =>
      service.messages(
        input.discussionId,
        definedOnly({ afterSeq: input.afterSeq, limit: input.limit }),
      ),
    [M.wiki]: (input: { readonly boardId: Parameters<KanbanServiceShape["wiki"]>[0] }) =>
      service.wiki(input.boardId),
    // The owner's create must not reuse a board: ensureBoard returns an existing one on a
    // slug match, so a taken slug is refused here, before any model or setup change.
    [M.boardCreate]: (input: Parameters<KanbanServiceShape["ensureBoard"]>[0]) =>
      Effect.gen(function* () {
        const slug = input.slug.trim().toLowerCase();
        const taken = (yield* service.boards).some((board) => board.slug === slug);
        if (taken) {
          return yield* Effect.fail(
            new KanbanError({ code: "conflict", detail: `a board with slug ${slug} already exists` }),
          );
        }
        return yield* service.ensureBoard(input);
      }),
    [M.boardUpdate]: updateBoard,
    [M.setupStart]: (input: {
      readonly boardId: Parameters<KanbanServiceShape["startSetup"]>[0];
      readonly evaluatorModel: Parameters<KanbanServiceShape["startSetup"]>[1]["evaluatorModel"];
      readonly text?: string | undefined;
    }) => service.startSetup(input.boardId, { evaluatorModel: input.evaluatorModel, text: input.text }),
    [M.setupEnd]: (input: { readonly boardId: Parameters<KanbanServiceShape["endSetup"]>[0] }) =>
      service.endSetup(input.boardId, OWNER),
    [M.cardPatch]: patchCard,
    [M.cardSettle]: (input: { readonly cardId: Parameters<KanbanServiceShape["settleCard"]>[0] }) =>
      service.settleCard(input.cardId),
    [M.cardStop]: (input: { readonly cardId: Parameters<KanbanServiceShape["cardThread"]>[0] }) =>
      service.cardThread(input.cardId, "stop", "Stopped by the owner.", OWNER),
    [M.cardAsk]: (input: {
      readonly cardId: Parameters<KanbanServiceShape["changeAsk"]>[0];
      readonly askId: string;
      readonly action: "block" | "drop";
    }) => service.changeAsk(input.cardId, input.askId, input.action, OWNER, "owner"),
    [M.cardDiscussion]: (input: {
      readonly cardId: Parameters<KanbanServiceShape["cardDiscussion"]>[0];
    }) => service.cardDiscussion(input.cardId),
    [M.poolSet]: (input: {
      readonly boardId: Parameters<KanbanServiceShape["setPool"]>[0];
      readonly model: Parameters<KanbanServiceShape["setPool"]>[1];
      readonly slots: number;
    }) => service.setPool(input.boardId, input.model, input.slots),
    [M.poolRemove]: (input: {
      readonly boardId: Parameters<KanbanServiceShape["removePool"]>[0];
      readonly model: Parameters<KanbanServiceShape["removePool"]>[1];
    }) => service.removePool(input.boardId, input.model),
    [M.discussionCreate]: (input: {
      readonly boardId: Parameters<KanbanServiceShape["createDiscussion"]>[0];
      readonly title: string;
    }) => service.createDiscussion(input.boardId, input.title, OWNER),
    [M.discussionUpdate]: ({ discussionId, ...patch }: KanbanDiscussionUpdateInput) =>
      service.updateDiscussion(discussionId, patch, OWNER),
    [M.discussionRead]: (input: {
      readonly discussionId: Parameters<KanbanServiceShape["markRead"]>[0];
      readonly seq: number;
    }) => service.markRead(input.discussionId, OWNER, input.seq).pipe(Effect.as({})),
    [M.messagePost]: (input: {
      readonly discussionId: Parameters<KanbanServiceShape["post"]>[0];
      readonly blocks: Parameters<KanbanServiceShape["post"]>[2];
    }) => service.post(input.discussionId, OWNER, input.blocks),
    [M.answer]: (input: {
      readonly discussionId: Parameters<KanbanServiceShape["answer"]>[0];
      readonly seq: number;
      readonly blockId: string;
      readonly choice: ReadonlyArray<string>;
      readonly text?: string | null | undefined;
    }) => service.answer(input.discussionId, input.seq, input.blockId, input.choice, OWNER, input.text ?? null),
    [M.scripts]: (input: { readonly boardId: Parameters<KanbanScriptsShape["scripts"]>[0] }) =>
      scripts.scripts(input.boardId),
    [M.scriptRuns]: (input: { readonly scriptId: ScriptId; readonly limit?: number | undefined }) =>
      scripts.runs(input.scriptId, input.limit || SCRIPT_RUNS_PAGE),
    [M.scriptEnable]: (input: { readonly scriptId: ScriptId; readonly enabled: boolean }) =>
      scripts.setEnabled(input.scriptId, input.enabled),
    [M.scriptRun]: (input: { readonly scriptId: ScriptId }) =>
      scripts.run(input.scriptId, "manual"),
  } as const;
};
