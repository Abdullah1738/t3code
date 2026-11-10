// Board lock diet: deferred stops (KanbanService runPendingStops / the
// interrupt route drain / loadPendingStops / giveUpStop).
//
// A card that lets go of its thread saves a stop row for the assignment the
// thread has at that commit. A dispatch commits a new assignment, then sends
// it outside the board gate in two steps: `consume` (under the stop lock: run
// the thread's pending stops, close their rows) and `accept` (the thread starts
// the assignment). Requests, drains, give-ups, crashes may land between them.
// The drain of a row runs the stop unless a send already did; a row that never
// confirms is given up under the stop lock. Closing rows can fail.
//
// Bounds: two stops, three assignments, two crashes, 10 steps. Sends from
// outside the board (UI/control) are not modelled. Safety only: `safe` holds in
// every explored state; nothing here proves eventual delivery.
//
// `step` is the shipped design (rows closed in the stop lock, give-up drops
// the pending entry in the same lock). `stepVolatile` is d41b206361: a send
// consumes a stop in memory only and the drain closes its row after the lock;
// a crash in between replays the stop against the next assignment.
module stops {
  var s: { alive: bool, crashes: int, assigned: int, sending: int, consumed: bool,
    runAssign: int, running: bool, requested: Set[int], target: int -> int,
    rows: Set[int], undeliverable: Set[int], pending: Set[int], done: Set[int],
    executed: Set[int], cutLater: bool }
  action init = s' = { alive: true, crashes: 0, assigned: 0, sending: -1, consumed: false,
    runAssign: 0, running: true, requested: Set(), target: Map(0 -> 0, 1 -> 0),
    rows: Set(), undeliverable: Set(), pending: Set(), done: Set(), executed: Set(),
    cutLater: false }
  // A stop for the thread's current assignment; row and pending entry commit with the write.
  action request(id: int): bool = all { s.alive, not(s.requested.contains(id)),
    s' = { ...s, requested: s.requested.union(Set(id)), target: s.target.set(id, s.assigned),
      rows: s.rows.union(Set(id)), pending: s.pending.union(Set(id)) } }
  action runEnds = all { s.alive, s.running, s' = { ...s, running: false } }
  // Dispatch commits the next assignment on the thread (under the board gate).
  action dispatchCommit = all { s.alive, s.sending == -1, s.assigned < 3,
    s' = { ...s, assigned: s.assigned + 1, sending: s.assigned + 1, consumed: false } }
  // One interrupt for stops `ks`: it cuts whatever assignment is running.
  def cuts(ks: Set[int]): bool = s.running and ks.exists(k => s.target.get(k) < s.runAssign)
  // The send's first step, under the stop lock. A failed close aborts the send.
  action consumeWith(ks: Set[int], durable: bool, closeOk: bool): bool =
    if (ks == Set()) s' = { ...s, consumed: true }
    else if (durable and not(closeOk))
      s' = { ...s, running: false, cutLater: s.cutLater or cuts(ks), sending: -1 }
    else
      s' = { ...s, running: false, cutLater: s.cutLater or cuts(ks), consumed: true,
        rows: if (durable) s.rows.exclude(ks) else s.rows,
        done: s.done.union(ks), pending: s.pending.exclude(ks) }
  action consume(durable: bool, closeOk: bool): bool =
    all { s.alive, s.sending != -1, not(s.consumed), consumeWith(s.pending, durable, closeOk) }
  // The send's second step: the thread starts the assignment.
  action accept = all { s.alive, s.sending != -1, s.consumed,
    s' = { ...s, runAssign: s.sending, running: true, sending: -1, consumed: false } }
  // The drain for row `id`, under the stop lock unless a send already ran it.
  action drainWith(id: int, ks: Set[int], durable: bool, closeOk: bool): bool =
    if (durable and not(closeOk))
      s' = { ...s, running: false, cutLater: s.cutLater or cuts(ks) }
    else
      s' = { ...s, running: false, cutLater: s.cutLater or cuts(ks),
        rows: if (durable) s.rows.exclude(ks) else s.rows,
        done: s.done.union(ks.exclude(Set(id))), executed: s.executed.union(Set(id)),
        pending: s.pending.exclude(ks) }
  action drain(id: int, durable: bool, closeOk: bool): bool = all { s.alive, s.rows.contains(id),
    if (s.done.contains(id)) s' = { ...s, rows: s.rows.exclude(Set(id)) }
    else drainWith(id, s.pending.union(Set(id)), durable, closeOk) }
  // Volatile design only: the drain closes its row after releasing the lock.
  action close(id: int): bool = all { s.alive, s.rows.contains(id), s.executed.contains(id),
    s' = { ...s, rows: s.rows.exclude(Set(id)) } }
  // Retries ran out: closed undeliverable and dropped from the pending stops, in the stop lock.
  action giveUp(id: int): bool = all { s.alive, s.rows.contains(id),
    s' = { ...s, rows: s.rows.exclude(Set(id)), undeliverable: s.undeliverable.union(Set(id)),
      pending: s.pending.exclude(Set(id)), done: s.done.exclude(Set(id)) } }
  // A crash loses memory and any send in flight; dispatch re-sends a committed assignment later.
  action crash = all { s.alive, s.crashes < 2,
    s' = { ...s, alive: false, crashes: s.crashes + 1, sending: -1, consumed: false,
      pending: Set(), done: Set(), executed: Set() } }
  // Startup reloads open stop rows before any board send or drain.
  action recover = all { not(s.alive), s' = { ...s, alive: true, pending: s.rows } }
  action step = {
    nondet id = Set(0, 1).oneOf()
    nondet closeOk = Set(true, false).oneOf()
    any { request(id), runEnds, dispatchCommit, consume(true, closeOk), accept,
      drain(id, true, closeOk), giveUp(id), crash, recover, s' = s }
  }
  action stepVolatile = {
    nondet id = Set(0, 1).oneOf()
    any { request(id), runEnds, dispatchCommit, consume(false, true), accept,
      drain(id, false, true), close(id), crash, recover, s' = s }
  }
  // No stop ever cuts an assignment committed after it was asked for.
  val invariant = not(s.cutLater)
  // Every open row is still owed: pending, or already run (closing it is what remains).
  val owed = s.alive implies s.rows.forall(id => s.pending.contains(id) or s.done.contains(id) or s.executed.contains(id))
  // A row given up is closed and holds no send.
  val givenUp = s.undeliverable.forall(id => not(s.rows.contains(id)) and not(s.pending.contains(id)))
  val safe = invariant and owed and givenUp
  // The same property, named apart for the expected `stepVolatile` counterexample.
  val volatileSafe = safe
  run heldStopTest = init.then(request(0)).then(runEnds).then(dispatchCommit).then(consume(true, true)).then(accept)
    .then(all { assert(not(s.cutLater) and s.rows == Set() and s.running and s.runAssign == 1), s' = s })
  run requestBetweenConsumeAndAcceptTest = init.then(runEnds).then(dispatchCommit).then(consume(true, true))
    .then(request(0)).then(accept).then(drain(0, true, true))
    .then(all { assert(not(s.cutLater) and s.rows == Set()), s' = s })
  run closeFailureRetriesTest = init.then(request(0)).then(runEnds).then(dispatchCommit).then(consume(true, false))
    .then(dispatchCommit).then(consume(true, true)).then(accept)
    .then(all { assert(not(s.cutLater) and s.rows == Set() and s.runAssign == 2), s' = s })
  run giveUpReleasesTest = init.then(request(0)).then(giveUp(0)).then(runEnds).then(dispatchCommit)
    .then(consume(true, true)).then(accept)
    .then(all { assert(not(s.cutLater) and s.running and s.undeliverable == Set(0)), s' = s })
  run crashReplayTest = init.then(request(0)).then(crash).then(recover).then(drain(0, true, true))
    .then(all { assert(not(s.cutLater) and s.rows == Set()), s' = s })
  run volatileCounterexampleTest = init.then(request(0)).then(runEnds).then(dispatchCommit)
    .then(consume(false, true)).then(accept).then(crash).then(recover).then(drain(0, false, true))
    .then(all { assert(s.cutLater), s' = s })
}
