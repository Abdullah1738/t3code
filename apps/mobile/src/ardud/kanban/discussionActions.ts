import type { KanbanDiscussionUpdateInput } from "@t3tools/contracts";
import { errorMessage } from "@t3tools/client-runtime/ardud/common";
import { resolveSnoozePresets } from "@t3tools/client-runtime/state/thread-settled";

import * as Dialog from "../../components/ui/Dialog";
import { kanbanClient } from "./kanbanStore";

type DiscussionPatch = Omit<KanbanDiscussionUpdateInput, "discussionId">;

/** What a discussion's menu offers, from where it sits now. */
export type DiscussionMenuItem =
  | { readonly id: "settle" | "unsettle" | "unsnooze" | "rename"; readonly title: string }
  | {
      readonly id: "snooze";
      readonly title: string;
      readonly presets: ReadonlyArray<{
        readonly id: string;
        readonly title: string;
        readonly subtitle: string;
      }>;
    };

export const SNOOZE_PREFIX = "snooze:";
/** Snooze submenu choice that opens the date and time picker instead of a preset. */
export const CUSTOM_SNOOZE = "snooze-custom";

export function discussionMenu(input: {
  readonly settled: boolean;
  readonly snoozed: boolean;
  readonly now: Date;
}): ReadonlyArray<DiscussionMenuItem> {
  const items: DiscussionMenuItem[] = [];
  if (input.settled) items.push({ id: "unsettle", title: "Unsettle" });
  else items.push({ id: "settle", title: "Settle" });
  if (input.snoozed) items.push({ id: "unsnooze", title: "Unsnooze" });
  else if (!input.settled)
    items.push({
      id: "snooze",
      title: "Snooze",
      presets: [
        ...resolveSnoozePresets(input.now).map((preset) => ({
          id: `${SNOOZE_PREFIX}${preset.snoozedUntil}`,
          title: preset.label,
          subtitle: preset.whenLabel,
        })),
        { id: CUSTOM_SNOOZE, title: "Custom…", subtitle: "Pick a date and time" },
      ],
    });
  items.push({ id: "rename", title: "Rename" });
  return items;
}

export const MENU_ICONS = {
  settle: "checkmark",
  unsettle: "arrow.uturn.backward",
  snooze: "clock",
  unsnooze: "clock",
  rename: "square.and.pencil",
} as const;

async function update(
  boardId: string,
  discussionId: string,
  patch: DiscussionPatch,
  failureTitle: string,
) {
  try {
    await kanbanClient().updateDiscussion(boardId, discussionId, patch);
  } catch (error) {
    Dialog.alert(failureTitle, errorMessage(error));
  }
}

/** Runs a menu choice; `snooze:<iso>` carries the preset's wake time. */
export function runDiscussionMenu(input: {
  readonly boardId: string;
  readonly discussionId: string;
  readonly title: string;
  readonly choice: string;
  readonly onCustomSnooze?: () => void;
}): void {
  const { boardId, discussionId } = input;
  if (input.choice === CUSTOM_SNOOZE) {
    input.onCustomSnooze?.();
    return;
  }
  if (input.choice.startsWith(SNOOZE_PREFIX)) {
    void update(
      boardId,
      discussionId,
      { snoozedUntil: input.choice.slice(SNOOZE_PREFIX.length) },
      "Could not snooze",
    );
    return;
  }
  switch (input.choice) {
    case "settle":
      void update(boardId, discussionId, { settled: true }, "Could not settle");
      return;
    case "unsettle":
      void update(boardId, discussionId, { settled: false }, "Could not unsettle");
      return;
    case "unsnooze":
      void update(boardId, discussionId, { snoozedUntil: null }, "Could not unsnooze");
      return;
    case "rename":
      renameDiscussion(boardId, discussionId, input.title);
  }
}

/** Snoozes a discussion until an ISO time, from a preset or the custom picker. */
export function snoozeDiscussion(
  boardId: string,
  discussionId: string,
  snoozedUntil: string,
): void {
  void update(boardId, discussionId, { snoozedUntil }, "Could not snooze");
}

export function renameDiscussion(boardId: string, discussionId: string, title: string): void {
  Dialog.prompt({
    title: "Rename discussion",
    initialValue: title,
    confirmText: "Rename",
    onConfirm: (value) => {
      const next = value.trim();
      if (next === "" || next === title) return;
      void update(boardId, discussionId, { title: next }, "Could not rename");
    },
  });
}
