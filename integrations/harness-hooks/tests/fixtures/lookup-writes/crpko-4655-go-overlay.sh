review_scratch=$(mktemp -d /Volumes/ExternalSSD/crpko-devops/tmp/card-4655/sol-proof.XXXXXX)
cat > "$review_scratch/early_hold_test.go" <<'EOF'
package runtime

import (
    "context"
    "testing"
    "time"
    "github.com/Equicom-Crypto/market-data-mock/internal/publisher"
)

func TestReviewEarlyHoldRefusesExistingPublisherRetry(t *testing.T) {
    _, store, clock, _ := delistingSetup(t)
    broker := &admissionRetryBroker{first: make(chan struct{}), release: make(chan struct{}), retried: make(chan struct{})}
    pub := publisher.NewWithTransport([]string{"broker:9092"}, broker, 2*time.Second, 2, "dev", "market-data")
    defer pub.Close()
    manager := NewWithDependencies(testConfig(), store, pub, nil, nil)
    defer manager.Close()
    // Open without launching any workers or background publications.
    if _, ok := manager.openPublication(store.Generation()); !ok { t.Fatal("opening fixture admission") }
    done := make(chan error, 1)
    go func() { done <- manager.publisher.Publish(context.Background(), publisher.TopicInstrumentStatus, "USDT-INR", publisher.SchemaInstrumentStatus, "instrument_status", publisher.NewInstrumentStatusEvent("USDT-INR", "ACTIVE", 1500)) }()
    admissionWait(t, broker.first, "first real produce attempt")
    clock.safeAt(1999)
    if _, ok, safe := store.NextTimer(); !ok || !safe { t.Fatal("arming fixture timer") }
    store.EarlyWake()
    if !store.PublicationHeld() || manager.publicationOpen() { t.Fatal("early hold not installed") }
    close(broker.release) // first attempt now fails with LeaderNotAvailable
    select {
    case <-broker.retried:
        <-done
        t.Fatal("real Kafka producer started a fresh retry after the early wake closed assigned scope publication")
    case <-time.After(500*time.Millisecond):
    }
}
EOF
python3 -I - "$PWD" "$review_scratch" <<'PY'
import json,sys
from pathlib import Path
root,scratch=map(Path,sys.argv[1:])
(scratch/'overlay.json').write_text(json.dumps({'Replace':{str(root/'internal/runtime/sol_review_test.go'):str(scratch/'early_hold_test.go')}}))
PY
printf '%s\n' "$review_scratch"
go test -count=1 -overlay "$review_scratch/overlay.json" ./internal/runtime -run '^TestReviewEarlyHoldRefusesExistingPublisherRetry$'
