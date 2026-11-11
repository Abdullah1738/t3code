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
`MessageView`/`Composer` from `Chat.tsx`. A message under an ask is shown outside its
discussion's feed: "Show full" reads it whole over the ask's own server calls, and a pick in
it is read-only.

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
- An answer that can't be changed (not his device, expired, with the evaluator, on its way)
  takes no input anywhere: fields, options, steps, the reason for a no, the note, the draft,
  uploads and a custom field's page. A field row drops any write while it is disabled.
- One store per server. A screen keeps the store of the server it rendered with
  (`useAskScope`), so an answer, a retry or a secret goes to that server or nowhere. When the
  server changes, secrets on screen are cleared first, then the held answer and every unsent
  one are dropped, and the ask, batch and discussion screens start over (keyed on the
  scope's `serial`).
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

## Whose phone

Answering, replying, hand-over, snooze and batches are on only once the session says this
phone is the owner's (`useOwnerStanding`: `checking`, `unchecked`, `owner`, `notOwner`). The
feed can load before the session does, so until then the asks read and nothing can be filled
in or sent: `OwnerBand` shows one quiet line while it checks, a band with Retry when the
session could not be read, and the pairing notice when the phone is not his. The bar under an
ask says the same in place of its buttons. A refusal from the server ("not the owner's
device") turns the controls off again, whatever the session said before.

A call that comes back late acts only for the screen and server that started it
(`useLateStanding`): nothing at all once the server changed, and no navigation, haptic or
announcement from a screen that was left or covered.

## Pages inside an ask

An `html` block is text an agent wrote, loaded from a string into a private WebView
(`incognito`, no cookies, no cache, no storage, no file access, no base address). It can say
how tall it is and hand back a value for a custom field; it is given the theme and nothing
else. It goes nowhere by itself (`ardud/common/pageNavigation.ts`): its own document and
frames load, a web address in a frame loads in that frame, and everything else is refused,
the app's own scheme first of all. A web link the page follows is shown under it
(`PageLinkOffer`, "Open example.com") and opens only on his tap. The origin whitelist stays
`*`: the WebView library opens anything outside the whitelist by itself. The board
discussion's page (`Chat.tsx`) follows the same rule. A task step's link is a link only when
it is a web address.

## Offline

A failed read keeps what was last read and says so, with Retry. An answer that never reached
the server is kept in memory as "Not sent" and goes again by itself on the next good read of
the feed that comes at least five seconds after it failed (`unreachedRetryTracker`), three
times at most. It does not matter whether the feed itself ever failed, or came back while the
answer was still on its way; the read the store makes right after a failure is too soon to
count, so a dead connection is not hammered. The count is on the answer (`autoRetries` in the shared store), so
it holds while the answer is on its way; after that the band says it no longer goes by itself.
Retry by hand always works. Nothing is written to disk, and nothing unsent survives a change
of server.
