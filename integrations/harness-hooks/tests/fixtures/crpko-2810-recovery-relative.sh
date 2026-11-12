cat > tmp/implement_recovery.py <<'PY'
from pathlib import Path
p=Path('internal/adapters/kafka/registry_cache_runtime.go')
s=p.read_text().replace('RestartBackoff          time.Duration','RestartBackoff          time.Duration\n\tNow                     func() time.Time\n\tonConsumerRecovered     func()')
a=s.index('func (service RegistryCacheConsumerService) runConsumerLoop('); b=s.index('\nfunc (service RegistryCacheConsumerService) recoveryCatchUpTargets',a)
t=s[a:b].replace('logger := adapterobservability.OrNoop(service.Logger)','episode := newCacheLiveRecovery(service.Logger, service.Now, "registry cache consumer")\n\tservice.onConsumerRecovered = func() { episode.recovered(ctx) }')
t=t.replace('logger.LogAttrs(\n\t\t\t\tctx,\n\t\t\t\tslog.LevelError,','episode.failed(\n\t\t\t\tctx, err,').replace('logger.LogAttrs(\n\t\t\t\t\tctx,\n\t\t\t\t\tslog.LevelError,','episode.failed(\n\t\t\t\t\tctx, err,').replace('logger.LogAttrs(\n\t\t\tctx,\n\t\t\tslog.LevelError,','episode.failed(\n\t\t\tctx, consumeErr,')
t=t.replace('service.CacheState.ClearConsumerFailure()','service.CacheState.ClearConsumerFailure()\n\t\t\t\tservice.onConsumerRecovered()')
s=s[:a]+t+s[b:]
a=s.index('func (service RegistryCacheConsumerService) consumeRegistryRecords('); b=s.index('// screenRegistryRecord',a)
t=s[a:b].replace('service.CacheState.ClearConsumerFailure()','service.CacheState.ClearConsumerFailure()\n\t\t\tif service.onConsumerRecovered != nil {\n\t\t\t\tservice.onConsumerRecovered()\n\t\t\t}')
s=s[:a]+t+s[b:]
s=s.replace('return fmt.Errorf("registry kafka %s failed topic=%q key=%q partition=%d offset=%d: %w",','return &registryRecordFailure{fmt.Errorf("registry kafka %s failed topic=%q key=%q partition=%d offset=%d: %w",').replace('\n\t\terr,\n\t)\n}\n\nfunc registryCatchUpTargetError','\n\t\terr,\n\t)}\n}\n\ntype registryRecordFailure struct { error }\n\nfunc (failure *registryRecordFailure) Unwrap() error { return failure.error }\n\nfunc registryCatchUpTargetError')
p.write_text(s)
p=Path('internal/adapters/kafka/kyc_profile_cache_runtime.go');s=p.read_text().replace('RestartBackoff             time.Duration','RestartBackoff             time.Duration\n\tNow                        func() time.Time\n\tliveRecovery               *cacheLiveRecovery')
a=s.index('func (service KYCProfileCacheConsumerService) runConsumerLoop(');b=s.index('\nfunc (service KYCProfileCacheConsumerService) replayKYCProfileBootstrapRecordBuffer',a)
t=s[a:b].replace('\trestartBackoff :=','\tservice.liveRecovery = newCacheLiveRecovery(service.Logger, service.Now, "kyc profile cache consumer")\n\trestartBackoff :=')
t=t.replace('service.CacheState.RecordConsumerFailure(err)','service.liveRecovery.failed(ctx, err, "kyc profile cache consumer recovery failed", registryCacheFailureLogAttrs("live_recovery", err)...)\n\t\t\t\tservice.CacheState.RecordConsumerFailure(err)')
t=t.replace('service.CacheState.MarkCatchUpComplete()','service.CacheState.MarkCatchUpComplete()\n\t\t\t\tservice.liveRecovery.recovered(ctx)')
t=t.replace('service.CacheState.RecordConsumerFailure(consumeErr)','service.liveRecovery.failed(ctx, consumeErr, "kyc profile cache consumer failed", registryCacheFailureLogAttrs("live_consume", consumeErr)...)\n\t\t\tservice.CacheState.RecordConsumerFailure(consumeErr)')
s=s[:a]+t+s[b:]
# A direct recovery helper is always live; bootstrap uses the horizon helper with no live episode.
a=s.index('func (service KYCProfileCacheConsumerService) kycProfileRecoveryCatchUpTargets(');b=s.index('\nfunc (service KYCProfileCacheConsumerService) consumeKYCProfileRecords',a)
t=s[a:b].replace('\tif partitionProgress == nil {','\tif service.liveRecovery == nil { service.liveRecovery = newCacheLiveRecovery(service.Logger, service.Now, "kyc profile cache consumer") }\n\tif partitionProgress == nil {')
t=t.replace('runKafkaStartupStep(ctx, startupRetry, kafkaStartupStageStartOffsets,','runCacheLiveRecoveryStep(ctx, startupRetry, service.liveRecovery, kafkaStartupStageStartOffsets,')
s=s[:a]+t+s[b:]
a=s.index('func (service KYCProfileCacheConsumerService) consumeKYCProfileRecords(');b=s.index('\nfunc (service KYCProfileCacheConsumerService) kycProfileCatchUpCompleteAfterFreshHorizon',a)
t=s[a:b].replace('\tif partitionProgress == nil {','\tif service.liveRecovery == nil { service.liveRecovery = newCacheLiveRecovery(service.Logger, service.Now, "kyc profile cache consumer") }\n\tif partitionProgress == nil {').replace('service.CacheState.MarkCatchUpComplete()','service.CacheState.MarkCatchUpComplete()\n\t\t\tservice.liveRecovery.recovered(ctx)')
s=s[:a]+t+s[b:]
s=s.replace('freshTargets, err := runKafkaStartupStep(ctx, startupRetry, kafkaStartupStageFreshHorizon,','runStep := runKafkaStartupStep[[]RegistryCatchUpTarget]\n\tif service.liveRecovery != nil {\n\t\trunStep = func(ctx context.Context, retry kafkaStartupRetry, stage string, step func(context.Context) ([]RegistryCatchUpTarget, error)) ([]RegistryCatchUpTarget, error) {\n\t\t\treturn runCacheLiveRecoveryStep(ctx, retry, service.liveRecovery, stage, step)\n\t\t}\n\t}\n\tfreshTargets, err := runStep(ctx, startupRetry, kafkaStartupStageFreshHorizon,')
p.write_text(s)
PY
python3 tmp/implement_recovery.py
cat > internal/adapters/kafka/live_recovery.go <<'EOF'
package kafka

