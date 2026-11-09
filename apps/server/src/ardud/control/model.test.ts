import type {
  ModelSelection,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { controlEventFromStored } from "./http.ts";
import {
  formatModel,
  lastAssistantText,
  modelSelectionFrom,
  parseSince,
  selectionMigrationApplies,
  selectionProblem,
  stateFromRunStatus,
  stateFromRuns,
} from "./model.ts";

const at = (ms: number) => DateTime.makeUnsafe(ms);
const selection = (options?: ModelSelection["options"]): ModelSelection =>
  ({
    instanceId: "opencode",
    model: "opus/claude-opus-5-5",
    ...(options === undefined ? {} : { options }),
  }) as ModelSelection;

/** The merged selection, or a failing test when the merge reports a conflict. */
const selectionOf = (result: ReturnType<typeof modelSelectionFrom>): ModelSelection => {
  if (result.kind !== "selection") throw new Error(`unexpected conflict: ${result.reason}`);
  return result.selection;
};

const run = (ordinal: number, status: OrchestrationV2Run["status"]) =>
  ({ id: `run-${ordinal}`, ordinal, status }) as unknown as OrchestrationV2Run;

const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
  createdAt: number,
  runId: string | null = "run-1",
) =>
  ({
    id,
    role,
    text,
    runId,
    createdAt: at(createdAt),
    updatedAt: at(createdAt),
  }) as unknown as OrchestrationV2ConversationMessage;

describe("state mapping", () => {
  it("maps run statuses onto control states", () => {
    expect(stateFromRunStatus("running", false)).toBe("running");
    expect(stateFromRunStatus("preparing", false)).toBe("running");
    expect(stateFromRunStatus("waiting", false)).toBe("waiting");
    expect(stateFromRunStatus("queued", false)).toBe("queued");
    expect(stateFromRunStatus("completed", false)).toBe("idle");
    expect(stateFromRunStatus("interrupted", false)).toBe("idle");
    expect(stateFromRunStatus(null, false)).toBe("idle");
    expect(stateFromRunStatus("running", true)).toBe("needs-input");
  });

  it("prefers the active run over newer queued or older finished ones", () => {
    const result = stateFromRuns([run(1, "completed"), run(2, "running"), run(3, "queued")], false);
    expect(result.state).toBe("running");
    expect(result.run?.ordinal).toBe(2);
    expect(stateFromRuns([run(1, "completed"), run(2, "failed")], false).run?.ordinal).toBe(2);
    expect(stateFromRuns([], false)).toEqual({ state: "idle", run: null });
  });
});

describe("model selection", () => {
  it.each([
    undefined,
    {},
    { ardudHarnessMigration: { selections: "off" as const } },
    { ardudHarnessMigration: { selections: "dryrun" as const } },
  ])("infers OpenCode only for an explicit provider/model without an instance (%j)", (settings) => {
    const base = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "max" }],
    } satisfies ModelSelection;
    for (const [model, instanceId, expected] of [
      ["opus/claude-opus-5-5", undefined, "opencode"],
      ["opus/cx/gpt-6.1-sol", undefined, "opencode"],
      ["opus/claude-opus-5-5", "claudeAgent", "claudeAgent"],
      ["claude-sonnet-5-5", undefined, "claudeAgent"],
    ] as const) {
      expect(
        selectionOf(modelSelectionFrom({ base, model, instanceId, variant: "high", settings })),
      ).toEqual({
        instanceId: expected,
        model,
        options: [{ id: "variant", value: "high" }],
      });
    }
    expect(selectionOf(modelSelectionFrom({ base, settings }))).toEqual(base);
  });

  it("parses provider/model with a variant", () => {
    expect(
      selectionOf(
        modelSelectionFrom({ model: "opus/gpt-6-astra", variant: "xhigh", base: selection() }),
      ),
    ).toEqual({
      instanceId: "opencode",
      model: "opus/gpt-6-astra",
      options: [{ id: "variant", value: "xhigh" }],
    });
  });

  it("keeps other options and the variant when only the variant changes or nothing changes", () => {
    const base = selection([
      { id: "agent", value: "build" },
      { id: "variant", value: "high" },
    ]);
    expect(selectionOf(modelSelectionFrom({ base })).options).toEqual([
      { id: "agent", value: "build" },
      { id: "variant", value: "high" },
    ]);
    expect(selectionOf(modelSelectionFrom({ variant: "low", base })).options).toEqual([
      { id: "agent", value: "build" },
      { id: "variant", value: "low" },
    ]);
    expect(selectionOf(modelSelectionFrom({ variant: null, base })).options).toEqual([
      { id: "agent", value: "build" },
    ]);
  });

  it("drops the old model's options when the model changes", () => {
    const base = selection([{ id: "variant", value: "high" }]);
    expect(selectionOf(modelSelectionFrom({ model: "opus/other", base }))).toEqual({
      instanceId: "opencode",
      model: "opus/other",
    });
  });
});

