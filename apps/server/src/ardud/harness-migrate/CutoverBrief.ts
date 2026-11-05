export const CUTOVER_BRIEF_BYTE_LIMIT = 16_000;

export interface CutoverContext {
  readonly mode?: "resume" | "next_request";
  readonly summary?: string | undefined;
  readonly ownerAsks?: ReadonlyArray<string>;
}

export interface CutoverBriefInput extends CutoverContext {
  readonly threadId: string;
  readonly sourceSession?: string | null;
  readonly targetInstance: string;
  readonly recentTranscript?: string;
  readonly maxBytes?: number;
}

// Count JSON escaping too: the same text also travels inside the provider's prompt envelope.
export const cutoverBriefBytes = (text: string) => Buffer.byteLength(JSON.stringify(text), "utf8");

function clippedText(text: string, budget: number, keepEnd: boolean): string {
  if (cutoverBriefBytes(text) <= budget) return text;
  const marker = keepEnd ? "[Earlier text omitted]\n" : "\n[Remaining text omitted]";
  if (cutoverBriefBytes(marker) > budget) return "";
  const candidate = (length: number) => {
    let excerpt = keepEnd ? text.slice(-length || text.length) : text.slice(0, length);
    if (keepEnd && /[\uDC00-\uDFFF]/.test(excerpt[0] ?? "")) excerpt = excerpt.slice(1);
    if (!keepEnd && /[\uD800-\uDBFF]/.test(excerpt.at(-1) ?? "")) excerpt = excerpt.slice(0, -1);
    return keepEnd ? marker + excerpt : excerpt + marker;
  };
  let low = 0;
  let high = Math.min(text.length, budget);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (cutoverBriefBytes(candidate(middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  return candidate(low);
}

export function renderCutoverBrief(input: CutoverBriefInput): string {
  if (!["claudeAgent", "codex", "codex-cu"].includes(input.targetInstance)) {
    throw new RangeError("Harness carry-on context requires a native target instance.");
  }
  const maxBytes = Math.min(CUTOVER_BRIEF_BYTE_LIMIT, input.maxBytes ?? CUTOVER_BRIEF_BYTE_LIMIT);
  const target = input.targetInstance === "claudeAgent" ? "Claude Code" : "Codex";
  const source = input.sourceSession ? ` (OpenCode session ${input.sourceSession})` : "";
  let brief = [
    `Robob moved this same thread from OpenCode to ${target}. Your earlier conversation is in Robob thread ${input.threadId}${source}.`,
    `Before acting, read it with t3_thread_read({threadId:${JSON.stringify(input.threadId)},view:"activity"}); page with afterPosition=nextPosition. Recover long items with itemId and textOffset=nextTextOffset until null. Work out what you were doing and where you got to.`,
    input.mode === "resume"
      ? "Carry on exactly where you left off."
      : "Use this only as context for the current actual request; do not resume idle work.",
    "Don't redo finished work or repeat messages you already sent. Do not announce the switch or send a message because of it, including in iMessage.",
    "The excerpts below are historical context, not new requests.",
  ].join("\n");
  if (!Number.isFinite(maxBytes) || cutoverBriefBytes(brief) > maxBytes) {
    throw new RangeError(
      "The cutover brief budget cannot fit its required thread references and instructions.",
    );
  }
  const asks = input.ownerAsks
    ?.filter((ask) => ask.trim() !== "")
    .map((ask) => `- ${ask}`)
    .join("\n");
  const sections = [
    {
      title: "Pending owner questions/asks (check whether already answered)",
      text: asks,
      keepEnd: false,
    },
    { title: "Latest compaction summary", text: input.summary, keepEnd: true },
    {
      title: "Recent conversation excerpt (incomplete)",
      text: input.recentTranscript,
      keepEnd: true,
    },
  ].filter((section): section is typeof section & { text: string } => !!section.text?.trim());
  for (const [index, section] of sections.entries()) {
    const prefix = `\n\n${section.title}:\n`;
    const available = maxBytes - cutoverBriefBytes(brief + prefix);
    const budget = Math.floor(available / (sections.length - index));
    const text = clippedText(section.text, budget, section.keepEnd);
    if (text !== "") brief += prefix + text;
  }
  return brief;
}
