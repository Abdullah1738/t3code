/**
 * Sendblue-mode routes that the per-chat API can't express: location, owner approvals and
 * access edits. The session that calls them decides the chat; only the owner chat may approve
 * or message other chats.
 */
import { writeFile, rename } from "node:fs/promises";
import { chatKey, type Line } from "./line.ts";
import type { Access, ChatInfo } from "./chats.ts";
import { loadAccess } from "./access.ts";

export type SbApiDeps = {
  line: Line;
  /** Resolves a route id (session) to the chat it belongs to. */
  chatForSession: (sessionId: string) => ChatInfo | undefined;
  owner: ChatInfo | undefined;
  accessPath: string;
  /** Queues a wake (text) into the owner chat for the owner's agent. */
  wakeOwner: (text: string, dedupeKey: string) => void;
};

export type SbApiResult = { status: number; body: unknown };

export async function locationRequest(deps: SbApiDeps, sessionId: string): Promise<SbApiResult> {
  const chat = deps.chatForSession(sessionId);
  if (!chat) return { status: 409, body: { error: "No chat for this session" } };
  if (chat.kind !== "dm") return { status: 400, body: { error: "Location requests are for 1:1 chats" } };
  await deps.line.requestLocation(chat.key);
  return { status: 202, body: { requested: true } };
}

/** Latest shared location for the chat's person, or "none". */
export async function location(deps: SbApiDeps, sessionId: string): Promise<SbApiResult> {
  const chat = deps.chatForSession(sessionId);
  if (!chat) return { status: 409, body: { error: "No chat for this session" } };
  if (chat.kind !== "dm") return { status: 400, body: { error: "Locations are for 1:1 chats" } };
  const address = chatKey.target(chat.key);
  const fix = await deps.line.location(address);
  return { status: 200, body: fix ? { latitude: fix.latitude, longitude: fix.longitude, accuracy: fix.accuracy, at: fix.at } : { location: "none" } };
}

/** Guests asking the owner something: the question lands in the owner chat as a wake, prefixed with the source chat. */
export function askOwner(deps: SbApiDeps, sessionId: string, text: string, key: string): SbApiResult {
  const chat = deps.chatForSession(sessionId);
  if (!chat) return { status: 409, body: { error: "No chat for this session" } };
  if (!deps.owner) return { status: 503, body: { error: "Owner chat not ready" } };
  if (chat.kind === "owner") return { status: 400, body: { error: "The owner chat does not ask itself" } };
  deps.wakeOwner(`[From ${chat.title}] ${text}`, `ask-owner:${chat.slug}:${key}`);
  return { status: 202, body: { queued: true } };
}

export type AccessEdit =
  | { type: "allow"; address: string; name: string; admin: boolean }
  | { type: "allow-group"; id: string; name?: string };

/** Owner session or a local shell only; the caller enforces that before this is reached. */
export async function editAccess(deps: SbApiDeps, edit: AccessEdit): Promise<SbApiResult> {
  const access = await loadAccess(deps.accessPath);
  const next = applyEdit(access, edit);
  const tmp = `${deps.accessPath}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, deps.accessPath);
  return { status: 200, body: { saved: true } };
}

/** Pure edit so it can be tested without touching disk. */
export function applyEdit(access: Access, edit: AccessEdit): Access {
  if (edit.type === "allow-group") {
    const groups = access.groups.filter(group => group.id !== edit.id);
    return { ...access, groups: [...groups, { id: edit.id, ...(edit.name ? { name: edit.name } : {}) }] };
  }
  const address = edit.address.trim();
  const people = access.people.map(person => ({ ...person, addresses: person.addresses.filter(entry => entry.toLowerCase() !== address.toLowerCase()) }))
    .filter(person => person.addresses.length > 0 || person.name !== edit.name);
  const existing = people.find(person => person.name === edit.name);
  const role = edit.admin ? "admin" : "person";
  if (existing) {
    return { ...access, people: people.map(person => person === existing
      ? { ...person, role, addresses: [...new Set([...person.addresses, address])] } : person) };
  }
  return { ...access, people: [...people, { name: edit.name, role, addresses: [address] }] };
}
