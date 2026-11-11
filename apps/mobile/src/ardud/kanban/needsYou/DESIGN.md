# Needs you on the phone

The native Needs-you screens. They follow the web page (`apps/web/src/ardud/kanban/needsYou`)
and share its logic from `packages/client-runtime/src/ardud/kanban`: the queue's order, what an
answer needs, the send queue, the wording. This file records what is specific to the phone.

Mode: Operate. Abdullah works down a list and answers. Nothing here is decoration.

## Screens

| Route                | Link                                      | What it is                                 |
| -------------------- | ----------------------------------------- | ------------------------------------------ |
| `NeedsYou`           | `needs-you`, `needs-you?ask=<card>:<ask>` | The queue: sections, filters, search       |
| `NeedsYouAsk`        | `needs-you/ask/:cardId/:askId`            | One ask, its answer and the bar to send it |
| `NeedsYouDiscussion` | `needs-you/ask/:cardId/:askId/discussion` | The talk under an ask, with the composer   |
| `NeedsYouBatch`      | `needs-you/batch/:boardId/:batchKey`      | Several asks of one shape, one answer      |
| `NeedsYouHistory`    | `needs-you/history`                       | What he answered, and what each agent said |
| `NeedsYouReference`  | `needs-you/reference`                     | "What an ask can be", from sample asks     |

The way in is the "Needs you" row above the Boards group on the thread list, with the number
of asks that are his to answer.

Web to phone: the list fills the screen and a row pushes its ask (no rail beside a reader).
The header's board chips become one scrolling row of chips. Kind and "Holds a card" move into
the header's Filter menu. The discussion is its own pushed screen, so the keyboard and the
composer behave as they do in a board discussion. Snooze times, "Add a note", "Edit the draft"
and "Open the card" sit in the header's More menu. Previous and next ask are the header's
chevrons, as on a card. There are no keyboard shortcuts and no side-by-side change view.

## Tokens

Only the app's Desk tokens, so every theme and both appearances work without a rule of their
own. No raw colours.

- Ground `bg-screen`. A panel or row is one tone off it: `bg-card` inside an ask,
  `bg-grouped-card` for list rows on the queue. Text set inside a panel sits on `bg-screen`.
- Accent band `bg-inline-skill-background` + `text-inline-skill-foreground`: a picked option,
  "Updated", "Back from snooze", "Recommended".
- Warning `bg-warning` + `text-warning-foreground`: holds a card, out of date, not his device.
- Negative `bg-danger` + `text-danger-foreground`: not sent, a field's problem.
- The one filled button is `bg-primary`; every other button is `bg-secondary`.
- Colour only carries state, and every state is also said in words (a pill, a band, a label).

## Type

The app's scaled roles, which follow Dynamic Type: `text-xl` the ask's title, `text-base`
body and controls, `text-sm` secondary lines, `text-2xs` labels and row metadata. No fixed
point sizes. Weights `font-t3-medium` and `font-t3-semibold`. Monospace only for a command
and for a markdown draft while it is edited. Numbers that change in place are tabular.

## Parts (`ui.tsx`)

`Pill` a state in a word or two. `Band` one line of state with at most one action. `Panel`
an exhibit (command, change, draft). `Label` the quiet name over a block. `Heading` "Your
answer". `GrowingInput` text that grows. `Check` the tick used by options, steps and batch
rows. `BarButton` the buttons of the bar under an ask. `ActionRow` a row in a small list of
actions. `AskToastBar` what just happened to an answer, with Undo (and the seconds left),
Retry or View.

Reused from the boards: `AppBar`, `ChoiceRow`, `Group`/`Row`, `SearchField`, `MarkdownText`,
`SegmentedControl`, `ThemedSwitch`, the system date picker, `FilePreviewModal` (pictures, pinch
to zoom, swipe between), the attachment screen (video, audio, PDF, any other file), and
`MessageView`/`Composer` from `Chat.tsx`.

## Rules

- Draw an ask from `kanbanAskResponse(ask)`, never from its kind. A field type this build does
  not know is a text field; a block it does not know is left out.
- Order inside an ask: where it is from, state pills, title, bands, text, context, exhibits,
  blocks, draft, then "Your answer" (steps, options, fields, why, note), the card and why it
  is here, "Fewer like this".
- The bar: discussion (with its count), the "no" in the ask's own word, the filled answer.
  The answer's label comes from `askPrimaryLabel`.
- Every target is at least 44pt (`min-h-11`), most are 48.
- A band says what happened and what he can do. A refusal is shown in the server's words.
- Not his device: a band at the top says so, everything stays readable, every control that
  would send is disabled and the bar says why.
- Haptics, iOS only: a selection tick on a pick or toggle, success when an answer leaves,
  a warning when something stops it, an error when a send fails.
- VoiceOver: a row is one label (title, where, state, age); a band that reports a failure is
  an alert; the toast is announced.

## Secrets

A `secret` field is a secure text entry with no autofill, no autocorrect and no clear-text
toggle. Its value lives in the ask screen's component state and nowhere else: not the form,
not the store, not the send queue, not a log. It goes once, over `secrets.answerAsk`, with no
Undo, and the field is emptied as it leaves. An answer that carries a secret is never retried
by itself; he types it again.

## Pages inside an ask

An `html` block is loaded from a string into a private WebView (`incognito`, no cookies, no
storage, no file access). It can say how tall it is and hand back a value for a custom field;
it is given the theme and nothing else. Any link it follows opens outside the app.

## Offline

A failed read keeps what was last read and says so, with Retry. An answer that never reached
the server is kept in memory as "Not sent", goes again by itself when the feed reads again
(at most three rounds), and can always be retried by hand. Nothing is written to disk.
