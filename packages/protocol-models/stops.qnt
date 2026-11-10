// Board lock diet: deferred stops (KanbanService runPendingStops, the interrupt
// route drain, loadPendingStops, the stop give-up).
//
// A card that lets go of its thread saves a stop row for the assignment the
// board has committed for that thread. Dispatch reuses a thread in the code's
// order: it sends first, outside the board gate, then commits the assignment
// when it takes the gate back. Dispatch is card-scoped, so only some writes
// make it stale; saving a stop for its thread does: `gen` is the thread's stop
// resource (`stops:<thread>`), which dispatch observes before the send and
// every saved stop moves after registering itself as pending. A stale commit is
// abandoned (the code then tells the thread the board changed). All modelled
// stops are on the one thread. The send runs the thread's pending
// stops under the one stop lock in two steps: capture the pending keys, then
// interrupt and close their rows (a failed close fails the send). Drains take
// the same lock the same way. Requests are never blocked by the lock, so they
// land between capture and interrupt. A give-up writes its notice (outside the
// lock), then closes its row and drops it from the pending stops in the lock.
//
// Bounds: two stops, three assignments, two crashes. Sends from outside the
// board (UI/control) are not modelled. Safety only: `safe` holds in every
// explored state; nothing here proves eventual delivery.
//
// `step` is the shipped design. `stepVolatile` is d41b206361: a send consumes
// a stop in memory only and the drain closes its row after the lock; a crash
// in between replays the stop against the next committed assignment. That
// counterexample takes 11 steps, past the sampled bound, so it is checked by
// the `volatileCounterexampleTest` witness rather than by `check.mjs run`.
module stops {
  var s: { alive: bool, crashes: int, committed: int, committedSet: Set[int], nextId: int,
    sending: int, phase: str, sendGen: int, gen: int, lock: str, captured: Set[int], drainId: int,
    runAssign: int, running: bool, requested: Set[int], target: int -> int,
    rows: Set[int], noticed: Set[int], undeliverable: Set[int],
    pending: Set[int], done: Set[int], executed: Set[int], wrongCuts: Set[int] }
  action init = s' = { alive: true, crashes: 0, committed: 0, committedSet: Set(0), nextId: 0,
    sending: -1, phase: "none", sendGen: 0, gen: 0, lock: "", captured: Set(), drainId: -1,
    runAssign: 0, running: true, requested: Set(), target: Map(0 -> 0, 1 -> 0),
    rows: Set(), noticed: Set(), undeliverable: Set(),
    pending: Set(), done: Set(), executed: Set(), wrongCuts: Set() }
  // A stop for the thread's committed assignment; row and pending entry commit with the write.
  action request(id: int): bool = all { s.alive, not(s.requested.contains(id)),
    s' = { ...s, requested: s.requested.union(Set(id)), target: s.target.set(id, s.committed),
      rows: s.rows.union(Set(id)), pending: s.pending.union(Set(id)), gen: s.gen + 1 } }
  action runEnds = all { s.alive, s.running, s' = { ...s, running: false } }
  // One interrupt for stops `ks` cuts the running assignment; it is a wrong cut
  // when that assignment is newer than what a stop was asked for.
  def cutsOf(ks: Set[int]): Set[int] =
    if (s.running and ks.exists(k => s.target.get(k) < s.runAssign)) Set(s.runAssign) else Set()
  // Dispatch decides to reuse the thread for a new assignment (gate released for the send).
  action sendStart = all { s.alive, s.sending == -1, s.nextId < 3,
    s' = { ...s, nextId: s.nextId + 1, sending: s.nextId + 1, phase: "start", sendGen: s.gen } }
  // runPendingStops, first half: the stop lock is taken and the pending keys captured.
  action sendCapture = all { s.alive, s.phase == "start", s.lock == "",
    s' = { ...s, phase: "captured", lock: "send", captured: s.pending } }
  // Second half: one interrupt, then the rows close (or the close fails and the send fails).
  action sendStops(durable: bool, closeOk: bool): bool = all { s.alive, s.phase == "captured",
    val ks = s.captured
    if (ks == Set()) s' = { ...s, phase: "consumed", lock: "" }
    else if (durable and not(closeOk))
      s' = { ...s, running: false, wrongCuts: s.wrongCuts.union(cutsOf(ks)),
        sending: -1, phase: "none", lock: "", captured: Set() }
    else
      s' = { ...s, running: false, wrongCuts: s.wrongCuts.union(cutsOf(ks)),
        rows: if (durable) s.rows.exclude(ks) else s.rows,
        done: s.done.union(ks), pending: s.pending.exclude(ks),
        phase: "consumed", lock: "", captured: Set() } }
  // The thread starts the assignment.
  action accept = all { s.alive, s.phase == "consumed",
    s' = { ...s, runAssign: s.sending, running: true, phase: "accepted" } }
  // Dispatch takes the gate back: it commits, or is stale after any board write and abandons.
  action commit = all { s.alive, s.phase == "accepted",
    s' = { ...s, sending: -1, phase: "none",
      committed: if (s.gen == s.sendGen) s.sending else s.committed,
      committedSet: if (s.gen == s.sendGen) s.committedSet.union(Set(s.sending)) else s.committedSet } }
  // The drain for row `id`: skipped if a send ran it; else the same two halves under the lock.
  action drainCapture(id: int): bool = all { s.alive, s.rows.contains(id), s.lock == "",
    if (s.done.contains(id)) s' = { ...s, rows: s.rows.exclude(Set(id)) }
    else s' = { ...s, lock: "drain", drainId: id, captured: s.pending.union(Set(id)) } }
  action drainStops(durable: bool, closeOk: bool): bool = all { s.alive, s.lock == "drain",
    val ks = s.captured
    val id = s.drainId
    if (durable and not(closeOk))
      s' = { ...s, running: false, wrongCuts: s.wrongCuts.union(cutsOf(ks)),
        lock: "", captured: Set(), drainId: -1 }
    else
      s' = { ...s, running: false, wrongCuts: s.wrongCuts.union(cutsOf(ks)),
        rows: if (durable) s.rows.exclude(ks) else s.rows,
        done: s.done.union(ks.exclude(Set(id))), executed: s.executed.union(Set(id)),
        pending: s.pending.exclude(ks), lock: "", captured: Set(), drainId: -1 } }
  // Volatile design only: the drain closes its row after releasing the lock.
  action close(id: int): bool = all { s.alive, s.rows.contains(id), s.executed.contains(id),
    s' = { ...s, rows: s.rows.exclude(Set(id)) } }
  // Retries ran out: the notice is written first (durable), outside the lock.
  action giveUpNotice(id: int): bool = all { s.alive, s.rows.contains(id),
    s' = { ...s, noticed: s.noticed.union(Set(id)) } }
  // Then, in the lock, the row closes undeliverable if still open and its pending entry goes.
  action giveUpClose(id: int): bool = all { s.alive, s.noticed.contains(id), s.lock == "",
    s' = { ...s,
      rows: s.rows.exclude(Set(id)),
      undeliverable: if (s.rows.contains(id)) s.undeliverable.union(Set(id)) else s.undeliverable,
      pending: s.pending.exclude(Set(id)), done: s.done.exclude(Set(id)) } }
  // A crash loses memory, the lock and any send in flight (never committed).
  action crash = all { s.alive, s.crashes < 2,
    s' = { ...s, alive: false, crashes: s.crashes + 1, sending: -1, phase: "none", lock: "",
      captured: Set(), drainId: -1, pending: Set(), done: Set(), executed: Set() } }
  // Startup reloads open stop rows before any board send or drain.
  action recover = all { not(s.alive), s' = { ...s, alive: true, pending: s.rows } }
  action step = {
    nondet id = Set(0, 1).oneOf()
    nondet closeOk = Set(true, false).oneOf()
    any { request(id), runEnds, sendStart, sendCapture, sendStops(true, closeOk), accept, commit,
      drainCapture(id), drainStops(true, closeOk), giveUpNotice(id), giveUpClose(id),
      crash, recover, s' = s }
  }
  action stepVolatile = {
    nondet id = Set(0, 1).oneOf()
    any { request(id), runEnds, sendStart, sendCapture, sendStops(false, true), accept, commit,
      drainCapture(id), drainStops(false, true), close(id), crash, recover, s' = s }
  }
  // No stop ever cuts an assignment the board committed after the stop was asked for.
  val invariant = s.wrongCuts.intersect(s.committedSet) == Set()
  // Every open row is still owed: pending, or already run (closing it is what remains).
  val owed = s.alive implies s.rows.forall(id => s.pending.contains(id) or s.done.contains(id) or s.executed.contains(id) or s.captured.contains(id))
  // A row given up is closed, holds no send, and its notice was written.
  val givenUp = s.undeliverable.forall(id => not(s.rows.contains(id)) and not(s.pending.contains(id)) and s.noticed.contains(id))
  val safe = invariant and owed and givenUp
  // The same property, named apart for the expected `stepVolatile` counterexample.
  val volatileSafe = safe
  run heldStopTest = init.then(request(0)).then(runEnds).then(sendStart).then(sendCapture)
    .then(sendStops(true, true)).then(accept).then(commit)
    .then(all { assert(safe and s.rows == Set() and s.running and s.committed == 1), s' = s })
  run requestDuringSendAbandonsTest = init.then(runEnds).then(sendStart).then(sendCapture)
    .then(request(0)).then(sendStops(true, true)).then(accept).then(commit)
    .then(drainCapture(0)).then(drainStops(true, true))
    .then(all { assert(safe and s.committed == 0 and s.wrongCuts == Set(1)), s' = s })
  run closeFailureRetriesTest = init.then(request(0)).then(runEnds).then(sendStart).then(sendCapture)
    .then(sendStops(true, false)).then(sendStart).then(sendCapture).then(sendStops(true, true))
    .then(accept).then(commit)
    .then(all { assert(safe and s.rows == Set() and s.committed == 2), s' = s })
  run giveUpReleasesTest = init.then(request(0)).then(giveUpNotice(0)).then(giveUpClose(0))
    .then(runEnds).then(sendStart).then(sendCapture).then(sendStops(true, true)).then(accept).then(commit)
    .then(all { assert(safe and s.running and s.undeliverable == Set(0) and s.committed == 1), s' = s })
  run giveUpCrashTest = init.then(request(0)).then(giveUpNotice(0)).then(crash).then(recover)
    .then(giveUpNotice(0)).then(giveUpClose(0))
    .then(all { assert(safe and s.undeliverable == Set(0) and s.pending == Set()), s' = s })
  run crashReplayTest = init.then(request(0)).then(crash).then(recover)
    .then(drainCapture(0)).then(drainStops(true, true))
    .then(all { assert(safe and s.rows == Set()), s' = s })
  run volatileCounterexampleTest = init.then(request(0)).then(runEnds).then(sendStart).then(sendCapture)
    .then(sendStops(false, true)).then(accept).then(commit).then(crash).then(recover)
    .then(drainCapture(0)).then(drainStops(false, true))
    .then(all { assert(not(volatileSafe)), s' = s })
}
