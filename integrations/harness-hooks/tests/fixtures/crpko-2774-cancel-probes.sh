cat > /Volumes/ExternalSSD/crpko-devops/tmp/card-1013/astra-r3/probes/make_cancel_probes.py <<'PY'
from pathlib import Path
import json
p=Path('/Volumes/ExternalSSD/crpko-devops/tmp/card-1013/astra-r3/probes')
w=Path('/Volumes/ExternalSSD/board-wt/edge-api-pr215-r3')
template=r'''package PACKAGE
import (
 "context"
 "crypto/sha256"
 "encoding/hex"
 "fmt"
 "net/http"
 "net/http/httptest"
 "strings"
 "testing"
 edgehttp "edge-api/internal/http"
 "edge-api/internal/http/middleware"
 "edge-api/internal/models"
 "edge-api/internal/repositories"
 "edge-api/internal/services/commandhealth"
 "edge-api/internal/tradinghealth"
 "github.com/go-chi/chi/v5"
)
type astraCancelStore struct { row *models.IdempotencyRecord; deletes int }
func(s *astraCancelStore) GetIdempotencyRecord(context.Context, models.IdempotencyScope)(*models.IdempotencyRecord,error){ return s.row,nil }
func(s *astraCancelStore) GetWriterIdempotencyRecord(context.Context, models.IdempotencyScope)(*models.IdempotencyRecord,error){ return s.row,nil }
func(s *astraCancelStore) ClaimPendingIdempotencyRecord(_ context.Context,_ models.IdempotencyScope,h string,n,e,st int64)(*models.IdempotencyRecord,bool,error){ s.row=&models.IdempotencyRecord{RequestHash:h,OwnerGeneration:"fresh",CreatedAtMs:n,ExpiresAtMs:e}; return s.row,true,nil }
func(s *astraCancelStore) FinalizeIdempotencyRecord(context.Context,models.IdempotencyScope,models.IdempotencyRecord,int64)error{ return fmt.Errorf("unexpected finalization") }
func(s *astraCancelStore) DeletePendingIdempotencyRecord(ctx context.Context,_ models.IdempotencyScope,_,_ string)error{ if ctx.Err()!=nil{return ctx.Err()}; s.deletes++; s.row=nil;return nil }
func astraLease(t *testing.T,seq int,accept bool){
 t.Helper()
 part,_:=tradinghealth.AccountPartitionFor("acct-1",256)
 sum:=sha256.Sum256([]byte(fmt.Sprint(part)))
 value:=fmt.Sprintf(`{"meta":{"producer":"trading-core","topic":"evt.trading.order_intake.health.v1","produced_at_ms":1000,"partition_key":"task-a","schema_name":"schemas/kafka/evt/trading/order_intake_health.v1.schema.json","schema_version":1},"payload":{"event_id":"event-%d","task_id":"task-a","lease_sequence":%d,"generation_id":"%s","accept_orders":%t,"partitions":[%d],"emitted_at_ms":1000,"ttl_ms":10000}}`,seq,seq,hex.EncodeToString(sum[:])[:16],accept,part)
 if err:=tradinghealth.ApplyRecord(tradinghealth.TopicOrderIntakeHealthV1,[]byte("task-a"),[]byte(value));err!=nil{t.Fatal(err)}
}
func TestAstraR3HealthRejectAfterClaimReleasesCanceledFreshKey(t *testing.T){
 for _,tc:=range []struct{name,method,pattern,path string; mapper func(http.ResponseWriter,*http.Request,error)}{ CASES } {
  for _,canceled:=range []bool{false,true}{ t.Run(fmt.Sprintf("%s/canceled=%v",tc.name,canceled),func(t *testing.T){
   tradinghealth.ResetForTest();defer tradinghealth.ResetForTest()
   tradinghealth.SetConsumerRequired(true);tradinghealth.MarkConsumerCaughtUp(true);tradinghealth.SetTrustedUpperBoundMsForTest(1001);astraLease(t,1,true)
   store:=&astraCancelStore{};old:=repositories.GetIdempotencyStore();repositories.SetIdempotencyStore(store);defer repositories.SetIdempotencyStore(old)
   ctx,cancel:=context.WithCancel(edgehttp.WithAccountID(context.Background(),"acct-1"));defer cancel()
   req:=httptest.NewRequest(tc.method,tc.path,strings.NewReader(`{"valid":"already-validated"}`)).WithContext(ctx);req.Header.Set("Idempotency-Key","test-key")
   r:=chi.NewRouter();calls:=0
   r.With(middleware.TradingHealthBeforeIdempotencyClaim,middleware.ReplayIdempotency).Method(tc.method,tc.pattern,http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
    calls++;if store.row==nil{t.Fatal("handler reached without claim")}
    // Model health changing after preclaim validation and before the service's pre-binding check.
    astraLease(t,2,false)
    if canceled { cancel() }
    err:=commandhealth.RejectIfTradingPartitionUnavailable(r.Context(),"acct-1",nil,nil)
    if err==nil{t.Fatal("blocked lease accepted")}
    tc.mapper(w,r,err)
   }))
   rec:=httptest.NewRecorder();r.ServeHTTP(rec,req)
   if rec.Code!=503 || calls!=1 {t.Fatalf("status=%d calls=%d",rec.Code,calls)}
   if store.row!=nil || store.deletes!=1 {t.Fatalf("no command prepared/published, but fresh key retained: row=%+v deletes=%d",store.row,store.deletes)}
  }) }
 }
}
'''
cases={
'trading':'''{"place","POST","/v1/orders","/v1/orders",func(w http.ResponseWriter,r *http.Request,e error){writeOrderPlaceError(w,r,models.OrderPlaceRequest{},e)}},
{"modify","PATCH","/v1/orders/{order_id}","/v1/orders/o-1",writeOrderModifyError},''',
'positions':'''{"leverage","POST","/v1/positions/{instrument_id}/leverage","/v1/positions/BTC-USD/leverage",writeSetLeverageError},
{"margin","POST","/v1/positions/{instrument_id}/margin","/v1/positions/BTC-USD/margin",writeAdjustMarginError},'''}
o=json.loads((p/'overlay.json').read_text())
for pkg,c in cases.items():
 file=p/f'astra_cancel_{pkg}_test.go';file.write_text(template.replace('PACKAGE',pkg).replace('CASES',c))
 o['Replace'][str(w/f'internal/http/handlers/{pkg}/astra_r3_test.go')]=str(file)
(p/'overlay.json').write_text(json.dumps(o,indent=2)+'\n')
PY
python3 /Volumes/ExternalSSD/crpko-devops/tmp/card-1013/astra-r3/probes/make_cancel_probes.py
 go test -count=1 -v -overlay=/Volumes/ExternalSSD/crpko-devops/tmp/card-1013/astra-r3/probes/overlay.json -run '^TestAstraR3HealthReject' ./internal/http/handlers/trading > /Volumes/ExternalSSD/crpko-devops/tmp/card-1013/astra-r3/astra-r3-cancel-trading-red.log 2>&1
rc=$?
cat /Volumes/ExternalSSD/crpko-devops/tmp/card-1013/astra-r3/astra-r3-cancel-trading-red.log
exit $rc