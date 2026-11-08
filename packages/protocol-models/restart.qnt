// Restart recovery: one queued/root run, one native child, two crashes.
// Weak fairness: after the last crash, recovery and pending effects run.
// Provider calls are represented by the durable dispatch command, not native execution.
module restart {
  var s: { phase: str, native: bool, child: bool, alive: bool, crashes: int,
    cut: bool, recovered: bool, reason: str, effect: str, message: bool, continued: int, wake: str, promoted: int, needsContinuation: bool, blocked: bool }
  action init = s' = { phase: "queued", native: false, child: false, alive: true,
    crashes: 0, cut: false, recovered: false, reason: "", effect: "none", message: false, continued: 0, wake: "none", promoted: 0, needsContinuation: false, blocked: false }
  action admit = all { s.alive, s.phase == "queued", s' = { ...s, phase: "preparing" } }
  action start = all { s.alive, s.phase == "preparing", s' = { ...s, phase: "running" } }
  action attach = all { s.alive, s.phase == "running", not(s.native), s' = { ...s, native: true, phase: "running" } }
  action awaitChild = all { s.alive, s.phase == "running", s.native, s' = { ...s, phase: "awaiting", child: true } }
  action settle = all { s.alive, s.phase == "running", s.native, s' = { ...s, phase: "settled" } }
  action crash = all { s.alive, s.crashes < 2,
    s' = { ...s, alive: false, crashes: s.crashes + 1,
      cut: s.cut or s.phase != "settled", recovered: false } }
  // Decision is made from pre-reconciliation live status. Awaited native work qualifies.
  // Skip summaries are logs, not durable per-run outcomes in the current implementation.
  action recover = all { not(s.alive),
    s' = { ...s, alive: true, recovered: true, needsContinuation: s.phase != "queued" and s.phase != "settled",
      reason: if (s.phase == "settled") "no_awaited_work" else "",
      wake: if (s.wake == "running" or (s.phase == "queued")) "pending" else s.wake,
      effect: if (s.effect == "running") "pending"
        else if (s.phase != "settled" and s.phase != "queued" and not(s.message)) "pending" else s.effect } }
  action block = all { s.alive, s.phase == "queued", s' = { ...s, blocked: true } }
  action unblock = all { s.alive, s.blocked, s' = { ...s, blocked: false } }
  action deferWake = all { s.alive, s.wake == "running", s.blocked, s' = { ...s, wake: "succeeded" } }
  action claimWake = all { s.alive, s.wake == "pending", s' = { ...s, wake: "running" } }
  // Promotion is a durable run-state transition, distinct from acknowledging its wake.
  action executeWake = all { s.alive, s.wake == "running", not(s.blocked),
    s' = { ...s, phase: if (s.phase == "queued") "preparing" else s.phase,
      promoted: if (s.phase == "queued") s.promoted + 1 else s.promoted } }
  action completeWake = all { s.alive, s.wake == "running", s.phase != "queued", s' = { ...s, wake: "succeeded" } }
  action claim = all { s.alive, s.effect == "pending", s' = { ...s, effect: "running" } }
  // Deterministic command/message IDs deduplicate retries, including a lost completion ACK.
  action execute = all { s.alive, s.effect == "running",
    s' = { ...s, message: true, continued: if (s.message) s.continued else s.continued + 1 } }
  action complete = all { s.alive, s.effect == "running", s.message,
    s' = { ...s, effect: "succeeded" } }
  action step = any { block, unblock, deferWake, claimWake, executeWake, completeWake, admit, start, attach, awaitChild, settle, crash, recover, claim, execute, complete, s' = s }
  val I7_noDuplicate = s.continued <= 1 and s.promoted <= 1
  val I7_accounted = not(s.cut and s.recovered) or s.reason != "" or s.effect != "none" or s.message or s.wake != "none"
  val preparationContinues = not(s.recovered and s.needsContinuation and not(s.native)) or s.effect != "none"
  val nativePreparationContinues = not(s.recovered and s.needsContinuation) or s.effect != "none"
  val queuedContinues = not(s.recovered and s.phase == "queued") or s.wake != "none"
  run queuedWitness = init.then(crash).then(recover).then(claimWake).then(executeWake).then(completeWake)
    .then(crash).then(recover).then(claim).then(execute).then(complete)
    .then(all { assert(s.continued == 1 and s.promoted == 1), s' = s })
  run unacknowledgedWakeWitness = init.then(crash).then(recover).then(claimWake).then(executeWake)
    .then(crash).then(recover).then(claimWake).then(executeWake).then(completeWake)
    .then(claim).then(execute).then(complete).then(all { assert(s.promoted == 1 and s.continued == 1), s' = s })
  run deferredWakeWitness = init.then(block).then(crash).then(recover).then(claimWake).then(deferWake)
    .then(crash).then(recover).then(unblock).then(claimWake).then(executeWake).then(completeWake)
    .then(all { assert(s.promoted == 1), s' = s })
  val invariant = I7_noDuplicate and I7_accounted
  run preparationWitness = init.then(admit).then(start).then(crash).then(recover).then(all { assert(preparationContinues), s' = s })
  run awaitedWitness = init.then(admit).then(start).then(attach).then(awaitChild).then(crash)
    .then(recover).then(claim).then(execute).then(complete)
    .then(all { assert(s.continued == 1), s' = s })
  run replayWitness = init.then(admit).then(start).then(attach).then(crash).then(recover).then(claim).then(execute)
    .then(crash).then(recover).then(claim).then(execute).then(complete).then(all { assert(I7_noDuplicate), s' = s })
}
