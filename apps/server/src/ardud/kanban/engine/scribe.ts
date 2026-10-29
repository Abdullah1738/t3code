import { KANBAN_DONE_STAGES, type KanbanCard, type KanbanGroup } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const SCRIBE_EVERY_MS = 10 * 60_000;
const MAX_CARDS = 400;
const MAX_GROUPS = 20;

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

const isOpen = (card: KanbanCard) =>
  !KANBAN_DONE_STAGES.has(card.stage) && card.settledAt === null;

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
};

const openCards = (cards: ReadonlyArray<KanbanCard>) =>
  cards.filter(isOpen).toSorted((a, b) => a.number - b.number);

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
