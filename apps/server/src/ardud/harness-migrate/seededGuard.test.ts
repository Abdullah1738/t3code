import { describe, expect, it } from "vite-plus/test";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { isClaudeSeeded, seededUnconfirmed } from "./seededGuard.ts";

const now = DateTime.makeUnsafe("2026-11-03T12:00:00Z");
const threadId = ProviderThreadId.make("seeded-thread");
const thread: OrchestrationV2ProviderThread = {
  id: threadId,
  driver: ProviderDriverKind.make("claudeAgent"),
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  providerSessionId: null,
  appThreadId: null,
  ownerNodeId: null,
  nativeThreadRef: null,
  nativeConversationHeadRef: null,
  status: "not_loaded",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  nativeMetadata: {
    seededHistory: {
      source: "opencode",
      sourceSessionId: "ses_source",
      digest: "sha256:source",
      mode: "claude-transcript",
    },
  },
  createdAt: now,
  updatedAt: now,
};
const turn: OrchestrationV2ProviderTurn = {
  id: ProviderTurnId.make("turn"),
  providerThreadId: threadId,
  nodeId: NodeId.make("node"),
  runAttemptId: null,
  nativeTurnRef: null,
  ordinal: 1,
  status: "completed",
  startedAt: now,
  completedAt: now,
};

describe("seeded history guards", () => {
  it("requires a completed turn on the same seeded provider thread", () => {
    expect(seededUnconfirmed(thread, [])).toBe(true);
    for (const status of ["pending", "running", "failed", "cancelled", "interrupted"] as const) {
      expect(seededUnconfirmed(thread, [{ ...turn, status }])).toBe(true);
    }
    expect(
      seededUnconfirmed(thread, [{ ...turn, providerThreadId: ProviderThreadId.make("other") }]),
    ).toBe(true);
    expect(seededUnconfirmed(thread, [turn])).toBe(false);
    expect(seededUnconfirmed({ ...thread, nativeMetadata: null }, [])).toBe(false);
    expect(seededUnconfirmed({ ...thread, nativeMetadata: {} }, [])).toBe(false);
  });

  it("recognizes Claude transcripts without confusing Codex injections or ordinary threads", () => {
    const codex: OrchestrationV2ProviderThread = {
      ...thread,
      nativeMetadata: {
        seededHistory: { ...thread.nativeMetadata!.seededHistory!, mode: "codex-inject" },
      },
    };
    expect(isClaudeSeeded(thread)).toBe(true);
    expect(isClaudeSeeded(codex)).toBe(false);
    expect(seededUnconfirmed(codex, [])).toBe(true);
    expect(seededUnconfirmed(codex, [turn])).toBe(true);
    expect(
      seededUnconfirmed(codex, [
        {
          ...turn,
          nativeTurnRef: {
            driver: ProviderDriverKind.make("codex"),
            nativeId: "native-turn",
            strength: "strong",
          },
        },
      ]),
    ).toBe(false);
    expect(isClaudeSeeded({ ...thread, nativeMetadata: null })).toBe(false);
    expect(isClaudeSeeded({ ...thread, nativeMetadata: {} })).toBe(false);
  });
});
