import {
  KANBAN_DONE_STAGES,
  type KanbanBlock,
  type KanbanCard,
  type KanbanGoal,
  type KanbanGroup,
  type KanbanMessage,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const SCRIBE_EVERY_MS = 10 * 60_000;
const MAX_CARDS = 400;
const MAX_GROUPS = 20;
const MAX_GOAL_CARDS = 40;
const MAX_NO_GOAL_CARDS = 300;

export const ScribeGroupsOutput = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({
      id: Schema.NullOr(Schema.String),
      name: Schema.String,
      summary: Schema.String,
      cards: Schema.Array(Schema.Number),
    }),
  ),
});
export type ScribeGroupsOutput = typeof ScribeGroupsOutput.Type;

export const ScribeGoalsOutput = Schema.Struct({
  assign: Schema.Array(Schema.Struct({ card: Schema.Number, goal: Schema.String })),
  goals: Schema.Array(
    Schema.Struct({ id: Schema.String, now: Schema.String, story: Schema.NullOr(Schema.String) }),
  ),
});
export type ScribeGoalsOutput = typeof ScribeGoalsOutput.Type;

const isOpen = (card: KanbanCard) =>
  !KANBAN_DONE_STAGES.has(card.stage) && card.settledAt === null;

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
};

const openCards = (cards: ReadonlyArray<KanbanCard>) =>
  cards.filter(isOpen).toSorted((a, b) => a.number - b.number);

/** Numbers of a goal's cards that finished after its last story line (or after it was made). */
export function finishedSince(
  goal: KanbanGoal,
  cards: ReadonlyArray<KanbanCard>,
  until = Number.POSITIVE_INFINITY,
): Array<number> {
  const since = Date.parse(goal.story.at(-1)?.at ?? goal.createdAt);
  return cards
    .filter((card) => {
      const moved = Date.parse(card.movedAt);
      return (
        card.goalId === goal.id &&
        KANBAN_DONE_STAGES.has(card.stage) &&
        moved > since &&
        moved <= until
      );
    })
    .map((card) => card.number)
    .toSorted((a, b) => a - b);
}

/** "" when the board has no active goal, so the pass is skipped. */
export function goalsFingerprint(
  cards: ReadonlyArray<KanbanCard>,
  goals: ReadonlyArray<KanbanGoal>,
): string {
  const active = new Set(goals.filter((goal) => goal.status === "active").map((goal) => goal.id as string));
  if (active.size === 0) return "";
  const lines = [...active];
  for (const card of cards) {
    // A goal's finished cards count too: their move to completed, deployed or verified is
    // what the goal's Story needs to hear about.
    const inGoal = card.goalId !== null && active.has(card.goalId as string);
    if (!inGoal && (card.goalId !== null || !isOpen(card))) continue;
    lines.push(`${card.number}:${card.stage}:${card.goalId ?? "-"}`);
  }
  return lines.sort().join("\n");
}

/** Changes when an open card is added, finished or renamed; "" when none are open. */
export function groupsFingerprint(cards: ReadonlyArray<KanbanCard>): string {
  return openCards(cards)
    .map((card) => `${card.number}:${card.title}`)
    .sort()
    .join("\n");
}

export function groupsPrompt(
  cards: ReadonlyArray<KanbanCard>,
  groups: ReadonlyArray<KanbanGroup>,
): string {
  const open = openCards(cards);
  const byId = new Map(open.map((card) => [card.id as string, card]));
  const groupLines = groups.map((group) => {
    const numbers = group.cardIds
      .map((id) => byId.get(id as string))
      .filter((card): card is KanbanCard => card !== undefined)
      .map((card) => `#${card.number}`)
      .join(", ");
    return `${group.id} | ${group.name} | ${group.summary} | ${numbers}`;
  });
  const cardLines = open
    .slice(-MAX_CARDS)
    .map(
      (card) =>
        `#${card.number} | ${oneLine(card.title, 120)} | ${card.projects.join(", ") || "-"} | ${oneLine(card.description, 140)}`,
    );
  return [
    "You group a work board's open cards so similar work sits together and one worker can carry related cards.",
    "Rules:",
    "- A group is 2 or more cards about the same feature, bug area or system. A card goes in at most one group. Leave a card out when nothing fits.",
    "- Keep an existing group (same id) while it still fits, and add new cards to it. Rename or drop one only when it no longer fits.",
    "- Name: 2 to 6 plain words. Summary: one plain sentence a non-technical reader understands.",
    "- At most 20 groups.",
    'Reply as JSON: {"groups": [{"id": "an existing group id, or null for a new group", "name": "...", "summary": "...", "cards": [12, 15]}]}',
    "",
    "Existing groups (id | name | summary | cards):",
    ...(groupLines.length > 0 ? groupLines : ["(none)"]),
    "",
    "Open cards (number | title | projects | description):",
    ...cardLines,
  ].join("\n");
}

