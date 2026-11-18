import { McpReasonClass, type KanbanError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";
import type * as SchemaIssue from "effect/SchemaIssue";

export const isReasonClass = Schema.is(McpReasonClass);

export const kanbanReasonClass = (code: KanbanError["code"], reason?: string): McpReasonClass =>
  reason === "stage_not_allowed" || reason === "transition_not_allowed"
    ? "stage_not_allowed"
    : reason === "wiki_section_unknown"
      ? "not_found"
      : code === "not-found"
        ? "not_found"
        : code === "conflict"
          ? "conflict"
          : code === "failed"
            ? "operation_failed"
            : code === "denied"
              ? "not_allowed"
              : "other";

// Traverse only issue metadata. Inputs and human-readable error messages never become labels.
export function schemaReason(issue: SchemaIssue.Issue): {
  reasonClass: McpReasonClass;
  invalidField?: string;
} {
  let field: string | undefined;
  let node = issue;
  let ast: SchemaAST.AST | undefined;
  for (let depth = 0; depth < 64; depth++) {
    if (node._tag === "Pointer") {
      if (field === undefined && typeof node.path[0] === "string") field = node.path[0];
      for (const key of node.path) {
        ast =
          ast?._tag === "Objects"
            ? ast.propertySignatures.find((property) => property.name === key)?.type
            : undefined;
      }
      node = node.issue;
    } else if (node._tag === "Composite") {
      ast = node.ast;
      node = node.issues[0];
    } else if (node._tag === "Filter") {
      const representation = node.filter.annotations?.representation;
      if (
        representation?.id === "effect/schema/isMaxLength" ||
        representation?.id === "effect/schema/isMaxSize"
      )
        return {
          reasonClass:
            ast?._tag === "Arrays" || representation.id === "effect/schema/isMaxSize"
              ? "too_many"
              : "too_long",
          ...(field === undefined ? {} : { invalidField: field }),
        };
      node = node.issue;
    } else if (node._tag === "Encoding") node = node.issue;
    else if (
      node._tag === "AnyOf" &&
      !node.ast.types.every(
        (member) =>
          member._tag === "Literal" || member._tag === "Null" || member._tag === "Undefined",
      )
    ) {
      if (node.issues.length === 0) break;
      node = node.issues[0]!;
    } else {
      const reasonClass =
        node._tag === "MissingKey"
          ? "missing_required"
          : node._tag === "AnyOf" || (node._tag === "InvalidType" && node.ast._tag === "Literal")
            ? "bad_enum"
            : "bad_type";
      return { reasonClass, ...(field === undefined ? {} : { invalidField: field }) };
    }
  }
  return { reasonClass: "bad_type", ...(field === undefined ? {} : { invalidField: field }) };
}
