import type { MissionId } from "@t3tools/contracts";
import { draftTitle, formatRelative } from "@t3tools/client-runtime/ardud/missions";

import { MissionSection } from "../MissionSection";
import { useMissionInboxHistory } from "../missionsStore";
import { TextBlock } from "./blocks";

/** Drafts the master took back from the owner, with why. */
export function WithdrawnDrafts(props: { missionId: MissionId | null; nowMs: number }) {
  const history = useMissionInboxHistory(props.missionId);
  const withdrawn = (history?.drafts ?? []).filter(
    (draft) => draft.status === "dropped" && (draft.withdrawNote ?? "").trim() !== "",
  );
  if (withdrawn.length === 0) return null;
  return (
    <MissionSection title="Withdrawn">
      {withdrawn.map((draft) => (
        <div key={draft.id} className="flex min-w-0 flex-col gap-0.5">
          <p className="flex min-w-0 items-center gap-1.5 text-sm">
            <span className="min-w-0 truncate font-medium">{draftTitle(draft)}</span>
            {draft.decidedAt ? (
              <time
                dateTime={draft.decidedAt}
                className="ms-auto shrink-0 text-xs text-(--m-muted) tabular-nums"
              >
                {formatRelative(draft.decidedAt, props.nowMs)}
              </time>
            ) : null}
          </p>
          <TextBlock text={draft.withdrawNote ?? ""} tone="meta" maxLines={2} />
        </div>
      ))}
    </MissionSection>
  );
}
