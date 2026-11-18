import type { KanbanCard, KanbanThreadLink } from "@t3tools/contracts";

export const EVALUATOR_LIMITS = {
  requestReuseMs: 5 * 60_000,
  requestMerges: 4,
  requestDuplicateMs: 30 * 60_000,
  reuseMs: 30 * 60_000,
  cardSpawnMs: 10 * 60_000,
  boardWindowMs: 60_000,
  boardSpawns: 12,
} as const;

const tokens = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((m) => m[1]!);

export const requestThreadIds = (text: string) =>
  tokens(text, /t3-thread:\/\/(?:v1\/)?([^\s)\]<>"']+)/g);

export const requestCardReferences = (text: string) => ({
  numbers: new Set(tokens(text, /(?:^|[^\p{L}\p{N}_])#(\d+)\b/gu).map(Number)),
  ids: tokens(text, /\b(card-[a-zA-Z0-9-]+)\b/g),
});

/** Only explicit references and exact incident evidence count; titles are not fuzzy matched. */
export const matchingCards = (
  text: string,
  cards: ReadonlyArray<KanbanCard>,
  links: ReadonlyArray<KanbanThreadLink>,
) => {
  const { numbers, ids } = requestCardReferences(text);
  const threads = requestThreadIds(text);
  const quotes = tokens(text, /["“'‘`]([^"”'’`\n]{24,})["”'’`]/g);
  const paths = tokens(text.replaceAll("file://", ""), /(?:^|[\s"'`(])(\/(?:[^\s"'`()<>]+))/g).map(
    (path) => path.replace(/[.,;:]+$/, ""),
  );
  return cards.filter((card) => {
    if (["completed", "deployed", "verified"].includes(card.stage)) return false;
    if (numbers.has(card.number) || ids.includes(card.id)) return true;
    const content = [
      card.title,
      card.description,
      card.prompt,
      ...card.links.map((l) => l.url),
    ].join("\n");
    if (ids.some((id) => content.includes(id))) return true;
    if (
      threads.some(
        (id) =>
          (card.createdBy._tag === "evaluator" && card.createdBy.threadId === id) ||
          links.some((l) => l.threadId === id && l.cardId === card.id) ||
          content.includes(id),
      )
    )
      return true;
    if (quotes.some((quote) => content.includes(quote))) return true;
    const pathContent = content.replaceAll("file://", "");
    return paths.some((path) => {
      for (let at = pathContent.indexOf(path); at >= 0; at = pathContent.indexOf(path, at + 1)) {
        const before = pathContent[at - 1];
        const after = pathContent[at + path.length];
        if ((!before || /[\s"'`(<>]/.test(before)) && (!after || /[\s"'`()<>.,;:]/.test(after)))
          return true;
      }
      return false;
    });
  });
};