import (
 "context"
 "log/slog"
 "time"

 adapterobservability "custody-transfer/internal/adapters/observability"
)

// registryLiveRecoveryEscalateAfter matches the startup per-attempt bound
// defaultKafkaStartupRetryAttemptTimeout; bootstrap keeps its own ERROR logging.
const registryLiveRecoveryEscalateAfter = 2 * time.Minute

// cacheLiveRecovery is owned by one live consumer loop, including its metadata
// retries. A successful metadata call alone does not end an episode: catch-up
// must restore cache usability first.
type cacheLiveRecovery struct {
 logger *slog.Logger
 now func() time.Time
 consumer string
 episodeStart time.Time
 attempts int
}

func newCacheLiveRecovery(logger *slog.Logger, now func() time.Time, consumer string) *cacheLiveRecovery {
 if now == nil { now = time.Now }
 return &cacheLiveRecovery{logger: adapterobservability.OrNoop(logger), now: now, consumer: consumer}
}

func (episode *cacheLiveRecovery) failed(ctx context.Context, err error, message string, attrs ...slog.Attr) {
 now := episode.now()
 if episode.attempts == 0 { episode.episodeStart = now }
 episode.attempts++
 failingFor := now.Sub(episode.episodeStart)
 level := slog.LevelError
 if isTransientRegistryRecoveryError(err) && failingFor < registryLiveRecoveryEscalateAfter { level = slog.LevelWarn }
 attrs = append(attrs, slog.Int("attempt", episode.attempts), slog.Duration("failing_for", failingFor))
 episode.logger.LogAttrs(ctx, level, message, attrs...)
}

func (episode *cacheLiveRecovery) recovered(ctx context.Context) {
 if episode.attempts == 0 { return }
 episode.logger.LogAttrs(ctx, slog.LevelInfo, episode.consumer+" recovered",
  slog.Int("attempts", episode.attempts+1), slog.Duration("failing_for", episode.now().Sub(episode.episodeStart)))
 episode.episodeStart = time.Time{}
 episode.attempts = 0
}

// Inspect the entire error tree: errors.Is/As alone can accept one transient
// branch of a join even when another branch is auth or a deterministic failure.
func isTransientRegistryRecoveryError(err error) bool {
 if err == nil { return false }
 if _, ok := err.(*registryRecordFailure); ok { return false }
 if joined, ok := err.(interface{ Unwrap() []error }); ok {
  leaves := joined.Unwrap()
  if len(leaves) == 0 { return false }
  for _, leaf := range leaves { if !isTransientRegistryRecoveryError(leaf) { return false } }
  return true
 }
 if wrapped, ok := err.(interface{ Unwrap() error }); ok {
  if inner := wrapped.Unwrap(); inner != nil { return isTransientRegistryRecoveryError(inner) }
 }
 return isRetryableKafkaStartupError(err)
}

// Keep metadata timeout, connection cleanup and jittered backoff identical to
// bootstrap, with a live episode's severity and no startup retry accounting.
func runCacheLiveRecoveryStep[T any](ctx context.Context, retry kafkaStartupRetry, episode *cacheLiveRecovery, stage string, step func(context.Context) (T, error)) (T, error) {
 var zero T
 for attempt := 1; ; attempt++ {
  attemptCtx, cancel := context.WithTimeout(ctx, retry.attemptTimeout())
  result, err := runKafkaStartupAttempt(attemptCtx, retry.Conns, step)
  cancel()
  if err == nil { return result, nil }
  if ctx.Err() != nil { return zero, ctx.Err() }
  if !isTransientRegistryRecoveryError(err) { return zero, err }
  delay := retry.backoff(attempt)
  episode.failed(ctx, err, "kyc profile cache consumer recovery failed; retrying",
   slog.String("consumer", retry.Consumer), slog.String("stage", stage), slog.String("retry_in", delay.String()), slog.String("error", err.Error()))
  if !sleepWithContextCancellation(ctx, delay) { return zero, ctx.Err() }
 }
}
EOF
gofmt -w internal/adapters/kafka/live_recovery.go internal/adapters/kafka/registry_cache_runtime.go internal/adapters/kafka/kyc_profile_cache_runtime.go
go test ./internal/adapters/kafka/ -run 'Registry|KYC|Startup' > tmp/focused.log 2>&1