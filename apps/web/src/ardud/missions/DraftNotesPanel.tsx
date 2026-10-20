import { useState } from "react";

import type { DraftChannel, MissionId } from "@t3tools/contracts";
import {
  DRAFT_CHANNEL_LABEL,
  DRAFT_CHANNELS,
  groupDraftNotes,
  type DraftNoteScopeChoice,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import { addDraftNote, setDraftNoteActive } from "./missionCommands";
import { useDraftNotes } from "./missionsStore";

// Draft notes ("how I want drafts to be"): list, add, turn off. Presentation
// plus form state; grouping comes from client-runtime, actions from
// missionCommands.

type ScopeKind = DraftNoteScopeChoice["kind"];

const SCOPE_KIND_LABEL: Record<ScopeKind, string> = {
  all: "All drafts",
  channel: "One channel",
  person: "One person",
};

export function DraftNotesPanel(props: { missionId: MissionId | null }) {
  const notes = useDraftNotes(props.missionId);
  if (!notes) return null;
  const groups = groupDraftNotes(notes);
  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => (
        <div key={group.key} className="flex flex-col gap-1">
          <h3 className="text-xs font-medium text-(--m-muted)">{group.label}</h3>
          <ul className="flex flex-col gap-1">
            {group.notes.map((note) => (
              <li key={note.id} className="flex items-start gap-2 text-sm">
                <Switch
                  size="sm"
                  aria-label={note.active ? "Turn off" : "Turn on"}
                  checked={note.active}
                  onCheckedChange={(active) => void setDraftNoteActive(note.id, active)}
                />
                <span className={note.active ? "text-(--m-text)" : "text-(--m-muted)"}>
                  {note.text}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <AddDraftNoteForm missionId={props.missionId} />
    </div>
  );
}

function AddDraftNoteForm(props: { missionId: MissionId | null }) {
  const [kind, setKind] = useState<ScopeKind>("all");
  const [channel, setChannel] = useState<DraftChannel>("github");
  const [person, setPerson] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const scope: DraftNoteScopeChoice =
    kind === "all" ? { kind } : kind === "channel" ? { kind, channel } : { kind, name: person };
  const add = async () => {
    setBusy(true);
    const sent = await addDraftNote(props.missionId, scope, text);
    setBusy(false);
    if (sent) setText("");
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
    >
      <div className="flex flex-wrap gap-2">
        <Select
          value={kind}
          onValueChange={(value) => {
            if (value === null) return;
            setKind(value as ScopeKind);
          }}
        >
          <SelectTrigger aria-label="Who the note applies to" size="sm" className="w-36">
            <SelectValue>{SCOPE_KIND_LABEL[kind]}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {(Object.keys(SCOPE_KIND_LABEL) as ScopeKind[]).map((value) => (
              <SelectItem key={value} value={value}>
                {SCOPE_KIND_LABEL[value]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {kind === "channel" ? (
          <Select
            value={channel}
            onValueChange={(value) => {
              if (value === null) return;
              setChannel(value as DraftChannel);
            }}
          >
            <SelectTrigger aria-label="Channel" size="sm" className="w-32">
              <SelectValue>{DRAFT_CHANNEL_LABEL[channel]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {DRAFT_CHANNELS.map((value) => (
                <SelectItem key={value} value={value}>
                  {DRAFT_CHANNEL_LABEL[value]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
        {kind === "person" ? (
          <Input
            size="sm"
            aria-label="Person"
            placeholder="First name"
            className="w-36"
            value={person}
            onChange={(event) => setPerson(event.target.value)}
          />
        ) : null}
      </div>
      <Textarea
        size="sm"
        aria-label="New draft note"
        placeholder="How you want drafts to be, e.g. “no opener, get to the point”"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="flex justify-end">
        <Button type="submit" size="sm" variant="outline" disabled={busy || text.trim() === ""}>
          Add note
        </Button>
      </div>
    </form>
  );
}
