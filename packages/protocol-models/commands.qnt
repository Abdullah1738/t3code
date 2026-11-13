// TARGET M2: two command IDs; each ID has a durable receipt/tombstone forever.
// Process crashes only; power-loss preservation assumes SQLite FULL + honest fsync.
// Weak fairness after final crash: recovery, claim, and delivery/rejection progress.
// Downstream dedup by command ID is required for exactly-once visible delivery.
module commands {
  var s: { alive: bool, crashes: int, receipts: Set[int], expired: Set[int],
    ack: Set[int], events: Set[int], applied: int -> int, pending: Set[int],
    delivered: Set[int], undeliverable: Set[int], lease: int, claimed: int, fence: int,
    draining: bool, remaining: int, currentSaved: bool, currentVolatile: bool, currentDelivered: bool, currentNotice: bool }
  action init = s' = { alive: true, crashes: 0, receipts: Set(), expired: Set(), ack: Set(),
    events: Set(), applied: Map(0 -> 0, 1 -> 0), pending: Set(), delivered: Set(),
    undeliverable: Set(), lease: 0, claimed: -1, fence: 0,
    draining: false, remaining: 2, currentSaved: false, currentVolatile: false, currentDelivered: false, currentNotice: false }
  action commit(id: int): bool = all { s.alive,
    if (s.receipts.contains(id) or s.expired.contains(id)) s' = s
    else s' = { ...s, receipts: s.receipts.union(Set(id)), events: s.events.union(Set(id)),
      applied: s.applied.set(id, s.applied.get(id) + 1), pending: s.pending.union(Set(id)) } }
  action ack(id: int): bool = all { s.alive, s.receipts.contains(id), s' = { ...s, ack: s.ack.union(Set(id)) } }
  action expire(id: int): bool = all { s.receipts.contains(id),
    s' = { ...s, receipts: s.receipts.exclude(Set(id)), expired: s.expired.union(Set(id)) } }
  action claim(id: int): bool = all { s.alive, s.pending.contains(id), s.claimed == -1, s.fence < 3,
    s' = { ...s, claimed: id, fence: s.fence + 1, lease: s.fence + 1 } }
  action finish(token: int, success: bool): bool = all { s.alive,
    if (s.claimed != -1 and token == s.lease)
      s' = { ...s, pending: s.pending.exclude(Set(s.claimed)), claimed: -1,
        delivered: if (success) s.delivered.union(Set(s.claimed)) else s.delivered,
        undeliverable: if (success) s.undeliverable else s.undeliverable.union(Set(s.claimed)) }
    else s' = s }
  action retry = all { s.alive, s.claimed != -1, s' = { ...s, claimed: -1 } }
  action crash = all { s.alive, s.crashes < 2,
    s' = { ...s, alive: false, crashes: s.crashes + 1, currentVolatile: false } }
  action recover = all { not(s.alive), s' = { ...s, alive: true, claimed: -1 } }
  // Bounded fair suffix: no new failures/admissions, one healthy worker service
  // opportunity per pending command. This is stronger than weak fairness.
  action beginDrain = all { s.alive, s' = { ...s, draining: true, claimed: -1 } }
  action fairService = {
    nondet id = Set(0, 1).oneOf()
    all { s.remaining > 0,
      if (s.pending.size() == 0) s' = { ...s, remaining: s.remaining - 1 }
      else all { s.pending.contains(id), s' = { ...s, remaining: s.remaining - 1,
        pending: s.pending.exclude(Set(id)), delivered: s.delivered.union(Set(id)) } } }
  }
  action step = if (s.draining) any { fairService, all { s.remaining == 0, s' = s } } else {
    nondet id = Set(0, 1).oneOf()
    nondet token = 0.to(3).oneOf()
    nondet success = Set(false, true).oneOf()
    any { commit(id), ack(id), expire(id), claim(id), finish(token, success), retry, crash, recover, beginDrain, s' = s }
  }
  val I1 = s.ack.subseteq(s.receipts.union(s.expired)) and s.ack.subseteq(s.events)
  val I2 = Set(0, 1).forall(id => s.applied.get(id) <= 1)
  // Safety obligation underlying I4; eventual termination additionally needs fairness.
  val I4_obligation = s.events.subseteq(s.pending.union(s.delivered).union(s.undeliverable))
  val I4_fairSuffix = s.remaining != 0 or s.events.subseteq(s.delivered.union(s.undeliverable))
  val invariant = I1 and I2 and I4_obligation and I4_fairSuffix
  // CURRENT post/answer: persistence precedes inline routing outside the saving lock.
  // currentSaved is the saved-message analogue of acceptance (there is no M2 receipt).
  action saveCurrent = all { s.alive, not(s.currentSaved),
    s' = { ...s, currentSaved: true, currentVolatile: true } }
  action routeCurrent = all { s.alive, s.currentVolatile,
    s' = { ...s, currentDelivered: true, currentVolatile: false } }
  // Hotfix retries conflict with fresh state; after retries a durable pending note is attempted.
  action conflictCurrent = all { s.alive, s.currentVolatile, s' = s }
  action noticeCurrent = all { s.alive, s.currentVolatile, s' = { ...s, currentNotice: true } }
  action stepCurrent = any { saveCurrent, routeCurrent, conflictCurrent, noticeCurrent, crash, recover, s' = s }
  val currentRecoverable = not(s.currentSaved) or s.currentDelivered or s.currentVolatile
  run lostOwnerWitness = init.then(saveCurrent).then(crash).then(recover).then(all { assert(not(currentRecoverable)), s' = s })
  run deliveryWitness = init.then(commit(0)).then(ack(0)).then(claim(0)).then(crash).then(recover)
    .then(claim(0)).then(finish(2, true)).then(all { assert(s.delivered.contains(0)), s' = s })
}
