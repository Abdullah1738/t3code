/**
 * Glue for scoped third parties: decides what happens to an unknown 1:1 sender, and runs the
 * owner-only grant, revoke, send and share routes. Approval needs evidence the bridge checks
 * itself: an outgoing message from the owner to that exact person (msgs archive), or a message
 * the owner typed to this line. A stranger's own words never count.
 */
import { createHash } from "node:crypto";
import { contactName, findEvidence, namesLine, verifyArchiveEvidence } from "./guest-evidence.ts";
import type { GuestResponder } from "./guest-responder.ts";
import {
  GUEST_ACTIONS, grantNotice, holdMessage, normalizeAddress, OWNER_WAKE_EVERY_MS, parseExpiry, peekHeld, takeHeld,
  unknownSenderWake, type GuestAction, type GuestBook, type GuestEvidence, type GuestGrant,
} from "./guests.ts";
import { chatKey, type Line, type LineInbound } from "./line.ts";
import type { NormalizedInbound } from "./photon.ts";
import type { Store } from "./store.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/** Unknown-sender wakes into the owner chat per hour, across everyone; past it they wait. */
const MAX_WAKES_PER_HOUR = 6;
/** Calendar writes need the owner to have said so in calendar words; "book a meeting" alone is not enough. */
const HOLD_WORDS = /\b(calendar|put (it|that|them) in|(add|block|hold) (it|that|the time|time)|send (an|the) invite)\b/i;

export type GuestDeskDeps = {
  book: GuestBook;
  responder: GuestResponder;
  ownerStore: Store;
  owner: string;
  lineNumber: string;
  sendText: Line["sendText"];
  shareContact?: (address: string) => Promise<unknown>;
  wakeOwner: (text: string, key: string) => void;
  tellOwner: (text: string, key: string) => void;
  /** Telegram fallback when the owner chat's wake budget is used up. */
  note?: (address: string, text: string) => Promise<void>;
  findEvidence?: typeof findEvidence;
  verifyArchiveEvidence?: typeof verifyArchiveEvidence;
  contactName?: typeof contactName;
  now?: () => number;
  log?: (event: string, code?: string) => void;
};

export type AllowInput = { address: string; name: string; purpose: string; actions: string[]; expires?: string; evidence: string };
export type DeskResult = { status: number; body: Record<string, unknown> };

const validAddress = (address: string) => /^\+[1-9]\d{6,14}$/.test(address) || /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(address);

export class GuestDesk {
  private readonly now: () => number;

