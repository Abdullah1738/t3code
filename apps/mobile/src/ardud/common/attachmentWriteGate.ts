/**
 * A caller's own rule for attachment writes, asked immediately before each one.
 *
 * The upload helper checks that the connection may operate on the server. Some
 * callers have a stricter rule. An answer to an ask is the owner's alone, so
 * its files may be created, sent and deleted only while this phone is confirmed
 * as his over the connection that is up now (`writeBlocked` of the ask scope).
 * The helper asks the gate before an upload is created, before its bytes go,
 * and before every delete. The gate answers with the reason nothing may be
 * written, or null.
 *
 * A delete the gate refuses is not tried again: the upload is left for the
 * server, which drops one that no message or answer took.
 */
export type AttachmentWriteGate = () => string | null;

/** A write the gate stopped. Its message is the gate's reason. */
export class AttachmentWriteRefused extends Error {
  override readonly name = "AttachmentWriteRefused";
}

/** Throws `AttachmentWriteRefused` when the gate is closed. No gate, no rule. */
export function requireAttachmentWrite(gate: AttachmentWriteGate | undefined): void {
  const why = gate?.() ?? null;
  if (why !== null) throw new AttachmentWriteRefused(why);
}
