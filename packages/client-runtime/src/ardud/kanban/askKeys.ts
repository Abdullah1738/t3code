/**
 * The Needs-you keyboard map: one key event and where the page is, in; what
 * the key does, out. Pure, so the map the shortcuts sheet prints is the map
 * the page runs.
 */

export type AskKeyAction =
  | { readonly _tag: "move"; readonly delta: 1 | -1 }
  | { readonly _tag: "primary" }
  | { readonly _tag: "refuse" }
  | { readonly _tag: "note" }
  | { readonly _tag: "reply" }
  | { readonly _tag: "card" }
  | { readonly _tag: "edit" }
  | { readonly _tag: "undo" }
  | { readonly _tag: "snooze" }
  | { readonly _tag: "search" }
  | { readonly _tag: "shortcuts" }
  | { readonly _tag: "view" }
  | { readonly _tag: "change"; readonly delta: 1 | -1 }
  | { readonly _tag: "pick"; readonly index: number }
  | { readonly _tag: "close" };

export interface AskKeyEvent {
  readonly key: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
}

export interface AskKeyContext {
  /** Focus is in a text box, a select or an editable draft. */
  readonly typing: boolean;
  /** Focus is on a button, link or other control Enter would press. */
  readonly onControl: boolean;
  /** A sheet or dialog is open over the page. */
  readonly layerOpen: boolean;
  /** An ask is in focus and can still be answered. */
  readonly answerable: boolean;
  /** The focused ask is a single ask (not a batch), so it has a discussion. */
  readonly single: boolean;
  /** Options the focused ask offers; 0 when it has none. */
  readonly options: number;
  /** Changes the focused ask shows; 0 when it has none. */
  readonly changes: number;
  /** The focused ask has a draft he may edit, or a text field to type in. */
  readonly editable: boolean;
  /** The focused ask can be refused (reject, fails, couldn't). */
  readonly refusable: boolean;
}

/** What a key does on the Needs-you page, or null when it is not one of its keys. */
export function askKeyAction(event: AskKeyEvent, context: AskKeyContext): AskKeyAction | null {
  if (event.key === "Escape") return { _tag: "close" };
  if (context.typing) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.key === "?") return { _tag: "shortcuts" };
  if (context.layerOpen) return null;

  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  switch (key) {
    case "/":
      return { _tag: "search" };
    case "j":
    case "ArrowDown":
      return { _tag: "move", delta: 1 };
    case "k":
    case "ArrowUp":
      return { _tag: "move", delta: -1 };
    case "z":
      return { _tag: "undo" };
  }
  if (!context.answerable) return null;
  switch (key) {
    case "Enter":
      // Enter on a control presses that control, nothing else.
      return context.onControl ? null : { _tag: "primary" };
    case "a":
      return { _tag: "primary" };
    case "x":
      return context.refusable ? { _tag: "refuse" } : null;
    case "s":
      return { _tag: "snooze" };
    case "n":
      return { _tag: "note" };
    case "r":
      return context.single ? { _tag: "reply" } : null;
    case "c":
      return context.single ? { _tag: "card" } : null;
    case "e":
      return context.editable ? { _tag: "edit" } : null;
    case "v":
      return context.changes > 0 ? { _tag: "view" } : null;
    case "[":
      return context.changes > 1 ? { _tag: "change", delta: -1 } : null;
    case "]":
      return context.changes > 1 ? { _tag: "change", delta: 1 } : null;
  }
  if (/^[1-9]$/.test(key) && Number(key) <= context.options) {
    return { _tag: "pick", index: Number(key) - 1 };
  }
  return null;
}

/** The shortcuts sheet, in the order it lists them. */
export const ASK_SHORTCUTS: ReadonlyArray<{
  readonly keys: ReadonlyArray<string>;
  readonly range?: boolean;
  readonly does: string;
}> = [
  { keys: ["J", "K"], does: "Next and previous ask" },
  { keys: ["A"], does: "Approve, send, Done or Seen" },
  { keys: ["1", "9"], range: true, does: "Pick an option" },
  { keys: ["E"], does: "Edit a draft, or type an answer" },
  { keys: ["V"], does: "Change asks: After, Before, Changes, Side by side" },
  { keys: ["[", "]"], does: "Step between changes in one ask" },
  { keys: ["N"], does: "Add a note for the agent" },
  { keys: ["R"], does: "Reply in the discussion" },
  { keys: ["X"], does: "Reject, Fails or Couldn't" },
  { keys: ["S"], does: "Snooze until tomorrow morning, or bring back" },
  { keys: ["Z"], does: "Undo, for six seconds" },
  { keys: ["C"], does: "Open the card" },
  { keys: ["/"], does: "Search" },
  { keys: ["Esc"], does: "Close, or leave a text box" },
];

/** The views a change ask steps through with V. Side by side needs a wide screen. */
export const CHANGE_VIEWS = ["after", "before", "diff", "both"] as const;
export type ChangeView = (typeof CHANGE_VIEWS)[number];

export const nextChangeView = (current: ChangeView, wide: boolean): ChangeView => {
  const views: ReadonlyArray<ChangeView> = wide
    ? CHANGE_VIEWS
    : CHANGE_VIEWS.filter((view) => view !== "both");
  return views[(views.indexOf(current) + 1) % views.length] ?? "after";
};
