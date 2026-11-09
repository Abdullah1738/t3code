import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type ModelSelection,
  type ServerSettings,
} from "@t3tools/contracts";

import { parseProjectOverrideRef, planSettings, projectOverrideRef } from "./settingsPlan.ts";

const projectId = ProjectId.make("project:one");

const selection = (model: string, options?: ModelSelection["options"]) =>
  ({
    instanceId: "opencode",
    model,
    ...(options === undefined ? {} : { options }),
  }) as ModelSelection;

const settings = (textGenerationModelSelection: ModelSelection): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  textGenerationModelSelection,
  projectSettingsOverrides: {
    [projectId]: { textGenerationModelSelection, responseStreamingMode: "paragraph" },
  },
});

describe("text-generation selection migration", () => {
  it.each([
    ["opus/claude-opus-5-5", "claudeAgent", "claude-opus-5-5", "effort"],
    ["opus/cc/claude-haiku-5-5", "claudeAgent", "claude-haiku-5-5", "effort"],
    ["opus/cx/gpt-6.1-sol", "codex", "gpt-6.1-sol", "reasoningEffort"],
    ["opus/cx/gpt-6.1-terra", "codex-cu", "gpt-6.1-terra", "reasoningEffort"],
  ])("maps %s globally and in project overrides", (model, instanceId, nativeModel, effortId) => {
    const before = selection(`${model}#xhigh`);
    const current = settings(before);
    const plan = planSettings(current);
    const after = { instanceId, model: nativeModel, options: [{ id: effortId, value: "xhigh" }] };
    expect(plan.conflicts).toEqual([]);
    expect(plan.patch).toEqual({
      textGenerationModelSelection: after,
      projectSettingsOverrides: {
        [projectId]: { textGenerationModelSelection: after, responseStreamingMode: "paragraph" },
      },
    });
    expect(plan.changes).toEqual([
      { field: "textGenerationModelSelection", before, after },
      {
        field: "projectSettingsOverrides:project%3Aone:textGenerationModelSelection",
        before,
        after,
      },
    ]);
    expect(current.textGenerationModelSelection).toBe(before);
    expect(current.projectSettingsOverrides[projectId]?.textGenerationModelSelection).toBe(before);
    expect(planSettings({ ...current, ...plan.patch } as ServerSettings).patch).toBeNull();
  });

  it("leaves GLM text generation unchanged globally and per project", () => {
    const before = selection("surplus/glm-5.3-flash", [{ id: "variant", value: "high" }]);
    expect(planSettings(settings(before))).toEqual({ changes: [], conflicts: [], patch: null });
  });

  it("reports unmapped Claude/OpenAI text generation in both scopes", () => {
    for (const model of ["opus/claude-future", "or/openai/gpt-future"]) {
      const plan = planSettings(settings(selection(model)));
      expect(plan.patch).toBeNull();
      expect(plan.changes).toEqual([]);
      expect(plan.conflicts).toEqual([
        { field: "textGenerationModelSelection", reason: expect.stringContaining(model) },
        {
          field: "projectSettingsOverrides:project%3Aone:textGenerationModelSelection",
          reason: expect.stringContaining(model),
        },
      ]);
    }
  });

  it("round-trips the text-generation ledger ref used for rollback", () => {
    const ref = projectOverrideRef("project:with/slashes", "textGenerationModelSelection");
    expect(parseProjectOverrideRef(ref)).toEqual({
      projectId: "project:with/slashes",
      field: "textGenerationModelSelection",
    });
  });
});
