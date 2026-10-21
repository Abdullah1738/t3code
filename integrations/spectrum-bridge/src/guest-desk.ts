/**
 * Glue for scoped third parties: decides what happens to an unknown 1:1 sender, and runs the
 * owner-only grant, revoke, send and share routes. Approval needs evidence the bridge checks
 * itself: an outgoing message from the owner to that exact person (msgs archive), or a message
 * the owner typed to this line. A stranger's own words never count.
 */
import { createHash } from "node:crypto";
import { contactName, findEvidence, namesLine, verifyArchiveEvidence } from "./guest-evidence.ts";
import type { GuestResponder } from "./guest-responder.ts";
import { parseProviderSpec, PROVIDER_KINDS, PROVIDERS, type ProviderDeps, type ProviderSpec } from "./guest-providers.ts";
import {
  grantNotice, holdMessage, MAX_GRANT_MS, normalizeAddress, OWNER_WAKE_EVERY_MS, parseExpiry, peekHeld, takeHeld,
  unknownSenderWake, type GuestBook, type GuestEvidence, type GuestFact, type GuestGrant,
} from "./guests.ts";
import { chatKey, type Line, type LineInbound } from "./line.ts";
import type { NormalizedInbound } from "./photon.ts";
import type { Store } from "./store.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/** Unknown-sender wakes into the owner chat per hour, across everyone; past it they wait. */
const MAX_WAKES_PER_HOUR = 6;
const MAX_FACTS = 8;
const MAX_EVIDENCE = 4;
/** Fact values must appear in the owner's own words; spacing and case don't matter. */
const squash = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

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
  /** Flighty and calendar access for provider checks at grant time. */
  providerDeps?: Omit<ProviderDeps, "now">;
};

