/**
 * Channel guidance rides beside a relayed message instead of inside it. The
 * iMessage bridge sends the owner's exact words as the message text and its
 * own guidance (reply ids, quoted context, channel rules) separately; the
 * server keeps the guidance as a context record on the message, so the
 * stored text is only what he typed, and adds it back, framed as not his,
 * when the message goes to the provider.
 */
import { ComposerContextId, type OrchestrationMessageContext } from "@t3tools/contracts";

import type { OriginSession } from "../auth/provenance.ts";

export const GUIDANCE_KIND = "ardud-guidance";
const GUIDANCE_START = "[Channel guidance from the iMessage bridge, not typed by the owner]";
const GUIDANCE_END = "[End of channel guidance. The owner's message follows.]";

/**
 * The most a context record's payload holds once encoded. Past it the record
 * would be dropped on decode, so a longer guidance is refused instead.
 */
export const GUIDANCE_MAX_CHARS = 64_000;

/** Whether the guidance fits in its context record. */
export const guidanceFits = (guidance: string) =>
  JSON.stringify({ text: guidance.trim() }).length <= GUIDANCE_MAX_CHARS;

/** The message context carrying a sender's channel guidance, or none when it is blank. */
export const guidanceContext = (
  guidance: string | undefined,
): OrchestrationMessageContext | undefined => {
  const text = guidance?.trim() ?? "";
  if (text.length === 0) return undefined;
  return {
    version: 1,
    records: [
      {
        version: 1,
        contextId: ComposerContextId.make(GUIDANCE_KIND),
        label: "Channel guidance",
        kind: GUIDANCE_KIND,
        payload: { text },
      },
    ],
  };
};

/** The guidance a message carries, if any. */
export const guidanceOf = (context: OrchestrationMessageContext | undefined): string | null => {
  for (const record of context?.records ?? []) {
    if (record.kind !== GUIDANCE_KIND || !("payload" in record)) continue;
    const payload = record.payload as { readonly text?: unknown } | null;
    if (typeof payload?.text === "string" && payload.text.trim().length > 0) {
      return payload.text.trim();
    }
  }
  return null;
};

/** The provider's view of a message: its guidance, framed as the bridge's, then the text. */
export const withChannelGuidance = (
  context: OrchestrationMessageContext | undefined,
  text: string,
): string => {
  const guidance = guidanceOf(context);
  return guidance === null ? text : `${GUIDANCE_START}\n${guidance}\n${GUIDANCE_END}\n\n${text}`;
};

/** The component credential the iMessage bridge runs as (`auth/components.ts`). */
const IMESSAGE_BRIDGE = "spectrum-bridge";

/** Whether a control session is the iMessage bridge. */
export const isBridgeSession = (session: OriginSession) =>
  session.origin?._tag === "component" && session.origin.component === IMESSAGE_BRIDGE;
