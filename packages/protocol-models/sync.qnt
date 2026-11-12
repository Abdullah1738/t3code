// TARGET M3: two keys, one scope/principal, four feed positions, two epochs.
// Snapshot pages use immutable versions captured at H, not current rows.
// Fairness: eventual reconnect, authorized snapshot completion and prefix delivery.
// I9 cache purge assumes immediate revocation discovery; disconnected clients cannot
// discover revocation. Server authorization is checked on EVERY page/delta request.
module sync {
  var s: { head: int, epoch: int, floor: int, rows: int -> int,
    history: int -> (int -> int), client: int -> int, cursor: int, clientEpoch: int,
    h: int, snapshot: int -> int, pages: Set[int], connected: bool,
    authorized: bool, response: { kind: str, authorized: bool }, activeSnapshot: bool }
  pure val empty = Map(0 -> 0, 1 -> 0)
  action init = s' = { head: 0, epoch: 0, floor: 0, rows: empty,
    history: Map(0 -> empty, 1 -> empty, 2 -> empty, 3 -> empty, 4 -> empty),
    client: empty, cursor: 0, clientEpoch: 0, h: 0, snapshot: empty, pages: Set(),
    connected: true, authorized: true, response: { kind: "none", authorized: true }, activeSnapshot: false }
  // 0 absent, 1 live, 2 tombstone. Re-creation after deletion is excluded in this bound.
  action mutate(key: int, value: int): bool = all { s.head < 4, s.rows.get(key) != 2,
    s' = { ...s, head: s.head + 1, rows: s.rows.set(key, value),
      history: s.history.set(s.head + 1, s.rows.set(key, value)) } }
  action beginSnapshot = all { s.connected, s.authorized,
    s' = { ...s, h: s.head, snapshot: s.rows, pages: Set(), activeSnapshot: true,
      clientEpoch: s.epoch, cursor: -1, client: empty, response: { kind: "data", authorized: s.authorized } } }
  action page(key: int): bool = all { s.connected, s.authorized, s.activeSnapshot, s.clientEpoch == s.epoch,
    s' = { ...s, pages: s.pages.union(Set(key)), client: s.client.set(key, s.snapshot.get(key)), response: { kind: "data", authorized: s.authorized } } }
  action finishSnapshot = all { s.authorized, s.activeSnapshot, s.pages == Set(0, 1), s.clientEpoch == s.epoch,
    s' = { ...s, cursor: s.h, activeSnapshot: false } }
  // Full changed-row prefix is atomic with its cursor; arbitrary future/gap deltas rejected.
  action delta = all { s.connected, s.authorized, not(s.activeSnapshot), s.clientEpoch == s.epoch,
    s.cursor >= s.floor, s.cursor >= 0, s.cursor < s.head,
    s' = { ...s, cursor: s.cursor + 1, client: s.history.get(s.cursor + 1), response: { kind: "data", authorized: s.authorized } } }
  // Requests are possible after revocation; their observed response must be a denial.
  action requestPage(key: int): bool = if (s.authorized) page(key)
    else s' = { ...s, response: { kind: "denied", authorized: s.authorized } }
  action disconnect = s' = { ...s, connected: false }
  action reconnect = s' = { ...s, connected: true }
  action compact = all { s.floor < s.head, not(s.activeSnapshot), s' = { ...s, floor: s.floor + 1 } }
  action rotate = all { s.epoch < 1, s' = { ...s, epoch: s.epoch + 1, activeSnapshot: false, cursor: -1, client: empty } }
  action revoke = s' = { ...s, authorized: false, client: empty, cursor: -1, activeSnapshot: false }
  action step = {
    nondet key = Set(0, 1).oneOf()
    nondet value = Set(1, 2).oneOf()
    any { mutate(key, value), beginSnapshot, requestPage(key), finishSnapshot, delta,
      disconnect, reconnect, compact, rotate, revoke, s' = s }
  }
  val I5_prefix = s.cursor < 0 or (s.clientEpoch == s.epoch and s.cursor <= s.head and s.client == s.history.get(s.cursor))
  val I5_convergence = s.cursor != s.head or s.client == s.rows
  val I5_noResurrection = s.cursor < 0 or Set(0, 1).forall(k => s.history.get(s.cursor).get(k) != 2 or s.client.get(k) == 2)
  val I9 = (s.response.kind != "data" or s.response.authorized) and (s.authorized or s.client == empty)
  val invariant = I5_prefix and I5_convergence and I5_noResurrection and I9
  run revocationWitness = init.then(mutate(0, 1)).then(beginSnapshot).then(page(0))
    .then(revoke).then(requestPage(1))
    .then(all { assert(s.response.kind == "denied" and s.client == empty and I9), s' = s })
  run convergenceWitness = init.then(mutate(0, 1)).then(beginSnapshot).then(page(0))
    .then(mutate(0, 2)).then(page(1)).then(finishSnapshot).then(delta).then(all { assert(s.client == s.rows), s' = s })
}