export type AllowInput = {
  address: string; name: string; purpose: string;
  /** "meeting", "flight-status:EK57", ...; the old --action names are the same strings. */
  providers: string[];
  /** "key=value", each value found in the owner's evidence. */
  facts?: string[];
  expires?: string;
  /** One or more refs; the first is the main one. */
  evidence: string | string[];
};
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
    const parsed = input.providers.map(parseProviderSpec);
    if (parsed.some(spec => !spec)) return { status: 400, body: { error: `Providers: ${PROVIDER_KINDS.join(", ")} (flight ones take :EK57 or :EK57@YYYY-MM-DD)` } };
    // Implied providers come along, and the first mention of a kind wins.
    const byKind = new Map<string, ProviderSpec>();
    for (const spec of parsed as ProviderSpec[]) if (!byKind.has(spec.kind)) byKind.set(spec.kind, spec);
    for (const spec of [...byKind.values()]) for (const kind of PROVIDERS[spec.kind].implies ?? []) {
      if (!byKind.has(kind)) byKind.set(kind, { kind, ...(spec.arg && kind.startsWith("flight") ? { arg: spec.arg } : {}) });
    }
    const refs = (Array.isArray(input.evidence) ? input.evidence : [input.evidence]).map(ref => ref.trim()).filter(Boolean);
    if (!refs.length || refs.length > MAX_EVIDENCE) return { status: 400, body: { error: `1-${MAX_EVIDENCE} --evidence refs` } };
    const evidence: GuestEvidence[] = [];
    for (const ref of refs) {
      const found = this.evidence(ref, address);
      if (!found) {
        this.deps.book.audit(address, "grant-refused", { evidence: ref.slice(0, 80) });
        return { status: 403, body: { error: `Evidence ${ref.slice(0, 40)} not accepted: it must be an outgoing message from the owner to this exact person that mentions this line or Robob (msgs:<id>), or a message the owner typed here (owner:<message id>). Ask the owner.` } };
      }
      if (!evidence.some(entry => entry.ref === found.ref)) evidence.push(found);
    }
    const words = (archiveOnly: boolean) => evidence.filter(entry => !archiveOnly || entry.ref.startsWith("msgs:")).map(entry => entry.snippet);
    for (const spec of byKind.values()) {
      const provider = PROVIDERS[spec.kind];
      if (!provider.ownerWords) continue;
      const pool = words(!!provider.ownerWordsArchiveOnly);
      // Archive-only checks pass when there is no archive evidence at all (the owner typed it to the line).
      if (provider.ownerWordsArchiveOnly && !pool.length) continue;
      if (!pool.some(text => provider.ownerWords!.test(text))) {
        return { status: 403, body: { error: `${spec.kind} needs the owner's own words to ask for it; his messages don't. Grant less, or ask him.` } };
      }
    }
    const facts: GuestFact[] = [];
    for (const raw of input.facts ?? []) {
      const at = raw.indexOf("=");
      const key = raw.slice(0, at).trim();
      const value = raw.slice(at + 1).trim();
      if (at < 1 || !/^[\w .'-]{1,40}$/.test(key) || !value || value.length > 300) return { status: 400, body: { error: "Facts look like \"gate code=4821\"" } };
      if (!evidence.some(entry => squash(entry.snippet).includes(squash(value)))) {
        this.deps.book.audit(address, "grant-refused", { fact: key });
        return { status: 403, body: { error: `Fact "${key}" isn't in the owner's evidence messages word for word. Only values he gave can be shared; ask him and cite his message.` } };
      }
      facts.push({ key, value });
    }
    if (facts.length > MAX_FACTS) return { status: 400, body: { error: `At most ${MAX_FACTS} facts` } };
    let pinnedEnd: number | undefined;
    const providers: ProviderSpec[] = [];
    for (const spec of byKind.values()) {
      const resolved = PROVIDERS[spec.kind].resolve?.(spec.arg, { ...this.deps.providerDeps, timezone: this.deps.providerDeps?.timezone ?? "Asia/Dubai", now: this.now });
      if (resolved && "error" in resolved) return { status: 409, body: { error: resolved.error } };
      providers.push({ kind: spec.kind, ...(resolved?.arg ?? spec.arg ? { arg: resolved?.arg ?? spec.arg } : {}) });
      if (resolved?.expiresAt) pinnedEnd = Math.max(pinnedEnd ?? 0, resolved.expiresAt);
    }
    let expiresAt: number;
    try {
      expiresAt = input.expires === undefined && pinnedEnd ? Math.min(pinnedEnd, this.now() + MAX_GRANT_MS) : parseExpiry(input.expires, this.now());
    } catch { return { status: 400, body: { error: "Expiry like 48h, 7d or 2w, at most 30 days" } }; }
    if (expiresAt <= this.now()) return { status: 409, body: { error: "That flight is already over" } };
    const grant: GuestGrant = {
      address, name: input.name.trim(), purpose: input.purpose.trim(), providers, facts,
      createdAt: this.now(), expiresAt, evidence,
    };
    this.deps.book.grant(grant);
    this.deps.tellOwner(grantNotice(grant), `guest-grant:${hash(`${address}:${grant.createdAt}`)}`);
    const held = takeHeld(this.deps.ownerStore, address);
    if (held.length) void this.deps.responder.handle(grant, held);
    return { status: 200, body: {
      granted: true, address, purpose: grant.purpose, providers: providers.map(spec => spec.arg ? `${spec.kind}:${spec.arg}` : spec.kind),
      facts: facts.map(fact => fact.key), expiresAt: new Date(expiresAt).toISOString(), released: held.length,
    } };
  }

  revoke(address: string): DeskResult {
    const changed = this.deps.book.revoke(address.trim());
    return { status: changed ? 200 : 404, body: { revoked: changed } };
  }

  list(): DeskResult {
    const now = this.now();
    return { status: 200, body: { guests: this.deps.book.list().map(grant => ({
      address: grant.address, name: grant.name, purpose: grant.purpose,
      providers: grant.providers.map(spec => spec.arg ? `${spec.kind}:${spec.arg}` : spec.kind), facts: grant.facts.map(fact => fact.key),
      expiresAt: new Date(grant.expiresAt).toISOString(), evidence: grant.evidence.map(entry => entry.ref),
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
