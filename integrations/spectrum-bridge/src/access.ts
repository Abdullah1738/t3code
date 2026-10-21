/**
 * Who may talk to the line, and where each conversation keeps its state.
 * Pure decisions over an Access snapshot; the file read and the mtime check live here too
 * so the runtime never caches a stale allow list past one tick.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { chatKey, type ChatKey } from "./line.ts";
import type { Access, ChatInfo, Person, Role } from "./chats.ts";

export const emptyAccess: Access = { people: [], groups: [] };

/** Missing file means nobody but the owner. Malformed JSON fails loud so a typo never silently opens the line. */
export async function loadAccess(path: string): Promise<Access> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyAccess;
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<Access>;
  const people = Array.isArray(parsed.people) ? parsed.people : [];
  const groups = Array.isArray(parsed.groups) ? parsed.groups : [];
  for (const person of people) {
    if (!person || typeof person.name !== "string" || !person.name.trim()) throw new Error("Invalid access.json");
    if (person.role !== "owner" && person.role !== "admin" && person.role !== "person") throw new Error("Invalid access.json");
    if (!Array.isArray(person.addresses) || person.addresses.some(address => typeof address !== "string")) {
      throw new Error("Invalid access.json");
    }
  }
  return { people, groups };
}

/** Reloads only when the file's mtime moved; cheap enough to call every tick. */
export function accessReloader(path: string): () => Promise<Access> {
  let mtime = -1;
  let cached: Access = emptyAccess;
  return async () => {
    const info = await stat(path).catch(() => undefined);
    const next = info ? info.mtimeMs : -2;
    if (next !== mtime) {
      cached = await loadAccess(path);
      mtime = next;
    }
    return cached;
  };
}

const normalize = (address: string) => address.trim().toLowerCase();

export function personFor(access: Access, address: string): Person | undefined {
  const wanted = normalize(address);
  return access.people.find(person => person.addresses.some(entry => normalize(entry) === wanted));
}

/** Owner address comes from config; everyone else from access.json. */
export function roleOf(access: Access, owner: string, address: string): { name: string; role: Role } {
  if (normalize(address) === normalize(owner)) return { name: "Abdullah", role: "owner" };
  const person = personFor(access, address);
  return person ? { name: person.name, role: person.role } : { name: address, role: "guest" };
}

export type Decision =
  | { allowed: true }
  | { allowed: false; reason: "unknown-dm" | "unknown-group"; address: string };

/**
 * A message is allowed when the owner or a non-guest person wrote it 1:1, or when the group
 * is listed explicitly or contains the owner or an admin. Anything else is dropped with a note.
 */
export function decide(access: Access, owner: string, chat: ChatKey, from: string, participants: string[]): Decision {
  const trusted = (address: string) => {
    const role = roleOf(access, owner, address).role;
    return role === "owner" || role === "admin";
  };
  if (chat.startsWith("dm:")) {
    if (normalize(from) === normalize(owner)) return { allowed: true };
    return personFor(access, from) ? { allowed: true } : { allowed: false, reason: "unknown-dm", address: from };
  }
  const groupId = chatKey.target(chat);
  if (access.groups.some(group => group.id === groupId)) return { allowed: true };
  // The owner counts only when the line reports them as a participant, never by default.
  if (participants.some(address => trusted(address))) return { allowed: true };
  return { allowed: false, reason: "unknown-group", address: groupId };
}

const slugPart = (value: string) => value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Stable slug for a chat. A person's slug is their name; a group's keeps 6 chars of its id so renames never collide. */
export function slugFor(chat: ChatKey, access: Access, owner: string, groupName?: string): string {
  if (chat.startsWith("dm:")) {
    const address = chatKey.target(chat);
    if (normalize(address) === normalize(owner)) return "owner";
    const person = personFor(access, address);
    return person ? slugPart(person.name) || "person" : `dm-${slugPart(address)}`;
  }
  const id = chatKey.target(chat);
  const named = slugPart(groupName ?? "");
  return named ? `group-${named}-${id.slice(0, 6)}` : `group-${id.slice(0, 6)}`;
}

export function chatInfo(chat: ChatKey, slug: string, access: Access, groupName?: string): ChatInfo {
  if (slug === "owner") return { key: chat, slug, kind: "owner", title: "Abdullah" };
  if (chat.startsWith("dm:")) {
    const address = chatKey.target(chat);
    const person = personFor(access, address);
    return { key: chat, slug, kind: "dm", title: person?.name ?? address, ...(person ? { person } : {}) };
  }
  return { key: chat, slug, kind: "group", title: groupName?.trim() || `Group ${chatKey.target(chat).slice(0, 6)}` };
}

export const accessPath = (stateRoot: string) => join(stateRoot, "access.json");