export function toGroups(
  output: ScribeGroupsOutput,
  cards: ReadonlyArray<KanbanCard>,
  existing: ReadonlyArray<KanbanGroup>,
  makeId: () => string,
): Array<Omit<KanbanGroup, "updatedAt">> {
  const byNumber = new Map<number, KanbanCard["id"]>();
  for (const card of openCards(cards)) byNumber.set(card.number, card.id);
  const known = new Set<string>(existing.map((group) => group.id as string));
  const used = new Set<string>();
  const seen = new Set<string>();
  const kept: Array<Omit<KanbanGroup, "updatedAt">> = [];

  for (const group of output.groups) {
    if (kept.length >= MAX_GROUPS) break;
    const name = group.name.trim();
    if (!name) continue;
    const cardIds: Array<KanbanCard["id"]> = [];
    for (const number of group.cards) {
      const cardId = byNumber.get(number);
      if (cardId === undefined || seen.has(cardId as string)) continue;
      if (cardIds.includes(cardId)) continue;
      cardIds.push(cardId);
    }
    if (cardIds.length < 2) continue;
    const wanted = group.id;
    const id =
      wanted !== null && known.has(wanted) && !used.has(wanted) ? wanted : makeId();
    used.add(id);
    for (const cardId of cardIds) seen.add(cardId as string);
    kept.push({
      id: id as KanbanGroup["id"],
      name,
      summary: group.summary.trim(),
      cardIds: cardIds as KanbanGroup["cardIds"],
    });
  }
  return kept;
}

export function goalsPrompt(
  cards: ReadonlyArray<KanbanCard>,
  goals: ReadonlyArray<KanbanGoal>,
): string {
  const open = openCards(cards);
  const active = goals.filter((goal) => goal.status === "active");
  const goalBlocks = active.flatMap((goal) => {
    const own = cards
      .filter((card) => card.goalId === goal.id)
      .toSorted((a, b) => a.number - b.number)
      .slice(-MAX_GOAL_CARDS)
      .map(
        (card) => `#${card.number} | ${oneLine(card.title, 120)} | ${card.stage}`,
      );
    const finished = finishedSince(goal, cards).map((number) => `#${number}`).join(", ") || "(none)";
    return [
      "",
      `Goal ${goal.id}: ${goal.name}`,
      `Now: ${goal.now?.text ?? "(none)"}`,
      "Cards (number | title | stage):",
      ...(own.length > 0 ? own : ["(none)"]),
      `Finished since the last story line: ${finished}`,
    ];
  });
  const noGoal = open
    .filter((card) => card.goalId === null)
    .slice(-MAX_NO_GOAL_CARDS)
    .map(
      (card) =>
        `#${card.number} | ${oneLine(card.title, 120)} | ${card.projects.join(", ") || "-"}`,
    );
  return [
    "You keep a work board's goals current for a reader who isn't technical.",
    "Rules:",
    "- assign: put an open card that has no goal into one of the goals below only when it clearly serves that goal. Leave it out when unsure.",
    "- now: for every goal, one or two plain sentences on where it stands: what landed, what is being worked on, what is left, anything waiting on the owner. Keep facts from its current Now that are still true.",
    '- story: one plain sentence about what finished, only for a goal with cards under "Finished since the last story line"; otherwise null.',
    'Reply as JSON: {"assign": [{"card": 12, "goal": "goal id"}], "goals": [{"id": "goal id", "now": "...", "story": null}]}',
    ...goalBlocks,
    "",
    "Open cards with no goal (number | title | projects):",
    ...(noGoal.length > 0 ? noGoal : ["(none)"]),
  ].join("\n");
}