describe("messages", () => {
  it("returns the newest non-empty assistant text, optionally per run", () => {
    const messages = [
      message("u1", "user", "hi", 1),
      message("a1", "assistant", "first", 2),
      message("a2", "assistant", "  ", 3),
      message("u2", "user", "again", 4, "run-2"),
      message("a3", "assistant", "second\n", 5, "run-2"),
    ];
    expect(lastAssistantText(messages)?.text).toBe("second");
    expect(lastAssistantText(messages, "run-1")?.text).toBe("first");
    expect(lastAssistantText(messages, "run-9")).toBeNull();
  });

  it("parses since as ISO or epoch milliseconds", () => {
    expect(parseSince("1700000000000")).toBe(1_700_000_000_000);
    expect(parseSince("2026-10-02T00:00:00.000Z")).toBe(Date.parse("2026-10-02T00:00:00.000Z"));
    expect(parseSince("nope")).toBeUndefined();
    expect(parseSince(null)).toBeUndefined();
  });
});

describe("control events", () => {
  const stored = (event: Record<string, unknown>) =>
    ({ sequence: 7, commandId: null, event }) as unknown as OrchestrationV2StoredEvent;

  it("maps run updates to thread status", () => {
    expect(
      controlEventFromStored(
        stored({ type: "run.updated", threadId: "t1", payload: { id: "r1", status: "waiting" } }),
      ),
    ).toEqual({
      type: "thread.status",
      threadId: "t1",
      runId: "r1",
      status: "waiting",
      state: "waiting",
    });
  });

  it("emits completed messages only", () => {
    const payload = { id: "m1", runId: "r1", role: "assistant", text: "PONG", streaming: false };
    expect(
      controlEventFromStored(stored({ type: "message.updated", threadId: "t1", payload })),
    ).toEqual({
      type: "message.completed",
      threadId: "t1",
      runId: "r1",
      messageId: "m1",
      role: "assistant",
      text: "PONG",
    });
    expect(
      controlEventFromStored(
        stored({
          type: "message.updated",
          threadId: "t1",
          payload: { ...payload, streaming: true },
        }),
      ),
    ).toBeNull();
  });

  it("maps runtime requests to opened and resolved", () => {
    const payload = { id: "q1", kind: "user_input", status: "pending" };
    expect(
      controlEventFromStored(stored({ type: "runtime-request.updated", threadId: "t1", payload })),
    ).toMatchObject({ type: "request.opened", kind: "question", requestId: "q1" });
    expect(
      controlEventFromStored(
        stored({
          type: "runtime-request.updated",
          threadId: "t1",
          payload: { id: "p1", kind: "command", status: "resolved" },
        }),
      ),
    ).toMatchObject({ type: "request.resolved", kind: "approval" });
  });

  it("ignores high-volume item events", () => {
    expect(
      controlEventFromStored(stored({ type: "turn-item.updated", threadId: "t1" })),
    ).toBeNull();
  });
});

