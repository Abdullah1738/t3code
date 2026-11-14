/**
 * What agents are told by the board's ask tools, word for word. The tools use
 * these constants and so does any page that shows agents' instructions, so the
 * two never drift apart.
 */

/** The `card_ask` tool's description. */
export const CARD_ASK_TOOL_DESCRIPTION = [
  "Ask the owner on a card.",
  "He answers from a list; the question must stand alone; his answer comes back.",
  "Async by default: work continues.",
  "Use blocking only when work can't go on without the answer: the card waits in Needs Owner, freeing its Working slot; an unattached own worker may ask async/blocking from todo or blocking from needs_owner, and revise/reply on open asks in either stage.",
  "One thing per ask.",
  "He can give back: approve or reject, a pick, values he fills in (text, a number, a date, a file), an edit of your draft, a step he does himself, or nothing but having seen it.",
  "Shortcuts: a bare question (free text); options (a pick: add details and mark yours recommended); draft (he may edit it; post exactly what comes back); action (what you run, with command, evidence, undo, and then for what you do after it: approve or reject); change or changes (before and after text).",
  "For anything else say it with respond.",
  "Use kind notice for something he should only see; when nothing needs him, don't ask.",
  "Give title and context.",
  'To clear a gated subtask (deploy, money or secret), name its id in the text or title, e.g. "Approve s4: merge PR #1288".',
  "Without an id, the wording must name the action (deploy/install/restart/release, pay, share a secret...) and match exactly one subtask with that gate; the ask's kind does not matter.",
  "Kind secret asks him to type a secret value; to approve a secret-gated step, ask a decision or action naming its id.",
  "Evidence: upload images, recordings, audio, PDFs or files with t3_attachment_prepare_upload and pass attachment blocks; use html blocks for charts, tables or diagrams (self-contained, no external scripts, fonts or fetches; readable at phone width, in light and dark).",
  "Give every image alt text and a one-line caption (an md block after it).",
].join(" ");
