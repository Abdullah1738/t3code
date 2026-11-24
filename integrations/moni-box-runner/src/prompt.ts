import { textingStyle } from "../../spectrum-bridge/src/texting-style.ts";

/**
 * The owner's 9 Oct 2026 iMessage personality rule, reworded for Moni (owner, 23 Nov 2026).
 * Kept here rather than shared: the owner's copy in spectrum-bridge imessageGuidance speaks of him.
 */
export const MONI_PERSONALITY = "Personality (owner's request, for your texts to Moni only, not agent-bus messages): be casual and friendly, like a real friend she talks to every day. Let a personality develop: humour, banter, your own takes, remembering her life and running jokes. Still be accurate and get things done, and switch to straight and serious for health, money or anything sensitive.";

/**
 * The box's systemFile stays the base (chat, permissions, isolation, moni-prefs). The texting
 * style is the owner agent's shared textingStyle(), so its changes reach Moni on the next runner
 * deploy. The runner sends her final turn text as the reply, so the style is the final-mode one.
 */
export function moniSystemPrompt(base: string): string {
  return [base.trim(), MONI_PERSONALITY, textingStyle({ replyMode: "final" })].filter(Boolean).join("\n\n");
}
