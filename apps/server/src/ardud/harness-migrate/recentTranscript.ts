import type {
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  RunId,
  ServerSettings,
} from "@t3tools/contracts";

export const TRANSCRIPT_ITEM_LIMIT = 64;
export const TRANSCRIPT_MESSAGE_BYTES = 8_000;

export function recentTranscriptEnabled(
  settings: Pick<ServerSettings, "ardudHarnessMigration">,
  targetInstanceId: string,
) {
  return (
    settings.ardudHarnessMigration?.transcript?.enabled === true &&
    ["claudeAgent", "codex", "codex-cu"].includes(targetInstanceId)
  );
}

export function recentTranscriptRunIds(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal" | "status">>,
  candidates: ReadonlyArray<RunId | null> | undefined,
  lastTurns = 8,
): ReadonlyArray<RunId | null> {
  const allowed = candidates === undefined ? null : new Set(candidates);
  const selected = runs
    .filter((run) => run.status !== "queued" && (allowed === null || allowed.has(run.id)))
    .toSorted((a, b) => a.ordinal - b.ordinal)
    .slice(-lastTurns)
    .map((run) => run.id);
  // Imported history has no run ids. The projection read is still row-bounded.
  return selected.length > 0 ? selected : allowed?.has(null) ? [null] : [];
}

export function compactTranscriptItems(items: ReadonlyArray<OrchestrationV2TurnItem>) {
  return items.flatMap((item) => {
    if (item.type !== "user_message" && item.type !== "assistant_message") return [];
    const bytes = Buffer.from(item.text);
    if (bytes.length <= TRANSCRIPT_MESSAGE_BYTES) return [item];
    let start = bytes.length - TRANSCRIPT_MESSAGE_BYTES;
    while ((bytes[start]! & 0xc0) === 0x80) start++;
    return [{ ...item, text: `[Earlier text omitted]\n${bytes.subarray(start).toString("utf8")}` }];
  });
}
