import { assert, it } from "@effect/vitest";
import {
  MessageId,
  PlanId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderDriverKind,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { historyCost } from "@t3tools/provider-core/server/handoffBudget";
import { deliverContextHandoffs } from "./ContextHandoffDelivery.ts";

const layerTest = ContextHandoffService.layer.pipe(Layer.provide(IdAllocator.layer));

function importedItem(
  input:
    | {
        readonly role: "user";
        readonly id: string;
        readonly text: string;
        readonly ordinal: number;
      }
    | {
        readonly role: "assistant";
        readonly id: string;
        readonly text: string;
        readonly ordinal: number;
      },
): Extract<OrchestrationV2TurnItem, { readonly type: "user_message" | "assistant_message" }> {
  const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
  const base = {
    id: TurnItemId.make(`turn-item:${input.id}`),
    threadId: ThreadId.make("thread:legacy-context"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    messageId: MessageId.make(`message:${input.id}`),
    text: input.text,
  };
  return input.role === "user"
    ? {
        ...base,
        createdBy: "user",
        creationSource: "server",
        type: "user_message",
        inputIntent: "turn_start",
        attachments: [],
      }
    : {
        ...base,
        type: "assistant_message",
        streaming: false,
      };
}

it.layer(layerTest)("ContextHandoffService legacy import", (it) => {
  it.effect("prepares imported history for the first native v2 turn", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({ role: "user", id: "one", text: "What did we decide?", ordinal: 1 }),
          importedItem({
            role: "assistant",
            id: "two",
            text: "We decided to keep the migration lightweight.",
            ordinal: 2,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.equal(handoff.strategy, "manual_context");
      assert.deepStrictEqual(handoff.fromProviderThreadIds, []);
      assert.include(handoff.summaryText, "What did we decide?");
      assert.include(handoff.summaryText, "keep the migration lightweight");
      const providerMessage = ContextHandoffService.providerMessageWithContextHandoff({
        handoff,
        userText: "Continue from there.",
      });
      assert.include(providerMessage, handoff.summaryText);
      assert.include(providerMessage, "User message:\nContinue from there.");
    }),
  );

  it.effect("preserves role attribution when truncating imported history", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({
            role: "user",
            id: "long",
            text: `${"x".repeat(35_000)} retained final words`,
            ordinal: 1,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.isAtMost(handoff.summaryText.length, 32_000);
      assert.include(handoff.summaryText, "User:\n... retained final words");
      assert.notMatch(handoff.summaryText, /\n+x+ retained final words/);
    }),
  );

  it.effect("retains the newest oversized import even when it has no whitespace", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({
            role: "assistant",
            id: "older",
            text: "older message",
            ordinal: 1,
          }),
          importedItem({
            role: "user",
            id: "long-single-token",
            text: `${"🧪".repeat(20_000)}LATEST_SINGLE_TOKEN`,
            ordinal: 2,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.include(
        handoff.history?.omittedItemIds ?? [],
        TurnItemId.make("turn-item:long-single-token"),
      );
      assert.isAtMost(handoff.summaryText.length, 32_000);
      assert.include(handoff.summaryText, "User:\n... ");
      assert.include(handoff.summaryText, "LATEST_SINGLE_TOKEN");
      assert.notInclude(handoff.summaryText, "\ufffd");
    }),
  );
});

it.layer(layerTest)("ContextHandoffService native switch", (it) => {
  it.effect.each(["claudeAgent", "codex", "codex-cu"])(
    "delivers native activity and same-thread recovery to %s once",
    (target) =>
      Effect.gen(function* () {
        const service = yield* ContextHandoffService.ContextHandoffServiceV2;
        const now = DateTime.makeUnsafe("2026-11-05T00:00:00Z");
        const threadId = ThreadId.make("thread:same-cutover");
        const toProviderThreadId = ProviderThreadId.make("provider-thread:native-target");
        const handoff = yield* service.prepareProviderHandoff({
          threadId,
          targetRunId: RunId.make("run:next-native"),
          transferId: null,
          fromProviderThreadIds: [
            ProviderThreadId.make("provider-thread:not-the-native-session-id"),
          ],
          toProviderThreadId,
          fromProviderInstanceId: ProviderInstanceId.make("opencode"),
          toProviderInstanceId: ProviderInstanceId.make(target),
          coveredRunOrdinals: { from: 1, to: 3 },
          strategy: "full_thread_summary",
          items: [
            importedItem({ role: "user", id: "one", text: "Keep the changes small.", ordinal: 1 }),
            importedItem({
              role: "assistant",
              id: "two",
              text: "The first fix is finished.",
              ordinal: 2,
            }),
            {
              ...importedItem({ role: "assistant", id: "command", text: "", ordinal: 3 }),
              type: "command_execution",
              input: "vp test parser",
              output: "Parser regression passed",
              exitCode: 0,
            },
            {
              ...importedItem({ role: "assistant", id: "plan", text: "", ordinal: 4 }),
              type: "proposed_plan",
              planId: PlanId.make("plan:remaining"),
              streaming: false,
              markdown: "Finish the remaining retry regression.",
            },
          ],
          createdAt: now,
        });
        assert.isUndefined(handoff.deliveryMode);
        assert.include(
          handoff.history!.coverage,
          't3_thread_read({threadId:"thread:same-cutover",view:"activity"',
        );
        assert.include(handoff.history!.coverage, "afterPosition=nextPosition");
        assert.include(
          handoff.summaryText,
          "Command: vp test parser\nExit code: 0\nParser regression passed",
        );
        assert.include(handoff.summaryText, "Finish the remaining retry regression.");
        assert.include(handoff.summaryText, "Keep the changes small.");
        assert.notInclude(handoff.summaryText, "Recent conversation excerpt only");
        assert.isAtMost(Buffer.byteLength(handoff.summaryText), 16_000);
        assert.isAtMost(
          historyCost(handoff.history!.messages, handoff.summaryText.split("\n\n[Historical")[0]!),
          16_000,
        );
        let durable = handoff;
        const input = {
          budget: 16_000,
          alreadyDeliveredItemIds: new Set<string>(),
          providerThread: {
            id: toProviderThreadId,
            driver: ProviderDriverKind.make(target === "codex-cu" ? "codex" : target),
            providerInstanceId: ProviderInstanceId.make(target),
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver: ProviderDriverKind.make(target === "codex-cu" ? "codex" : target),
              nativeId: "native:target",
              strength: "strong" as const,
            },
            nativeConversationHeadRef: null,
            status: "idle" as const,
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
          persist: (updated: typeof handoff) =>
            Effect.sync(() => {
              durable = updated;
            }),
        };
        const delivered = yield* deliverContextHandoffs({ ...input, handoffs: [durable] });
        assert.include(delivered.context, "afterPosition=nextPosition");
        assert.include(delivered.context, "Parser regression passed");
        assert.include(delivered.context, "Finish the remaining retry regression.");
        assert.isAtMost(Buffer.byteLength(delivered.context), 16_000);
        yield* delivered.delivered;
        assert.equal(durable.delivery?.status, "inline");
        const second = yield* deliverContextHandoffs({ ...input, handoffs: [durable] });
        assert.equal(second.context, "");
      }),
  );

  it.effect(
    "keeps prompt-only excerpts opt-in while ordinary and reverse handoffs remain native",
    () =>
      Effect.gen(function* () {
        const service = yield* ContextHandoffService.ContextHandoffServiceV2;
        for (const [source, target, promptOnly] of [
          ["opencode", "codex", false],
          ["codex", "opencode", false],
          ["claudeAgent", "codex", true],
        ] as const) {
          const handoff = yield* service.prepareProviderHandoff({
            threadId: ThreadId.make("thread:ordinary"),
            targetRunId: RunId.make("run:ordinary"),
            transferId: null,
            fromProviderThreadIds: [],
            toProviderThreadId: ProviderThreadId.make("provider-thread:ordinary"),
            fromProviderInstanceId: ProviderInstanceId.make(source),
            toProviderInstanceId: ProviderInstanceId.make(target),
            coveredRunOrdinals: { from: 1, to: 1 },
            items: [],
            promptOnly,
            strategy: "full_thread_summary",
            createdAt: yield* DateTime.now,
          });
          assert.notInclude(handoff.summaryText, "Robob moved this same thread");
        }
      }),
  );
});
