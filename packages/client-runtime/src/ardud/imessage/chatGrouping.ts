/**
 * iMessage threads are ordinary Robob threads whose working directory sits under
 * the iMessage workspace. The thread shell carries no origin for them, so the
 * chat is read back from the path: owner threads live at
 * `imessage/<date>/session-*`, every other chat at `imessage/chats/<slug>/<date>/session-*`.
 */

import { threadRuntimeIsActive, type EnvironmentThreadShell } from "../../state/models.ts";

export const OWNER_CHAT_SLUG = "owner";

const IMESSAGE_ROOT_SEGMENT = "/imessage/";
const CHATS_SEGMENT = "chats";
const DATE_SEGMENT = /^\d{4}-\d{2}-\d{2}$/;

export interface IMessageChatRef {
  readonly slug: string;
  readonly date: string;
}

/** Reads the chat a thread path belongs to, or null when it is not an iMessage thread. */
export function imessageChatOfPath(path: string | null | undefined): IMessageChatRef | null {
  if (path === null || path === undefined) return null;
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.indexOf(IMESSAGE_ROOT_SEGMENT);
  if (index === -1) return null;
  const parts = normalized
    .slice(index + IMESSAGE_ROOT_SEGMENT.length)
    .split("/")
    .filter((part) => part.length > 0);
  if (parts.length === 0) return null;

  if (parts[0] === CHATS_SEGMENT) {
    const [, slug, date] = parts;
    if (slug === undefined || date === undefined || !DATE_SEGMENT.test(date)) return null;
    return { slug, date };
  }
  const [date] = parts;
  if (date === undefined || !DATE_SEGMENT.test(date)) return null;
  return { slug: OWNER_CHAT_SLUG, date };
}

export interface IMessageThreadInput {
  readonly id: string;
  readonly path: string | null | undefined;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly running: boolean;
  /**
   * Subagent and fork threads share their parent's iMessage folder, but their
   * messages are agent prompts, not the chat, so they never join a chat.
   */
  readonly child: boolean;
}

export interface IMessageChatSummary {
  readonly slug: string;
  /** Oldest first, the order the conversation happened in. */
  readonly threadIds: ReadonlyArray<string>;
  readonly latestThreadId: string;
  /** The bridge titles each non-owner thread with the chat's name. */
  readonly latestTitle: string;
  readonly latestActivityAt: string;
  readonly running: boolean;
}

/**
 * One entry per chat, newest activity first. Threads that are not iMessage threads
 * are skipped, so callers can pass the whole thread list.
 */
export function groupIMessageThreads(
  threads: ReadonlyArray<IMessageThreadInput>,
): ReadonlyArray<IMessageChatSummary> {
  const byChat = new Map<string, IMessageThreadInput[]>();
  for (const thread of threads) {
    if (thread.child) continue;
    const chat = imessageChatOfPath(thread.path);
    if (chat === null) continue;
    const slug = chat.slug;
    const list = byChat.get(slug);
    if (list === undefined) byChat.set(slug, [thread]);
    else list.push(thread);
  }

  const chats: IMessageChatSummary[] = [];
  for (const [slug, list] of byChat) {
    const sorted = sortIMessageThreadsByCreation(list);
    const latest = sorted[sorted.length - 1]!;
    const latestActivityAt = sorted.reduce(
      (newest, thread) => (compareTimes(thread.updatedAt, newest) > 0 ? thread.updatedAt : newest),
      latest.updatedAt,
    );
    chats.push({
      slug,
      threadIds: sorted.map((thread) => thread.id),
      latestThreadId: latest.id,
      latestTitle: latest.title,
      latestActivityAt,
      running: sorted.some((thread) => thread.running),
    });
  }
  return chats.sort((a, b) => compareTimes(b.latestActivityAt, a.latestActivityAt));
}

/** A chat reads oldest to newest by when each session began, not by its last edit. */
export function sortIMessageThreadsByCreation<T extends { readonly createdAt: string }>(
  threads: ReadonlyArray<T>,
): T[] {
  return [...threads].sort((a, b) => compareTimes(a.createdAt, b.createdAt));
}

function compareTimes(a: string, b: string): number {
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (Number.isNaN(left) || Number.isNaN(right)) return a < b ? -1 : a > b ? 1 : 0;
  return left - right;
}

/** Drops iMessage threads so the ordinary thread list leaves them to the iMessage group. */
export function withoutIMessageThreads<T extends { readonly worktreePath: string | null }>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const kept = threads.filter((thread) => imessageChatOfPath(thread.worktreePath) === null);
  return kept.length === threads.length ? threads : kept;
}

export type IMessageChatKind = "owner" | "person" | "group";

/** Group chats are created with a `group-` slug; everything else other than the owner is a person. */
export function imessageChatKind(slug: string): IMessageChatKind {
  if (slug === OWNER_CHAT_SLUG) return "owner";
  return slug.startsWith("group-") ? "group" : "person";
}

const KIND_ORDER: Record<IMessageChatKind, number> = { owner: 0, person: 1, group: 2 };

/** Owner first, then people, then groups; each kind keeps its latest-activity order. */
export function sortIMessageChats<T extends { readonly slug: string }>(
  chats: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return [...chats].sort(
    (a, b) => KIND_ORDER[imessageChatKind(a.slug)] - KIND_ORDER[imessageChatKind(b.slug)],
  );
}

/** An iMessage thread is any thread whose path sits in the iMessage workspace. */
export const imessageThreadInput = (thread: EnvironmentThreadShell): IMessageThreadInput => ({
  id: thread.id,
  path: thread.worktreePath,
  title: thread.title,
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
  running: threadRuntimeIsActive(thread.runtime),
  child: thread.lineage.relationshipToParent !== null,
});

// Owner threads are titled by session time; any other title is the chat's name.
const SESSION_TITLE = /^iMessage \d{4}-\d{2}-\d{2}/;

/**
 * The owner's chat is "Abdullah". Other chats use the name the bridge titles their
 * threads with, falling back to the slug written as a name.
 */
export function imessageChatLabel(slug: string, threadTitle?: string): string {
  if (imessageChatKind(slug) === "owner") return "Abdullah";
  const title = threadTitle?.trim();
  if (title && !SESSION_TITLE.test(title)) return title;
  return slug
    .replace(/^group-/, "")
    .replace(/-[a-z0-9]{6}$/, "")
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}
