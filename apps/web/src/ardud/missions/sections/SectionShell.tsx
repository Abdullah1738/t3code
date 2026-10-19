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
  TypeIcon,
  Undo2Icon,
} from "lucide-react";

import type { MissionId } from "@t3tools/contracts";
import {
  canChangeViewTab,
  canRemoveViewSection,
  viewSectionMoves,
  type MissionViewsState,
  type ResolvedViewLayout,
  type ViewSectionEntry,
  type ViewTabEntry,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
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
import { askAboutSection, changeSection } from "../missionCommands";
import { SampleMark } from "../MissionSection";

// The frame every overview section shares: one header row (title, a count or
// meta element, an aside action, the section menu) and the body. No box.

/** What a section menu opens inline under its row. */
export type SectionForm = "rename" | "discuss" | "change" | null;

export function SectionShell(props: {
  missionId: MissionId;
  views: MissionViewsState;
  layout: ResolvedViewLayout;
  section: ViewSectionEntry;
  /** Shown instead of the record's title (Path to a dated milestone). */
  title?: string;
  /** Count glyph or meta element right of the title. */
  meta?: ReactNode;
  /** One quiet action before the menu (Inbox, Mark seen). */
  aside?: ReactNode;
  sample?: boolean;
  children: ReactNode;
}) {
  const title = props.title ?? props.section.title;
  const headingId = `mission-section-${props.section.key}`;
  const [form, setForm] = useState<SectionForm>(null);
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
            views={props.views}
            layout={props.layout}
            section={props.section}
            onForm={setForm}
          />
        </div>
      </div>
      <SectionFormRow
        form={form}
        missionId={props.missionId}
        views={props.views}
        entryKey={props.section.key}
        title={props.section.title}
        onDone={() => setForm(null)}
      />
      {props.children}
    </section>
  );
}

function MenuButton(props: { title: string }) {
  return (
    <MenuTrigger
      render={<Button size="icon-xs" variant="ghost-muted" aria-label={`${props.title} menu`} />}
    >
      <EllipsisIcon aria-hidden />
    </MenuTrigger>
  );
}

/** Discuss and "Ask the master to change", shared by section and tab menus. */
function TalkItems(props: { onForm: (form: SectionForm) => void }) {
  return (
    <>
      <MenuItem onClick={() => props.onForm("discuss")}>
        <MessagesSquareIcon aria-hidden />
        Discuss
      </MenuItem>
      <MenuItem onClick={() => props.onForm("change")}>
        <PencilLineIcon aria-hidden />
        Ask the master to change
      </MenuItem>
    </>
  );
}

/**
 * Hide / Move / Rename / Discuss / Ask the master to change / Remove. A hidden
 * section offers Show instead of Hide and Move; a removed one Restore.
 */
