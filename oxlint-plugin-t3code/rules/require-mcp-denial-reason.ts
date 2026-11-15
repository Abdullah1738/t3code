import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";
import { getPropertyName, unwrapExpression } from "../utils.ts";

const failures = new Set(["OrchestratorMcpFailure", "WorktreeMcpFailure", "KanbanError"]);
const message = "MCP refusals need a fixed reason slug; keep message text separate.";

export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Require diagnostic reason slugs on MCP refusals." },
  },
  create(context) {
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(context.filename)) return {};
    const names = new Set(failures);
    return {
      ImportDeclaration(node) {
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") continue;
          const imported = Option.getOrUndefined(getPropertyName(specifier.imported));
          if (imported && failures.has(imported)) names.add(specifier.local.name);
        }
      },
      NewExpression(node) {
        const name = Option.getOrUndefined(
          getPropertyName(
            node.callee.type === "MemberExpression" ? node.callee.property : node.callee,
          ),
        );
        if (!name || !names.has(name)) return;
        const argument = Option.getOrUndefined(unwrapExpression(node.arguments[0]));
        if (argument?.type !== "ObjectExpression") return;
        const code = argument.properties.find(
          (prop) =>
            prop.type === "Property" && Option.getOrUndefined(getPropertyName(prop.key)) === "code",
        );
        if (!code || code.type !== "Property") return;
        const value = Option.getOrUndefined(unwrapExpression(code.value));
        const literal =
          value?.type === "Literal" && typeof value.value === "string" ? value.value : undefined;
        if (
          literal !== undefined &&
          literal !== "invalid_request" &&
          literal !== "denied" &&
          !literal.endsWith("_denied")
        )
          return;
        // DeadlineInput allows only caller_unresolved/delegation_timeout here.
        if (
          literal === undefined &&
          context.filename.replaceAll("\\", "/").endsWith("/mcp/McpDeadline.ts")
        )
          return;
        const reason = argument.properties.find(
          (prop) =>
            prop.type === "Property" &&
            Option.getOrUndefined(getPropertyName(prop.key)) === "reason",
        );
        const reasonValue =
          reason?.type === "Property"
            ? Option.getOrUndefined(unwrapExpression(reason.value))
            : undefined;
        if (!reason || (reasonValue?.type === "Identifier" && reasonValue.name === "undefined"))
          context.report({ node, message });
      },
      CallExpression(node) {
        const name = Option.getOrUndefined(
          getPropertyName(
            node.callee.type === "MemberExpression" ? node.callee.property : node.callee,
          ),
        );
        if (
          name === "failWith" &&
          context.filename.replaceAll("\\", "/").endsWith("/kanban/engine/KanbanService.ts")
        ) {
          const code = Option.getOrUndefined(unwrapExpression(node.arguments[0]));
          const literal = code?.type === "Literal" ? code.value : undefined;
          if ((literal === undefined || literal === "denied") && node.arguments.length < 3)
            context.report({ node, message });
        }
        if (
          context.filename.replaceAll("\\", "/").endsWith("/kanban/tools/handlers.ts") &&
          (name === "refuse" || name === "invalid") &&
          node.arguments.length < 2
        )
          context.report({ node, message });
      },
    };
  },
});
