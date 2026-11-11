/**
 * Which listed sessions are paired devices, and which of those the server
 * says are not the owner's. A device is the owner's when the link it was
 * paired from was made by an owner session (the desktop app, or Settings >
 * Connections on an owner device); a link made on the Mac's command line
 * pairs a device that is not.
 */

/**
 * Subjects of sessions minted from a pairing link (`t3 pair`, `t3 auth pairing
 * create`, the startup link, a link made in an app). `t3 auth session issue`
 * refuses them, so a hand-issued token never reads as a paired device.
 */
const PAIRED_DEVICE_SUBJECTS: ReadonlySet<string> = new Set([
  "one-time-token",
  "administrative-bootstrap",
]);

export const isPairedDeviceSubject = (subject: string): boolean =>
  PAIRED_DEVICE_SUBJECTS.has(subject);

/**
 * True for a paired device the server says is not the owner's. A session
 * whose standing is not known (an older server, a list entry that came
 * without it) is not flagged, and neither is a component's or a token's.
 */
export const isDeviceNotPairedAsOwner = (session: {
  readonly subject: string;
  readonly owner?: boolean | undefined;
}): boolean => session.owner === false && isPairedDeviceSubject(session.subject);