describe("effort compatibility", () => {
  const settings = { ardudHarnessMigration: { selections: "apply" as const } };
  const claude = {
    instanceId: "claudeAgent",
    model: "claude-opus-5-5",
    options: [{ id: "effort", value: "max" }],
  } as unknown as ModelSelection;
  const suffixed = {
    instanceId: "opencode",
    model: "opus/cx/gpt-6.1-sol#xhigh",
  } as unknown as ModelSelection;
  it("a variant patch replaces an existing effort with one effort option", () => {
    expect(selectionOf(modelSelectionFrom({ variant: "xhigh", base: claude, settings }))).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "xhigh" }],
    });
  });

  it("a null variant clears the effort", () => {
    expect(selectionOf(modelSelectionFrom({ variant: null, base: claude, settings }))).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
    });
  });

  it("clears a legacy suffix effort on variant null, so resolution no longer restores it", () => {
    const cleared = selectionOf(modelSelectionFrom({ variant: null, base: suffixed, settings }));
    expect(cleared).toEqual({ instanceId: "codex", model: "gpt-6.1-sol" });
  });

  it("clears a legacy suffix effort on an explicit empty options list", () => {
    const emptied = modelSelectionFrom({ base: suffixed, options: [], settings });
    expect(emptied).toEqual({
      kind: "selection",
      selection: { instanceId: "codex", model: "gpt-6.1-sol" },
    });
  });

  it("a variant max over a legacy xhigh suffix replaces the effort, not a conflict", () => {
    expect(selectionOf(modelSelectionFrom({ variant: "max", base: suffixed, settings }))).toEqual({
      instanceId: "codex",
      model: "gpt-6.1-sol",
      options: [{ id: "reasoningEffort", value: "max" }],
    });
  });

  it("a lone variant patch overrides the base's old effort", () => {
    expect(selectionOf(modelSelectionFrom({ variant: "low", base: claude, settings }))).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "low" }],
    });
  });

  it("reports an explicit effort and a variant that disagree, instead of picking one", () => {
    const result = modelSelectionFrom({
      base: { instanceId: "claudeAgent", model: "claude-opus-5-5" } as ModelSelection,
      options: [{ id: "effort", value: "max" }],
      variant: "xhigh",
      settings,
    });
    expect(result.kind).toBe("conflict");
  });

  it("reports duplicate native efforts in one patch as a conflict", () => {
    const result = modelSelectionFrom({
      base: { instanceId: "codex", model: "gpt-6.1-sol" } as ModelSelection,
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "reasoningEffort", value: "xhigh" },
      ],
      settings,
    });
    expect(result.kind).toBe("conflict");
  });

  it("reports a suffix and an explicit effort that disagree in one patch", () => {
    const result = modelSelectionFrom({
      base: { instanceId: "opencode", model: "opus/gpt-6-astra" } as ModelSelection,
      model: "opus/cx/gpt-6.1-sol#xhigh",
      options: [{ id: "variant", value: "max" }],
      settings,
    });
    expect(result.kind === "conflict" ? result.reason : null).toMatch(/conflicting efforts/);
  });

  it("reports a variant set together with a clear as a conflict", () => {
    const result = modelSelectionFrom({
      base: claude,
      variant: null,
      options: [{ id: "effort", value: "low" }],
      settings,
    });
    expect(result.kind).toBe("conflict");
  });

  it("routes a provider/model id to OpenCode on the old path when the default is native (#586)", () => {
    const nativeDefault: ModelSelection = {
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
    } as ModelSelection;
    expect(
      selectionOf(
        modelSelectionFrom({ base: nativeDefault, model: "opus/claude-opus-5-5", variant: "high" }),
      ),
    ).toEqual({
      instanceId: "opencode",
      model: "opus/claude-opus-5-5",
      options: [{ id: "variant", value: "high" }],
    });
    expect(
      selectionOf(
        modelSelectionFrom({
          base: nativeDefault,
          model: "opus/claude-opus-5-5",
          instanceId: "claudeAgent",
        }),
      ).instanceId,
    ).toBe("claudeAgent");
    expect(
      selectionOf(modelSelectionFrom({ base: nativeDefault, model: "claude-sonnet-5-5" }))
        .instanceId,
    ).toBe("claudeAgent");
  });

  it("uses the typed flag, keeping absent, off and dryrun on the old path", () => {
    for (const legacySettings of [
      undefined,
      {},
      { ardudHarnessMigration: { selections: "off" as const } },
      { ardudHarnessMigration: { selections: "dryrun" as const } },
    ]) {
      expect(selectionMigrationApplies(legacySettings)).toBe(false);
      expect(selectionOf(modelSelectionFrom({ base: suffixed, settings: legacySettings }))).toEqual(
        suffixed,
      );
      expect(
        selectionOf(
          modelSelectionFrom({ base: claude, variant: "high", settings: legacySettings }),
        ),
      ).toEqual({
        ...claude,
        options: [
          { id: "effort", value: "max" },
          { id: "variant", value: "high" },
        ],
      });
    }
    expect(selectionMigrationApplies(settings)).toBe(true);
    expect(selectionOf(modelSelectionFrom({ base: suffixed, settings }))).toEqual({
      instanceId: "codex",
      model: "gpt-6.1-sol",
      options: [{ id: "reasoningEffort", value: "xhigh" }],
    });
    expect(
      selectionOf(modelSelectionFrom({ base: selection(), model: "claude-sonnet-5-5", settings })),
    ).toEqual({
      instanceId: "claudeAgent",
      model: "claude-sonnet-5-5",
    });
  });

  it("inherits across canonical equivalents, but not another model or instance", () => {
    const base = {
      ...claude,
      options: [
        { id: "effort", value: "max" },
        { id: "fastMode", value: true },
      ],
    } as ModelSelection;
    expect(
      selectionOf(modelSelectionFrom({ base, model: "opus/claude-opus-5-5", settings })),
    ).toEqual({
      ...base,
      options: [
        { id: "fastMode", value: true },
        { id: "effort", value: "max" },
      ],
    });
    expect(selectionOf(modelSelectionFrom({ base, model: "claude-sonnet-5-5", settings }))).toEqual(
      {
        instanceId: "claudeAgent",
        model: "claude-sonnet-5-5",
      },
    );
    expect(
      selectionOf(
        modelSelectionFrom({ base, instanceId: "codex", model: "gpt-6.1-sol", settings }),
      ),
    ).toEqual({
      instanceId: "codex",
      model: "gpt-6.1-sol",
    });
    expect(selectionOf(modelSelectionFrom({ base, options: [], settings }))).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
    });
  });

  it("passes native secondary options, validates duplicates and reports model options", () => {
    const selected = selectionOf(
      modelSelectionFrom({
        base: claude,
        options: [
          { id: "effort", value: "high" },
          { id: "fastMode", value: true },
        ],
        settings,
      }),
    );
    expect(formatModel(selected)).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      effort: "high",
      options: [
        { id: "fastMode", value: true },
        { id: "effort", value: "high" },
      ],
    });
    expect(
      modelSelectionFrom({
        base: claude,
        options: [
          { id: "fastMode", value: true },
          { id: "fastMode", value: true },
        ],
        settings,
      }).kind,
    ).toBe("conflict");
    expect(selectionProblem([], selected)).toMatch(/cannot be checked/);
  });

  it("leaves unrelated OpenCode models alone and refuses to drop stored options on mapping", () => {
    const unrelated = {
      instanceId: ProviderInstanceId.make("opencode"),
      model: "other/glm",
      options: [{ id: "variant", value: "high" }],
    } as ModelSelection;
    expect(selectionOf(modelSelectionFrom({ base: unrelated, settings }))).toEqual(unrelated);
    const unknownOption = selection([{ id: "someSetting", value: "keep" }]);
    expect(modelSelectionFrom({ base: unknownOption, settings }).kind).toBe("conflict");
  });

  it("distinguishes legacy OpenCode slugs from native slugs on either base", () => {
    for (const base of [selection(), claude]) {
      expect(selectionOf(modelSelectionFrom({ base, model: "surplus/glm", settings }))).toEqual({
        instanceId: "opencode",
        model: "surplus/glm",
      });
      expect(
        selectionOf(modelSelectionFrom({ base, model: "claude-sonnet-5-5", settings })),
      ).toEqual({
        instanceId: "claudeAgent",
        model: "claude-sonnet-5-5",
      });
    }
  });

  it("lets a replacement or model switch discard obsolete stored options", () => {
    const base = selection([{ id: "agent", value: "build" }]);
    expect(selectionOf(modelSelectionFrom({ base, options: [], settings }))).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
    });
    expect(
      selectionOf(
        modelSelectionFrom({
          base,
          instanceId: "codex",
          model: "gpt-6.1-sol",
          options: [],
          settings,
        }),
      ),
    ).toEqual({
      instanceId: "codex",
      model: "gpt-6.1-sol",
    });
    expect(modelSelectionFrom({ base, settings }).kind).toBe("conflict");
  });

  it("lets a new effort replace conflicting stored native efforts", () => {
    const base = {
      ...claude,
      options: [
        { id: "variant", value: "high" },
        { id: "effort", value: "max" },
        { id: "fastMode", value: true },
      ],
    } as ModelSelection;
    expect(selectionOf(modelSelectionFrom({ base, variant: "low", settings }))).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [
        { id: "fastMode", value: true },
        { id: "effort", value: "low" },
      ],
    });
  });
});

