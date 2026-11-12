// TARGET M4: one board mailbox, two cards, two fields, one pool slot.
// Mailbox reduction/commit atomic; no I/O. Fair scheduling required for progress only.
// Revisions/tokens bounded at 3; commands include expected FIELD revision.
module boards {
  var s: { title: int, body: int, titleRev: int, bodyRev: int,
    expectedTitle: int, expectedBody: int, titleSeen: int, bodySeen: int,
    conflict: bool, slots: Set[int], fence: int -> int, attached: Set[int], attachedFence: int -> int }
  action init = s' = { title: 0, body: 0, titleRev: 0, bodyRev: 0,
    expectedTitle: 0, expectedBody: 0, titleSeen: 0, bodySeen: 0, conflict: false,
    slots: Set(), fence: Map(0 -> 0, 1 -> 0), attached: Set(), attachedFence: Map(0 -> 0, 1 -> 0) }
  action read = s' = { ...s, expectedTitle: s.titleRev, expectedBody: s.bodyRev }
  action patchTitle = all { s.titleRev < 3,
    if (s.expectedTitle == s.titleRev)
      s' = { ...s, title: s.title + 1, titleRev: s.titleRev + 1, titleSeen: s.titleSeen + 1, conflict: false }
    else s' = { ...s, conflict: true } }
  action patchBody = all { s.bodyRev < 3,
    if (s.expectedBody == s.bodyRev)
      s' = { ...s, body: s.body + 1, bodyRev: s.bodyRev + 1, bodySeen: s.bodySeen + 1, conflict: false }
    else s' = { ...s, conflict: true } }
  action moveIn(id: int): bool = all { s.slots.size() < 1, not(s.slots.contains(id)), s.fence.get(id) < 3,
    s' = { ...s, slots: s.slots.union(Set(id)), fence: s.fence.set(id, s.fence.get(id) + 1) } }
  action moveOut(id: int): bool = all { s.slots.contains(id), s.fence.get(id) < 3,
    s' = { ...s, slots: s.slots.exclude(Set(id)), attached: s.attached.exclude(Set(id)),
      fence: s.fence.set(id, s.fence.get(id) + 1) } }
  action completion(id: int, token: int): bool =
    if (s.slots.contains(id) and token == s.fence.get(id))
      s' = { ...s, attached: s.attached.union(Set(id)), attachedFence: s.attachedFence.set(id, token) }
    else s' = s
  action step = {
    nondet id = Set(0, 1).oneOf()
    nondet token = 0.to(3).oneOf()
    any { read, patchTitle, patchBody, moveIn(id), moveOut(id), completion(id, token), s' = s }
  }
  val I3 = s.title == s.titleSeen and s.body == s.bodySeen
  val I6 = s.slots.size() <= 1 and s.attached.subseteq(s.slots) and s.attached.forall(id => s.attachedFence.get(id) == s.fence.get(id))
  val invariant = I3 and I6
  run disjointWitness = init.then(patchTitle).then(patchBody).then(all { assert(s.title == 1 and s.body == 1), s' = s })
  run conflictWitness = init.then(patchTitle).then(patchTitle).then(all { assert(s.conflict and s.title == 1), s' = s })
  run staleSameCardWitness = init.then(moveIn(0)).then(moveOut(0)).then(moveIn(0))
    .then(completion(0, 1)).then(all { assert(s.attached == Set()), s' = s })
  run staleWitness = init.then(moveIn(0)).then(moveOut(0)).then(moveIn(1))
    .then(completion(0, 1)).then(all { assert(s.attached == Set()), s' = s })
}
