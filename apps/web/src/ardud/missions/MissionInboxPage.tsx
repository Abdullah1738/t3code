import { useEffect, useMemo, useRef } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronLeftIcon, ListFilterIcon } from "lucide-react";

import type { InboxTab, MissionId, MissionListItem, MissionListSnapshot } from "@t3tools/contracts";
import {
  ageView,
  defaultInboxTab,
  DRAFT_STATUS_LABEL,
  draftOwnerEdit,
  draftTitle,
  entryRow,
  formatRelative,
  INBOX_ROUTE_FILTER_LABEL,
  INBOX_TAB_LABEL,
  INBOX_TABS,
  inboxTabCounts,
  ownerConditionOf,
  splitForks,
  staleApprovals,
  totalNeedsYou,
  type InboxEntry,
  type InboxEntryGroup,
  type InboxRouteFilter,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../../components/ui/menu";
import { ScrollArea } from "../../components/ui/scroll-area";
import { SidebarInset } from "../../components/ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { isElectron } from "../../env";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import { AgeElement, CountBadge, HealthGlyph, needsYouLabel } from "./cards/chips";
import { ConditionNote } from "./DiscussPanel";
import { DraftNotesPanel } from "./DraftNotesPanel";
import { ClosedApprovalRow, entryCardState, InboxEntryCard } from "./InboxCards";
import { MissionForksList } from "./MissionForksList";
import { MissionSection } from "./MissionSection";
import { RoutingPanel } from "./RoutingPanel";
import {
  isSampleFeed,
  useDraftNotes,
  useMasterRoleId,
  useMissionForks,
  useMissionInbox,
  useMissionInboxHistory,
  useMissionList,
  useSuggestionStats,
} from "./missionsStore";
import { WordDiff } from "./TextDiffView";
import { inboxActions, inboxItemDomId, useInboxScreen } from "./useInboxScreen";
import { useNowMs } from "./useNowMs";

/** List and reading pane side by side from here; one column below. */
const TWO_COLUMNS_QUERY = "(min-width: 1100px)";

const ACTION_TABS: ReadonlySet<InboxTab> = new Set(["decide", "approve", "knocks"]);

type InboxScreen = ReturnType<typeof useInboxScreen>;

/** Stable empty list, so memoized cards don't re-render while a feed loads. */
const NONE: ReadonlyArray<never> = [];

/**
 * The owner inbox: a list of what waits, grouped by mission, and a reading
 * pane with the selected card. Selection, keys and decisions run through
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
  const wide = useMediaQuery(TWO_COLUMNS_QUERY);
  // Two columns always show a card; one column opens one only when asked.
  const screen = useInboxScreen(props.missionId, tab, props.route, { autoSelectFirst: wide });
  const needsYou = mission ? mission.needsYou : totalNeedsYou(list?.missions ?? []);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader
          electron={isElectron}
          reserveNativeControls
          className="relative bg-background"
        >
          <WorkspaceBreadcrumb ariaLabel="Mission inbox" className="overflow-hidden">
            <WorkspaceBreadcrumbItem>
              {mission ? (
                <Link
                  to="/missions/$missionId"
                  params={{ missionId: mission.id }}
                  className="min-w-0 rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <WorkspaceBreadcrumbText>{mission.title}</WorkspaceBreadcrumbText>
                </Link>
              ) : (
                <WorkspaceBreadcrumbText>Missions</WorkspaceBreadcrumbText>
              )}
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current>
              <WorkspaceBreadcrumbText>Inbox</WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-5 pt-6 sm:px-6">
          <div className="flex min-h-8 items-center gap-2">
            <h1 className="text-base/6 font-semibold">Inbox</h1>
            {needsYou > 0 ? <CountBadge count={needsYou} label={needsYouLabel(needsYou)} /> : null}
            <div className="ms-auto">
              <InboxFilterMenu
                missionId={props.missionId}
                tab={props.tab}
                route={props.route}
                missions={list?.missions ?? []}
                masterCount={
                  inbox ? inbox.masterCounts.approve + inbox.masterCounts.suggestions : 0
                }
              />
            </div>
          </div>
          <InboxTabs
            missionId={props.missionId}
            tab={tab}
            route={props.route}
            counts={inbox ? inboxTabCounts(inbox, props.route) : undefined}
          />
        </div>
        {inbox ? (
          <InboxBody
            missionId={props.missionId}
            tab={tab}
            route={props.route}
            screen={screen}
            nowMs={nowMs}
            wide={wide}
          />
        ) : (
          <p className="mx-auto w-full max-w-6xl px-5 pt-5 text-sm text-muted-foreground sm:px-6">
            Loading…
          </p>
        )}
      </div>
    </SidebarInset>
  );
}

const ALL_MISSIONS = "*";

/** Which mission, and whose inbox (the owner's or what is routed to the master). */
function InboxFilterMenu(props: {
  missionId: MissionId | null;
  tab: InboxTab | null;
  route: InboxRouteFilter;
  missions: ReadonlyArray<MissionListItem>;
  masterCount: number;
}) {
  const navigate = useNavigate();
  const showMissions = props.missions.length > 1 || props.missionId !== null;
  const showRoute = props.masterCount > 0 || props.route === "master";
  if (!showMissions && !showRoute) return null;
  const go = (next: { missionId: MissionId | null; route: InboxRouteFilter }) =>
    void navigate({
      to: "/missions/inbox",
      search: {
        ...(next.missionId ? { mission: next.missionId } : {}),
        ...(props.tab ? { tab: props.tab } : {}),
        ...(next.route === "master" ? { route: "master" as const } : {}),
      },
    });
  const pickMission = (value: unknown) => {
    if (typeof value !== "string") return;
    const missionId = value === ALL_MISSIONS ? null : (value as MissionId);
    if (missionId !== props.missionId) go({ missionId, route: props.route });
  };
  const pickRoute = (value: unknown) => {
    if ((value === "owner" || value === "master") && value !== props.route) {
      go({ missionId: props.missionId, route: value });
    }
  };
  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost-muted" size="sm" />}>
        <ListFilterIcon aria-hidden />
        <span className="max-sm:sr-only">
          {props.route === "master" ? INBOX_ROUTE_FILTER_LABEL.master : "Filter"}
        </span>
      </MenuTrigger>
      <MenuPopup align="end" side="bottom">
        {showMissions ? (
          <MenuGroup>
            <MenuGroupLabel>Mission</MenuGroupLabel>
            <MenuRadioGroup value={props.missionId ?? ALL_MISSIONS} onValueChange={pickMission}>
              <MenuRadioItem value={ALL_MISSIONS} closeOnClick>
                All missions
              </MenuRadioItem>
              {props.missions.map((mission) => (
                <MenuRadioItem key={mission.id} value={mission.id} closeOnClick>
                  <MenuCountLabel label={mission.title} count={mission.needsYou} />
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        ) : null}
        {showMissions && showRoute ? <MenuSeparator /> : null}
        {showRoute ? (
          <MenuGroup>
            <MenuRadioGroup value={props.route} onValueChange={pickRoute}>
              <MenuRadioItem value="owner" closeOnClick>
                {INBOX_ROUTE_FILTER_LABEL.owner}
              </MenuRadioItem>
              <MenuRadioItem value="master" closeOnClick>
                <MenuCountLabel label={INBOX_ROUTE_FILTER_LABEL.master} count={props.masterCount} />
              </MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

function MenuCountLabel(props: { label: string; count: number }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.count > 0 ? (
        <span className="text-xs text-muted-foreground tabular-nums">{props.count}</span>
      ) : null}
    </span>
  );
}

function InboxTabs(props: {
  missionId: MissionId | null;
  tab: InboxTab;
  route: InboxRouteFilter;
  counts: Record<InboxTab, number> | undefined;
}) {
  return (
    <nav aria-label="Inbox sections" className="overflow-x-auto border-b border-border">
      <ul className="flex min-w-max gap-0.5">
        {INBOX_TABS.map((tab) => {
          const active = tab === props.tab;
          const count = props.counts?.[tab] ?? 0;
          return (
            <li key={tab}>
              <Link
                to="/missions/inbox"
                search={{
                  ...(props.missionId ? { mission: props.missionId } : {}),
                  tab,
                  ...(props.route === "master" ? { route: "master" as const } : {}),
                }}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex h-9 items-center gap-1.5 px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:h-11",
                  active
                    ? "font-medium text-foreground after:absolute after:inset-x-2.5 after:-bottom-px after:h-0.5 after:rounded-full after:bg-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {INBOX_TAB_LABEL[tab]}
                {count > 0 ? (
                  <span className="text-xs font-normal text-muted-foreground tabular-nums">
                    {count}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function InboxBody(props: {
  missionId: MissionId | null;
  tab: InboxTab;
  route: InboxRouteFilter;
  screen: InboxScreen;
  nowMs: number;
  wide: boolean;
}) {
  const { screen, nowMs } = props;
  const masterRoleId = useMasterRoleId(props.missionId);
  const forks = useMissionForks(props.missionId) ?? NONE;
  const draftNotes = useDraftNotes(props.missionId) ?? NONE;
  const allStats = useSuggestionStats();
  const missionList = useMissionList();
  // Sample track records would misstate a live author, so they stay hidden.
  const stats = isSampleFeed("suggestion-stats") ? null : (allStats ?? NONE);
  const actions = useMemo(() => inboxActions(screen.dispatch), [screen.dispatch]);
  const deps = useMemo(
    () => ({
      draftNotes,
      stats,
      list: missionList,
      masterRoleId,
      nowMs,
      actions,
      size: "pane" as const,
    }),
    [draftNotes, stats, missionList, masterRoleId, nowMs, actions],
  );
  const selected = screen.selected;
  const openForks = splitForks(forks).open.length;

  const listView =
    screen.entries.length === 0 ? (
      <p className="text-sm text-muted-foreground">
        {props.route === "owner" && ACTION_TABS.has(props.tab)
          ? "Nothing needs you"
          : "Nothing here"}
      </p>
    ) : (
      <InboxList
        groups={screen.groups}
        missionList={missionList}
        nowMs={nowMs}
        label={INBOX_TAB_LABEL[props.tab]}
        selectedKey={selected?.key ?? null}
        onOpen={(key) => screen.dispatch({ type: "select", key })}
      />
    );
  // Every card stays mounted and only the selected one shows, so a half-typed
  // answer survives switching items (not resizing across the breakpoint, which
  // swaps layouts). Cards are memoized on their own state.
  const cards = screen.entries.map((entry) => (
    <div key={entry.key} hidden={entry.key !== selected?.key}>
      <InboxEntryCard
        entry={entry}
        {...entryCardState(screen.ui, entry.key)}
        dispatch={screen.dispatch}
        deps={deps}
      />
    </div>
  ));
  const extras = (
    <InboxExtras missionId={props.missionId} tab={props.tab} nowMs={nowMs} openForks={openForks} />
  );
  const entryKeys = useMemo(() => screen.entries.map((entry) => entry.key), [screen.entries]);
  const paneRef = usePaneFocus(selected?.key ?? null, props.wide, entryKeys);

  if (props.wide) {
    return (
      <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 gap-7 px-5 sm:px-6">
        {/* Rows bleed 12px left so their text lines up with the heading. */}
        <div className="-ms-3 flex min-h-0 w-86 shrink-0 flex-col">
          <ScrollArea className="min-h-0 flex-1">
            <div className="pt-5 pb-12">{listView}</div>
          </ScrollArea>
        </div>
        <section
          ref={paneRef}
          tabIndex={-1}
          aria-label="Reading pane"
          className="flex min-h-0 min-w-0 flex-1 flex-col outline-none"
        >
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex max-w-160 flex-col gap-8 pt-5 pb-12">
              {cards}
              {extras}
            </div>
          </ScrollArea>
        </section>
      </div>
    );
  }
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-5 pt-5 pb-12 sm:px-6">
        <section
          ref={paneRef}
          tabIndex={-1}
          aria-label="Reading pane"
          hidden={selected === null}
          className="flex max-w-160 flex-col gap-3 outline-none"
        >
          <div className="-ms-2">
            <Button
              variant="ghost-muted"
              size="sm"
              onClick={() => screen.dispatch({ type: "select", key: null })}
            >
              <ChevronLeftIcon aria-hidden />
              Inbox
            </Button>
          </div>
          {cards}
        </section>
        <div hidden={selected !== null} className="flex flex-col gap-8">
          <div className="-mx-3">{listView}</div>
          {extras}
        </div>
      </div>
    </ScrollArea>
  );
}

const SCROLL_VIEWPORT = '[data-slot="scroll-area-viewport"]';

/**
 * A newly opened item starts at the top of the pane. In one column, opening
 * moves focus into the pane and Back returns it to the item's row.
 */
function usePaneFocus(selectedKey: string | null, wide: boolean, entryKeys: ReadonlyArray<string>) {
  const paneRef = useRef<HTMLElement>(null);
  const shown = useRef({ key: selectedKey, wide });
  useEffect(() => {
    const previous = shown.current;
    if (previous.key === selectedKey && previous.wide === wide) return;
    shown.current = { key: selectedKey, wide };
    // Crossing the breakpoint changes the implicit selection; nothing to move.
    if (previous.wide !== wide) return;
    const pane = paneRef.current;
    if (selectedKey) {
      // Wide: the pane owns its scroll area. One column: the page scrolls.
      const viewport = wide ? pane?.querySelector(SCROLL_VIEWPORT) : pane?.closest(SCROLL_VIEWPORT);
      viewport?.scrollTo({ top: 0 });
      // Opening from the list, or a decided card unmounting with focus inside it.
      const decided = previous.key !== null && !entryKeys.includes(previous.key);
      const focusLost = document.activeElement === null || document.activeElement === document.body;
      if ((!wide && previous.key === null) || (decided && focusLost)) {
        pane?.focus({ preventScroll: true });
      }
      return;
    }
    if (!wide && previous.key) {
      const row = document.getElementById(inboxItemDomId(previous.key));
      row?.focus({ preventScroll: true });
      row?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedKey, wide, entryKeys]);
  return paneRef;
}

/** One list per mission; the mission header only shows when there are several. */
function InboxList(props: {
  groups: ReadonlyArray<InboxEntryGroup>;
  missionList: MissionListSnapshot | undefined;
  nowMs: number;
  label: string;
  selectedKey: string | null;
  onOpen: (key: string) => void;
}) {
  const headed = props.groups.length > 1;
  return (
    <div className="flex flex-col gap-4.5">
      {props.groups.map((group) => {
        const title = group.title ?? "Other";
        return (
          <div key={group.missionId ?? "none"}>
            {headed ? (
              <h2 className="flex h-7 items-center gap-1.5 px-3 text-xs text-muted-foreground">
                {group.health ? <HealthGlyph health={group.health} paused={group.paused} /> : null}
                <span className="truncate">{title}</span>
              </h2>
            ) : null}
            <ul aria-label={headed ? title : props.label} className="flex flex-col">
              {group.entries.map((entry) => (
                <InboxRow
                  key={entry.key}
                  entry={entry}
                  missionList={props.missionList}
                  nowMs={props.nowMs}
                  current={entry.key === props.selectedKey}
                  onOpen={props.onOpen}
                />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function InboxRow(props: {
  entry: InboxEntry;
  missionList: MissionListSnapshot | undefined;
  nowMs: number;
  current: boolean;
  onOpen: (key: string) => void;
}) {
  const row = entryRow(props.entry, props.missionList);
  const age = ageView(row.since, props.nowMs);
  return (
    <li>
      <button
        type="button"
        id={inboxItemDomId(row.key)}
        aria-current={props.current || undefined}
        onClick={() => props.onOpen(row.key)}
        className={cn(
          "grid w-full grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2.5 gap-y-0.5 rounded-lg px-3 py-2.5 text-start text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.current ? "bg-foreground/7" : "hover:bg-foreground/4",
        )}
      >
        <span className="truncate font-medium">{row.title}</span>
        {age ? <AgeElement age={age} at={row.since} prefix="waiting " /> : <span />}
        <span className="col-span-2 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0 font-medium">{row.kicker}</span>
          {row.sub ? (
            <>
              <span className="sr-only">Sub-mission</span>
              <span className="shrink-0 font-medium tabular-nums">{row.sub.rank}</span>
              <span className="truncate">{row.sub.title}</span>
            </>
          ) : row.about ? (
            <span className="truncate">{row.about}</span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

/** What sits under the list for a tab: open discussions, routing, history, draft notes. */
function InboxExtras(props: {
  missionId: MissionId | null;
  tab: InboxTab;
  nowMs: number;
  openForks: number;
}) {
  if (props.tab === "decide") {
    return (
      <>
        {props.openForks > 0 ? (
          <MissionSection title="Open discussions">
            <MissionForksList missionId={props.missionId} nowMs={props.nowMs} />
          </MissionSection>
        ) : null}
        <AnsweredOnCondition missionId={props.missionId} />
      </>
    );
  }
  if (props.tab !== "approve") return null;
  return (
    <>
      {props.missionId ? <RoutingPanel missionId={props.missionId} /> : null}
      <ApproveHistory missionId={props.missionId} nowMs={props.nowMs} />
      <MissionSection title="Draft notes">
        <DraftNotesPanel missionId={props.missionId} />
      </MissionSection>
    </>
  );
}

/** Asks the master answered on a condition the owner stated in a Discuss request. */
function AnsweredOnCondition(props: { missionId: MissionId | null }) {
  const history = useMissionInboxHistory(props.missionId);
  const answered = (history?.asks ?? []).flatMap((ask) => {
    const condition = ask.answer ? ownerConditionOf(ask.answer) : null;
    return condition ? [{ ask, condition }] : [];
  });
  if (answered.length === 0) return null;
  return (
    <MissionSection title="Decided today">
      {answered.map(({ ask, condition }) => (
        <div key={ask.id} className="flex min-w-0 flex-col gap-1.5">
          <p className="min-w-0 truncate text-sm font-medium">{ask.question}</p>
          <ConditionNote condition={condition} />
        </div>
      ))}
    </MissionSection>
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
  const conditionDrafts = history.drafts.flatMap((draft) => {
    const condition = ownerConditionOf(draft);
    return condition ? [{ draft, condition }] : [];
  });
  if (editedDrafts.length === 0 && closed.length === 0 && conditionDrafts.length === 0) {
    return null;
  }
  return (
    <MissionSection title="Decided today">
      {editedDrafts.map(({ draft, edit }) => (
        <div key={draft.id} className="flex flex-col gap-1">
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="shrink-0 font-medium">Your edit</span>
            <span className="truncate">To {draft.audience}</span>
            {draft.decidedAt ? (
              <time dateTime={draft.decidedAt} className="ms-auto shrink-0 tabular-nums">
                {formatRelative(draft.decidedAt, props.nowMs)}
              </time>
            ) : null}
          </p>
          {edit ? <WordDiff segments={edit.segments} /> : null}
        </div>
      ))}
      {conditionDrafts.map(({ draft, condition }) => (
        <div key={`condition:${draft.id}`} className="flex min-w-0 flex-col gap-1.5">
          <p className="flex min-w-0 items-center gap-1.5 text-sm">
            <span className="min-w-0 truncate font-medium">{draftTitle(draft)}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {DRAFT_STATUS_LABEL[draft.status]}
            </span>
          </p>
          <ConditionNote condition={condition} />
        </div>
      ))}
      {closed.length > 0 ? (
        <ul className="flex flex-col gap-4">
          {closed.map((approval) => (
            <ClosedApprovalRow key={approval.id} approval={approval} nowMs={props.nowMs} />
          ))}
        </ul>
      ) : null}
    </MissionSection>
  );
}
