// Reserved auth reader only (0). The unchanged base reader is outside this model.
// ACK follows COMMIT.
// Every borrow starts a new snapshot. No stale snapshot is reused by a new
// request. Archive pinning excludes the mover until ALL WALs are pinned.
// Bounded duration is a scheduler assumption implemented by the worker watchdog.
module readers {
  var s: { head: int, ack: int, active: Set[int], snap: int -> int,
    required: int -> int, age: int -> int, hot: bool, cold: bool,
    pinnedHot: int -> bool, pinnedCold: int -> bool,
    revoked: bool, authorized: bool, checked: bool, checkpoint: int, priorHead: int, checkpointFloor: int }
  pure val ids = Set(0)
  action init = s' = { head: 0, ack: 0, active: Set(),
    snap: Map(0 -> 0), required: Map(0 -> 0),
    age: Map(0 -> 0), hot: true, cold: false,
    pinnedHot: Map(0 -> true),
    pinnedCold: Map(0 -> false),
    revoked: false, authorized: false, checked: false, checkpoint: 0, priorHead: 0, checkpointFloor: 0 }
  action commit = all { s.head < 4, s' = { ...s, head: s.head + 1 } }
  action ack = s' = { ...s, ack: s.head }
  action borrow(r: int): bool = all { not(s.active.contains(r)),
    s' = { ...s, active: s.active.union(Set(r)), snap: s.snap.set(r, s.head),
      required: s.required.set(r, s.ack), age: s.age.set(r, 0),
      pinnedHot: s.pinnedHot.set(r, s.hot), pinnedCold: s.pinnedCold.set(r, s.cold) } }
  action release(r: int): bool = s' = { ...s, active: s.active.exclude(Set(r)) }
  // Copy then delete; pinning and retirement are indivisible with respect to mover.
  action copy = s' = { ...s, cold: true }
  action retire = all { s.cold, s' = { ...s, hot: false } }
  action revoke = s' = { ...s, revoked: true, checked: false }
  action verify = s' = { ...s, authorized: not(s.revoked), checked: true }
  // One tick ages every snapshot and expires it after two ticks. New readers
  // start at head and cannot pin an older checkpoint prefix.
  action tick = s' = { ...s, priorHead: s.head, checkpointFloor: s.priorHead,
    active: s.active.filter(r => s.age.get(r) < 1),
    age: ids.mapBy(r => if (s.age.get(r) < 2) s.age.get(r) + 1 else 2),
    // A guaranteed prefix rather than the exact maximal checkpoint. The
    // noPinnedPrefix invariant proves this periodic attempt is never blocked.
    checkpoint: s.priorHead }
  action step = { nondet r = ids.oneOf()
    any { commit, ack, borrow(r), release(r), copy, retire, revoke, verify, tick } }
  val readAfterAck = s.active.forall(r => s.snap.get(r) >= s.required.get(r))
  val noTornArchive = s.active.forall(r => s.pinnedHot.get(r) or s.pinnedCold.get(r))
  val boundedSnapshots = s.active.forall(r => s.age.get(r) <= 1)
  val authorization = not(s.checked) or s.authorized == not(s.revoked)
  val checkpointProgress = s.checkpoint >= s.checkpointFloor
  val noPinnedPrefix = s.active.forall(r => s.snap.get(r) >= s.checkpoint)
  val invariant = readAfterAck and noTornArchive and boundedSnapshots and authorization and checkpointProgress and noPinnedPrefix and s.ack <= s.head and (s.hot or s.cold)
  run ackWitness = init.then(commit).then(ack).then(borrow(0))
    .then(all { assert(s.snap.get(0) == 1 and readAfterAck), s' = s })
  run archiveWitness = init.then(borrow(0)).then(copy).then(retire).then(release(0)).then(borrow(0))
    .then(all { assert(noTornArchive), s' = s })
  run checkpointWitness = init.then(borrow(0)).then(commit).then(ack).then(tick).then(tick)
    .then(all { assert(s.checkpoint == s.head and s.active == Set()), s' = s })
  run revocationWitness = init.then(verify).then(revoke).then(verify)
    .then(all { assert(not(s.authorized) and authorization), s' = s })
}
