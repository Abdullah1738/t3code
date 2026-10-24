/**
 * iMessage runs data detectors over a card's body text (fallback text, else the caption). When
 * they find a time, a date or a day word such as "today", the balloon renders as a plain text
 * bubble instead of the card, even with the right app installed. Card text therefore keeps only
 * the words around those values; the page behind the card carries the times and dates.
 */
const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAY = "(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)day";
const DAY_WORD = "(?:today|tonight|tomorrow|yesterday|this (?:morning|afternoon|evening|week(?:end)?)|next week(?:end)?|last night)";
const ORDINAL = "\\d{1,2}(?:st|nd|rd|th)?";

const DETECTED = [
  // ISO and numeric dates: 2026-10-24, 24/10, 10.24.2026 (a bare "2.5" stays a number)
  /\b\d{4}-\d{1,2}-\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/gi,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,
  /\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/g,
  // "Oct 24", "October 24th, 2026", "24 Oct 2026", "24th of October"
  new RegExp(`\\b${MONTH}\\.?\\s+${ORDINAL}(?:,?\\s+\\d{4})?\\b`, "gi"),
  new RegExp(`\\b${ORDINAL}\\s+(?:of\\s+)?${MONTH}\\b\\.?(?:,?\\s+\\d{4})?`, "gi"),
  // Clock times: 14:35, 8:15:30, 9 pm, 9.30am
  /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\b\.?)?/gi,
  /\b\d{1,2}\.\d{2}\s*[ap]\.?m\b\.?/gi,
  /\b\d{1,2}\s*[ap]\.?m\b\.?/gi,
  /\b(?:noon|midnight)\b/gi,
  new RegExp(`\\b${WEEKDAY}s?\\b`, "gi"),
  new RegExp(`\\b${DAY_WORD}\\b`, "gi"),
];

// Connectors a removed value leaves dangling at either end ("Departs at", "from - to").
const EDGE = /^(?:[\s,;:·•|@–—-]+|(?:at|on|by|from|until|till|for|due|since)\b)+|(?:[\s,;:·•|@–—-]+|\b(?:at|on|by|from|until|till|for|due|since))+$/gi;

/** Removes times, dates and day words, plus the separators and connectors they leave behind. */
export function cardSafeText(text: string): string {
  let clean = text;
  for (const pattern of DETECTED) clean = clean.replace(pattern, " ");
  clean = clean
    .replace(/[^\S\n]+/g, " ")
    .replace(/\s*([,;])(?:\s*[,;])+/g, "$1")
    .replace(/(\s[·•|–—-])(?:\s*[·•|–—-])+/g, "$1")
    .replace(/\(\s*\)/g, "");
  let previous;
  do {
    previous = clean;
    clean = clean.replace(EDGE, "").trim();
  } while (clean !== previous);
  return clean;
}

export const CARD_TEXT_FIELDS = ["caption", "subcaption", "trailingCaption", "trailingSubcaption", "summary"] as const;
export type CardText = Partial<Record<(typeof CARD_TEXT_FIELDS)[number], string>>;

// Used when a caption is nothing but a time or date; the page still has the details.
const BLANK_CAPTION = "Open card";

/** The text a card's bubble shows, as sent: each field cleaned, undefined when no caption was given. */
export function cardLayout(card: CardText): CardText | undefined {
  const layout: CardText = {};
  for (const key of CARD_TEXT_FIELDS) {
    const clean = card[key] ? cardSafeText(card[key]) : "";
    if (clean) layout[key] = clean;
  }
  if (layout.caption || layout.subcaption || layout.trailingCaption || layout.trailingSubcaption) return layout;
  if (!CARD_TEXT_FIELDS.some(key => key !== "summary" && card[key]?.trim())) return undefined;
  return { ...layout, caption: BLANK_CAPTION };
}
