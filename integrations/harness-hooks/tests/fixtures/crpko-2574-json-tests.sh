cat > tmp/write_tests.py <<'PY'
from pathlib import Path
import json
root=Path('.')
rows=[]
def add(n,b,reject=True): rows.append(dict(name=n,body=b,reject=reject))
add('A','{"amount_atomic":1000,"AMOUNT_ATOMIC":2000}')
add('A0','{"amount_atomic":0,"AMOUNT_ATOMIC":1000}')
add('long_s','{"asset":"USDT","aſſet":"BTC"}')
add('kelvin','{"kind":"A","\\u212aind":"B"}')
for leg in ['from','to']:
    prefix='"scope":"ACCOUNT","subaccount_id":null'
    add('B1_'+leg,'{"'+leg+'":{'+prefix+',"WALLET_FAMILY":"NOT_A_WALLET","wallet_family":"FUNDING"}}')
    add('B2_'+leg,'{"'+leg.upper()+'":{"wallet_family":"NOT_A_WALLET"},"'+leg+'":{'+prefix+',"wallet_family":"FUNDING"}}')
    add('B3_'+leg,'{"'+leg+'":{'+prefix+',"wallet_family":"FUNDING"},"'+leg+'":{'+prefix+'}}')
    add('B4_'+leg,'{"'+leg+'":{'+prefix+',"wallet_family":"FUNDING","wallet_family":null}}')
