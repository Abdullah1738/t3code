import { describe, expect, it } from "vite-plus/test";
import {
  KanbanBoardId,
  KanbanCardId,
  KanbanScriptId,
  ProviderInstanceId,
  ThreadId,
  type KanbanActor,
  type KanbanCard,
} from "@t3tools/contracts";
import { cardEvents, reasonClass, elapsed, label } from "./analytics.ts";

const manualActors: KanbanActor[] = [
  { _tag: "owner" },
  { _tag: "thread", threadId: ThreadId.make("private-thread") },
  { _tag: "evaluator", threadId: ThreadId.make("private-evaluator") },
  { _tag: "script", scriptId: KanbanScriptId.make("private-script") },
];
const system: KanbanActor = { _tag: "system", component: "dispatcher" };
const at = "2026-11-14T13:00:00.000Z";
const later = "2026-11-14T13:01:00.000Z";

const snapshot = (stalled: KanbanCard["stalled"]): KanbanCard => ({
  id: KanbanCardId.make("private-card"),
  boardId: KanbanBoardId.make("private-board"),
  number: 1,
  title: "Private title",
  description: "Private description",
  prompt: "Private prompt",
  stage: "todo",
  priority: 4,
  goalId: null,
  projects: [],
  model: { instanceId: ProviderInstanceId.make("codex"), model: "private-model" },
  models: [],
  subtasks: [],
  subtaskSeq: 0,
  projectId: null,
  links: [],
  blockedBy: [],
  stalled,
  question: null,
  asks: [],
  reviewChain: null,
  reviewStep: 0,
  reviewRound: 0,
  activeThreadId: null,
  activeRole: null,
  activePool: null,
  workThreadId: null,
  reviewThreadId: null,
  discussionId: null,
  wakeNote: null,
  nudgedAt: null,
  settledAt: null,
  createdBy: system,
  createdAt: at,
  updatedAt: at,
  movedAt: at,
});

