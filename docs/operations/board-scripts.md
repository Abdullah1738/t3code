# Recovering unresolved board script deliveries

A board script records a card or post as `unresolved` when its write may have landed or the server stopped before receiving the result. These commands never replay automatically. After 100 unresolved outcomes, further card and post commands are held until an operator reconciles them.

1. Read the script from `GET /api/ardud/kanban/boards/:board/scripts` with `orchestration:read` access.
2. Check each unresolved command against the board. Confirm whether it landed, was superseded, or should be abandoned before acknowledging it.
3. With `orchestration:operate` access, send `POST /api/ardud/kanban/scripts/:script/acknowledge`. Copy the checked records' `command`, `firstFailedAt`, and `attempts` into `deliveries`:

```json
{
  "deliveries": [
    {
      "command": { "kanban": "post", "text": "Deploy failed." },
      "firstFailedAt": "2026-11-13T00:00:00.000Z",
      "attempts": 1
    }
  ]
}
```

Acknowledgement clears only those unresolved records and returns the updated script. It does not send a command or start a run. Held work resumes on the next run. To retry a command confirmed not to have landed, explicitly emit it again after acknowledgement. Avoid re-emitting commands that already landed.

A running script or a stale delivery reference returns HTTP 409 without clearing any records. Wait for the run to finish, read the script again, and check its current outcomes. Batches accept 1–100 references. The equivalent WebSocket operation is `kanban.script.acknowledge`, with `scriptId` alongside `deliveries`.