for n,b in [('null_value','{"a":null,"a":1}'),('array','{"a":[1],"a":[2]}'),('string_number','{"a":"x","a":1}'),('object_number','{"a":{},"a":1}'),('nested_array','[{"a":1,"A":2}]'),('three_null_end','{"a":1,"a":2,"a":null}'),('three_mixed','{"a":1,"a":"x","a":3}')]:add(n,b)
for n,b in [('K1','{"amount_atomic":999,"amount_atomic":1000}'),('K2','{"from":{"wallet_family":"SPOT","wallet_family":"FUNDING"}}'),('K3','{"amount\\u005fatomic":1,"amount_atomic":2}'),('K4','{"from":{"scope":"ACCOUNT"},"to":{"SCOPE":"ACCOUNT"}}'),('bool','{"a":true,"a":false}'),('fraction_int','{"a":1.5,"a":1000}'),('overflow_int','{"a":99999999999999999999999,"a":1000}'),('exponent_int','{"a":1e3,"a":1000}'),('float','{"a":1.5,"a":2.5}'),('nulls','{"a":null,"a":null}'),('three_numbers','{"a":1,"a":2,"a":3}'),('three_nulls','{"a":null,"a":null,"a":null}'),('plain','{"a":1}'),('free_form','{"credential":{"clientExtensionResults":{"a":1,"A":2,"x":{},"x":null}}}')]: add(n,b,False)
Path('internal/http/testdata').mkdir(exist_ok=True)
Path('internal/http/testdata/json_ambiguity.json').write_text(json.dumps(rows,indent=2,ensure_ascii=False)+'\n')
Path('internal/http/json_ambiguity_test.go').write_text('''package edgehttp
import (
 "encoding/json"
 "errors"
 "net/http"
 "net/http/httptest"
 "os"
 "strings"
 "testing"
)
func TestDecodeJSONStrictAmbiguousMembers(t *testing.T) {
 data, err := os.ReadFile("testdata/json_ambiguity.json"); if err != nil { t.Fatal(err) }
 var rows []struct{Name,Body string; Reject bool}; if err := json.Unmarshal(data,&rows); err != nil {t.Fatal(err)}
 for _, row := range rows {t.Run(row.Name,func(t *testing.T){
  var dest any
  if err := DecodeJSONStrict(strings.NewReader(row.Body), &dest); (err != nil) != row.Reject {t.Fatalf("decode error=%v reject=%v",err,row.Reject)}
 })}
}
func TestDecodeJSONStrictPreservesMaxBytesError(t *testing.T) {
 r:=httptest.NewRequest("POST","/",strings.NewReader(`{"a":"too long"}`))
 var dest any
 err:=DecodeJSONStrict(http.MaxBytesReader(httptest.NewRecorder(),r.Body,4),&dest)
 var limit *http.MaxBytesError
 if !errors.As(err,&limit) {t.Fatalf("error=%v want MaxBytesError",err)}
}
''')
Path('internal/http/idempotency/hash_ambiguity_test.go').write_text('''package idempotency
import (
 "encoding/json"
 "errors"
 "net/http/httptest"
 "os"
 "strings"
 "testing"
)
func TestHashRequestAmbiguousMembers(t *testing.T) {
 data,err:=os.ReadFile("../testdata/json_ambiguity.json");if err!=nil {t.Fatal(err)}
 var rows []struct{Name,Body string;Reject bool};if err:=json.Unmarshal(data,&rows);err!=nil{t.Fatal(err)}
 for _,row:=range rows{t.Run(row.Name,func(t *testing.T){
  _,err:=HashRequest(httptest.NewRequest("POST","/v1/transfers",strings.NewReader(row.Body)),"/v1/transfers")
  if errors.Is(err,ErrInvalidJSON)!=row.Reject {t.Fatalf("hash error=%v reject=%v",err,row.Reject)}
 })}
}
func TestHashRequestGoldenBeforeAmbiguityCutover(t *testing.T) {
 const transfer=`{"from":{"scope":"ACCOUNT","subaccount_id":null,"wallet_family":"FUNDING"},"to":{"scope":"SUBACCOUNT","subaccount_id":"11111111-1111-1111-1111-111111111111","wallet_family":"SPOT"},"asset":"USDT","amount_atomic":1000}`
 rows:=[]struct{name,method,path,template,body,token,want string}{
 {"canonical","POST","/v1/transfers","/v1/transfers",transfer,"",""},
 {"K1","POST","/v1/transfers","/v1/transfers",strings.Replace(transfer,`"amount_atomic":1000`,`"amount_atomic":999,"amount_atomic":1000`,1),"",""},
 {"K2","POST","/v1/transfers","/v1/transfers",strings.Replace(transfer,`"wallet_family":"FUNDING"`,`"wallet_family":"SPOT","wallet_family":"FUNDING"`,1),"",""},
 {"K3","POST","/v1/transfers","/v1/transfers",`{"amount\\u005fatomic":1,"amount_atomic":2}`,"",""},
 {"withdrawal_stepup","POST","/v1/withdrawals","/v1/withdrawals",`{"amount_gross":"1","asset_id":"USDT"}`,"stepup-token-1",""},
 {"delete_path","DELETE","/v1/price-alerts/alert-a","/v1/price-alerts/{price_alert_id}",`{}`,"",""},
 {"empty","POST","/v1/orders","/v1/orders","","",""},
 {"delete_case_pair","DELETE","/v1/price-alerts/alert-a","/v1/price-alerts/{price_alert_id}",`{"a":1,"A":2}`,"",""},
 }
 for _,row:=range rows{t.Run(row.name,func(t *testing.T){
  req:=httptest.NewRequest(row.method,row.path,strings.NewReader(row.body));req.Header.Set("Withdrawal-Stepup-Token",row.token)
  got,err:=HashRequest(req,row.template);if err!=nil{t.Fatal(err)}
  if row.want=="" {t.Logf("GOLDEN %s %s",row.name,got)} else if got!=row.want{t.Fatalf("hash=%s want=%s",got,row.want)}
 })}
}
''')
PY
python3 tmp/write_tests.py
gofmt -w internal/http/json_ambiguity_test.go internal/http/idempotency/hash_ambiguity_test.go
go test ./internal/http/idempotency -run 'TestHashRequest(Ambiguous|Golden)' -count=1 -v > tmp/evidence/hash-red.log 2>&1
rg 'GOLDEN|FAIL|PASS' tmp/evidence/hash-red.log