// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "./orchestrationInstructions.ts";

const readRepoFile = (path: string) =>
  NodeFS.readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8");

const decodeCatalog = Schema.decodeUnknownSync(
  Schema.Struct({
    models: Schema.Array(
      Schema.Struct({
        slug: Schema.String,
        default_service_tier: Schema.NullOr(Schema.String),
      }),
    ),
  }),
);

describe("standard-mode policy", () => {
  const agentFacingText = [
    ["provider instructions", T3_CODE_ORCHESTRATION_INSTRUCTIONS],
    ["target options description", readRepoFile("packages/contracts/src/orchestratorMcp.ts")],
    [
      "delegate_task description",
      readRepoFile("apps/server/src/mcp/toolkits/orchestrator/tools.ts"),
    ],
  ];

  it.each(agentFacingText)("keeps %s in standard mode", (_name, source) => {
    const text = source.replace(/\\(["'])/g, "$1");
    expect(text).not.toMatch(/["']?fastMode["']?\s*:\s*true/);
    expect(text).not.toMatch(/["']?serviceTier["']?\s*:\s*["']priority["']/);
    expect(text).toContain("Standard mode only");
    expect(text).toContain("never fast mode");
  });

  it("keeps every vendored Codex model off priority by default", () => {
    const catalog = decodeCatalog(
      JSON.parse(readRepoFile("integrations/harness-homes/vendor/codex-models-0.166.0.json")),
    );

    expect(catalog.models.length).toBeGreaterThan(0);
    for (const model of catalog.models) {
      expect(model.default_service_tier, model.slug).not.toBe("priority");
    }
    for (const slug of ["gpt-6-sol", "gpt-6-luna"]) {
      expect(catalog.models.find((model) => model.slug === slug)?.default_service_tier).toBe(
        "default",
      );
    }
  });
});
