import type { InboxMark, MissionId, MissionListSnapshot } from "@t3tools/contracts";
import { markOf, type InboxEntry } from "@t3tools/client-runtime/ardud/missions";
import {
  decidedRows,
  filteredEntries,
  inboxChips,
  inboxRow,
  INBOX_EMPTY_LABEL,
  resolveInboxFilter,
  snoozedFor,
  type DecidedRowView,
  type InboxFilter,
} from "@t3tools/client-runtime/ardud/missions/mobile";
import { Fragment, useState } from "react";
import { ScrollView, View } from "react-native";

import { FeedError, LoadingLine } from "./FeedError";
import { ItemReader } from "./ItemReader";
import {
  useMissionInbox,
  useMissionInboxFeed,
  useMissionInboxHistory,
  useOwnerRequests,
} from "./missionsStore";
import {
  ChoiceRow,
  ConditionQuote,
  EmptyLine,
  Group,
  LinkButton,
  Meta,
  Row,
  SectionHead,
  Separator,
  Title,
} from "./parts";
import { InboxRowLine } from "./rows";

/**
 * The inbox: kind chips, what waits on the owner oldest first, what the
 * owner snoozed and what was decided today, both folded. On a wide screen the
 * open item reads beside the list.
 */
export function InboxPane(props: {
  readonly missionId: MissionId | null;
  readonly list: MissionListSnapshot | undefined;
  readonly filter: string | null;
  readonly onFilter: (filter: InboxFilter) => void;
  readonly onOpen: (entry: InboxEntry) => void;
  readonly wide: boolean;
  readonly nowMs: number;
  readonly bottomInset: number;
}) {
  const inbox = useMissionInbox(props.missionId);
  const feed = useMissionInboxFeed(props.missionId);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  if (!inbox) {
    return feed.failure ? (
      <FeedError what="the inbox" feed={feed} nowMs={props.nowMs} />
    ) : (
      <LoadingLine />
    );
  }

  const filter = resolveInboxFilter(props.filter, inbox, props.nowMs);
  const entries = filteredEntries(inbox, filter, props.nowMs);
  const snoozed = snoozedFor(inbox, filter, props.nowMs);
  const selected = props.wide
    ? ([...entries, ...snoozed].find((entry) => entry.key === selectedKey) ?? entries[0] ?? null)
    : null;
  const rows = (items: ReadonlyArray<InboxEntry>) => (
    <Group>
      {items.map((entry, index) => (
        <Fragment key={entry.key}>
          {index > 0 ? <Separator /> : null}
          <EntryRow
            entry={entry}
            list={props.list}
            nowMs={props.nowMs}
            selected={selected?.key === entry.key}
            onOpen={() => (props.wide ? setSelectedKey(entry.key) : props.onOpen(entry))}
          />
        </Fragment>
      ))}
    </Group>
  );

  const list = (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-3 px-4 pb-8 pt-3"
      keyboardShouldPersistTaps="handled"
    >
      <FeedError what="the inbox" feed={feed} nowMs={props.nowMs} />
      <ChoiceRow
        accessibilityLabel="Inbox"
        options={inboxChips(inbox, props.nowMs)}
        selected={filter}
        onSelect={props.onFilter}
      />
      {filter === "all" ? <SectionHead title="Waiting on you" /> : null}
      {entries.length === 0 ? (
        <EmptyLine label={filter === "all" ? "Nothing waits on you." : INBOX_EMPTY_LABEL[filter]} />
      ) : (
        rows(entries)
      )}
      {snoozed.length > 0 ? (
        <View className="gap-2 pt-3">
          <SectionHead
            title={`Snoozed ${snoozed.length}`}
            trailing={
              <LinkButton
                label={snoozedOpen ? "Hide" : "Show"}
                onPress={() => setSnoozedOpen(!snoozedOpen)}
              />
            }
          />
          {snoozedOpen ? rows(snoozed) : null}
        </View>
      ) : null}
      <DecidedToday missionId={props.missionId} marks={inbox.marks} nowMs={props.nowMs} />
    </ScrollView>
  );

  if (!props.wide) return list;
  return (
    <View className="flex-1 flex-row">
      <View className="w-[384px] border-r border-border">{list}</View>
      <View className="flex-1">
        {selected ? (
          <ItemReader
            key={selected.key}
            entry={selected}
            missionId={selected.record.missionId ?? props.missionId}
            nowMs={props.nowMs}
            bottomInset={props.bottomInset}
            mark={markOf(inbox, selected.key)}
          />
        ) : (
          <EmptyLine label="Nothing open." />
        )}
      </View>
    </View>
  );
}

// Each row reads its own mission's discussions so the symbol's counter is
// right in the every-mission inbox too.
export function EntryRow(props: {
  readonly entry: InboxEntry;
  readonly list: MissionListSnapshot | undefined;
  readonly nowMs: number;
  readonly selected: boolean;
  readonly onOpen: () => void;
  /** A kind tag for the board's day one ("Approve the plan"). */
  readonly tag?: string; // ardud missions: finish-a
}) {
  const requests = useOwnerRequests(props.entry.record.missionId ?? null);
  const row = inboxRow(props.entry, props.list, props.nowMs, requests ?? []);
  return (
    <InboxRowLine
      row={props.tag ? { ...row, tag: props.tag } : row}
      selected={props.selected}
      onOpen={props.onOpen}
    />
  );
}

function DecidedToday(props: {
  readonly missionId: MissionId | null;
  readonly marks: ReadonlyArray<InboxMark> | undefined;
  readonly nowMs: number;
}) {
  const history = useMissionInboxHistory(props.missionId);
  const [open, setOpen] = useState(false);
  const rows = history ? decidedRows(history, props.nowMs, props.marks) : [];
  if (rows.length === 0) return null;
  return (
    <View className="gap-2 pt-3">
      <SectionHead
        title={`Decided today ${rows.length}`}
        trailing={<LinkButton label={open ? "Hide" : "Show"} onPress={() => setOpen(!open)} />}
      />
      {open ? (
        <Group>
          {rows.map((row, index) => (
            <Fragment key={row.key}>
              {index > 0 ? <Separator /> : null}
              <Row>
                <View className="min-w-0 flex-1 gap-1">
                  <DecidedSummary row={row} />
                  {row.comments.map((comment) => (
                    <Meta key={comment.id}>You: {comment.body}</Meta>
                  ))}
                </View>
              </Row>
            </Fragment>
          ))}
        </Group>
      ) : null}
    </View>
  );
}

/** A decided item's title, outcome, condition and, for a draft, what went out. */
export function DecidedSummary(props: { readonly row: DecidedRowView }) {
  const { row } = props;
  return (
    <>
      <View className="flex-row items-start gap-3">
        <Title className="flex-1">{row.title}</Title>
        {row.age ? <Meta className="pt-0.5">{row.age}</Meta> : null}
      </View>
      <Meta>{row.outcome}</Meta>
      {row.condition ? <ConditionQuote quote={row.condition} /> : null}
      {row.sent ? <Meta>What went out: {row.sent}</Meta> : null}
    </>
  );
}
