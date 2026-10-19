import { useState, type ReactNode } from "react";
import {
  ArrowDownIcon,
  ArrowLeftRightIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  EllipsisIcon,
  EyeIcon,
  EyeOffIcon,
  MessagesSquareIcon,
  PencilLineIcon,
  SendIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react";

import type { MissionId } from "@t3tools/contracts";
import {
  canRemoveSection,
  sectionMoves,
  sectionTitle,
  type MissionLayout,
  type SectionEntry,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../../components/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../../../components/ui/menu";
import { Textarea } from "../../../components/ui/textarea";
import { askSectionChange, changeSection, discussSection } from "../missionCommands";
import { SampleMark } from "../MissionSection";

// The frame every overview section shares: one header row (title, a count or
// meta element, an aside action, the section menu) and the body. No box.

export function SectionShell(props: {
  missionId: MissionId;
  layout: MissionLayout;
  section: SectionEntry;
  /** Count glyph or meta element right of the title. */
  meta?: ReactNode;
  /** One quiet action before the menu (Inbox, Mark seen). */
  aside?: ReactNode;
  sample?: boolean;
  children: ReactNode;
}) {
  const title = sectionTitle(props.section);
  const headingId = `mission-section-${props.section.key}`;
  const [asking, setAsking] = useState(false);
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2.5">
      <div className="flex min-h-7 min-w-0 items-center gap-2.5">
        <h2 id={headingId} className="truncate text-sm font-semibold text-foreground">
          {title}
        </h2>
        {props.meta}
        {props.sample ? <SampleMark /> : null}
        <div className="ms-auto flex shrink-0 items-center gap-1">
          {props.aside}
          <SectionMenu
            missionId={props.missionId}
            layout={props.layout}
            section={props.section}
            onAsk={() => setAsking(true)}
          />
        </div>
      </div>
      {asking ? (
        <AskMasterForm
          missionId={props.missionId}
          section={props.section}
          onDone={() => setAsking(false)}
        />
      ) : null}
      {props.children}
    </section>
  );
}

/**
 * Hide / Move / Discuss / Ask the master to change / Remove. A hidden section
 * offers Show instead of Hide and Move; a removed one only Restore and Discuss.
 */
export function SectionMenu(props: {
  missionId: MissionId;
  layout: MissionLayout;
  section: SectionEntry;
  onAsk: () => void;
}) {
  const { missionId, layout, section } = props;
  const shown = !section.hidden && !section.removed;
  const moves = shown ? sectionMoves(layout, section.key) : null;
  const title = sectionTitle(section);
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="icon-xs" variant="ghost-muted" aria-label={`${title} section menu`} />
        }
      >
        <EllipsisIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end">
        {section.removed ? (
          <MenuItem onClick={() => void changeSection(missionId, section.key, { type: "restore" })}>
            <Undo2Icon aria-hidden />
            Restore
          </MenuItem>
        ) : section.hidden ? (
          <MenuItem onClick={() => void changeSection(missionId, section.key, { type: "show" })}>
            <EyeIcon aria-hidden />
            Show
          </MenuItem>
        ) : (
          <MenuItem onClick={() => void changeSection(missionId, section.key, { type: "hide" })}>
            <EyeOffIcon aria-hidden />
            Hide
          </MenuItem>
        )}
        {moves ? (
          <MenuSub>
            <MenuSubTrigger>
              <ArrowUpDownIcon aria-hidden />
              Move
            </MenuSubTrigger>
            <MenuSubPopup>
              <MenuItem
                disabled={moves.up === null}
                onClick={() =>
                  moves.up !== null &&
                  void changeSection(missionId, section.key, {
                    type: "move",
                    region: section.region,
                    index: moves.up,
                  })
                }
              >
                <ArrowUpIcon aria-hidden />
                Up
              </MenuItem>
              <MenuItem
                disabled={moves.down === null}
                onClick={() =>
                  moves.down !== null &&
                  void changeSection(missionId, section.key, {
                    type: "move",
                    region: section.region,
                    index: moves.down,
                  })
                }
              >
                <ArrowDownIcon aria-hidden />
                Down
              </MenuItem>
              <MenuItem
                onClick={() =>
                  void changeSection(missionId, section.key, {
                    type: "move",
                    region: moves.other,
                    index: 0,
                  })
                }
              >
                <ArrowLeftRightIcon aria-hidden />
                {moves.other === "rail" ? "To the side column" : "To the main column"}
              </MenuItem>
            </MenuSubPopup>
          </MenuSub>
        ) : null}
        <MenuItem onClick={() => void discussSection(missionId, section)}>
          <MessagesSquareIcon aria-hidden />
          Discuss
        </MenuItem>
        {section.removed ? null : (
          <MenuItem onClick={props.onAsk}>
            <PencilLineIcon aria-hidden />
            Ask the master to change
          </MenuItem>
        )}
        {!section.removed && canRemoveSection(section) ? (
          <>
            <MenuSeparator />
            <MenuItem
              variant="destructive"
              onClick={() => void changeSection(missionId, section.key, { type: "remove" })}
            >
              <Trash2Icon aria-hidden />
              Remove
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/** Inline "Ask the master to change" form under a section header or Views row. */
export function AskMasterForm(props: {
  missionId: MissionId;
  section: SectionEntry;
  onDone: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    const sent = await askSectionChange(props.missionId, props.section, text);
    setBusy(false);
    if (sent) props.onDone();
  };
  return (
    <form
      className="flex min-w-0 flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <Textarea
        size="sm"
        autoFocus
        aria-label={`What should change in ${sectionTitle(props.section)}`}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="flex items-center gap-1.5">
        <Button type="submit" size="sm" disabled={busy || text.trim() === ""}>
          <SendIcon aria-hidden />
          Ask the master
        </Button>
        <Button type="button" size="sm" variant="ghost-muted" onClick={props.onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Small count next to a section title; the update tint marks things that wait on the owner. */
export function SectionCount(props: { count: number; tone?: "update" | "muted"; label: string }) {
  if (props.count === 0) return null;
  return (
    <span
      className={
        props.tone === "update"
          ? "inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-update/14 px-1.5 text-xs font-medium text-update-foreground tabular-nums"
          : "text-xs text-muted-foreground tabular-nums"
      }
    >
      <span aria-hidden>{props.count}</span>
      <span className="sr-only">{props.label}</span>
    </span>
  );
}

/** "Show N more" under a list, aligned with its left edge. */
export function FoldButton(props: { hidden: number; onShow: () => void }) {
  if (props.hidden <= 0) return null;
  return (
    <Button size="xs" variant="ghost-muted" className="self-start" onClick={props.onShow}>
      Show {props.hidden} more
    </Button>
  );
}
