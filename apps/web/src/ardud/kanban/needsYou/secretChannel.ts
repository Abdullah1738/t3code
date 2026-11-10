/**
 * The one place a secret typed on an ask would leave the page. The server has
 * no private channel for ask secrets yet (it refuses secret fields when an ask
 * is created), so nothing is sent from here: the value is dropped and the
 * caller is told why. When the server gains the channel, this function is the
 * only thing that changes.
 */
export type AskSecretResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface AskSecretInput {
  readonly cardRef: string;
  readonly askId: string;
  readonly fieldId: string;
  readonly value: string;
}

export const ASK_SECRETS_AVAILABLE = false;

export async function submitAskSecret(_input: AskSecretInput): Promise<AskSecretResult> {
  return {
    ok: false,
    reason: "Not available in this build. Its agent has to ask through the private secret prompt.",
  };
}