describe("post-cutover resolver", () => {
  const settings = { ardudHarnessMigration: { cutoverComplete: true } };

  it.each([
    ["opus/claude-opus-5-5#max", "claudeAgent/claude-opus-5-5"],
    ["opus/cc/claude-haiku-5-5", "claudeAgent/claude-haiku-5-5"],
    ["opus/cx/gpt-6.1-sol", "codex/gpt-6.1-sol"],
    ["layso/gpt-6-astra", "codex/gpt-6-astra"],
    ["opus/cx/gpt-6.1-terra#xhigh", "codex-cu/gpt-6.1-terra"],
  ])("refuses explicit OpenCode selection %s and names %s", (model, target) => {
    for (const instanceId of [undefined, "opencode"]) {
      expect(modelSelectionFrom({ base: selection(), model, instanceId, settings })).toEqual({
        kind: "conflict",
        reason: expect.stringContaining(`use ${target} instead`),
      });
    }
  });

  it("refuses an instance-only request to keep a legacy Claude selection on OpenCode", () => {
    expect(modelSelectionFrom({ base: selection(), instanceId: "opencode", settings })).toEqual({
      kind: "conflict",
      reason: expect.stringContaining("claudeAgent/claude-opus-5-5"),
    });
  });

  it("maps inherited archived selections lazily, including option-only patches", () => {
    const base = selection([{ id: "variant", value: "max" }]);
    expect(selectionMigrationApplies(settings)).toBe(true);
    expect(selectionOf(modelSelectionFrom({ base, settings }))).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "max" }],
    });
    expect(selectionOf(modelSelectionFrom({ base, variant: "high", settings }))).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "high" }],
    });
  });

  it("does not let an off migration mode bypass the completed cutover", () => {
    const off = { ardudHarnessMigration: { selections: "off" as const, cutoverComplete: true } };
    expect(
      modelSelectionFrom({ base: selection(), model: "opus/claude-opus-5-5", settings: off }).kind,
    ).toBe("conflict");
    expect(selectionOf(modelSelectionFrom({ base: selection(), settings: off })).instanceId).toBe(
      "claudeAgent",
    );
  });

  it("allows native targets and unrelated OpenCode selections", () => {
    expect(
      selectionOf(
        modelSelectionFrom({
          base: selection(),
          instanceId: "claudeAgent",
          model: "claude-opus-5-5",
          settings,
          options: [{ id: "effort", value: "xhigh" }],
        }),
      ),
    ).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "xhigh" }],
    });
    expect(
      selectionOf(modelSelectionFrom({ base: selection(), model: "surplus/glm", settings })),
    ).toEqual({
      instanceId: "opencode",
      model: "surplus/glm",
    });
  });

  it("refuses unknown family models both explicit and inherited", () => {
    for (const model of ["opus/claude-future", "openai/gpt-future"]) {
      expect(modelSelectionFrom({ base: selection(), model, settings }).kind).toBe("conflict");
      expect(modelSelectionFrom({ base: { ...selection(), model }, settings }).kind).toBe(
        "conflict",
      );
    }
  });

  it("lets an explicit native target repair an unmapped inherited selection", () => {
    expect(
      selectionOf(
        modelSelectionFrom({
          base: { ...selection(), model: "opus/claude-future" },
          instanceId: "codex",
          model: "gpt-6.1-sol",
          settings,
        }),
      ),
    ).toEqual({ instanceId: "codex", model: "gpt-6.1-sol" });
  });

  it("preserves pre-cutover compatibility for an absent or false guard", () => {
    for (const cutoverComplete of [undefined, false]) {
      const before = {
        ardudHarnessMigration: {
          selections: "apply" as const,
          ...(cutoverComplete === undefined ? {} : { cutoverComplete }),
        },
      };
      expect(
        selectionOf(
          modelSelectionFrom({
            base: selection(),
            model: "opus/claude-opus-5-5",
            settings: before,
          }),
        ).instanceId,
      ).toBe("claudeAgent");
    }
  });
});
