import { useState } from "react";

import type { MissionId } from "@t3tools/contracts";
import {
  FORK_KIND_LABEL,
  forkTitle,
  formatRelative,
  splitForks,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { askTheMission, closeFork } from "./missionCommands";
import { useMissionForks } from "./missionsStore";

// Presentation over `useMissionForks`; actions come from missionCommands.

/**
 * Open forks of the master (Discuss threads and the owner's side questions).
 * Fork threads are placeholders in the fixture, so there is no thread link yet.
 */
export function MissionForksList(props: { missionId: MissionId | null; nowMs: number }) {
  const forks = useMissionForks(props.missionId);
  if (!forks) return null;
  const { open } = splitForks(forks);
  if (open.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2">
      {open.map((entry) => (
        <li key={entry.fork.id} className="flex items-start gap-2 text-sm">
          <div className="min-w-0 flex-1">
            <p className="truncate text-foreground">{forkTitle(entry)}</p>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="font-medium">{FORK_KIND_LABEL[entry.fork.kind]}</span>
              <time dateTime={entry.fork.createdAt} className="tabular-nums">
                {formatRelative(entry.fork.createdAt, props.nowMs)}
              </time>
            </p>
          </div>
          <Button size="xs" variant="ghost" onClick={() => void closeFork(entry.fork.id)}>
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
    const sent = await askTheMission(props.missionId, question);
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
        placeholder="Your question"
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
