import type { KanbanCard } from "@t3tools/contracts";
import { cardMatches } from "./cardSearch.ts";

const stopWords = new Set(
  "a an and are as at be been bug by for from has have i in is it of on or report reports that the this to was were with".split(
    " ",
  ),
);
const tokens = (text: string) =>
  [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].filter(
    (word) => (word.length > 1 || /^\p{N}+$/u.test(word)) && !stopWords.has(word),
  );

export const bugMatches = (cards: ReadonlyArray<KanbanCard>, title: string) => {
  // Whole tokens keep URL fragments and arithmetic from selecting a card by prefix.
  const reference = /(?<=^|\s)[([{'"“‘]*(\*\*|\*|`)?#([1-9]\d*)\1[)\]}'"”’.,:;!?]*(?=$|\s)/gu;
  const references = [...title.matchAll(reference)];
  // A malformed second mention makes an otherwise valid card reference ambiguous.
  const allReferencesValid = references.length === [...title.matchAll(/#+(?=\p{N})/gu)].length;
  const numbers = new Set(references.map((match) => Number(match[2])));
  // Rejected references still contribute tokens; stripping them would inflate the match score.
  const words = tokens(title.replace(reference, ""));
  return cards
    .map((card) => {
      const exact = allReferencesValid && numbers.size === 1 && numbers.has(card.number);
      const titleWords = new Set(tokens(card.title));
      const overlap = words.filter((word) => titleWords.has(word)).length;
      const score = words.length === 0 ? 0 : overlap / words.length;
      // Search the same text as card_search, restricted to the report's title/description scope.
      const searchable = { ...card, prompt: "", links: [] };
      const found = exact || words.some((word) => cardMatches(searchable, word));
      return {
        card,
        found,
        exact,
        score,
        // Generic one-word titles and ambiguous card references need an evaluator.
        strong:
          allReferencesValid &&
          (exact || (numbers.size === 0 && words.length >= 2 && score >= 0.7)),
      };
    })
    .filter((match) => match.found)
    .toSorted(
      (left, right) =>
        Number(right.exact) - Number(left.exact) ||
        right.score - left.score ||
        right.card.number - left.card.number,
    );
};
