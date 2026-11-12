---
name: Board
description: Every card in the column of what it is really doing, with the one line that says what it waits on.
colors:
  ground: "#ffffff"
  surface: "#f7f7f5"
  raised: "#ffffff"
  active: "#ececea"
  chip: "#ececea"
  rule: "#e8e8e4"
  text: "#1f201d"
  muted: "#63635f"
  accent: "#1b6e66"
  accent-ink: "#ffffff"
  accent-text: "#1b6e66"
  negative: "#b42318"
  warning: "#92400e"
  warning-band: "#fbf4ea"
typography:
  board-name:
    fontSize: "1rem"
    fontWeight: 600
  number:
    fontSize: "1.25rem"
    fontWeight: 600
  card-title:
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.375
  control:
    fontSize: "0.875rem"
    fontWeight: 500
  meta:
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.375
rounded:
  row: "8px"
  tile: "12px"
  pill: "9999px"
spacing:
  tile-gap: "8px"
  column-gap: "10px"
  block: "14px"
  page: "20px"
components:
  tile:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.tile}"
    padding: "9px 11px 10px"
  tile-raised:
    backgroundColor: "{colors.raised}"
    rounded: "{rounded.tile}"
  strip:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.tile}"
    padding: "10px 16px"
  pause-banner:
    backgroundColor: "{colors.warning-band}"
    textColor: "{colors.text}"
    rounded: "{rounded.tile}"
    padding: "8px 14px"
  switch:
    backgroundColor: "{colors.chip}"
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    height: "32px"
  switch-picked:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
    rounded: "{rounded.pill}"
  hidden-rail:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
    rounded: "{rounded.tile}"
    width: "32px"
---

# Board

## Overview

A working screen the owner scans many times a day to answer one question: what
is each card really doing, and what is it waiting on. A stage name alone does
not say that, so the board groups by true state and each tile carries one line
of why. The Needs you page (`needsYou/DESIGN.md`) is its sibling and looks the
same.

The board takes the app's own look through `tokens.css` and `kanban.css`. The
colours above are the "desk" theme's light values and exist here only so the
file is self-contained. In code, always use the `--m-*` tokens, never these
literals. Dark values and other themes come from the same tokens.

Reading order of the page never changes: board name and search, the pause
banner when the board is paused, the flow numbers, All / Stuck, then the
columns left to right from not started to shipped, with Needs you last.

## Colors

- Almost everything is ground, surface and two greys. Colour is kept for what
  the owner has to act on.
- Warning (`--m-warning`, band `--m-warnband`): Needs you, a paused board and
  what the pause holds, a check that is failing, a wait about to run out.
- Negative (`--m-negative`): failed and flagged cards only.
- Accent (`--m-accent`, text `--m-accent-text`): the slots bar, "Unblocks N",
  focus rings, the one filled button of a dialog. Nothing else.
- State is said in words first; the colour and the glyph only support it.
- Measured contrast with the desk tokens: light, lowest pair 5.1:1 (muted on
  chip); dark, lowest 5.4:1 (negative on raised).

## Typography

The app's UI face, four sizes: 20 px for the flow numbers, 16 px board name,
14 px card titles and controls, 12 px for everything that is meta (card
number, age, the why line, group and column headings). On touch each steps up
one size (14 px meta, 16 px titles and controls). Counts, ages and times are
tabular. Titles clamp at two lines, the why line at two, an ask at three; the
drawer shows them whole.

12 px meta is the board's incumbent scale and stays: a column is 184 to 250 px
wide, and the title has to win the tile. Column headings are in the text
colour and group headings in the muted one, so the two levels read apart at
the same size.

## Layout

The board's own width decides, not the window's (the app sidebar may be open):

- Under 640 px: one column at a time, picked from a row of column buttons with
  counts (To-Do, Working, Reviewing, Waiting, Needs you, Shipped). The picked
  button is scrolled into sight. The banner, the numbers, the switches and the
  column buttons scroll away with the cards; the page header keeps only the
  board, search and New. Group by, Filter and Settled are icon menus beside
  All / Stuck. The Stuck lens shows every column one under the other in one
  scroller, never a scroller inside a scroller.
- 640 px up to the full grid (1118 px with a mouse, 1230 px on touch): every
  column at a readable width (248 px or more) in one strip that scrolls
  sideways, Needs you inside it.
- Wider: the columns share the width, Needs you stays outside the scroller so
  it never slides away. Shipped is folded to a 56 px strip until the board is
  1500 px wide or the reader opens it.

Inside a column, cards sit in groups named for their state, in the order the
engine will take them. Groups that are going nowhere soon (blocked, parked)
start folded and show their count. An open group shows five cards, then
"N more"; a column with a single group shows all of it. Lists over 40 rows
mount only what is on screen.

A column picks its list renderer from its card count, not its row count, so
opening or folding a group never swaps the scroller and loses the place.

