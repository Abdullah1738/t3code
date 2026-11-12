/**
 * "What an ask can be", as data: the named combinations agents reach for, the
 * five most used with what an agent fills in, and the words agents are given
 * about asking. The web page and the phone draw the same lists.
 */
import {
  CARD_ASK_TOOL_DESCRIPTION,
  kanbanAskChanges,
  kanbanAskResponse,
  type KanbanAskFeedItem,
} from "@t3tools/contracts";

import { askFieldKind } from "./askAnswer.ts";

export type AskReferenceMatch = (entry: KanbanAskFeedItem) => boolean;
const kind =
  (name: string): AskReferenceMatch =>
  (entry) =>
    entry.kind === name;
const field =
  (name: string): AskReferenceMatch =>
  (entry) =>
    kanbanAskResponse(entry.ask).fields.some((candidate) => askFieldKind(candidate) === name);

export const ASK_REFERENCE_KINDS: ReadonlyArray<
  readonly [name: string, shows: string, gives: string, match: AskReferenceMatch]
> = [
  ["Action", "The command, where, evidence, undo", "Approve or reject", kind("action")],
  ["Draft", "The text where it will land", "Edit, then approve", kind("draft")],
  ["Decision", "The question", "Choose", kind("decision")],
  ["Change", "Before, after and the difference", "Approve or reject", kind("change")],
  ["Question", "The question", "One answer", kind("question")],
  ["Secret", "What the key or code is for", "Fill in, masked", field("secret")],
  ["File", "Which file", "A file", field("file")],
  ["Input", "The question", "A few fields", kind("input")],
  ["Task", "The steps and a link", "Done or Couldn't", kind("task")],
  ["Sign-off", "Screenshots or a recording", "Passes or Fails", kind("signoff")],
  ["Rank", "The things to order", "An order", field("rank")],
  [
    "Design pick",
    "The options as pictures",
    "Choose",
    (entry) =>
      (kanbanAskResponse(entry.ask).choose?.options ?? []).some(
        (option) => option.block !== undefined,
      ),
  ],
  ["Notice", "What happened", "Seen", (entry) => kanbanAskResponse(entry.ask).ack],
  [
    "Several changes",
    "Two or three changes, one at a time",
    "Approve or reject",
    (entry) => kanbanAskChanges(entry.ask).length > 1,
  ],
  [
    "Action with a choice",
    "The command",
    "Choose when, then approve",
    (entry) => entry.kind === "action" && kanbanAskResponse(entry.ask).choose !== null,
  ],
  ["Value from a chart", "A chart you can move", "The value you picked", field("custom")],
];

export const ASK_REFERENCE_MOST_USED: ReadonlyArray<{
  readonly name: string;
  readonly use: string;
  readonly fills: ReadonlyArray<readonly [what: string, how: string]>;
  readonly answer: string;
  readonly match: AskReferenceMatch;
}> = [
  {
    name: "Action",
    use: "Something will run: a deploy, an install, a merge, a spend.",
    fills: [
      ["What runs", "The exact command"],
      ["Where", "The machine, service or account"],
      ["What changes", "One or two plain sentences"],
      ["Evidence", "Review, tests, CI, each with its commit"],
      ["How to undo", "The exact way back"],
      ["Then", "What the agent does right after"],
    ],
    answer: "You approve or reject. A note rides along.",
    match: kind("action"),
  },
  {
    name: "Draft",
    use: "Text that goes somewhere: a comment, a message, a line in a file.",
    fills: [
      ["Where it goes", "The ticket, PR, chat or file"],
      ["The text", "Shown as it will appear"],
    ],
    answer: "You approve it, or edit it and approve. Your text is what gets sent.",
    match: kind("draft"),
  },
  {
    name: "Decision",
    use: "A choice between a few ways forward.",
    fills: [
      ["The question", "One sentence"],
      ["Options", "Each with what it is and what it leads to"],
      ["Recommended", "The one the agent would pick"],
    ],
    answer: "You pick one, or write your own answer.",
    match: kind("decision"),
  },
  {
    name: "Change",
    use: "Existing wording or a setting is replaced.",
    fills: [
      ["What is changing", "The setting, brief line or description"],
      ["Before", "The current text, in full"],
      ["After", "The new text, in full"],
    ],
    answer: "You read After, Before or the difference, then approve or reject.",
    match: kind("change"),
  },
  {
    name: "Question",
    use: "The agent needs something only you know.",
    fills: [
      ["The question", "One sentence"],
      ["Background", "What you need to answer it"],
    ],
    answer: "You type an answer.",
    match: kind("question"),
  },
];

/**
 * The tool description, a sentence to a line. The words are the constant's
 * own. Split without a lookbehind, which not every JavaScript engine the
 * clients run on has.
 */
export const ASK_REFERENCE_TOLD: ReadonlyArray<string> = CARD_ASK_TOOL_DESCRIPTION.replace(
  /([.?!])\s+(?=[A-Z])/g,
  "$1\u0000",
).split("\u0000");
