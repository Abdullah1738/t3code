/**
 * What agents are told by the board's ask tools, word for word. The tools use
 * these constants and so does any page that shows agents' instructions, so the
 * two never drift apart.
 */

/** The `card_ask` tool's description. */
export const CARD_ASK_TOOL_DESCRIPTION = [
  "Ask the owner on a card.",
  "He answers from a list, without opening the card, so the ask must stand on its own, and the question must read alone; his answer comes back to you.",
  "Async by default: the card and its work go on.",
  "Pass blocking only when the work can't go on without the answer: the card then waits in Needs Owner (a work thread's own card must be in Working, and gives up its slot).",
  "One thing per ask.",
  "He can give back: approve or reject, a pick, values he fills in (text, a number, a date, a file), an edit of your draft, a step he does himself, or nothing but having seen it.",
  "Shortcuts set that up from what you pass: a bare question (free text); options (he picks: give each a detail and mark yours recommended); draft (a text you will post or send: he may edit it, and you post exactly what comes back); action (something you will run, with command, evidence and undo, and then for what you do after it: approve or reject); change or changes (texts you replace, before and after).",
  "For anything else say it with respond.",
  "Use kind notice for something he should only see; when nothing needs him, don't ask.",
  "Always give title and context.",
  "Show evidence instead of describing it, with blocks: attach screenshots, screen recordings, audio, PDFs or files (upload with t3_attachment_prepare_upload, then pass an attachment block), and put a visualization in an html block (a self-contained page like the ones html_render publishes: chart, table, before/after, diagram; no external scripts, fonts or fetches; readable at phone width, in light and dark).",
  "Give every image alt text and a one-line caption (an md block after it).",
].join(" ");
