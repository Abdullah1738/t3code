import { Link } from "@tanstack/react-router";
import { CheckIcon, LinkIcon, MessageCircleIcon, SquareKanbanIcon } from "lucide-react";
import { createContext, use, type ReactElement, type ReactNode } from "react";

import {
  kanbanLink,
  kanbanLinkOf,
  type KanbanLink,
  type KanbanLinkKind,
} from "@t3tools/client-runtime/ardud/kanban";
import { formatThreadLink } from "@t3tools/shared/threadLinks";

import ChatMarkdown from "../../components/ChatMarkdown";
import { ComposerContextChipRendererContext } from "../../components/composerContextPresentation";
import { ContextChip, ContextChipLabel } from "../../components/ContextChip";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useBoardState } from "./kanbanStore";
import type { BoardSearch } from "./search";

export interface LinkReference {
  readonly kind: string;
  readonly contextId: string;
  readonly label: string;
}

type LinkRenderer = (reference: LinkReference) => ReactElement | null;

/** A board link as a chip, live from the board; one from another board keeps its label and opens nothing. */
function KanbanLinkChip(props: { boardId: string; link: KanbanLink; label: string }) {
  const state = useBoardState(props.boardId);
  const { link } = props;
  if (link.kind === "kanban-card") {
    const card = state?.cards.get(link.id);
    if (!card) return <StaticChip kind={link.kind} label={props.label} />;
    return (
      <BoardChip
        kind={link.kind}
        boardId={props.boardId}
        label={`#${card.number} ${card.title}`}
        search={(prev) => ({ ...prev, card: card.id })}
      />
    );
  }
  const discussion = state?.discussions.get(link.id);
  if (!discussion) return <StaticChip kind={link.kind} label={props.label} />;
  return (
    <BoardChip
      kind={link.kind}
      boardId={props.boardId}
      label={discussion.title}
      search={(prev) => {
        const { card: _card, ...rest } = prev;
        return { ...rest, view: "discussions", discussion: discussion.id };
      }}
    />
  );
}

const CHIP_KIND = { "kanban-card": "mention", "kanban-discussion": "thread" } as const;

function ChipIcon(props: { kind: KanbanLinkKind }) {
  return props.kind === "kanban-card" ? <SquareKanbanIcon /> : <MessageCircleIcon />;
}

function BoardChip(props: {
  kind: KanbanLinkKind;
  boardId: string;
  label: string;
  search: (prev: BoardSearch) => BoardSearch;
}) {
  return (
    <ContextChip
      kind={CHIP_KIND[props.kind]}
      render={
        <Link
          to="/boards/$boardId"
          params={{ boardId: props.boardId }}
          search={(prev) => props.search(prev as BoardSearch)}
        />
      }
      className="no-underline"
    >
      <ChipIcon kind={props.kind} />
      <ContextChipLabel>{props.label}</ContextChipLabel>
    </ContextChip>
  );
}

function StaticChip(props: { kind: KanbanLinkKind; label: string }) {
  return (
    <ContextChip
      kind={CHIP_KIND[props.kind]}
      state="unresolved"
      aria-label={`${props.label}, not on this board`}
    >
      <ChipIcon kind={props.kind} />
      <ContextChipLabel>{props.label}</ContextChipLabel>
    </ContextChip>
  );
}

const KanbanLinksContext = createContext<LinkRenderer | null>(null);

/**
 * Board links show as chips in the board's messages, comments and composers.
 * The renderer only changes with the board, so messages don't redraw on every
 * board change; each chip follows the board itself.
 */
export function KanbanLinksProvider(props: { boardId: string; children: ReactNode }) {
  const { boardId } = props;
  const render: LinkRenderer = (reference) => {
    const link = kanbanLinkOf(reference.kind, reference.contextId);
    return link ? <KanbanLinkChip boardId={boardId} link={link} label={reference.label} /> : null;
  };
  return (
    <KanbanLinksContext value={render}>
      <ComposerContextChipRendererContext value={render}>
        {props.children}
      </ComposerContextChipRendererContext>
    </KanbanLinksContext>
  );
}

/** Message markdown with board links as chips and thread links that open. */
export function KanbanMarkdown(props: { text: string }) {
  const render = use(KanbanLinksContext);
  const environmentId = usePrimaryEnvironmentId();
  return (
    <ChatMarkdown
      text={props.text}
      cwd={undefined}
      headingLevelOffset={2}
      environmentId={environmentId ?? undefined}
      renderContextReference={(reference) => render?.(reference) ?? <span>{reference.label}</span>}
    />
  );
}

/** Copies a link to paste into a discussion or comment, where it shows as a chip. */
export function CopyLinkButton(props: {
  kind: KanbanLinkKind | "thread";
  id: string;
  label: string;
  className?: string;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <button
      type="button"
      aria-label={isCopied ? "Link copied" : "Copy link"}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        copyToClipboard(
          props.kind === "thread"
            ? formatThreadLink(props.id, props.label)
            : kanbanLink(props.kind, props.id, props.label),
        );
      }}
      className={cn(
        "grid size-7.5 shrink-0 place-items-center rounded-full text-(--m-muted) outline-none hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)",
        props.className,
      )}
    >
      {isCopied ? <CheckIcon className="size-4" /> : <LinkIcon className="size-4" />}
    </button>
  );
}
