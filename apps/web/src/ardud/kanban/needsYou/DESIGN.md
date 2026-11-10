---
name: Needs you
description: One queue for every ask an agent has for the owner, answered without opening the card.
colors:
  ground: "#ffffff"
  surface: "#f7f7f5"
  raised: "#ffffff"
  chip: "#ececea"
  rule: "#e8e8e4"
  control: "#d9d9d6"
  text: "#1f201d"
  muted: "#63635f"
  accent: "#1b6e66"
  accent-ink: "#ffffff"
  band: "#e6f1ef"
  negative: "#b42318"
  negative-band: "#fdecea"
  warning: "#92400e"
  warning-band: "#fdf0dc"
  positive: "#1d7044"
  positive-band: "#e3f3ea"
typography:
  title:
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.4
  section:
    fontSize: "1rem"
    fontWeight: 600
  body:
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  control:
    fontSize: "0.875rem"
    fontWeight: 500
  label:
    fontSize: "0.75rem"
    fontWeight: 400
rounded:
  field: "12px"
  panel: "16px"
  pill: "9999px"
spacing:
  row: "8px"
  block: "20px"
  page: "28px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.pill}"
    height: "36px"
    padding: "0 16px"
  button-plain:
    backgroundColor: "{colors.chip}"
    textColor: "{colors.text}"
    rounded: "{rounded.pill}"
    height: "36px"
  field:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.text}"
    rounded: "{rounded.field}"
    padding: "8px 12px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.panel}"
    padding: "16px"
  option-picked:
    backgroundColor: "{colors.band}"
    rounded: "{rounded.field}"
---

# Needs you

## Overview

A working screen, not a page to read: the owner comes here to clear asks. The
queue is on the left, one ask is open on the right, and the answer is always
one key or one tap away. The page takes the board's own look (`../tokens.css`,
`../kanban.css`); the colours above are the "desk" theme's light values and
exist here only so the file is self-contained. In code, always use the
`--m-*` tokens, never these literals. Dark values come from the same tokens.

Order inside an ask never changes: where it is from, its state, the title, the
question, what it shows (command, changes, blocks), the draft, the answer
(steps, options, fields, reason, note), the discussion, then the facts.

## Colors

- One accent (`--m-accent`), used for the single filled button in a bar, the
  picked option, focus rings and links. Nothing else is accent-coloured.
- State is said in words first and tinted second: warning band for "holds a
  card" and "out of date", negative band for "not sent", accent band for
  "updated", "new reply" and "back from snooze".
- Removed and added words in a change use the negative and positive bands with
  strike-through for removed, so the difference does not rest on colour alone.
- The full-size media viewer is black in both themes.

## Typography

The app's UI face at five sizes: 20 px title, 16 px section headings and body,
14 px controls and rows, 12 px labels and meta, 11 px marks inside a row.
Numbers that change or line up are tabular. Monospace only for literal text:
the command an action runs, a secret, a markdown source being edited.

## Layout

Composition follows the width the page really has (the app sidebar may be open
or folded), measured on the sheet, not the window:

- Under 700 px: one pane. The queue is a bottom sheet behind "Queue"; the
  discussion is a bottom sheet that stops above the answer bar; the bar holds
  the discussion button, More and the answer.
- 700 to 999 px: queue rail (272 px) and reader. Facts sit under the ask.
- 1000 px and up: queue rail (320 px), reader, and a 232 px facts column.

The answer bar is fixed to the bottom of the reader and never scrolls away.
Inline html pages are capped at 520 px tall and scroll inside; Expand shows
them whole. Text columns do not go wider than the reader; long words wrap.

## Elevation & Depth

Flat. Panels are a fill one step from the ground or a 1 px ring in
`--m-rule`. Only real overlays float: sheets, the toast, the media viewer.

## Shapes

Pills for buttons, chips and state marks. 12 px corners for fields, options
and rows. 16 px corners for panels and the main sheet. Hairline rings instead
of borders so corners stay clean.

## Components

- **Queue row**: kind, board and card number, marks, age; then the title on
  one line. A dot says whether it holds its card. Roving tab stop.
- **Answer bar**: one filled button named for what it does ("Deploy",
  "Approve all 3", "Send answer"), then quieter ways out. Key caps beside each
  action; hidden where there is no keyboard.
- **Option**: a full-width row with its number key; picked is the accent band
  with a 2 px accent ring. A picture or chart sits inside the option.
- **Field**: label above, hint and unit beside, the problem under the field in
  the negative colour, announced. A secret is masked and lives only in the
  reader's state.
- **Change viewer**: After, Before, Changes, Side by side; several changes are
  stepped through one at a time.
- **Toast**: bottom of the reader, with the seconds left to undo.
- **Sheet (`Layer`)**: right on wide screens, bottom on a phone, centred for
  short dialogs. Focus stays inside; Escape closes.

## Do's and Don'ts

- Do render from `kanbanAskResponse(ask)`; never branch on `kind` for behaviour.
- Do keep one filled button per bar.
- Do say state in words; colour only supports it.
- Don't add explanatory sublines; a label that restates the obvious goes.
- Don't add shadows to anything that is not an overlay.
- Don't keep a secret value anywhere but the reader's component state.
- Don't use `title` tooltips or manual memo hooks (repo lint rules).
