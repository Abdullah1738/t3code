import {
  BookOpenIcon,
  BotIcon,
  BoxIcon,
  BrainIcon,
  BriefcaseIcon,
  BugIcon,
  ChartLineIcon,
  CodeIcon,
  CoinsIcon,
  DatabaseIcon,
  FlaskConicalIcon,
  GlobeIcon,
  HeartIcon,
  HouseIcon,
  LeafIcon,
  type LucideIcon,
  PlaneIcon,
  RocketIcon,
  ServerIcon,
  ShieldIcon,
  TargetIcon,
  UsersIcon,
  WalletIcon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";

import { kanbanBoardIcon, type KanbanBoard, type KanbanBoardIcon } from "@t3tools/contracts";

import { cn } from "../../lib/utils";

export const BOARD_ICONS: Record<KanbanBoardIcon, LucideIcon> = {
  briefcase: BriefcaseIcon,
  rocket: RocketIcon,
  code: CodeIcon,
  shield: ShieldIcon,
  chart: ChartLineIcon,
  bot: BotIcon,
  wallet: WalletIcon,
  flask: FlaskConicalIcon,
  server: ServerIcon,
  globe: GlobeIcon,
  users: UsersIcon,
  wrench: WrenchIcon,
  book: BookOpenIcon,
  bolt: ZapIcon,
  home: HouseIcon,
  heart: HeartIcon,
  target: TargetIcon,
  box: BoxIcon,
  database: DatabaseIcon,
  bug: BugIcon,
  brain: BrainIcon,
  coins: CoinsIcon,
  plane: PlaneIcon,
  leaf: LeafIcon,
};

/** The board's picture, else its named icon, else its first letter. */
export function BoardIcon(props: { board: KanbanBoard; className?: string }) {
  if (props.board.iconImage) {
    return (
      <img
        alt=""
        src={props.board.iconImage}
        className={cn("size-4 shrink-0 rounded-sm object-cover", props.className)}
      />
    );
  }
  const name = kanbanBoardIcon(props.board);
  if (name === null) {
    return (
      <span
        aria-hidden
        className={cn(
          "inline-grid size-4 shrink-0 place-items-center rounded-sm bg-(--m-chip) text-2xs font-semibold text-(--m-muted)",
          props.className,
        )}
      >
        {props.board.name.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  const Icon = BOARD_ICONS[name];
  return <Icon aria-hidden className={cn("size-4 shrink-0", props.className)} />;
}
