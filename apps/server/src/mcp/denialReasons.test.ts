// @effect-diagnostics nodeBuiltinImport:off -- The schema vocabulary is source metadata, never runtime state.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

it("reason codes stay short, fixed and unique", () => {
  const source = NodeFS.readFileSync(
    NodePath.resolve(
      import.meta.dirname,
      "../../../../packages/contracts/src/ardud/mcpDenyReason.ts",
    ),
    "utf8",
  );
  const reasons = [...source.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]!);
  expect(reasons.length).toBeGreaterThan(0);
  expect(new Set(reasons).size).toBe(reasons.length);
  for (const reason of reasons) expect(reason.length).toBeLessThanOrEqual(48);
});
