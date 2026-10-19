import { useMemo, useReducer, useState } from "react";
import { Link } from "@tanstack/react-router";
import { EyeOffIcon, PinIcon } from "lucide-react";

import type { MissionId } from "@t3tools/contracts";
import {
  ageView,
  entryHeadline,
  inboxUiReducer,
  INITIAL_INBOX_UI,
  masterRoutedEntries,
  ownerWaitingEntries,
  type InboxEntry,
  type MissionInboxSnapshot,
  type MissionViewsState,
  type OwnerRequest,
  type ResolvedViewLayout,
  type ViewSectionEntry,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../../components/ui/button";
import { Skeleton } from "../../../components/ui/skeleton";
import { CardList, CardListItem } from "../cards/CardFrame";
import { AgeElement, ByMarker, YouGlyph } from "../cards/chips";
import { entryCardState, InboxEntryCard, type EntryCardDeps } from "../InboxCards";
import { changeSection } from "../missionCommands";
import { useDraftNotes, useMasterRoleId, useMissionList } from "../missionsStore";
import { inboxActions } from "../useInboxScreen";
import { FoldButton, SectionCount, SectionShell } from "./SectionShell";

/** Cards shown before the "Show N more" fold. */
const FIRST_CARDS = 3;

/** Cards for entries outside the inbox page, with their own selection and editors. */
function useEntryCards(missionId: MissionId, nowMs: number) {
  const [ui, dispatch] = useReducer(inboxUiReducer, INITIAL_INBOX_UI);
  const deps: EntryCardDeps = {
    draftNotes: useDraftNotes(missionId) ?? [],
    stats: null,
    list: useMissionList(),
    masterRoleId: useMasterRoleId(missionId),
    nowMs,
    actions: inboxActions(dispatch),
  };
  return { ui, dispatch, deps };
}

function EntryCardList(props: {
  missionId: MissionId;
  entries: ReadonlyArray<InboxEntry>;
  nowMs: number;
  label: string;
}) {
  const cards = useEntryCards(props.missionId, props.nowMs);
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

/** What waits on the owner in this mission, as cards he can act on in place. */
export function NeedsYouSection(props: {
  missionId: MissionId;
  views: MissionViewsState;
  layout: ResolvedViewLayout;
  section: ViewSectionEntry;
  inbox: MissionInboxSnapshot | undefined;
  nowMs: number;
}) {
  const entries = useMemo(
    () => (props.inbox ? ownerWaitingEntries(props.inbox) : null),
    [props.inbox],
  );
  return (
    <SectionShell
      missionId={props.missionId}
      views={props.views}
      layout={props.layout}
      section={props.section}
      meta={
        entries ? (
          <SectionCount count={entries.length} tone="update" label={`${entries.length} waiting`} />
        ) : null
      }
      aside={
        <Button
          size="xs"
          variant="ghost-muted"
          render={<Link to="/missions/inbox" search={{ mission: props.missionId }} />}
        >
          Inbox
        </Button>
      }
    >
      {entries === null ? (
        <LoadingRows />
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing needs you.</p>
      ) : (
        <EntryCardList
          missionId={props.missionId}
          entries={entries}
          nowMs={props.nowMs}
          label="Waiting on you"
        />
      )}
    </SectionShell>
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
      />
    </SectionShell>
  );
}

function LoadingRows() {
  return (
    <div aria-hidden className="flex flex-col gap-3">
      <Skeleton className="h-4 w-3/5" />
      <Skeleton className="h-4 w-4/5" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pinned strip: what a hidden section would have shown, kept under the head

interface PinnedRow {
  readonly key: string;
  readonly kicker: string;
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
        ? ownerWaitingEntries(props.inbox).map((entry) => ({
            key: entry.key,
            ...entryHeadline(entry),
            requestId: null,
          }))
        : [];
    }
    return (props.requests ?? []).map((request) => ({
      key: request.id,
      kicker: "Answered",
      title: request.title,
      since: request.updatedAt,
      requestId: request.id,
    }));
  }, [props.kind, props.inbox, props.requests]);
  if (!section || rows.length === 0) return null;
  const title = section.title;
  // The layout's last author; a starter layout never hides a section.
  const by = props.layout.by === "owner" ? "owner" : "master";
  return (
    <section
      aria-label={`${title}, pinned`}
      className="grid min-w-0 gap-2 rounded-lg bg-update/8 px-3 pt-2.5 pb-3"
    >
      <div className="flex min-h-7 min-w-0 items-center gap-2">
        <PinIcon aria-hidden className="size-3.5 shrink-0 text-update-foreground" />
        <h2 className="truncate text-sm font-semibold">{title}</h2>
        <SectionCount count={rows.length} tone="update" label={`${rows.length} pinned`} />
        <EyeOffIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <ByMarker
          by={by}
          label={by === "owner" ? "Section hidden by you" : "Section hidden by the master"}
        />
        <Button
          size="xs"
          variant="ghost-muted"
          className="ms-auto"
          onClick={() => void changeSection(props.views, section.key, { type: "restore" })}
        >
          Show section
        </Button>
      </div>
      <ul className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-x-7 gap-y-1.5">
        {rows.map((row) => {
          const age = ageView(row.since, props.nowMs);
          return (
            <li
              key={row.key}
              className="grid min-w-0 grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2"
            >
              <YouGlyph className="size-2.5 text-update-foreground" />
              {row.requestId ? (
                <Link
                  to="/missions/$missionId"
                  params={{ missionId: props.missionId }}
                  search={{ request: row.requestId }}
                  className={PINNED_LINK_CLASS}
                >
                  <PinnedLabel row={row} />
                </Link>
              ) : (
                <Link
                  to="/missions/inbox"
                  search={{ mission: props.missionId }}
                  className={PINNED_LINK_CLASS}
                >
                  <PinnedLabel row={row} />
                </Link>
              )}
              {age ? <AgeElement age={age} at={row.since} /> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const PINNED_LINK_CLASS =
  "flex min-w-0 items-baseline gap-1.5 rounded-sm text-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function PinnedLabel(props: { row: PinnedRow }) {
  return (
    <>
      <span className="shrink-0 text-xs font-medium text-muted-foreground">{props.row.kicker}</span>
      <span className="min-w-0 truncate">{props.row.title}</span>
    </>
  );
}
