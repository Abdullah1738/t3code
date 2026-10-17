import { useState } from "react";

import type { MissionId } from "@t3tools/contracts";
import {
  askTheMissionInput,
  FORK_KIND_LABEL,
  forkTitle,
  formatRelative,
  splitForks,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { runMissionAction, submitMissionInput } from "./missionActions";
import { missionsSource, useMissionForks } from "./missionsStore";

// Presentation over `useMissionForks`; the only logic is calling the source.

/**
 * Open forks of the master (Discuss threads and the owner's side questions).
 * Fork threads are placeholders in the fixture, so there is no thread link yet.
 */
export function MissionForksList(props: { missionId: MissionId | null; nowMs: number }) {
  const forks = useMissionForks(props.missionId);
  if (!forks) return null;
  const { open } = splitForks(forks);
  if (open.length === 0) {
    return <p className="text-sm text-muted-foreground">No open discussions.</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {open.map((entry) => (
        <li key={entry.fork.id} className="flex items-start gap-2 text-sm">
          <div className="min-w-0 flex-1">
            <p className="truncate text-foreground">{forkTitle(entry)}</p>
            <p className="text-xs text-muted-foreground">
              {FORK_KIND_LABEL[entry.fork.kind]} · opened{" "}
              {formatRelative(entry.fork.createdAt, props.nowMs)} · thread not connected yet
            </p>
          </div>
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void runMissionAction(
                missionsSource.archiveFork({ forkId: entry.fork.id }),
                "Couldn't close the discussion",
              )
            }
          >
            Close
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** "Ask the mission": a side question answered by a fork of the master. */
export function AskTheMissionForm(props: { missionId: MissionId; onAsked?: () => void }) {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const ask = async () => {
    setBusy(true);
    const sent = await submitMissionInput(
      askTheMissionInput(props.missionId, question),
      (input) => missionsSource.openFork(input),
      "Couldn't ask the mission",
    );
    setBusy(false);
    if (!sent) return;
    setQuestion("");
    props.onAsked?.();
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void ask();
      }}
    >
      <Textarea
        size="sm"
        aria-label="Question for the mission"
        placeholder="A fork of the master answers; the master gets a one-line summary."
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
      />
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={busy || question.trim() === ""}>
          Ask
        </Button>
      </div>
    </form>
  );
}