export function SectionMenu(props: {
  views: MissionViewsState;
  layout: ResolvedViewLayout;
  section: ViewSectionEntry;
  onForm: (form: SectionForm) => void;
}) {
  const { views, layout, section } = props;
  const shown = !section.hidden && !section.removed;
  const moves = shown ? viewSectionMoves(layout, section.key) : null;
  const change = (next: Parameters<typeof changeSection>[2]) =>
    void changeSection(views, section.key, next);
  return (
    <Menu>
      <MenuButton title={section.title} />
      <MenuPopup align="end">
        {section.removed ? (
          <MenuItem onClick={() => change({ type: "restore" })}>
            <Undo2Icon aria-hidden />
            Restore
          </MenuItem>
        ) : section.hidden ? (
          <MenuItem onClick={() => change({ type: "show" })}>
            <EyeIcon aria-hidden />
            Show
          </MenuItem>
        ) : (
          <MenuItem onClick={() => change({ type: "hide" })}>
            <EyeOffIcon aria-hidden />
            Hide
          </MenuItem>
        )}
        {moves && (moves.up || moves.down || moves.across) ? (
          <MenuSub>
            <MenuSubTrigger>
              <ArrowUpDownIcon aria-hidden />
              Move
            </MenuSubTrigger>
            <MenuSubPopup>
              <MenuItem
                disabled={moves.up === null}
                onClick={() => moves.up !== null && change(moves.up)}
              >
                <ArrowUpIcon aria-hidden />
                Up
              </MenuItem>
              <MenuItem
                disabled={moves.down === null}
                onClick={() => moves.down !== null && change(moves.down)}
              >
                <ArrowDownIcon aria-hidden />
                Down
              </MenuItem>
              {moves.across ? (
                <MenuItem onClick={() => moves.across !== null && change(moves.across)}>
                  <ArrowLeftRightIcon aria-hidden />
                  {moves.acrossLabel}
                </MenuItem>
              ) : null}
            </MenuSubPopup>
          </MenuSub>
        ) : null}
        {section.removed ? null : (
          <MenuItem onClick={() => props.onForm("rename")}>
            <TypeIcon aria-hidden />
            Rename
          </MenuItem>
        )}
        <TalkItems onForm={props.onForm} />
        {!section.removed && canRemoveViewSection(section) ? (
          <>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={() => change({ type: "remove" })}>
              <Trash2Icon aria-hidden />
              Remove
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/** Show or hide a mission tab, rename it, or talk about it. The Views tab always stays. */
export function TabMenu(props: {
  views: MissionViewsState;
  tab: ViewTabEntry;
  onForm: (form: SectionForm) => void;
}) {
  const { views, tab } = props;
  const change = (next: Parameters<typeof changeSection>[2]) =>
    void changeSection(views, tab.key, next);
  return (
    <Menu>
      <MenuButton title={`${tab.title} tab`} />
      <MenuPopup align="end">
        {canChangeViewTab(tab) ? (
          tab.hidden ? (
            <MenuItem onClick={() => change({ type: "show" })}>
              <EyeIcon aria-hidden />
              Show
            </MenuItem>
          ) : (
            <MenuItem onClick={() => change({ type: "hide" })}>
              <EyeOffIcon aria-hidden />
              Hide
            </MenuItem>
          )
        ) : null}
        <MenuItem onClick={() => props.onForm("rename")}>
          <TypeIcon aria-hidden />
          Rename
        </MenuItem>
        <TalkItems onForm={props.onForm} />
      </MenuPopup>
    </Menu>
  );
}

/** The inline form a section or tab menu opened, if any. */
export function SectionFormRow(props: {
  form: SectionForm;
  missionId: MissionId;
  views: MissionViewsState;
  entryKey: string;
  title: string;
  onDone: () => void;
}) {
  switch (props.form) {
    case null:
      return null;
    case "rename":
      return (
        <RenameForm
          views={props.views}
          entryKey={props.entryKey}
          title={props.title}
          onDone={props.onDone}
        />
      );
    case "discuss":
    case "change":
      return (
        <AskMasterForm
          missionId={props.missionId}
          title={props.title}
          kind={props.form}
          onDone={props.onDone}
        />
      );
  }
}

/** An empty name goes back to the built-in title. */
function RenameForm(props: {
  views: MissionViewsState;
  entryKey: string;
  title: string;
  onDone: () => void;
}) {
  const [text, setText] = useState(props.title);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const title = text.trim();
    if (title === props.title) return props.onDone();
    setBusy(true);
    const done = await changeSection(props.views, props.entryKey, {
      type: "rename",
      title: title === "" ? null : title,
    });
    setBusy(false);
    if (done) props.onDone();
  };
  return (
    <form
      className="flex max-w-120 min-w-0 items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <Input
        size="sm"
        autoFocus
        aria-label={`New name for ${props.title}`}
        value={text}
        maxLength={60}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") props.onDone();
        }}
      />
      <Button type="submit" size="sm" disabled={busy}>
        Rename
      </Button>
      <Button type="button" size="sm" variant="ghost-muted" onClick={props.onDone}>
        Cancel
      </Button>
    </form>
  );
}

/** Inline Discuss or "Ask the master to change": sends an owner request. */
export function AskMasterForm(props: {
  missionId: MissionId;
  title: string;
  kind: "discuss" | "change";
  onDone: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    const sent = await askAboutSection(props.missionId, props.title, props.kind, text);
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
        aria-label={
          props.kind === "discuss"
            ? `What to discuss about ${props.title}`
            : `What should change in ${props.title}`
        }
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="flex items-center gap-1.5">
        <Button type="submit" size="sm" disabled={busy || text.trim() === ""}>
          <SendIcon aria-hidden />
          {props.kind === "discuss" ? "Discuss" : "Ask the master"}
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
