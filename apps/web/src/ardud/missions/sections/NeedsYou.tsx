import { useMemo, useReducer, useState } from "react";
import { Link } from "@tanstack/react-router";

import type { MissionId } from "@t3tools/contracts";
import {
  ageView,
  dayOnePlan,
  entryHeadline,
  inboxUiReducer,
  INITIAL_INBOX_UI,
  masterRoutedEntries,
  ownerWaitingEntries,
  snoozedEntries,
  type InboxEntry,
  type MissionInboxSnapshot,
  type MissionViewsState,
  type OwnerRequest,
  type ResolvedViewLayout,
  type ViewSectionEntry,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../../components/ui/button";
import { CardList, CardListItem } from "../cards/CardFrame";
import { AgeElement } from "../cards/chips";
import { entryCardState, InboxEntryCard, type EntryCardDeps } from "../InboxCards";
import { changeSection } from "../missionCommands";
import {
  useDraftNotes,
  useMasterRoleId,
  useMissionInboxFeed,
  useMissionList,
  useMissionOverview,
} from "../missionsStore";
import { inboxActions } from "../useInboxScreen";
import { FeedError } from "./FeedError";
import { FoldButton, LoadingRows, SectionCount, SectionShell } from "./SectionShell";

/** Cards shown before the "Show N more" fold. */
const FIRST_CARDS = 3;

/** Snoozing only moves what waits on the owner; Needs you shows these tabs. */
export const OWNER_WAITING_TABS = ["decide", "approve", "knocks"] as const;

/** Cards for entries outside the inbox page, with their own selection and editors. */
function useEntryCards(
  missionId: MissionId,
  nowMs: number,
  inbox: MissionInboxSnapshot | undefined,
  planKey: string | null,
) {
  const [ui, dispatch] = useReducer(inboxUiReducer, INITIAL_INBOX_UI);
  const deps: EntryCardDeps = {
    draftNotes: useDraftNotes(missionId) ?? [],
    stats: null,
    list: useMissionList(),
    masterRoleId: useMasterRoleId(missionId),
    nowMs,
    actions: inboxActions(dispatch),
    marks: inbox?.marks,
    planKey,
  };
  return { ui, dispatch, deps };
}

function EntryCardList(props: {
  missionId: MissionId;
  entries: ReadonlyArray<InboxEntry>;
  nowMs: number;
  label: string;
  inbox: MissionInboxSnapshot | undefined;
  planKey?: string | null;
}) {
  const cards = useEntryCards(props.missionId, props.nowMs, props.inbox, props.planKey ?? null);
  const [open, setOpen] = useState(false);
  const shown = open ? props.entries : props.entries.slice(0, FIRST_CARDS);
  return (
    <>
      <CardList label={props.label}>
        {shown.map((entry) => (
          <CardListItem key={entry.key}>
            <InboxEntryCard
              entry={entry}
              {...entryCardState(cards.ui, entry.key)}
              dispatch={cards.dispatch}
              deps={cards.deps}
            />
          </CardListItem>
        ))}
      </CardList>
      <FoldButton hidden={props.entries.length - shown.length} onShow={() => setOpen(true)} />
    </>
  );
}

/**
 * What waits on the owner in this mission, as cards he can act on in place.
 * On day one (no lanes yet) the master's plan leads. Snoozed items sit folded
 * under the cards with Unsnooze.
 */
export function NeedsYouSection(props: {
  missionId: MissionId;
  views: MissionViewsState;
  layout: ResolvedViewLayout;
  section: ViewSectionEntry;
  inbox: MissionInboxSnapshot | undefined;
  nowMs: number;
}) {
  const { inbox, nowMs } = props;
  const feed = useMissionInboxFeed(props.missionId);
  const lanes = useMissionOverview(props.missionId)?.lanes;
  const waiting = useMemo(() => (inbox ? ownerWaitingEntries(inbox, nowMs) : null), [inbox, nowMs]);
  const plan = waiting && lanes ? dayOnePlan(lanes, waiting) : null;
  const entries = useMemo(
    () => (waiting && plan ? [plan, ...waiting.filter((entry) => entry !== plan)] : waiting),
    [waiting, plan],
  );
  const snoozed = useMemo(
    () => (inbox ? snoozedEntries(inbox, nowMs, OWNER_WAITING_TABS) : []),
    [inbox, nowMs],
  );
  return (
    <SectionShell
      missionId={props.missionId}
      views={props.views}
      layout={props.layout}
      section={props.section}
      meta={
        entries ? (
          <SectionCount count={entries.length} zero label={`${entries.length} waiting`} />
        ) : null
      }
      aside={
        <Button
          size="sm"
          variant="ghost-muted"
          render={<Link to="/missions/inbox" search={{ mission: props.missionId }} />}
        >
          Inbox
        </Button>
      }
    >
      <FeedError what="what needs you" feed={feed} nowMs={nowMs} />
      {entries === null ? (
        feed.failure ? null : (
          <LoadingRows />
        )
      ) : entries.length === 0 ? (
        <p className="pt-3.5 pb-1 text-sm">Nothing needs you.</p>
      ) : (
        <EntryCardList
          missionId={props.missionId}
          entries={entries}
          nowMs={nowMs}
          label="Waiting on you"
          inbox={inbox}
          planKey={plan?.key ?? null}
        />
      )}
      <SnoozedCards missionId={props.missionId} entries={snoozed} nowMs={nowMs} inbox={inbox} />
    </SectionShell>
  );
}

/** The owner's snoozed holds, folded; open, each card shows its snooze and Unsnooze. */
function SnoozedCards(props: {
  missionId: MissionId;
  entries: ReadonlyArray<InboxEntry>;
  nowMs: number;
  inbox: MissionInboxSnapshot | undefined;
}) {
  const [open, setOpen] = useState(false);
  if (props.entries.length === 0) return null;
  return (
    <div className="flex flex-col pt-2">
      <FoldButton
        hidden={props.entries.length}
        expanded={open}
        label={`Snoozed ${props.entries.length}`}
        onShow={() => setOpen(!open)}
      />
      {open ? (
        <EntryCardList
          missionId={props.missionId}
          entries={props.entries}
          nowMs={props.nowMs}
          label="Snoozed"
          inbox={props.inbox}
        />
      ) : null}
    </div>
  );
}

/** Drafts, approvals and suggestions routed to the master. Hidden when there are none. */
export function WithTheMasterSection(props: {
  missionId: MissionId;
  views: MissionViewsState;
  layout: ResolvedViewLayout;
  section: ViewSectionEntry;
  inbox: MissionInboxSnapshot | undefined;
  nowMs: number;
}) {
  const entries = useMemo(
    () => (props.inbox ? masterRoutedEntries(props.inbox) : []),
    [props.inbox],
  );
  if (entries.length === 0) return null;
  return (
    <SectionShell
      missionId={props.missionId}
      views={props.views}
      layout={props.layout}
      section={props.section}
      meta={<SectionCount count={entries.length} label={`${entries.length} with the master`} />}
    >
      <EntryCardList
        missionId={props.missionId}
        entries={entries}
        nowMs={props.nowMs}
        label="With the master"
        inbox={props.inbox}
      />
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Pinned strip: what a hidden section would have shown, kept under the head

interface PinnedRow {
  readonly key: string;
  readonly title: string;
  readonly since: string;
  /** Opens the request on the overview; inbox items open the inbox. */
  readonly requestId: string | null;
}

/** One strip per hidden section that still holds something for the owner. */
export function PinnedStrip(props: {
  missionId: MissionId;
  views: MissionViewsState;
  layout: ResolvedViewLayout;
  kind: "needs-you" | "your-requests";
  inbox?: MissionInboxSnapshot | undefined;
  requests?: ReadonlyArray<OwnerRequest>;
  nowMs: number;
}) {
  const section = props.layout.setAside.find((entry) => entry.kind === props.kind);
  const rows = useMemo((): PinnedRow[] => {
    if (props.kind === "needs-you") {
      return props.inbox
        ? ownerWaitingEntries(props.inbox, props.nowMs).map((entry) => ({
            key: entry.key,
            ...entryHeadline(entry),
            requestId: null,
          }))
        : [];
    }
    return (props.requests ?? []).map((request) => ({
      key: request.id,
      title: request.title,
      since: request.updatedAt,
      requestId: request.id,
    }));
  }, [props.kind, props.inbox, props.requests, props.nowMs]);
  if (!section || rows.length === 0) return null;
  const title = section.title;
  return (
    <section
      aria-label={`${title}, pinned`}
      className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-(--m-surface) py-2.5 ps-4.5 pe-2.5"
    >
      <h2 className="flex shrink-0 items-center gap-2 text-sm font-semibold">
        {title}
        <SectionCount count={rows.length} label={`${rows.length} pinned`} />
      </h2>
      <ul className="flex min-w-0 flex-1 flex-wrap gap-2">
        {rows.map((row) => {
          const age = ageView(row.since, props.nowMs);
          return (
            <li key={row.key} className="min-w-0">
              {row.requestId ? (
                <Link
                  to="/missions/$missionId"
                  params={{ missionId: props.missionId }}
                  search={{ request: row.requestId }}
                  className={PINNED_LINK_CLASS}
                >
                  <span className="min-w-0 truncate">{row.title}</span>
                  {age ? <AgeElement age={age} at={row.since} /> : null}
                </Link>
              ) : (
                <Link
                  to="/missions/inbox"
                  search={{ mission: props.missionId }}
                  className={PINNED_LINK_CLASS}
                >
                  <span className="min-w-0 truncate">{row.title}</span>
                  {age ? <AgeElement age={age} at={row.since} /> : null}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      <Button
        size="sm"
        variant="secondary"
        className="ms-auto"
        onClick={() => void changeSection(props.views, section.key, { type: "restore" })}
      >
        Show section
      </Button>
    </section>
  );
}

const PINNED_LINK_CLASS =
  "flex h-8 max-w-80 min-w-0 items-center gap-2.5 rounded-full bg-(--m-raised) px-3.5 text-sm outline-none hover:bg-(--m-active) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
