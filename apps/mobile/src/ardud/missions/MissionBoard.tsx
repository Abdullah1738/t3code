import {
  VIEW_BUILTIN_SECTION_TITLES,
  type CallId,
  type MissionId,
  type MissionListSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import {
  attachedThreadGroups,
  dayOnePlan,
  formatPercent,
  groupRequests,
  isRequestUnread,
  masterRoutedEntries,
  ownerConditionOf,
  ownerWaitingEntries,
  PLAN_KICKER,
  resolveMissionLayout,
  type InboxEntry,
  type MissionOverviewSnapshot,
  type ViewSectionEntry,
} from "@t3tools/client-runtime/ardud/missions";
import {
  boardFigures,
  entrySubject,
  laneSections,
  priorityStackView,
  sinceView,
  snoozedFor,
  towardView,
  type LaneSection,
  type SinceRow,
} from "@t3tools/client-runtime/ardud/missions/mobile";
import { Fragment, useState } from "react";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { boardSlotKey, boardSlots, type BoardSlot } from "./boardLayout";
import { DiscussionPanel, OpenDiscussions } from "./Discussion";
import { FeedError, LoadingLine } from "./FeedError";
import { EntryRow } from "./InboxPane";
import {
  useMissionInbox,
  useMissionInboxFeed,
  useMissionLanes,
  useOwnerRequestsFeed,
  useYourRequests,
} from "./missionsStore";
import { useOverviewActions } from "./overviewLogic";
import {
  ActionButton,
  Chip,
  ChoiceRow,
  ConditionQuote,
  EmptyLine,
  Group,
  LinkButton,
  Meta,
  Row,
  SectionHead,
  Separator,
  StateGlyph,
  Title,
} from "./parts";
import { PinnedStrip } from "./PinnedStrip";
import { useRequestComposer } from "./recordLogic";
import { RequestEditor } from "./RequestEditor";
import { RequestReader } from "./RequestReader";
import { MISSION_PAGES, type MissionPage } from "./routeParams";
import { RequestRows } from "./rows";
import { CustomSection } from "./ViewBlocks";
import { useMissionViews } from "./viewsStore";

const BOARD_LIMIT = 3;

export interface MissionBoardProps {
  readonly overview: MissionOverviewSnapshot;
  readonly list: MissionListSnapshot | undefined;
  readonly page: MissionPage;
  readonly onPage: (page: MissionPage) => void;
  /** Bumped by the top bar's Ask so the compose field takes focus. */
  readonly askKey: number;
  readonly wide: boolean;
  readonly nowMs: number;
  readonly bottomInset: number;
  readonly onOpenInbox: () => void;
  readonly onOpenItem: (entry: InboxEntry) => void;
  readonly onOpenRequest: (requestId: string) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}

/** One mission: Board, Your requests and Lanes as in-screen pages. */
export function MissionBoard(props: MissionBoardProps) {
  const tabs = (
    <ChoiceRow
      accessibilityLabel="Mission pages"
      options={MISSION_PAGES}
      selected={props.page}
      onSelect={props.onPage}
    />
  );
  switch (props.page) {
    case "requests":
      return <RequestsPage {...props} tabs={tabs} />;
    case "lanes":
      return <LanesPage {...props} tabs={tabs} />;
    case "board":
      return <BoardPage {...props} tabs={tabs} />;
  }
}

type PageProps = MissionBoardProps & { readonly tabs: React.ReactNode };

function Page(props: { readonly children: React.ReactNode }) {
  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-3 px-4 pb-8 pt-3"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
    >
      {props.children}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Board

function BoardPage(props: PageProps) {
  const missionId = props.overview.mission.id;
  const inbox = useMissionInbox(missionId);
  const loadedRequests = useYourRequests(missionId);
  const requests = loadedRequests ?? [];
  const lanes = useMissionLanes(missionId);
  const views = useMissionViews(missionId);
  const actions = useOverviewActions(props.overview);
  const inboxFeed = useMissionInboxFeed(missionId);
  const requestsFeed = useOwnerRequestsFeed(missionId);
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const holds = inbox ? ownerWaitingEntries(inbox, props.nowMs) : [];
  // Day one: the master's plan, filed as an ask or approval, leads Needs you.
  const plan = dayOnePlan(props.overview.lanes, holds);
  const waiting = plan ? [plan, ...holds.filter((entry) => entry !== plan)] : holds;
  const snoozed = inbox ? snoozedFor(inbox, "all", props.nowMs) : [];
  const withMaster = inbox ? masterRoutedEntries(inbox) : [];
  const { open } = groupRequests(requests);
  const unread = requests.filter(isRequestUnread);
  const problems = laneSections(lanes ?? [], props.nowMs).filter(
    (section) => section.key === "stuck" || section.key === "waiting",
  );
  const since = sinceView(props.overview, props.nowMs);
  const toward = towardView(props.overview, props.nowMs);
  const stack = priorityStackView(props.overview).rows;
  // The pinned strip counts what this board would show, as the web board does.
  const layout = views
    ? resolveMissionLayout(views.snapshot, {
        ...(inbox ? { ownerWaiting: waiting.length } : {}),
        ...(loadedRequests ? { requestsUnread: unread.length } : {}),
      })
    : null;
  const slots = boardSlots(layout);
  const visible = new Set(
    slots.flatMap((slot) => (slot.type === "section" ? [slot.entry.kind] : [])),
  );
  // Records whose card here carries its discussion; Needs you past the first
  // few still has one a tap away in the inbox.
  const discussed = [
    ...[
      ...(visible.has("needs-you") ? [...waiting, ...snoozed] : []),
      ...(visible.has("with-the-master") ? withMaster : []),
    ].map((entry) => ({ kind: entry.kind, id: entry.record.id })),
    ...(visible.has("since-last-looked")
      ? since.rows.flatMap((row) => (row.ref ? [row.ref] : []))
      : []),
  ];

  const section = (entry: ViewSectionEntry): React.ReactNode => {
    switch (entry.kind) {
      case "header-stats":
        return null;
      case "needs-you":
        return (
          <>
            <SectionHead
              className="pt-3"
              title={entry.title}
              trailing={
                waiting.length > BOARD_LIMIT ? (
                  <LinkButton label={`All ${waiting.length}`} onPress={props.onOpenInbox} />
                ) : null
              }
            />
            <FeedError what="what needs you" feed={inboxFeed} nowMs={props.nowMs} />
            {waiting.length === 0 ? (
              inboxFeed.failure ? null : (
                <EmptyLine label="Nothing needs you." />
              )
            ) : (
              <EntryCards
                entries={waiting.slice(0, BOARD_LIMIT)}
                missionId={missionId}
                list={props.list}
                nowMs={props.nowMs}
                onOpen={props.onOpenItem}
                planKey={plan?.key ?? null}
              />
            )}
            {snoozed.length > 0 ? (
              <>
                <SectionHead
                  title={`Snoozed ${snoozed.length}`}
                  trailing={
                    <LinkButton
                      label={snoozedOpen ? "Hide" : "Show"}
                      onPress={() => setSnoozedOpen(!snoozedOpen)}
                    />
                  }
                />
                {snoozedOpen ? (
                  <EntryCards
                    entries={snoozed}
                    missionId={missionId}
                    list={props.list}
                    nowMs={props.nowMs}
                    onOpen={props.onOpenItem}
                  />
                ) : null}
              </>
            ) : null}
          </>
        );
      case "your-requests":
        return (
          <>
            <SectionHead
              className="pt-3"
              title={entry.title}
              trailing={<LinkButton label="Ask" onPress={() => props.onPage("requests")} />}
            />
            <FeedError what="your requests" feed={requestsFeed} nowMs={props.nowMs} />
            {open.length === 0 ? (
              requestsFeed.failure ? null : (
                <EmptyLine label="Nothing open." />
              )
            ) : (
              <RequestRows
                requests={open.slice(0, BOARD_LIMIT)}
                nowMs={props.nowMs}
                onOpen={props.onOpenRequest}
              />
            )}
          </>
        );
      case "since-last-looked":
        return (
          <>
            <SectionHead
              className="pt-3"
              title={entry.title}
              trailing={
                <View className="flex-row items-center gap-3">
                  {since.mark ? <Meta>{since.mark}</Meta> : null}
                  {since.canMarkSeen ? (
                    <LinkButton
                      label="Mark seen"
                      disabled={actions.pending}
                      onPress={actions.markSeen}
                    />
                  ) : null}
                </View>
              }
            />
            <SinceRows
              rows={since.rows}
              missionId={missionId}
              nowMs={props.nowMs}
              onFine={(callId) => actions.react(callId as CallId, "ok")}
            />
          </>
        );
      case "path-to-milestone":
        if (!toward) return null;
        return (
          <>
            <SectionHead
              className="pt-3"
              // A renamed section keeps its name; the stock one names the day.
              title={
                entry.title === VIEW_BUILTIN_SECTION_TITLES["path-to-milestone"]
                  ? toward.title
                  : entry.title
              }
              trailing={<Meta>{toward.countdown}</Meta>}
            />
            <Group>
              {toward.milestones.map((milestone, index) => (
                <Fragment key={milestone.id}>
                  {index > 0 ? <Separator /> : null}
                  <Row>
                    <Title className="flex-1">{milestone.title}</Title>
                    <Meta className={milestone.atRisk ? "text-warning-foreground" : undefined}>
                      {milestone.status}
                    </Meta>
                  </Row>
                </Fragment>
              ))}
            </Group>
          </>
        );
      case "sub-missions":
        if (stack.length === 0) return null;
        return (
          <>
            <SectionHead
              className="pt-3"
              title={entry.title}
              trailing={<Meta>{stack.length}</Meta>}
            />
            <Group>
              {stack.map((sub, index) => (
                <Fragment key={sub.id}>
                  {index > 0 ? <Separator /> : null}
                  <Row>
                    <Meta className="w-5 pt-0.5">{sub.position}</Meta>
                    <View className="pt-1.5">
                      <StateGlyph state={sub.tone} />
                    </View>
                    <Text className="flex-1 text-[15px]" numberOfLines={2}>
                      {sub.title}
                    </Text>
                    {sub.actual === null ? null : (
                      <Meta className="pt-0.5">{formatPercent(sub.actual)}</Meta>
                    )}
                  </Row>
                </Fragment>
              ))}
            </Group>
          </>
        );
      case "with-the-master":
        if (withMaster.length === 0) return null;
        return (
          <>
            <SectionHead className="pt-3" title={entry.title} />
            <EntryCards
              entries={withMaster}
              missionId={missionId}
              list={props.list}
              nowMs={props.nowMs}
              onOpen={props.onOpenItem}
            />
          </>
        );
      case "custom":
        return views ? (
          <CustomSection snapshot={views.snapshot} entry={entry} nowMs={props.nowMs} />
        ) : null;
    }
  };

  const slot = (item: BoardSlot): React.ReactNode => {
    switch (item.type) {
      case "figures":
        return (
          <Figures
            figures={boardFigures(props.overview, requests, props.nowMs)}
            wide={props.wide}
          />
        );
      case "pinned":
        return views ? (
          <PinnedStrip
            views={views}
            entry={item.entry}
            rows={
              item.kind === "needs-you"
                ? { kind: "entries", entries: waiting }
                : { kind: "requests", requests: unread }
            }
            list={props.list}
            nowMs={props.nowMs}
            onOpenAll={
              item.kind === "needs-you" ? props.onOpenInbox : () => props.onPage("requests")
            }
            onOpenItem={props.onOpenItem}
            onOpenRequest={props.onOpenRequest}
          />
        ) : null;
      case "lanes":
        return (
          <>
            <SectionHead
              className="pt-3"
              title="Lanes"
              trailing={<LinkButton label="All" onPress={() => props.onPage("lanes")} />}
            />
            {problems.length === 0 ? (
              <EmptyLine label="No lane is stuck or waiting." />
            ) : (
              <LaneGroups
                sections={problems}
                limit={BOARD_LIMIT}
                onOpenThread={props.onOpenThread}
              />
            )}
          </>
        );
      case "discussions":
        return inbox ? (
          <OpenDiscussions missionId={missionId} shown={discussed} nowMs={props.nowMs} />
        ) : null;
      case "section":
        return section(item.entry);
    }
  };

  return (
    <Page>
      {props.tabs}
      {slots.map((item) => (
        <Fragment key={boardSlotKey(item)}>{slot(item)}</Fragment>
      ))}
    </Page>
  );
}

function Figures(props: {
  readonly figures: ReturnType<typeof boardFigures>;
  readonly wide: boolean;
}) {
  return (
    <View className="flex-row flex-wrap gap-2">
      {props.figures.map((figure) => (
        <View
          key={figure.key}
          className={
            props.wide
              ? "min-w-0 flex-1 gap-1 rounded-[18px] bg-grouped-card p-3.5"
              : "min-w-0 basis-[48%] grow gap-1 rounded-[18px] bg-grouped-card p-3.5"
          }
        >
          <Meta numberOfLines={1}>{figure.label}</Meta>
          <Text className="text-xl font-t3-semibold" numberOfLines={1}>
            {figure.value}
          </Text>
          {figure.detail ? <Meta numberOfLines={1}>{figure.detail}</Meta> : null}
        </View>
      ))}
    </View>
  );
}

/** Item rows with their discussion inline and any condition the master acted on. */
function EntryCards(props: {
  readonly entries: ReadonlyArray<InboxEntry>;
  readonly missionId: MissionId;
  readonly list: MissionListSnapshot | undefined;
  readonly nowMs: number;
  readonly onOpen: (entry: InboxEntry) => void;
  readonly planKey?: string | null;
}) {
  return (
    <Group>
      {props.entries.map((entry, index) => {
        const condition =
          "onOwnerCondition" in entry.record ? ownerConditionOf(entry.record) : null;
        return (
          <Fragment key={entry.key}>
            {index > 0 ? <Separator /> : null}
            <EntryRow
              entry={entry}
              list={props.list}
              nowMs={props.nowMs}
              selected={false}
              onOpen={() => props.onOpen(entry)}
              {...(entry.key === props.planKey ? { tag: PLAN_KICKER } : {})}
            />
            <View className="gap-2 px-3.5 pb-3">
              {condition ? <ConditionQuote quote={condition.quote} /> : null}
              <DiscussionPanel
                missionId={props.missionId}
                subject={entrySubject(entry)}
                nowMs={props.nowMs}
              />
            </View>
          </Fragment>
        );
      })}
    </Group>
  );
}

function SinceRows(props: {
  readonly rows: ReadonlyArray<SinceRow>;
  readonly missionId: MissionId;
  readonly nowMs: number;
  readonly onFine: (callId: string) => void;
}) {
  if (props.rows.length === 0) return <EmptyLine label="Nothing new." />;
  const shown = props.rows;
  return (
    <>
      <Group>
        {shown.map((row, index) => (
          <Fragment key={row.key}>
            {index > 0 ? <Separator /> : null}
            <View className="gap-2 px-3.5 py-3">
              <View className="flex-row items-start gap-3">
                <Meta className="w-14 pt-0.5">{row.time}</Meta>
                <View className="min-w-0 flex-1 gap-1">
                  <Text className="text-[15px]">{row.summary}</Text>
                  <View className="flex-row flex-wrap gap-2">
                    <Chip label={row.label} />
                    {row.count > 1 ? <Chip label={`${row.count} times`} /> : null}
                  </View>
                </View>
              </View>
              {row.ref ? (
                <View className="ml-[68px] gap-2">
                  {row.callId ? (
                    <View className="flex-row">
                      <ActionButton
                        label="Fine"
                        onPress={() => row.callId && props.onFine(row.callId)}
                      />
                    </View>
                  ) : null}
                  <DiscussionPanel
                    missionId={props.missionId}
                    subject={row.ref}
                    nowMs={props.nowMs}
                  />
                </View>
              ) : null}
            </View>
          </Fragment>
        ))}
      </Group>
    </>
  );
}

// ---------------------------------------------------------------------------
// Your requests

function RequestsPage(props: PageProps) {
  const missionId = props.overview.mission.id;
  const requests = useYourRequests(missionId);
  const requestsFeed = useOwnerRequestsFeed(missionId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showSettled, setShowSettled] = useState(false);
  const open = (requestId: string) =>
    props.wide ? setSelectedId(requestId) : props.onOpenRequest(requestId);
  const composer = useRequestComposer(missionId, (request) => open(request.id));
  const groups = groupRequests(requests ?? []);
  const selected = props.wide ? (selectedId ?? groups.open[0]?.id ?? null) : null;

  const list = (
    <Page>
      {props.tabs}
      <RequestEditor
        key={props.askKey}
        draft={composer.draft}
        placeholder="Ask or tell the master"
        autoFocus={props.askKey > 0}
      >
        <ActionButton
          label="Send"
          primary
          disabled={composer.pending || composer.draft.empty}
          onPress={composer.send}
        />
      </RequestEditor>
      <FeedError what="your requests" feed={requestsFeed} nowMs={props.nowMs} />
      {requests === undefined ? (
        requestsFeed.failure ? null : (
          <LoadingLine />
        )
      ) : groups.open.length === 0 ? (
        <EmptyLine label="Nothing open." />
      ) : (
        <>
          <SectionHead className="pt-3" title="Open" />
          <RequestRows
            requests={groups.open}
            nowMs={props.nowMs}
            selectedId={selected}
            onOpen={open}
          />
        </>
      )}
      {groups.settled.length > 0 ? (
        <>
          <SectionHead
            className="pt-3"
            title={`Settled ${groups.settled.length}`}
            trailing={
              <LinkButton
                label={showSettled ? "Hide" : "Show"}
                onPress={() => setShowSettled(!showSettled)}
              />
            }
          />
          {showSettled ? (
            <RequestRows
              requests={groups.settled}
              nowMs={props.nowMs}
              selectedId={selected}
              onOpen={open}
            />
          ) : null}
        </>
      ) : null}
    </Page>
  );

  if (!props.wide) return list;
  return (
    <View className="flex-1 flex-row">
      <View className="w-[320px] border-r border-border">{list}</View>
      <View className="flex-1">
        {selected ? (
          <RequestReader
            key={selected}
            missionId={missionId}
            requestId={selected}
            nowMs={props.nowMs}
            bottomInset={props.bottomInset}
          />
        ) : (
          <EmptyLine label="Nothing open." />
        )}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Lanes

function LanesPage(props: PageProps) {
  const lanes = useMissionLanes(props.overview.mission.id);
  const sections = laneSections(lanes ?? [], props.nowMs);
  return (
    <Page>
      {props.tabs}
      {lanes === undefined ? (
        <LoadingLine />
      ) : sections.length === 0 ? (
        <EmptyLine label="No lanes yet." />
      ) : (
        <LaneGroups sections={sections} onOpenThread={props.onOpenThread} />
      )}
      {/* ardud missions: crw-threads */}
      <ReviewThreads {...props} />
    </Page>
  );
}

const CLOSED_SHOWN = 5;

/** Threads crw runs for the mission's PRs; they live here, not in the thread list. */
function ReviewThreads(props: PageProps) {
  const groups = attachedThreadGroups(props.overview.attachedThreads);
  const actions = useOverviewActions(props.overview);
  const [all, setAll] = useState(false);
  if (groups.open.length === 0 && groups.closed.length === 0) return null;
  const rows = [...groups.open, ...(all ? groups.closed : groups.closed.slice(0, CLOSED_SHOWN))];
  const hidden = groups.open.length + groups.closed.length - rows.length;
  return (
    <View className="gap-2">
      <SectionHead
        title={`Reviews ${groups.open.length}`}
        trailing={
          hidden > 0 ? <LinkButton label={`${hidden} more`} onPress={() => setAll(true)} /> : null
        }
      />
      <Group>
        {rows.map((row, index) => (
          <Fragment key={row.threadId}>
            {index > 0 ? <Separator /> : null}
            <Row accessibilityLabel={row.title} onPress={() => props.onOpenThread(row.threadId)}>
              <Text className="min-w-0 flex-1 text-[15px] font-t3-medium" numberOfLines={1}>
                {row.title}
              </Text>
              <LinkButton
                label="Detach"
                accessibilityLabel={`Detach ${row.title}`}
                disabled={actions.pending}
                onPress={() => actions.detachThread(row.threadId, row.title)}
              />
            </Row>
          </Fragment>
        ))}
      </Group>
    </View>
  );
}

function LaneGroups(props: {
  readonly sections: ReadonlyArray<LaneSection>;
  readonly limit?: number;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  return (
    <View className="gap-3">
      {props.sections.map((section) => (
        <View key={section.key} className="gap-2">
          <SectionHead title={`${section.label} ${section.rows.length}`} />
          <Group>
            {section.rows.slice(0, props.limit ?? section.rows.length).map((lane, index) => {
              const threadId = lane.threadId;
              return (
                <Fragment key={lane.id}>
                  {index > 0 ? <Separator /> : null}
                  <Row
                    accessibilityLabel={`${lane.name}, ${section.label}`}
                    {...(threadId ? { onPress: () => props.onOpenThread(threadId) } : {})}
                  >
                    <View className="pt-1.5">
                      <StateGlyph state={lane.status} />
                    </View>
                    <View className="min-w-0 flex-1 gap-0.5">
                      <Text className="text-[15px] font-t3-medium" numberOfLines={1}>
                        {lane.name}
                      </Text>
                      <Meta numberOfLines={2}>{lane.reason ?? lane.purpose}</Meta>
                    </View>
                    {lane.age ? <Meta className="pt-0.5">{lane.age}</Meta> : null}
                  </Row>
                </Fragment>
              );
            })}
          </Group>
        </View>
      ))}
    </View>
  );
}
