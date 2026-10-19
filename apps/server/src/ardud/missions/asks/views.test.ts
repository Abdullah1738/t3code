import { describe, expect, it } from "@effect/vitest";
import { ViewTemplateId, type RecordView } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as MissionStore from "../store/MissionStore.ts";
import * as AsksService from "./AsksService.ts";
import {
  agent,
  askInput,
  governor,
  harness,
  laneThread,
  missionId,
  ownerApp,
  seed,
  writerThread,
} from "./AsksService.testkit.ts";

const view = (summary: string): RecordView => ({
  templateId: ViewTemplateId.make("tpl-migration"),
  fields: { summary: { _tag: "short", value: summary } },
});

describe("record views", () => {
  it.effect("asks, drafts and suggestions keep the view they were opened with", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const store = yield* MissionStore.MissionStore;

      const ask = yield* asks.openAsk(
        askInput("Which way?", { view: view("Online or offline") }),
        agent(laneThread),
      );
      expect(Option.getOrThrow(yield* store.get("ask", ask.id)).view).toEqual(
        view("Online or offline"),
      );

      const target = { kind: "ticket" as const, label: "CRP-1", url: null, ref: "CRP-1" };
      const draft = yield* asks.submitDraft(
        {
          missionId,
          audience: "Sami",
          channel: "linear",
          target,
          text: "The fix is merged.",
          view: view("Merged"),
        },
        agent(writerThread),
      );
      expect(draft.view).toEqual(view("Merged"));
      expect(draft.previousText).toBeUndefined();

      yield* asks.decideDraft(
        { draftId: draft.id, action: "rewrite", rewriteNote: "Name the PR." },
        ownerApp,
      );
      const revised = yield* asks.reviseDraft(
        { draftId: draft.id, text: "The fix is merged in #12." },
        agent(writerThread),
      );
      expect(revised.previousText).toBe("The fix is merged.");
      expect(revised.view).toEqual(view("Merged"));
      const stored = Option.getOrThrow(yield* store.get("draft", draft.id));
      expect(stored.previousText).toBe("The fix is merged.");

      const again = yield* asks.reviseDraft(
        { draftId: draft.id, text: "Merged in #12, deploying now.", view: view("Deploying") },
        agent(writerThread),
      );
      expect(again.previousText).toBe("The fix is merged in #12.");
      expect(again.view).toEqual(view("Deploying"));

      const suggestion = yield* asks.proposeSuggestion(
        {
          missionId,
          targetKind: "pool",
          title: "Raise the pool",
          after: { size: 4 },
          diffText: "size -> 4",
          why: "Lanes queue.",
          evidence: [{ kind: "lane", id: "lane-api" }],
          view: view("Pool 4"),
        },
        governor,
      );
      expect(Option.getOrThrow(yield* store.get("suggestion", suggestion.id)).view).toEqual(
        view("Pool 4"),
      );
    }).pipe(Effect.provide(layer));
  });
});
