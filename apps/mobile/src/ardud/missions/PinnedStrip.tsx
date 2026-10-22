import type { MissionListSnapshot } from "@t3tools/contracts";
import {
  viewSectionRequest,
  type InboxEntry,
  type MissionViewsState,
  type OwnerRequest,
  type ViewSectionEntry,
} from "@t3tools/client-runtime/ardud/missions";
import { Fragment } from "react";
import { View } from "react-native";

import { EntryRow } from "./InboxPane";
import { missionsSource } from "./missionsStore";
import { Group, LinkButton, SectionHead, Separator } from "./parts";
import { RequestRows } from "./rows";
import { useMissionAction } from "./useMissionsLogic";

const PINNED_LIMIT = 3;

/** A hidden Needs you or Your requests section that still holds something for the owner. */
export function PinnedStrip(props: {
  readonly views: MissionViewsState;
  readonly entry: ViewSectionEntry;
  readonly rows:
    | { readonly kind: "entries"; readonly entries: ReadonlyArray<InboxEntry> }
    | { readonly kind: "requests"; readonly requests: ReadonlyArray<OwnerRequest> };
  readonly list: MissionListSnapshot | undefined;
  readonly nowMs: number;
  readonly onOpenAll: () => void;
  readonly onOpenItem: (entry: InboxEntry) => void;
  readonly onOpenRequest: (requestId: string) => void;
}) {
  const action = useMissionAction();
  const count =
    props.rows.kind === "entries" ? props.rows.entries.length : props.rows.requests.length;
  if (count === 0) return null;
  const restore = () => {
    const request = viewSectionRequest(props.views.snapshot, props.entry.key, { type: "restore" });
    if (request === null) return;
    void action.run("Couldn't change the layout", () => missionsSource().changeView(request));
  };
  return (
    <>
      <SectionHead
        className="pt-3"
        title={`${props.entry.title} ${count}`}
        trailing={
          <View className="flex-row items-center gap-3">
            {count > PINNED_LIMIT ? (
              <LinkButton label={`All ${count}`} onPress={props.onOpenAll} />
            ) : null}
            <LinkButton label="Show section" disabled={action.pending} onPress={restore} />
          </View>
        }
      />
      {props.rows.kind === "entries" ? (
        <Group>
          {props.rows.entries.slice(0, PINNED_LIMIT).map((entry, index) => (
            <Fragment key={entry.key}>
              {index > 0 ? <Separator /> : null}
              <EntryRow
                entry={entry}
                list={props.list}
                nowMs={props.nowMs}
                selected={false}
                onOpen={() => props.onOpenItem(entry)}
              />
            </Fragment>
          ))}
        </Group>
      ) : (
        <RequestRows
          requests={props.rows.requests.slice(0, PINNED_LIMIT)}
          nowMs={props.nowMs}
          onOpen={props.onOpenRequest}
        />
      )}
    </>
  );
}
