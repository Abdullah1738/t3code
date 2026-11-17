import { CommandId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

export function delegationTaskIdentity(taskId: string) {
  if (!taskId.startsWith("node:delegated-task:")) return undefined;
  let command = taskId.slice("node:delegated-task:".length);
  // Also read a copied id with one extra/missing encoding layer, for request-key recovery only.
  for (let depth = 0; depth <= 2; depth++) {
    const parts = command.split(":");
    // A decoded key can add fields or make a legacy operation look like a modern environment.
    const modern =
      parts.length === 6 && parts[2] === "delegate-task" && parts[3] !== "delegate-task";
    const legacy = parts.length === 5 && parts[3] === "delegate-task";
    if (parts[0] === "command" && parts[1] === "mcp" && (modern || legacy)) {
      try {
        const commandId = CommandId.make(command);
        const key = decodeURIComponent(parts[modern ? 5 : 4]!);
        return {
          commandId,
          key,
          environment: modern ? parts[3] : undefined,
          thread: modern ? parts[4] : undefined,
          canonical:
            IdAllocator.derive.delegatedTaskNode({ commandId }) === taskId &&
            parts[modern ? 5 : 4] === encodeURIComponent(key),
        };
      } catch {
        return undefined;
      }
    }
    try {
      command = decodeURIComponent(command);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function delegationIdShape(value: unknown) {
  if (typeof value !== "string") return "other";
  if (value.trim().length === 0) return "empty";
  if (delegationTaskIdentity(value) !== undefined) return "task_id";
  if (
    value.startsWith("thread:") ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
    return "thread_id";
  return "other";
}