export function toGoalUpdates(
  output: ScribeGoalsOutput,
  cards: ReadonlyArray<KanbanCard>,
  goals: ReadonlyArray<KanbanGoal>,
  until = Number.POSITIVE_INFINITY,
): {
  readonly assign: Array<{ readonly cardId: KanbanCard["id"]; readonly goalId: KanbanGoal["id"] }>;
  readonly goals: Array<{
    readonly id: KanbanGoal["id"];
    readonly now: string;
    readonly story: string | null;
  }>;
} {
  const active = new Map(
    goals.filter((goal) => goal.status === "active").map((goal) => [goal.id as string, goal]),
  );
  const byNumber = new Map<number, KanbanCard>();
  for (const card of openCards(cards)) byNumber.set(card.number, card);

  const assign: Array<{ readonly cardId: KanbanCard["id"]; readonly goalId: KanbanGoal["id"] }> =
    [];
  const assigned = new Set<string>();
  for (const entry of output.assign) {
    const card = byNumber.get(entry.card);
    if (!card || card.goalId !== null || assigned.has(card.id as string)) continue;
    if (!active.has(entry.goal)) continue;
    assigned.add(card.id as string);
    assign.push({ cardId: card.id, goalId: entry.goal as KanbanGoal["id"] });
  }

  const updates: Array<{
    readonly id: KanbanGoal["id"];
    readonly now: string;
    readonly story: string | null;
  }> = [];
  const seen = new Set<string>();
  for (const entry of output.goals) {
    const goal = active.get(entry.id);
    if (!goal || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const now = entry.now.trim().slice(0, 600);
    const text = entry.story?.trim() ?? "";
    const story = text !== "" && finishedSince(goal, cards, until).length > 0 ? text : null;
    if (now === "" && story === null) continue;
    updates.push({ id: goal.id, now, story });
  }
  return { assign, goals: updates };
}

export const PROPOSAL_CHECK_MS = 30 * 60_000;
const PROPOSE_AFTER_ANSWERED_MS = 6 * 60 * 60_000;
const PROPOSE_AFTER_MS = 24 * 60 * 60_000;
const MAX_ACTIVE_GOALS = 6;
const MIN_CARDS = 3;
export const GOAL_IDEAS_TITLE = "Goal ideas";

export const ScribeProposalsOutput = Schema.Struct({
  proposals: Schema.Array(
    Schema.Struct({ name: Schema.String, summary: Schema.String, cards: Schema.Array(Schema.Number) }),
  ),
});
export type ScribeProposalsOutput = typeof ScribeProposalsOutput.Type;

const goalless = (cards: ReadonlyArray<KanbanCard>) =>
  cards.filter((card) => isOpen(card) && card.goalId === null);

/** Whether to ask the model: enough goal-less cards, room for goals, and the last proposal is old or answered. */
export function proposalDue(
  cards: ReadonlyArray<KanbanCard>,
  goals: ReadonlyArray<KanbanGoal>,
  last: KanbanMessage | null,
  nowMs: number,
): boolean {
  if (goalless(cards).length < MIN_CARDS) return false;
  if (goals.filter((goal) => goal.status === "active").length >= MAX_ACTIVE_GOALS) return false;
  if (last === null) return true;
  const age = nowMs - Date.parse(last.createdAt);
  if (age >= PROPOSE_AFTER_MS) return true;
  const choices = last.blocks.filter((block) => block._tag === "choice");
  const answered = choices.every((block) =>
    last.answers.some((answer) => answer.blockId === block.id && answer.by._tag === "owner"),
  );
  return age >= PROPOSE_AFTER_ANSWERED_MS && answered;
}

/** Questions of earlier proposals, so the model doesn't repeat them. */
export function pastProposals(messages: ReadonlyArray<KanbanMessage>): Array<string> {
  return messages.flatMap((message) =>
    message.blocks.flatMap((block) => {
      if (block._tag !== "choice") return [];
      const answered = message.answers.some((answer) => answer.blockId === block.id);
      return [block.question + (answered ? " (answered)" : " (no answer yet)")];
    }),
  );
}

export function proposalsPrompt(
  cards: ReadonlyArray<KanbanCard>,
  goals: ReadonlyArray<KanbanGoal>,
  past: ReadonlyArray<string>,
): string {
  const active = goals.filter((goal) => goal.status === "active");
  const goalLines = active.map(
    (goal) => `- ${goal.name}: ${goal.now?.text ?? "(no status yet)"}`,
  );
  const cardLines = goalless(cards)
    .toSorted((a, b) => a.number - b.number)
    .slice(-MAX_NO_GOAL_CARDS)
    .map(
      (card) =>
        `#${card.number} | ${oneLine(card.title, 120)} | ${card.projects.join(", ") || "-"}`,
    );
  return [
    "You suggest goals for a work board, for an owner who isn't technical.",
    "Rules:",
    "- A goal is an outcome the owner cares about, served by 3 or more of the open cards below that have no goal yet. Suggest at most 3, only clear ones; an empty list is fine.",
    "- Don't suggest a goal that matches an existing goal or one already suggested below.",
    "- Name: 2 to 6 plain words. Summary: one plain sentence on what is true when the goal is done.",
    'Reply as JSON: {"proposals": [{"name": "...", "summary": "...", "cards": [12, 15, 19]}]}',
    "",
    "Existing goals:",
    ...(goalLines.length > 0 ? goalLines : ["(none)"]),
    "",
    "Already suggested:",
    ...(past.length > 0 ? past.map((line) => `- ${line}`) : ["(none)"]),
    "",
    "Open cards with no goal (number | title | projects):",
    ...cardLines,
  ].join("\n");
}

export function toProposals(
  output: ScribeProposalsOutput,
  cards: ReadonlyArray<KanbanCard>,
  goals: ReadonlyArray<KanbanGoal>,
  past: ReadonlyArray<string>,
): Array<{ readonly name: string; readonly summary: string; readonly cards: Array<number> }> {
  const open = new Set(goalless(cards).map((card) => card.number));
  const taken = new Set(
    goals.filter((goal) => goal.status === "active").map((goal) => goal.name.toLowerCase()),
  );
  const pastLower = past.map((line) => line.toLowerCase());
  const used = new Set<number>();
  const kept: Array<{ readonly name: string; readonly summary: string; readonly cards: Array<number> }> = [];

  for (const proposal of output.proposals) {
    if (kept.length >= 3) break;
    const name = proposal.name.replace(/"/g, "").trim().slice(0, 60);
    if (name === "") continue;
    const lower = name.toLowerCase();
    if (taken.has(lower) || pastLower.some((line) => line.includes(`"${lower}"`))) continue;
    const numbers = [
      ...new Set(proposal.cards.filter((number) => open.has(number) && !used.has(number))),
    ].toSorted((a, b) => a - b);
    if (numbers.length < MIN_CARDS) continue;
    for (const number of numbers) used.add(number);
    kept.push({ name, summary: proposal.summary.trim(), cards: numbers });
    taken.add(lower);
  }
  return kept;
}

export function proposalBlocks(
  proposals: ReadonlyArray<{
    readonly name: string;
    readonly summary: string;
    readonly cards: ReadonlyArray<number>;
  }>,
): Array<KanbanBlock> {
  const choices: Array<KanbanBlock> = proposals.map((proposal, index) => ({
    _tag: "choice",
    id: `goal-${index + 1}`,
    style: "pick",
    question: `Make goal "${proposal.name}"? ${proposal.summary} Cards: ${proposal.cards.map((n) => "#" + n).join(", ")}`,
    options: [
      { id: "make", label: "Make it" },
      { id: "skip", label: "Skip" },
    ],
    multi: false,
  }));
  return [
    { _tag: "md", text: "These open cards look like they share an outcome. Make a goal for them?" },
    ...choices,
    {
      _tag: "collapse",
      title: "For the evaluator",
      text: "On Make it: goal_set a goal with that name and the summary as its Now, then card_edit goalId onto the listed cards that are still open and have no goal, and say so here in one line. On his own words: do what he says. On Skip: nothing.",
    },
  ];
}
