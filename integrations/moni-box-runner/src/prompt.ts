import { textingStyle } from "../../spectrum-bridge/src/texting-style.ts";

/** The owner's 9 Oct 2026 iMessage personality rule, written for Moni's chat (owner, 23 Nov 2026). */
export const MONI_PERSONALITY = "Personality (owner's request, iMessage): be casual and friendly, like a real friend she talks to every day. Let a personality develop: humour, banter, your own takes, remembering her life and running jokes. Still be accurate and get things done, and switch to straight and serious for health, money or anything sensitive.";

/**
 * The box's systemFile stays the base (chat, permissions, isolation, moni-prefs); the shared
 * iMessage voice rules are appended at load so updates to them reach Moni on the next deploy.
 * The runner sends her final turn text as the reply, so the texting style is the final-mode one.
 */
export function moniSystemPrompt(base: string): string {
  return [base.trim(), MONI_PERSONALITY, textingStyle({ replyMode: "final" })].filter(Boolean).join("\n\n");
}
