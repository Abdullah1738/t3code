import { useState } from "react";

import {
  formatPercent,
  INTENDED_EFFORT_SOURCE_LABEL,
  type PriorityStackRow,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../../components/ui/popover";
import { handBackIntendedShare, setIntendedShare } from "./missionCommands";

// Presentation plus form state. Parsing and the source call live in
// missionCommands; the source locks the field on an owner edit.

/**
 * The intended share on one priority-stack row: who set it and an editor.
 * The master proposes; an owner edit locks the field until handed back.
 */
export function IntendedShareEditor(props: { row: PriorityStackRow }) {
  const { row } = props;
  const sub = row.subMission;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (action: Promise<boolean>) => {
    setBusy(true);
    const sent = await action;
    setBusy(false);
    if (sent) setOpen(false);
  };
  const submit = () => void run(setIntendedShare(sub.id, text));
  const handBack = () => void run(handBackIntendedShare(sub.id));

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setText(row.intended === null ? "" : String(Math.round(row.intended * 100)));
      }}
    >
      <PopoverTrigger
        render={<Button variant="ghost" size="xs" />}
        aria-label={`Intended share for ${sub.title}: ${
          row.intended === null ? "none" : formatPercent(row.intended)
        }, ${INTENDED_EFFORT_SOURCE_LABEL[row.intendedBy]}`}
      >
        {row.intended === null ? "set share" : formatPercent(row.intended)}
        <span className="text-muted-foreground">
          {INTENDED_EFFORT_SOURCE_LABEL[row.intendedBy]}
        </span>
      </PopoverTrigger>
      <PopoverPopup align="end" side="bottom" className="w-64">
        <PopoverTitle>Intended share for {sub.title}</PopoverTitle>
        <form
          className="mt-2 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Input
            size="sm"
            aria-label="Share in percent"
            inputMode="decimal"
            placeholder="e.g. 40"
            autoFocus
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Your value locks the field; the master can't overwrite it.
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            {row.intendedBy === "owner" ? (
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={handBack}>
                Hand back to master
              </Button>
            ) : null}
            <Button type="submit" size="sm" disabled={busy}>
              Save
            </Button>
          </div>
        </form>
      </PopoverPopup>
    </Popover>
  );
}
