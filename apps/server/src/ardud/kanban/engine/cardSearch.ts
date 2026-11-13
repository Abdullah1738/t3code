import type { KanbanCard } from "@t3tools/contracts";

export const isCardNumber = (card: KanbanCard, query: string) => {
  const trimmed = query.trim();
  return /^#?\d+$/.test(trimmed) && card.number === Number(trimmed.replace("#", ""));
};

/**
 * Every word must appear in the card's text; a lone "#12" (or "12") also finds
 * card 12, which sorts first so the limit never cuts it for #120 and friends.
 */
export const cardMatches = (card: KanbanCard, query: string) => {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  if (isCardNumber(card, trimmed)) return true;
  const text = [
    `#${card.number}`,
    card.title,
    card.description,
    card.prompt,
    ...card.links.flatMap((link) => [link.url, link.label ?? ""]),
  ]
    .join("\n")
    .toLowerCase();
  return trimmed.split(/\s+/).every((word) => text.includes(word));
};
