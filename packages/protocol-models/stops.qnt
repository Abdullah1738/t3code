// Board lock diet: a card that lets go of its thread asks for a deferred stop
// (an interrupt route row). The stop is meant for the run current when it was
// asked for. Board sends to the thread run pending stops first; the drain runs
// a stop unless a send already did. Two stops, three runs, two crashes.
// Sends from outside the board (UI/control) are not modelled.
// `step` closes a stop's row durably, inside the stop lock, as soon as it ran
// (the code since d41b206361's follow-up). `stepVolatile` remembers a stop run by a send
// only in memory and closes the drain's row after the lock (the r1 fix): a
// crash in between replays the stop against a newer run.
module stops {
  var s: { alive: bool, crashes: int, runId: int, running: bool,
    requested: Set[int], target: int -> int, rows: Set[int],
    pending: Set[int], done: Set[int], executed: Set[int], cutLater: bool }
  action init = s' = { alive: true, crashes: 0, runId: 0, running: true,
    requested: Set(), target: Map(0 -> 0, 1 -> 0), rows: Set(),
    pending: Set(), done: Set(), executed: Set(), cutLater: false }
  // A stop for the current run; its row and pending entry commit with the write.
  action request(id: int): bool = all { s.alive, not(s.requested.contains(id)),
    s' = { ...s, requested: s.requested.union(Set(id)), target: s.target.set(id, s.runId),
      rows: s.rows.union(Set(id)), pending: s.pending.union(Set(id)) } }
  action runEnds = all { s.alive, s.running, s' = { ...s, running: false } }
  // One interrupt for stops `ks`: it cuts whatever run is current.
  def cuts(ks: Set[int]): bool = s.running and ks.exists(k => s.target.get(k) < s.runId)
  // A board send: pending stops first, then a new run starts.
  action sendWith(ks: Set[int], durable: bool): bool =
    s' = { ...s, runId: s.runId + 1, running: true,
      cutLater: s.cutLater or cuts(ks),
      rows: if (durable) s.rows.exclude(ks) else s.rows,
      done: s.done.union(ks), pending: Set() }
  action send(durable: bool): bool = all { s.alive, s.runId < 3, sendWith(s.pending, durable) }
  // The drain for row `id`: skipped if a send ran it, else one interrupt.
  action drainWith(id: int, ks: Set[int], durable: bool): bool =
    s' = { ...s, running: false, cutLater: s.cutLater or cuts(ks),
      rows: if (durable) s.rows.exclude(ks) else s.rows,
      done: s.done.union(ks.exclude(Set(id))), executed: s.executed.union(Set(id)),
      pending: Set() }
  action drain(id: int, durable: bool): bool = all { s.alive, s.rows.contains(id),
    if (s.done.contains(id)) s' = { ...s, rows: s.rows.exclude(Set(id)) }
    else drainWith(id, s.pending.union(Set(id)), durable) }
  // Volatile design only: the drain closes its row after releasing the lock.
  action close(id: int): bool = all { s.alive, s.rows.contains(id), s.executed.contains(id),
    s' = { ...s, rows: s.rows.exclude(Set(id)) } }
  action crash = all { s.alive, s.crashes < 2,
    s' = { ...s, alive: false, crashes: s.crashes + 1, pending: Set(), done: Set(), executed: Set() } }
  // Startup reloads open stop rows before any board send or drain.
  action recover = all { not(s.alive), s' = { ...s, alive: true, pending: s.rows } }
  action step = {
    nondet id = Set(0, 1).oneOf()
    any { request(id), runEnds, send(true), drain(id, true), crash, recover, s' = s }
  }
  action stepVolatile = {
    nondet id = Set(0, 1).oneOf()
    any { request(id), runEnds, send(false), drain(id, false), close(id), crash, recover, s' = s }
  }
  // No stop ever cuts a run that started after it was asked for.
  val invariant = not(s.cutLater)
  // Every open row is still owed: pending (or about to be reloaded) or already run.
  val owed = s.alive implies s.rows.forall(id => s.pending.contains(id) or s.done.contains(id) or s.executed.contains(id))
  val safe = invariant and owed
  run heldStopTest = init.then(request(0)).then(runEnds).then(send(true))
    .then(all { assert(not(s.cutLater) and s.rows == Set() and s.running), s' = s })
  run drainFirstTest = init.then(request(0)).then(drain(0, true)).then(send(true))
    .then(all { assert(not(s.cutLater) and s.rows == Set() and s.runId == 1), s' = s })
  run crashReplayTest = init.then(request(0)).then(crash).then(recover).then(drain(0, true))
    .then(all { assert(not(s.cutLater) and s.rows == Set()), s' = s })
  run volatileCounterexampleTest = init.then(request(0)).then(runEnds).then(send(false))
    .then(crash).then(recover).then(drain(0, false))
    .then(all { assert(s.cutLater), s' = s })
}
