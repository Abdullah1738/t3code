import {
  effortOptionId,
  mergeSelection,
  resolveSelection,
  splitLegacySuffix,
} from "@t3tools/client-runtime/ardud/models/harnessRouting";
import type { ModelSelection } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** Resolve script inputs using the same implementation bundled into this server. */
export function resolveScriptSelection(selection: ModelSelection) {
  const merged = mergeSelection(selection, {});
  if (merged.kind === "conflict") return merged;
  const resolved = resolveSelection(merged.selection);
  if (resolved.kind === "conflict") return resolved;
  const current = resolved.selection;
  const split = splitLegacySuffix(current.model);
  if (split.effort === null) return { kind: "selection" as const, selection: current };
  const ids = ["variant", effortOptionId(current.instanceId)];
  if (
    (current.options ?? []).some(
      (option) => ids.includes(option.id) && option.value !== split.effort,
    )
  ) {
    return {
      kind: "conflict" as const,
      reason: `${current.model} conflicts with its effort option`,
    };
  }
  return mergeSelection({ ...current, model: split.model }, { variant: split.effort });
}

/** Hidden CLI fast path: no server startup, credentials or live state. */
export async function runSelectionBridge() {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 1024 * 1024) throw new Error("Selection input exceeds 1 MiB");
    chunks.push(bytes);
  }
  const { ModelSelection: Selection } = await import("@t3tools/contracts");
  const input = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Selection)))(
    Buffer.concat(chunks).toString("utf8"),
  );
  if (input.length > 4096) throw new Error("Too many selections");
  const results = input.map(resolveScriptSelection);
  process.stdout.write(`${Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(results)}\n`);
}
