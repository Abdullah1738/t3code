import { memo } from "react";
import { Link, useParams } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  groupIMessageThreads,
  imessageChatKind,
  sortIMessageChats,
  type IMessageChatSummary,
} from "@t3tools/client-runtime/ardud/imessage";

import { hasUnseenCompletion } from "../../components/Sidebar.logic";
import { CollapsibleSectionHeader } from "../../components/ui/collapsible-section-header";
import { SidebarGroup, useSidebar } from "../../components/ui/sidebar";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useThreadShells } from "../../state/entities";
import { cn } from "../../lib/utils";
import { UnreadDot } from "../missions/cards/chips";

const SIDEBAR_STATE_KEY = "t3code:ardud-imessage:sidebar";
const SidebarState = Schema.Struct({ collapsed: Schema.Boolean });
type SidebarState = typeof SidebarState.Type;
const INITIAL_STATE: SidebarState = { collapsed: false };

const rowClassName =
  "flex h-8 min-w-0 items-center gap-2 rounded-lg px-2.5 text-sm text-sidebar-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:h-11";

function rowState(isActive: boolean) {
  return isActive ? "bg-sidebar-row-active font-medium" : "hover:bg-sidebar-row-hover";
}

/** An iMessage thread is any thread whose path sits in the iMessage workspace. */
export const iMessageThreadInput = (thread: EnvironmentThreadShell) => ({
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

/**
 * The iMessage group above the thread list: one row per chat, owner first, then
 * people, then groups. Read-only; each row opens the chat's transcript.
 */
export function IMessageSidebarGroup() {
  const threads = useThreadShells();
  const chats = sortIMessageChats(groupIMessageThreads(threads.map(iMessageThreadInput)));
  const byId = new Map<string, EnvironmentThreadShell>(
    threads.map((thread) => [thread.id, thread] as const),
  );
  const unreadSlugs = new Set(
    chats
      .filter((chat) =>
        chat.threadIds.some((id) => {
          const thread = byId.get(id);
          return thread !== undefined && hasUnseenCompletion(thread);
        }),
      )
      .map((chat) => chat.slug),
  );

  const [state, setState] = useLocalStorage(SIDEBAR_STATE_KEY, INITIAL_STATE, SidebarState);
  const activeSlug = useParams({
    strict: false,
    select: (params) => (typeof params.chatSlug === "string" ? params.chatSlug : null),
  });
  const { isMobile, setOpenMobile } = useSidebar();
  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };

  if (chats.length === 0) return null;

  const expanded = !state.collapsed;
  return (
    <SidebarGroup aria-label="iMessage">
      <div className="mx-0.5 h-8">
        <CollapsibleSectionHeader
          expanded={expanded}
          onClick={() => setState((current) => ({ ...current, collapsed: !current.collapsed }))}
        >
          iMessage
        </CollapsibleSectionHeader>
      </div>
      {expanded ? (
        <ul className="flex flex-col gap-0.5 pb-3.5">
          {chats.map((chat) => (
            <IMessageChatRow
              key={chat.slug}
              chat={chat}
              isActive={chat.slug === activeSlug}
              unread={unreadSlugs.has(chat.slug)}
              onNavigate={closeMobileSidebar}
            />
          ))}
        </ul>
      ) : null}
    </SidebarGroup>
  );
}

const IMessageChatRow = memo(function IMessageChatRow(props: {
  chat: IMessageChatSummary;
  isActive: boolean;
  unread: boolean;
  onNavigate: () => void;
}) {
  const { chat, isActive, unread, onNavigate } = props;
  const label = imessageChatLabel(chat.slug, chat.latestTitle);
  return (
    <li>
      <Link
        to="/imessage/$chatSlug"
        params={{ chatSlug: chat.slug }}
        onClick={onNavigate}
        aria-current={isActive ? "page" : undefined}
        className={cn(rowClassName, "pe-2", rowState(isActive))}
      >
        {unread ? <UnreadDot label={`${label} has new replies`} /> : null}
        <span className={cn("min-w-0 flex-1 truncate", chat.running && "font-medium")}>
          {label}
        </span>
        {/* Static text on purpose: a pulsing indicator would repaint every frame. */}
        {chat.running ? (
          <span className="shrink-0 text-xs text-sidebar-muted-foreground">working</span>
        ) : null}
      </Link>
    </li>
  );
});
