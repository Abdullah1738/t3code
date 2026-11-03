import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import { componentSpec } from "./components.ts";

it("grants harness hooks the scopes needed for identity reads and desktop lease calls", () => {
  expect(componentSpec("harness-hooks")?.scopes).toEqual([
    AuthOrchestrationReadScope,
    AuthOrchestrationOperateScope,
  ]);
});
