import { Link } from "@tanstack/react-router";

import type { InboxTab, MissionId } from "@t3tools/contracts";
import {
  defaultInboxTab,
  draftOwnerEdit,
  formatRelative,
  INBOX_ROUTE_FILTER_LABEL,
  INBOX_TAB_LABEL,
  INBOX_TABS,
  inboxTabCounts,
  staleApprovals,
  type InboxEntry,
  type InboxRouteFilter,
} from "@t3tools/client-runtime/ardud/missions";

import { Kbd } from "../../components/ui/kbd";
import { ScrollArea } from "../../components/ui/scroll-area";
import { SidebarInset } from "../../components/ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../../components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../../components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { DraftNotesPanel } from "./DraftNotesPanel";
import {
  ApprovalCard,
  AskCard,
  ClosedApprovalRow,
  DraftCard,
  KnockCard,
  NoteCard,
  SuggestionCard,
} from "./InboxCards";
import { MissionForksList } from "./MissionForksList";
import { MissionSection } from "./MissionSection";
import { RoutingPanel } from "./RoutingPanel";
import {
  useDraftNotes,
  useMasterRoleId,
  useMissionForks,
  useMissionInbox,
  useMissionInboxHistory,
  useMissionList,
  useSuggestionStats,
} from "./missionsStore";
import { WordDiff } from "./TextDiffView";
import { inboxActions, useInboxScreen } from "./useInboxScreen";
import { useNowMs } from "./useNowMs";

/**
 * The owner inbox: Decide / Approve / Knocks / Suggestions / FYI for one
 * mission or all of them. Selection, keys and decisions run through
 * `useInboxScreen` (client-runtime reducer); this file is layout.
 */