describe("board analytics privacy", () => {
  it.each([
    ["Stale queued runs on the thread", "stale_queued_runs"],
    ["Run went silent twice", "run_silent"],
    ["No project set for this card", "missing_project"],
    ["Thread model differs from card model: private", "thread_model_differs"],
    ["Review verdict refused: private", "verdict_refused"],
    ["Model refused: Model private is not offered by codex.", "model_unavailable"],
    ["Model refused: private Option effort was specified more than once.", "model_unavailable"],
    ["Model refused: private Unknown option effort; supported options: none.", "model_unavailable"],
    ["Model refused: private Option enabled expects a boolean value.", "model_unavailable"],
    ["Model refused: private Option effort expects one of: max.", "model_unavailable"],
    ['Model refused: private has no "low" effort value; it offers: max.', "model_unavailable"],
    ['Model refused: private has no "low" variant; it offers: max.', "model_unavailable"],
    ["Thread model differs from card model: unknown; private cause", "thread_model_differs"],
    ["Variant unavailable for private model", "variant_unavailable"],
    ["Provider blocked the response: private prompt", "provider_blocked"],
    ["Interrupted by owner", "interrupted"],
    ["Run failed: prompt is too long", "context_exhausted"],
    ["usage limit exceeded", "provider_capacity"],
    ["access token has expired", "authentication"],
    ["Model unavailable: private", "model_unavailable"],
    ["Timed out waiting", "timeout"],
    ["Reviewer stopped without a verdict", "no_verdict"],
    ["Thread start failed: private", "thread_start"],
    ["Thread start failed: private. Clear this flag after checking the provider.", "thread_start"],
    ["Run failed: private", "run_failed"],
    ["Run failed: The provider never started this run (waited 10 min).", "run_failed"],
    [
      "Run failed: Provider restart cleanup did not finish (waited 30 sec). The replacement was not sent.",
      "run_failed",
    ],
    [
      "Run failed: The restart admission queue never released this run (waited 30 min). The card's evaluator can clear this flag; a new run on its work thread clears it automatically.",
      "run_failed",
    ],
    ["Stopped", "interrupted"],
    ["A private error message", "other"],
  ])("classifies %s without retaining it", (message, expected) => {
    expect(reasonClass(message)).toBe(expected);
  });
  it.each([
    ["content_filter", "provider_blocked"],
    ["model_invalid", "model_unavailable"],
    ["context_exhausted", "context_exhausted"],
    ["auth_expired", "authentication"],
    ["quota", "provider_capacity"],
    ["transient", "provider_capacity"],
    ["config", "configuration"],
  ])("uses normalized %s categories when message wording varies", (category, expected) => {
    expect(reasonClass("private", category)).toBe(expected);
    expect(reasonClass("Thread model differs from card model: auth timeout", category)).toBe(
      expected,
    );
    expect(reasonClass("Provider blocked the response; stopped", category, "system")).toBe(
      expected,
    );
  });
  it.each([undefined, "unknown", "future_category"])(
    "falls back to text for category %s",
    (category) => {
      expect(reasonClass("Run went silent twice", category, "system")).toBe("run_silent");
      expect(reasonClass("Timed out waiting", category)).toBe("timeout");
      expect(reasonClass("A private unknown reason", category, "system")).toBe("other");
    },
  );
  it.each(manualActors)("uses the $_tag flag source before text or category", (actor) => {
    for (const text of [
      "Private reason",
      "Auth token expired; timed out",
      "Stopped",
      "Run failed",
    ]) {
      expect(reasonClass(text, undefined, actor._tag)).toBe("manual_flag");
      expect(reasonClass(text, "auth_expired", actor._tag)).toBe("manual_flag");
    }
  });
  it.each(manualActors)("keeps $_tag attribution through set, replacement, and clear", (by) => {
    const manual = { reason: "Private auth timeout", by, at };
    const generated = { reason: "Run went silent twice", by: system, at: later };
    const none = snapshot(null);
    const flagged = snapshot(manual);
    const automatic = { ...snapshot(generated), updatedAt: later };
    const cleared = { ...none, updatedAt: later };
    const cases = [
      { before: none, after: flagged, actor: by, classes: ["manual_flag"], actors: [by._tag] },
      {
        before: flagged,
        after: cleared,
        actor: system,
        classes: ["manual_flag"],
        actors: [by._tag],
      },
      {
        before: flagged,
        after: automatic,
        actor: system,
        classes: ["manual_flag", "run_silent"],
        actors: [by._tag, "system"],
      },
      {
        before: automatic,
        after: flagged,
        actor: by,
        classes: ["run_silent", "manual_flag"],
        actors: ["system", by._tag],
      },
      { before: automatic, after: cleared, actor: by, classes: ["run_silent"], actors: ["system"] },
    ];
    for (const entry of cases) {
      const events = cardEvents(entry.before, entry.after, entry.actor);
      expect(events.map((event) => event.props?.reasonClass)).toEqual(entry.classes);
      expect(events.map((event) => event.props?.actor)).toEqual(entry.actors);
      expect(events.map((event) => event.props?.action)).toEqual(
        entry.before.stalled === null
          ? ["set"]
          : entry.after.stalled === null
            ? ["clear"]
            : ["clear", "set"],
      );
      expect(JSON.stringify(events)).not.toContain(manual.reason);
      expect(JSON.stringify(events)).not.toMatch(
        /Private (title|prompt|description)|Run went silent twice/,
      );
    }
  });
  it("bounds labels and clamps malformed or negative durations", () => {
    expect(label("private words")).toBe("other");
    expect(label("a".repeat(161))).toBe("other");
    expect(elapsed("2026-11-13T12:00:00.000Z", "2026-11-13T13:00:00.000Z")).toBe(0);
    expect(elapsed("bad", "bad")).toBe(0);
  });
});