Column widths are the reader's: drag a column's edge, double-click to reset,
hide one to a 32 px rail from the Columns menu. They are saved per board.

## Elevation & Depth

Flat. A tile is a fill one step from the ground; a tile inside the Needs you
well is the raised fill. The page panel has a 1 px ring in `--m-rule`. Only
real overlays float: the card drawer, menus, dialogs.

## Shapes

12 px corners for tiles, the flow strip, the banner and rails. 8 px for rows
inside a column (group headings, "N more", shipped rows). Pills for switches,
chips, column buttons and text buttons. No borders on tiles; a hairline ring
only where a panel needs an edge.

## Components

- **Flow strip**: one definition list. Running now (slots used, with a track),
  Ready to start, Blocked ("Held by the pause" on a paused board), Waiting on
  authors, Needs you. Needs you is a link to the Needs you page for this board.
- **Pause banner**: since when, how many of the open cards it lets through,
  "Lift the pause", and the words it was paused with. Lifting asks first.
- **All / Stuck**: a two-way switch with the stuck count on it, above the
  columns at every width. Stuck keeps cards that need a look and says in one
  line under the switch how many and why. The count only includes cards a
  Stuck column can show.
- **Board switcher**: the board name. With two or more boards it opens a menu
  of them with each one's Needs you count; switching opens the other board on
  All.
- **Column**: heading and count, then groups. A hidden column is a rail with
  its count and name; folded Shipped is a strip with the word and a count per
  stage.
- **Group heading**: name and count; a chevron when it folds.
- **Tile**: number, priority and age; the title; the why line (glyph, what it
  waits on, since or until when); "Unblocks N" when it holds others up; goal
  and pull request chips. One button, whole tile.
- **Why line**: one cause per card, picked by the engine (`tilePlace`): failed
  or flagged, waiting on an author, a check, a merge, a time, another card, a
  slot, a reviewer. Never two. The reason clamps at three lines; what moves the
  card next sits under it and is never cut. A wait past its limit keeps its
  date and says "Past its 3-day limit: needs a look"; it never keeps promising
  to wake by itself.
- **Drawer state block**: the column the card is in, "Waiting on" with the
  same line at reading size, "Unblocks N cards". On a phone the label sits
  over its value. History below lists moves, waits set, ended and expired,
  reviews and flags, newest first; a kind the client does not know is a plain
  line. A failed card's Stalled row offers Restart; a flag offers Clear.
- **Loading**: the board's shape in flat bars, nothing moving, announced once.
- **Empty**: "No cards yet" and where cards come from. Filters or a search
  that match nothing say so and offer Clear filters.

## Do's and Don'ts

- Do place a card with `boardViewFor(boardId)`; never work a card's state out
  in a component.
- Do give a new state a group and a why line in `tilePlace`, with a test,
  before any markup.
- Do keep one why line per tile; more belongs in the drawer.
- Do keep touch targets at 44 px: where a control stays smaller to the eye
  (the switch, a column heading link) its hit area grows instead.
- Don't add a second accent, a shadow on a tile, a border on a tile or a
  status dot beside a word that already says it.
- Don't add explanatory sublines under headings; a count is enough.
- Don't render every card: long lists go through `BoardRows`.
- Don't use `title` tooltips or manual memo hooks (repo lint rules).
- Don't say a state in colour alone: amber and red always come with the words.
- Don't cap a control's width at "100%" when it is outdented with a negative
  margin; let it shrink through `min-w-0` (the board name was cut this way).

## Review notes (11 Nov 2026)

A scored critique of the rebuilt board (two independent passes: a design read
of about 40 captures at 1440, 834 and 390 px, and detector plus measured
evidence) gave 27 of 40 on Nielsen's heuristics. Lowest: consistency (2),
error recovery (2), help (2).

Fixed from it: a wait that ran out was told apart by colour only; the board
name was cut 12 px short; the phone lost the picked column and nested a
scroller in the Stuck lens; three shipped columns on the phone became one;
Needs you tiles on the phone lost their ask; the Stuck sentence wrapped beside
the switch; held cards queued for review sat under Reviewing on a paused
board; a failed card told the owner to restart it with no control of that
name; a missing board showed the server's raw words; a step showed its id.

Kept on purpose, with the reason:

- The page panel's 1 px ring reads as a shadow to the inspector. It is a
  hairline edge, not depth.
- 12 px meta fails the inspector's "tiny text" share. It is the board's scale;
  touch steps up one size.
- The drawer's Stage field and its history name stages ("In Review"), the
  board names columns ("In review, waiting"). A column is where the card
  really is; the stage is the field the owner can change. They differ on
  purpose when a card in review is waiting on someone.
- The folded Shipped strip, hidden-column rails and the icon menus on narrow
  widths have no visible words beyond their name; each has an accessible name.

Open, not done here: keys for the board (search, Stuck, tile to tile), a
legend for the priority bars and model marks, strip numbers that jump to their
group, undo for lifting a pause.
