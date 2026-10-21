/**
 * Who the line talks to, shared by the per-chat runtime (main/ingress) and the
 * router. Photon mode never sets any of this.
 */
import type { ChatKey } from "./line.ts";

/** owner: Abdullah. admin: trusted like the owner (Moni). person: allowed 1:1. guest: anyone else in an allowed group. */
export type Role = "owner" | "admin" | "person" | "guest";

export type Person = {
  name: string;
  role: Exclude<Role, "guest">;
  /** E.164 numbers and Apple ID emails this person writes from. */
  addresses: string[];
};

/** ~/.config/spectrum-bridge/access.json */
export type Access = {
  people: Person[];
  /** Groups the owner allowed explicitly. Groups with the owner or an admin as a participant are allowed anyway. */
  groups: { id: string; name?: string }[];
};

/** One conversation the line takes part in. */
export type ChatInfo = {
  key: ChatKey;
  /** "owner", a person slug ("moni"), or "group-<name-slug>-<first 6 of group id>". Also the Robob directory name. */
  slug: string;
  kind: "owner" | "dm" | "group";
  /** Display name: the person's name or the group's name. */
  title: string;
  /** The other side of a dm. */
  person?: Person;
};

/** Extra router input in Sendblue mode. */
export type ChatContext = {
  chat: ChatInfo;
  /** Name and role for a sender address seen in this chat. Unknown addresses are guests. */
  roleOf: (address: string) => { name: string; role: Role };
  /** True while someone in this chat is typing (a typing-on event in the last 30 s with no later typing-off or message). */
  typing: () => boolean;
};
