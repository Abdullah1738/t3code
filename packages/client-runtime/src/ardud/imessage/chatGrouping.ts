/**
 * iMessage threads are ordinary Robob threads whose working directory sits under
 * the iMessage workspace. The thread shell carries no origin for them, so the
 * chat is read back from the path: owner threads live at
 * `imessage/<date>/session-*`, every other chat at `imessage/chats/<slug>/<date>/session-*`.
 */

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
  readonly updatedAt: string;
  readonly running: boolean;
}

export interface IMessageChatSummary {
  readonly slug: string;
  readonly threadIds: ReadonlyArray<string>;
  readonly latestThreadId: string;
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
    const chat = imessageChatOfPath(thread.path);
    if (chat === null) continue;
    const slug = chat.slug;
    const list = byChat.get(slug);
    if (list === undefined) byChat.set(slug, [thread]);
    else list.push(thread);
  }

  const chats: IMessageChatSummary[] = [];
  for (const [slug, list] of byChat) {
    const sorted = [...list].sort((a, b) => compareTimes(b.updatedAt, a.updatedAt));
    const latest = sorted[0]!;
    chats.push({
      slug,
      threadIds: sorted.map((thread) => thread.id),
      latestThreadId: latest.id,
      latestActivityAt: latest.updatedAt,
      running: sorted.some((thread) => thread.running),
    });
  }
  return chats.sort((a, b) => compareTimes(b.latestActivityAt, a.latestActivityAt));
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
