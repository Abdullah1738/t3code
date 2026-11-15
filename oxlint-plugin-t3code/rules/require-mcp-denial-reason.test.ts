import { describe } from "@effect/vitest";
import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/require-mcp-denial-reason", {
  filename: "apps/server/src/mcp/refusal.ts",
});
const engine = createOxlintRuleHarness("t3code/require-mcp-denial-reason", {
  filename: "apps/server/src/ardud/kanban/engine/KanbanService.ts",
});
const handlers = createOxlintRuleHarness("t3code/require-mcp-denial-reason", {
  filename: "apps/server/src/ardud/kanban/tools/handlers.ts",
});

describe("require-mcp-denial-reason", () => {
  rule.valid(
    "accepts fixed reasons and unrelated errors",
    `
    new OrchestratorMcpFailure({code: "invalid_request", reason: "invalid_args", message});
    new WorktreeMcpFailure({code: "capability_denied", reason: "capability_missing", message});
    new OrchestratorMcpFailure({code: "thread_not_found", message});
    new KanbanError({code: "denied", reason: "not_card_owner", detail});
    failWith("denied", detail, "card_settled");
  `,
  );
  rule.invalid(
    "rejects an omitted capability reason",
    `new OrchestratorMcpFailure({code: "capability_denied", message});`,
  );
  rule.invalid(
    "rejects an omitted invalid request reason",
    `new OrchestratorMcpFailure({code: "invalid_request", message});`,
  );
  rule.invalid(
    "rejects a missing suffix denial reason",
    `new OrchestratorMcpFailure({code: "runtime_mode_escalation_denied", message});`,
  );
  rule.invalid(
    "rejects undefined on a refusal",
    `new WorktreeMcpFailure({code: "capability_denied", reason: undefined, message});`,
  );
  rule.valid("ignores unrelated helpers", `failWith(error.reason, error); failWith(message);`);
  rule.invalid(
    "checks aliased imports",
    `import {OrchestratorMcpFailure as Failure} from "@t3tools/contracts"; new Failure({code: "capability_denied", message});`,
  );
  rule.invalid(
    "checks namespaced constructors",
    `new Contracts.OrchestratorMcpFailure({code: "capability_denied", message});`,
  );
  rule.invalid("checks generic factories", `new OrchestratorMcpFailure({code, message});`);
  rule.invalid("checks engine refusals", `new KanbanError({code: "denied", detail});`);
  engine.invalid(
    "checks literal and dynamic engine helper calls",
    `failWith("denied", detail); failWith(check.code, check.reason);`,
  );
  handlers.invalid("checks handler helpers", `refuse(message); invalid(message);`);
  handlers.valid(
    "allows explicit handler reasons",
    `refuse(message, "not_card_owner"); invalid(message, "invalid_args");`,
  );
});
