// CURRENT d069f2795d: one root run, one native child, two crashes.
// Weak fairness: after the last crash, recovery and pending effects run.
// Provider calls are represented by the durable dispatch command, not native execution.
module restart {
  var s: { phase: str, native: bool, child: bool, alive: bool, crashes: int,
    cut: bool, recovered: bool, reason: str, effect: str, message: bool, continued: int }
  action init = s' = { phase: "preparing", native: false, child: false, alive: true,
    crashes: 0, cut: false, recovered: false, reason: "", effect: "none", message: false, continued: 0 }
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
    s' = { ...s, alive: true, recovered: true,
      reason: if (s.phase == "preparing") "other" else if (not(s.native)) "no_provider_thread" else if (s.phase == "settled") "other" else "",
      effect: if (s.effect == "running") "pending"
        else if (s.native and s.phase != "settled" and not(s.message)) "pending" else s.effect } }
  action claim = all { s.alive, s.effect == "pending", s' = { ...s, effect: "running" } }
  // Deterministic command/message IDs deduplicate retries, including a lost completion ACK.
  action execute = all { s.alive, s.effect == "running",
    s' = { ...s, message: true, continued: if (s.message) s.continued else s.continued + 1 } }
  action complete = all { s.alive, s.effect == "running", s.message,
    s' = { ...s, effect: "succeeded" } }
  action step = any { start, attach, awaitChild, settle, crash, recover, claim, execute, complete, s' = s }
  val I7_noDuplicate = s.continued <= 1
  val I7_accounted = not(s.cut and s.recovered) or s.reason != "" or s.effect != "none" or s.message
  val preparationContinues = not(s.recovered and not(s.native)) or s.effect != "none"
  val nativePreparationContinues = s.reason != "no_provider_thread" or s.effect != "none"
  val invariant = I7_noDuplicate and I7_accounted
  run preparationWitness = init.then(start).then(crash).then(recover).then(all { assert(not(preparationContinues)), s' = s })
  run awaitedWitness = init.then(start).then(attach).then(awaitChild).then(crash)
    .then(recover).then(claim).then(execute).then(complete)
    .then(all { assert(s.continued == 1), s' = s })
  run replayWitness = init.then(start).then(attach).then(crash).then(recover).then(claim).then(execute)
    .then(crash).then(recover).then(claim).then(execute).then(complete).then(all { assert(I7_noDuplicate), s' = s })
}