  constructor(private readonly deps: GuestDeskDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Ingress hook for an unknown 1:1 sender. True when the message was taken (answered or held). */
  async unknown(message: LineInbound): Promise<boolean> {
    const { book, ownerStore } = this.deps;
    const address = message.from;
    if (normalizeAddress(address) === normalizeAddress(this.deps.owner)) return false;
    const grant = book.active(address);
    if (grant) {
      void this.deps.responder.handle(grant, [message]);
      return true;
    }
    const before = peekHeld(ownerStore, address).length;
    if (peekHeld(ownerStore, address).some(entry => entry.handle === message.handle)) return false;
    holdMessage(ownerStore, message);
    book.audit(address, "held", { handle: message.handle, chars: message.text.length });
    const key = normalizeAddress(address);
    const lastWake = ownerStore.get<number>(`guest-woke:${key}`) ?? 0;
    if (before > 0 && this.now() - lastWake < OWNER_WAKE_EVERY_MS) return true;
    const hour = (ownerStore.get<number[]>("guest-wakes") ?? []).filter(at => this.now() - at < 60 * 60_000);
    if (hour.length >= MAX_WAKES_PER_HOUR) {
      book.audit(address, "wake-throttled");
      await this.deps.note?.(address, `Unknown sender ${address} texted Robob; held, not answered (too many unknown senders this hour).`).catch(() => {});
      return true;
    }
    ownerStore.set("guest-wakes", [...hour, this.now()]);
    ownerStore.set(`guest-woke:${key}`, this.now());
    const evidence = (this.deps.findEvidence ?? findEvidence)(address, this.deps.lineNumber, this.now());
    const contact = (this.deps.contactName ?? contactName)(address);
    const latest = book.latest(address);
    const text = unknownSenderWake({
      address, held: peekHeld(ownerStore, address), evidence, lineNumber: this.deps.lineNumber,
      ...(contact && contact !== "unavailable" ? { contactName: contact } : {}),
      ...(latest ? { expired: latest } : {}),
    });
    book.audit(address, "owner-asked", { evidence: evidence === "unavailable" ? "unavailable" : evidence.map(entry => entry.ref), contact: contact === "unavailable" ? "unavailable" : !!contact });
    this.deps.wakeOwner(contact === "unavailable" ? `${text}\nContacts could not be read; say so if you ask the owner.` : text, `guest-unknown:${key}:${message.handle}`);
    return true;
  }

  /** Checks evidence in code; the agent's say-so is never enough. */
  private evidence(ref: string, address: string): GuestEvidence | undefined {
    if (ref.startsWith("msgs:")) {
      const found = (this.deps.verifyArchiveEvidence ?? verifyArchiveEvidence)(ref, address);
      if (!found || !namesLine(found.snippet, this.deps.lineNumber)) return undefined;
      return { ref, source: found.source, at: found.at, snippet: found.snippet };
    }
    const match = /^owner:(.{1,200})$/.exec(ref);
    if (!match || /^(?:wake|secret|reset|send|guest):/.test(match[1]!)) return undefined;
    const row = this.deps.ownerStore.db.query<{ payload: string }, [string]>("SELECT payload FROM inbound WHERE id = ?").get(match[1]!);
    if (!row) return undefined;
    const payload = JSON.parse(row.payload) as NormalizedInbound;
    // Only something the owner himself typed to the line: not a wake, a vote or a transcription.
    if (payload.source !== "typed" || (payload.sender !== undefined && normalizeAddress(payload.sender) !== normalizeAddress(this.deps.owner))) return undefined;
    return { ref, source: "owner-chat", at: payload.receivedAt ?? this.now(), snippet: payload.text.slice(0, 600) };
  }

  allow(input: AllowInput): DeskResult {
    const address = input.address.trim();
    if (!validAddress(address)) return { status: 400, body: { error: "Address must be E.164 or an email" } };
    if (normalizeAddress(address) === normalizeAddress(this.deps.owner)) return { status: 400, body: { error: "That is the owner" } };
    const actions = [...new Set(input.actions)];
    if (actions.some(action => !(GUEST_ACTIONS as readonly string[]).includes(action))) return { status: 400, body: { error: `Actions: ${GUEST_ACTIONS.join(", ")}` } };
    if (actions.includes("create-hold") && !actions.includes("meeting")) return { status: 400, body: { error: "create-hold needs meeting" } };
    let expiresAt: number;
    try { expiresAt = parseExpiry(input.expires, this.now()); } catch { return { status: 400, body: { error: "Expiry like 48h, 7d or 2w, at most 30 days" } }; }
    const evidence = this.evidence(input.evidence.trim(), address);
    if (!evidence) {
      this.deps.book.audit(address, "grant-refused", { evidence: input.evidence.slice(0, 80) });
      return { status: 403, body: { error: "Evidence not accepted: it must be an outgoing message from the owner to this exact person that mentions this line or Robob (msgs:<id>), or a message the owner typed here (owner:<message id>). Ask the owner." } };
    }
    if (actions.includes("create-hold") && evidence.ref.startsWith("msgs:") && !HOLD_WORDS.test(evidence.snippet)) {
      return { status: 403, body: { error: "create-hold needs the owner to have said to book it; his message doesn't. Grant meeting only, or ask him." } };
    }
    const grant: GuestGrant = {
      address, name: input.name.trim(), purpose: input.purpose.trim(), actions: actions as GuestAction[],
      createdAt: this.now(), expiresAt, evidence,
    };
    this.deps.book.grant(grant);
    this.deps.tellOwner(grantNotice(grant), `guest-grant:${hash(`${address}:${grant.createdAt}`)}`);
    const held = takeHeld(this.deps.ownerStore, address);
    if (held.length) void this.deps.responder.handle(grant, held);
    return { status: 200, body: { granted: true, address, purpose: grant.purpose, actions: grant.actions, expiresAt: new Date(expiresAt).toISOString(), released: held.length } };
  }

  revoke(address: string): DeskResult {
    const changed = this.deps.book.revoke(address.trim());
    return { status: changed ? 200 : 404, body: { revoked: changed } };
  }

  list(): DeskResult {
    const now = this.now();
    return { status: 200, body: { guests: this.deps.book.list().map(grant => ({
      address: grant.address, name: grant.name, purpose: grant.purpose, actions: grant.actions,
      expiresAt: new Date(grant.expiresAt).toISOString(), evidence: grant.evidence.ref,
      state: grant.revokedAt ? "revoked" : grant.expiresAt <= now ? "expired" : "active",
    })) } };
  }

  /** The owner's own words to a third party, relayed by his agent. Only to someone who texted the line. */
  async send(address: string, text: string, key: string): Promise<DeskResult> {
    const target = address.trim();
    const known = !!this.deps.book.latest(target) || peekHeld(this.deps.ownerStore, target).length > 0;
    if (!known) return { status: 404, body: { error: "This person hasn't texted the line" } };
    const sentKey = `guest-send:${hash(`${normalizeAddress(target)}:${key}`)}`;
    if (this.deps.ownerStore.get(sentKey)) return { status: 200, body: { sent: true, created: false } };
    this.deps.ownerStore.set(sentKey, true);
    await this.deps.sendText(chatKey.dm(target), text);
    this.deps.responder.noteOwnerSent(target, text);
    this.deps.book.audit(target, "owner-sent", { chars: text.length });
    return { status: 202, body: { sent: true, created: true } };
  }

  async share(address: string): Promise<DeskResult> {
    if (!this.deps.shareContact) return { status: 503, body: { error: "Contact sharing unavailable" } };
    return { status: 200, body: { result: await this.deps.shareContact(address.trim()) } };
  }
}
