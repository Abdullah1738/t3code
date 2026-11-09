python3 - <<'PY'
from pathlib import Path
p=Path('internal/domain/exposurereconciliation/delist_workflow.go');s=p.read_text().replace('\t\t\tcurrent.PostcheckGeneration = 0\n','''            // Only the first entry starts at zero. Retained generations are
            // immutable across a platform-residue rediscovery of this episode.
''',1);p.write_text(s)
p=Path('internal/domain/exposurereconciliation/delist_native_test.go');s=p.read_text().replace('"risk-liquidation/internal/deliststate"','"risk-liquidation/internal/deliststate"\n marketdata "risk-liquidation/internal/domain/cache/marketdata"\n kafkafake "risk-liquidation/tests/testkit/fakes/kafka"\n venuefake "risk-liquidation/tests/testkit/fakes/venue"')
s=s.replace('func nativeDelistFixture(t *testing.T, db ports.FDB)', 'func nativeDelistFixture(t *testing.T, db ports.FDB, kinds ...string)')
s=s.replace('item["type"], item["perp"], item["hedge_venue_account_id"] = "SPOT", nil, nil', 'if len(kinds) == 0 || kinds[0] == "SPOT" { item["type"], item["perp"], item["hedge_venue_account_id"] = "SPOT", nil, nil }')
s=s.replace('r := &Coordinator{cfg: RuntimeConfig{FDB: db,', 'r, err := NewCoordinator(RuntimeConfig{FDB: db, Producer: kafkafake.NewProducer(), Venue: venuefake.New(), MarketDataCache: marketdata.NewCache(),')
s=s.replace('HedgePartitionCount: 256}}', 'HedgePartitionCount: 256})\n if err != nil { t.Fatal(err) }\n r.OnPartitionsAssigned([]int32{hedgePartitionForKey(ExposureKey{VenueID: "bybit", VenueAccountID: "hedge-1", InstrumentID: "SPOT-X"}, 256)})',1)
s=s.replace('_, err := (deliststate.WorkflowStore', '_, err = (deliststate.WorkflowStore',1)
s+='''
// DELIST-023/027: a terminal hedge result committed before a crash remains the
// parent's current generation. A proof before the window end cannot complete;
// an after-window result is consumed without reseeding or overwriting history.
func TestRealFDBDelistPerpPostcheckRestartConsumesCommittedResult(t *testing.T) {
 db := fdbfixture.Real(t)
 r, clock := nativeDelistFixture(t, db, "PERP")
 runParent := func() {
  t.Helper()
  if err := r.RunDueDelistWorkflows(context.Background(), clock.Lower.Load(), 32); err != nil { t.Fatal(err) }
 }
 for i:=0; i<4 && readNativeDelist(t,db).State != "POSTCHECK"; i++ {
  runParent()
  clock.Lower.Store(max(clock.Lower.Load(), readNativeDelist(t,db).NextAttemptAtMS))
 }
 runParent()
 first := readNativeDelist(t,db)
 if first.PostcheckGeneration != 1 { t.Fatal(first) }
 if err := r.RunDueDelistHedgePostchecks(context.Background(), clock.Lower.Load(), 32); err != nil { t.Fatal(err) }
 var before []byte
 if err := db.View(context.Background(), func(tx ports.Txn) error { var err error; before,err=tx.Get(keyDelistHedgePostcheck("SPOT-X",1000,1)); return err }); err != nil { t.Fatal(err) }
 var child DelistHedgePostcheckRecord
 if err := unmarshalDelistChild(before, &child); err != nil || child.State != DelistHedgePostcheckTerminal { t.Fatal(child,err) }
 // Replace the process after the result transaction, before parent consumption.
 replacement, err := NewCoordinator(r.cfg)
 if err != nil { t.Fatal(err) }
 replacement.OnPartitionsAssigned([]int32{child.HedgePartition})
 r = replacement
 clock.Lower.Store(*first.PostcheckUntilMS+1)
 runParent()
 second := readNativeDelist(t,db)
 if second.State != "POSTCHECK" || second.PostcheckGeneration != 2 { t.Fatal("pre-window proof completed or failed to seed next generation",second) }
 if err := r.RunDueDelistHedgePostchecks(context.Background(), clock.Lower.Load(), 32); err != nil { t.Fatal(err) }
 clock.Lower.Store(second.NextAttemptAtMS)
 runParent()
 done := readNativeDelist(t,db)
 if done.State != "COMPLETED" || done.PostcheckGeneration != 2 { t.Fatal("committed current result was not consumed",done) }
 if err := db.View(context.Background(), func(tx ports.Txn) error {
  after,err := tx.Get(keyDelistHedgePostcheck("SPOT-X",1000,1)); if err==nil && string(after)!=string(before) { t.Fatal("historical postcheck generation changed") }; return err
 }); err != nil { t.Fatal(err) }
}
''';p.write_text(s)
p=Path('internal/startup/readiness.go');s=p.read_text().replace('NativeEpochReasons []string','NativeEpochReasons []string\n DelistWorkflowReasons []string',1).replace('out.NativeEpochReasons = slices.Clone(r.state.NativeEpochReasons)','out.NativeEpochReasons = slices.Clone(r.state.NativeEpochReasons)\n out.DelistWorkflowReasons = slices.Clone(r.state.DelistWorkflowReasons)',1);i=s.index('func EvaluateReadiness(');s=s[:i]+'''func (r *ReadinessState) SetDelistWorkflowReasons(reasons []string) {
 r.set(func(in *ReadinessInputs) { in.DelistWorkflowReasons = slices.Clone(reasons) })
}

'''+s[i:];s=s.replace('reasons = append(reasons, in.NativeEpochReasons...)', 'reasons = append(reasons, in.NativeEpochReasons...)\n reasons = append(reasons, in.DelistWorkflowReasons...)',1);p.write_text(s)
p=Path('internal/app/app.go');s=p.read_text().replace('exposureCoordinator, err := exposurereconcile.NewCoordinator(exposurereconcile.RuntimeConfig{', 'runtimeState.ReadinessState.SetDelistWorkflowReasons([]string{"delist_workflow_recovery_pending"})\n exposureCoordinator, err := exposurereconcile.NewCoordinator(exposurereconcile.RuntimeConfig{\n OnDelistReadiness: runtimeState.ReadinessState.SetDelistWorkflowReasons,',1);p.write_text(s)
PY
gofmt -w internal/startup/readiness.go internal/app/app.go internal/domain/exposurereconciliation/delist_workflow.go internal/domain/exposurereconciliation/delist_native_test.go
offbox run --remote --include tmp/card2996-fdb.sh -- bash tmp/card2996-fdb.sh go test ./internal/domain/exposurereconciliation ./tests/boread -run '^TestRealFDBDelist' -count=1 -v -timeout 2m