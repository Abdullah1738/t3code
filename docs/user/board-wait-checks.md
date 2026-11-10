# Board wait checks

A card with no running thread can be parked on a wait: the one thing it is
waiting for, as data. Each wait has a check. The board asks the check, the
check answers, and the board applies the answer: keep holding, wake someone,
or show a problem.

The board has six checks of its own. A board script can be a check too, for
everything else (a Linear issue reaching a state, a deploy landing, a reply
from a person).

| `on`       | Ends when                               |
| ---------- | --------------------------------------- |
| `push`     | new commits land on `pr`                |
| `merge`    | `pr` merges                             |
| `ci`       | checks on `pr` finish                   |
| `owner_go` | the owner answers open question `ask`   |
| `card`     | card `waitsOn` is done                  |
| `time`     | `until` passes                          |
| `script`   | the board script named `script` says so |

The six names are reserved. A board script is only ever reached as
`on: "script"` with its name in `script`, so a script can't change what
`merge` means, whatever it is called.

## What a check is given

One JSON object per waiting card. A board script gets an array of them on
stdin: one run handles every card waiting on that script.

```json
{
  "wait": {
    "on": "script",
    "script": "linear-state",
    "args": { "issue": "ENG-123", "state": "Done" },
    "note": "ENG-123 to reach Done",
    "pr": null,
    "card": null,
    "ask": null,
    "until": null,
    "sinceHead": null,
    "wakeRole": null,
    "by": { "_tag": "evaluator", "threadId": "..." },
    "at": "2026-11-10T10:00:00.000Z",
    "expiredAt": null,
    "status": "ENG-123 is In Review",
    "lastCheckedAt": "2026-11-10T11:55:00.000Z",
    "failures": 0,
    "problem": null
  },
  "card": {
    "id": "card-...",
    "number": 12,
    "title": "Ship the exporter",
    "stage": "in_review",
    "links": [
      { "kind": "pr", "url": "https://github.com/acme/app/pull/12", "label": null, "state": "open" }
    ],
    "blockedBy": ["card-..."],
    "next": "evaluator"
  },
  "facts": {
    "now": "2026-11-10T12:00:00.000Z",
    "prs": [
      {
        "url": "https://github.com/acme/app/pull/12",
        "state": "open",
        "head": "ffee0011...",
        "checks": "pending",
        "at": "2026-11-10T11:58:00.000Z"
      }
    ],
    "cards": [{ "id": "card-...", "number": 3, "stage": "completed", "done": true }],
    "asks": [{ "id": "q1", "open": false }]
  },
  "args": { "issue": "ENG-123", "state": "Done" }
}
```

- `card.next` is who acts next on the card once nothing holds it: `work`,
  `review` or `evaluator`.
- `facts.prs` has a reading for each pull request the wait or the card points
  at. `state` is `open`, `draft`, `merged` or `closed`; `checks` is `passing`,
  `failing`, `pending` or null; `head` and `checks` can be missing. A pull
  request that is not listed could not be read: that is unknown, not gone.
- `facts.cards` has the cards the wait or `blockedBy` name. One not listed is
  gone.
- `args` is what the agent passed to `card_wait`, or `{}`.

## What a check answers

One of three. A board script prints one line per card it wants to change;
a card it prints nothing for holds.

```json
{"kanban":{"wait":{"card":"#12","result":"hold","status":"CI 3 of 5 passed"}}}
{"kanban":{"wait":{"card":"#12","result":"wake","to":"review","note":"ENG-123 is Done","restart":true}}}
{"kanban":{"wait":{"card":"#12","result":"fail","reason":"Linear said 401"}}}
```

- `hold`: still waiting. `status` is optional, one line, shown on the card.
- `wake`: the wait comes off and `to` is woken with `note`. `to` is `work`,
  `review`, `evaluator` or `none`; left out, it is the wait's own `wakeRole`,
  else `card.next`. `restart: true` starts a reviewer at the first review step
  instead of the one it was on (use it when the code changed).
- `fail`: the check could not tell. The card keeps waiting and shows the
  reason. Three in a row and the card shows "check failing" and the evaluator
  is told. A `fail` never wakes anyone and never drops the wait.

Anything else (a line the board can't read, a script that exits non-zero,
times out or prints too much) counts as `fail` for the cards it did not answer.

`card` is the card's number, as `12` or `"#12"`.

## Script checks

- A script runs its checks at most every 5 minutes. A wait can ask for another
  pace with `args.everyMs` (1 minute to 6 hours); the shortest any of its
  waits asks for wins.
- The run is a normal script run (trigger `wait-check`): same timeout, same
  output cap, same environment, and it shows on the scripts page.
- Only the script a card waits on can answer that card's check.
- A script that is turned off or removed fails its waits, so the card shows it.

## Waking and parking from any script

A script that runs on a board event or a webhook can end a wait without
polling, or park a card:

```json
{"kanban":{"wake":{"card":"#12","to":"work","note":"v2.4.1 is live in prod"}}}
{"kanban":{"wait":{"card":"#12","on":"time","until":"2026-11-14T09:00:00+04:00","note":"recheck after the release"}}}
```

- `wake` ends the card's wait, whatever it waits on. It is refused, with the
  reason in the run's output, when the card has no wait or a thread is running
  it.
- `wait` with `on` parks a card. It takes the same fields as `card_wait`
  (`on`, `note`, `pr`, `waitsOn`, `ask`, `until`, `head`, `wakeRole`, `script`,
  `args`) and has the same guards.

## Examples

Two short reference scripts, not installed on any board:

- [`board-wait-checks/linear-state.py`](board-wait-checks/linear-state.py): a
  Linear issue reaches a state. Reads Linear through `linctl`, which uses the
  owner's own login; the script holds no token.
- [`board-wait-checks/pr-ready.py`](board-wait-checks/pr-ready.py): a pull
  request leaves draft. No network call: it reads `facts.prs`.
