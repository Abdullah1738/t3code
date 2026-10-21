/**
 * Line events and backfill into per-chat stores. Access decisions happen here, before a
 * message reaches any chat's router. Dedupe is by Sendblue handle, so an overlapping backfill
 * after a reconnect never runs a message twice.
 */
import type { Access } from "./chats.ts";
import { decide } from "./access.ts";
import { chatKey, type ChatKey, type Line, type LineInbound } from "./line.ts";
import { inboundFromLine } from "./sb-transport.ts";
import type { Store } from "./store.ts";

/** Backfill overlaps the last event by this much so a message stamped during a reconnect is not missed. */
export const CURSOR_OVERLAP_MS = 2 * 60_000;
/** A typing-on older than this no longer counts as typing. */
export const TYPING_WINDOW_MS = 30_000;

export type IngressSink = {
  /** Store for an accepted chat. Creates the runtime lazily. */
  acceptInto: (chat: ChatKey, groupName: string | undefined, sender: string) => { accept: (input: unknown) => boolean };
  /** Typing state of one chat. */
  setTyping: (chat: ChatKey, from: string, on: boolean, at: number) => void;
  /** Telegram note for an unknown sender; deduped by the caller's key. */
  note: (address: string, text: string) => Promise<void>;
  /**
   * Unknown 1:1 sender (scoped third parties, guests.ts): answered by the scoped responder when
   * they hold a live grant, otherwise held and raised in the owner's chat. Returns whether it
   * took the message. Unset: the old Telegram note.
   */
  guest?: (message: LineInbound) => Promise<boolean>;
};

export type IngressDeps = {
  line: Line;
  owner: string;
  ownerStore: Store;
  access: () => Promise<Access>;
  sink: IngressSink;
  now?: () => number;
  log?: (event: string, code?: string) => void;
};

/** Handles one inbound message. Returns whether it was newly accepted. */
export async function handleInbound(deps: IngressDeps, message: LineInbound): Promise<boolean> {
  // Sendblue reports our own sends on the same stream; they are never input.
  if (!message.from || message.from === deps.line.number) return false;
  const access = await deps.access();
  const decision = decide(access, deps.owner, message.chat, message.from, message.participants);
  if (!decision.allowed) {
    if (decision.reason === "unknown-dm" && deps.sink.guest) return deps.sink.guest(message);
    await noteOnce(deps, decision.address, message);
    return false;
  }
  const target = deps.sink.acceptInto(message.chat, message.groupName, message.from);
  const accepted = target.accept(inboundFromLine(message));
  if (accepted) deps.sink.setTyping(message.chat, message.from, false, message.sentAt);
  return accepted;
}

async function noteOnce(deps: IngressDeps, address: string, message: LineInbound): Promise<void> {
  const key = `sb-note:${address}`;
  if (deps.ownerStore.get<boolean>(key)) return;
  deps.ownerStore.set(key, true);
  const who = message.groupName ? `group "${message.groupName}" (${address})` : address;
  const words = message.text.trim().slice(0, 80) || "(no text)";
  const allow = message.groupName || chatKey.isGroup(message.chat)
    ? `allow-group --id ${chatKey.target(message.chat)}`
    : `allow --address ${address} --name <name>`;
  await deps.sink.note(address, `iMessage from ${who}: "${words}". Allow them with: ${allow}`);
}

/** Applies events from one chat in order and tracks the cursor. */
export function handleTyping(deps: IngressDeps, event: { chat: ChatKey; from: string; typing: boolean; at: number }): void {
  deps.sink.setTyping(event.chat, event.from, event.typing, event.at);
}

/** Message stream: backfill, then live events, with backfill again after any drop. Stops when the signal aborts. */
export async function runIngress(deps: IngressDeps, signal: AbortSignal): Promise<void> {
  const now = deps.now ?? Date.now;
  let backoff = 2_000;
  while (!signal.aborted) {
    try {
      await backfill(deps, now);
      for await (const event of deps.line.events(signal)) {
        if (signal.aborted) break;
        if (event.type === "message") {
          // The live stream sends only ids for a received message; the full row comes from the message list.
          if (!event.message.from) {
            await backfill(deps, now).catch(() => deps.log?.("ingress-backfill-failed"));
            continue;
          }
          await handleInbound(deps, event.message).catch(() => deps.log?.("ingress-message-failed"));
          advanceCursor(deps.ownerStore, event.message.sentAt);
        } else if (event.type === "typing") {
          handleTyping(deps, event);
        }
      }
      backoff = 2_000;
    } catch (error) {
      deps.log?.("ingress-unavailable", (error as { code?: string })?.code ?? "operationFailed");
      await sleep(backoff, signal);
      backoff = Math.min(60_000, backoff * 2);
    }
  }
}

export async function backfill(deps: IngressDeps, now: () => number): Promise<number> {
  const cursor = deps.ownerStore.get<number>("sendblueCursor") ?? now() - CURSOR_OVERLAP_MS;
  const messages = await deps.line.backfill(Math.max(0, cursor - CURSOR_OVERLAP_MS));
  for (const message of messages) {
    await handleInbound(deps, message).catch(() => deps.log?.("ingress-backfill-failed"));
    advanceCursor(deps.ownerStore, message.sentAt);
  }
  return messages.length;
}

function advanceCursor(store: Store, sentAt: number): void {
  const current = store.get<number>("sendblueCursor") ?? 0;
  if (sentAt > current) store.set("sendblueCursor", sentAt);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