export function MissionInboxPage(props: {
  missionId: MissionId | null;
  tab: InboxTab | null;
  route: InboxRouteFilter;
}) {
  const list = useMissionList();
  const nowMs = useNowMs();
  const mission = list?.missions.find((item) => item.id === props.missionId) ?? null;
  const inbox = useMissionInbox(props.missionId);
  // No tab in the URL: the first tab with something in it.
  const tab = props.tab ?? (inbox ? defaultInboxTab(inbox, props.route) : "decide");
  const screen = useInboxScreen(props.missionId, tab, props.route);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader
          electron={isElectron}
          reserveNativeControls
          className="relative bg-background"
        >
          <WorkspaceBreadcrumb ariaLabel="Mission inbox" className="overflow-hidden">
            {mission ? (
              <>
                <WorkspaceBreadcrumbItem>
                  <Link
                    to="/missions/$missionId"
                    params={{ missionId: mission.id }}
                    className="min-w-0 rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <WorkspaceBreadcrumbText>{mission.title}</WorkspaceBreadcrumbText>
                  </Link>
                </WorkspaceBreadcrumbItem>
                <WorkspaceBreadcrumbSeparator />
              </>
            ) : null}
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">Inbox</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="readable" className="min-h-full gap-4">
            <InboxScopeLinks missionId={props.missionId} tab={props.tab} route={props.route} />
            <InboxRouteLinks
              missionId={props.missionId}
              tab={props.tab}
              route={props.route}
              masterCount={inbox ? inbox.masterCounts.approve + inbox.masterCounts.suggestions : 0}
            />
            <InboxTabs
              missionId={props.missionId}
              tab={tab}
              route={props.route}
              counts={inbox ? inboxTabCounts(inbox, props.route) : undefined}
            />
            {inbox ? (
              <InboxTabBody
                missionId={props.missionId}
                tab={tab}
                route={props.route}
                screen={screen}
                nowMs={nowMs}
              />
            ) : (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )}
            <KeyboardHint />
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

/** One mission or all of them. */
function InboxScopeLinks(props: {
  missionId: MissionId | null;
  tab: InboxTab | null;
  route: InboxRouteFilter;
}) {
  const list = useMissionList();
  if (!list || list.missions.length < 2) return null;
  const tabSearch = {
    ...(props.tab ? { tab: props.tab } : {}),
    ...(props.route === "master" ? { route: "master" as const } : {}),
  };
  const linkClass = (active: boolean) =>
    cn(
      "rounded px-1.5 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
    );
  return (
    <nav aria-label="Missions in the inbox" className="flex flex-wrap gap-1 text-sm">
      <Link to="/missions/inbox" search={tabSearch} className={linkClass(props.missionId === null)}>
        All missions
      </Link>
      {list.missions.map((mission) => (
        <Link
          key={mission.id}
          to="/missions/inbox"
          search={{ mission: mission.id, ...tabSearch }}
          className={linkClass(props.missionId === mission.id)}
        >
          {mission.title}
          {mission.needsYou > 0 ? ` (${mission.needsYou})` : ""}
        </Link>
      ))}
    </nav>
  );
}

/** The owner's inbox (default) or what is routed to the master. Both can be decided here. */
function InboxRouteLinks(props: {
  missionId: MissionId | null;
  tab: InboxTab | null;
  route: InboxRouteFilter;
  masterCount: number;
}) {
  const base = {
    ...(props.missionId ? { mission: props.missionId } : {}),
    ...(props.tab ? { tab: props.tab } : {}),
  };
  const linkClass = (active: boolean) =>
    cn(
      "rounded px-1.5 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
    );
  return (
    <nav aria-label="Whose inbox" className="flex flex-wrap gap-1 text-sm">
      <Link to="/missions/inbox" search={base} className={linkClass(props.route === "owner")}>
        {INBOX_ROUTE_FILTER_LABEL.owner}
      </Link>
      <Link
        to="/missions/inbox"
        search={{ ...base, route: "master" }}
        className={linkClass(props.route === "master")}
      >
        {INBOX_ROUTE_FILTER_LABEL.master}
        {props.masterCount > 0 ? ` (${props.masterCount})` : ""}
      </Link>
    </nav>
  );
}

function InboxTabs(props: {
  missionId: MissionId | null;
  tab: InboxTab;
  route: InboxRouteFilter;
  counts: Record<InboxTab, number> | undefined;
}) {
  return (
    <nav aria-label="Inbox sections" className="border-b border-border/60">
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        {INBOX_TABS.map((tab) => {
          const active = tab === props.tab;
          const count = props.counts?.[tab] ?? 0;
          return (
            <li key={tab} className="shrink-0">
              <Link
                to="/missions/inbox"
                search={{
                  ...(props.missionId ? { mission: props.missionId } : {}),
                  tab,
                  ...(props.route === "master" ? { route: "master" as const } : {}),
                }}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-9 items-center gap-1.5 border-b-2 px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  active
                    ? "border-foreground font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {INBOX_TAB_LABEL[tab]}
                <span className="tabular-nums text-muted-foreground">{count}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

const EMPTY_LINE: Record<InboxTab, string> = {
  decide: "No open questions. Lanes the master can't decide for would wait here.",
  approve: "No drafts or approvals waiting.",
  knocks: "No knocks.",
  suggestions: "No open suggestions.",
  fyi: "Nothing new you need to know.",
};

function InboxTabBody(props: {
  missionId: MissionId | null;
  tab: InboxTab;
  route: InboxRouteFilter;
  screen: ReturnType<typeof useInboxScreen>;
  nowMs: number;
}) {
  const { screen, nowMs } = props;
  const masterRoleId = useMasterRoleId(props.missionId);
  const forks = useMissionForks(props.missionId) ?? [];
  const draftNotes = useDraftNotes(props.missionId) ?? [];
  const stats = useSuggestionStats() ?? [];
  const actions = inboxActions(screen.dispatch);

  const card = (entry: InboxEntry) => {
    const selected = screen.ui.selectedKey === entry.key;
    const onSelect = () => screen.dispatch({ type: "select", key: entry.key });
    const editing = screen.ui.editingKey === entry.key;
    const onEdit = (open: boolean) =>
      screen.dispatch({ type: "edit", key: open ? entry.key : null });
    switch (entry.kind) {
      case "ask":
        return (
          <AskCard
            ask={entry.record}
            selected={selected}
            onSelect={onSelect}
            picked={screen.ui.picked[entry.key] ?? null}
            onPick={(optionId) => screen.dispatch({ type: "pick", key: entry.key, optionId })}
            forks={forks}
            nowMs={nowMs}
            masterRoleId={masterRoleId}
            actions={actions}
          />
        );
      case "draft":
        return (
          <DraftCard
            draft={entry.record}
            selected={selected}
            onSelect={onSelect}
            editing={editing}
            onEdit={onEdit}
            notes={draftNotes}
            masterRoleId={masterRoleId}
            nowMs={nowMs}
            actions={actions}
          />
        );
      case "approval":
        return (
          <ApprovalCard
            approval={entry.record}
            selected={selected}
            onSelect={onSelect}
            masterRoleId={masterRoleId}
            nowMs={nowMs}
            actions={actions}
          />
        );
      case "knock":
        return (
          <KnockCard
            knock={entry.record}
            selected={selected}
            onSelect={onSelect}
            editing={editing}
            onEdit={onEdit}
            nowMs={nowMs}
            actions={actions}
          />
        );
      case "suggestion":
        return (
          <SuggestionCard
            suggestion={entry.record}
            selected={selected}
            onSelect={onSelect}
            stats={stats}
            nowMs={nowMs}
            actions={actions}
          />
        );
      case "note":
        return (
          <NoteCard
            note={entry.record}
            selected={selected}
            onSelect={onSelect}
            nowMs={nowMs}
            actions={actions}
          />
        );
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {screen.entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{EMPTY_LINE[props.tab]}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {screen.entries.map((entry) => (
            <li key={entry.key}>{card(entry)}</li>
          ))}
        </ul>
      )}
      {props.tab === "decide" ? (
        <MissionSection title="Open discussions">
          <MissionForksList missionId={props.missionId} nowMs={nowMs} />
        </MissionSection>
      ) : null}
      {props.tab === "approve" ? (
        <>
          {props.missionId ? <RoutingPanel missionId={props.missionId} /> : null}
          <ApproveHistory missionId={props.missionId} nowMs={nowMs} />
          <MissionSection title="Draft notes" caption="How you want drafts to be.">
            <DraftNotesPanel missionId={props.missionId} />
          </MissionSection>
        </>
      ) : null}
    </div>
  );
}

/** Drafts the owner edited (the diff he taught the writer) and closed approvals. */
function ApproveHistory(props: { missionId: MissionId | null; nowMs: number }) {
  const history = useMissionInboxHistory(props.missionId);
  if (!history) return null;
  const editedDrafts = history.drafts
    .map((draft) => ({ draft, edit: draftOwnerEdit(draft) }))
    .filter((item) => item.edit !== null);
  const closed = [
    ...staleApprovals(history),
    ...history.approvals.filter((approval) => approval.status !== "stale-closed"),
  ];
  if (editedDrafts.length === 0 && closed.length === 0) return null;
  return (
    <MissionSection title="Decided today">
      {editedDrafts.map(({ draft, edit }) => (
        <div key={draft.id} className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">
            Your edit to the draft for {draft.audience} ·{" "}
            {draft.decidedAt ? formatRelative(draft.decidedAt, props.nowMs) : ""}
          </p>
          {edit ? <WordDiff segments={edit.segments} /> : null}
        </div>
      ))}
      {closed.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {closed.map((approval) => (
            <ClosedApprovalRow key={approval.id} approval={approval} nowMs={props.nowMs} />
          ))}
        </ul>
      ) : null}
    </MissionSection>
  );
}

function KeyboardHint() {
  return (
    <p className="hidden text-xs text-muted-foreground sm:block">
      <Kbd>j</Kbd> <Kbd>k</Kbd> move · <Kbd>1</Kbd>–<Kbd>9</Kbd> pick an option · <Kbd>e</Kbd> edit
      a draft or knock
    </p>
  );
}
