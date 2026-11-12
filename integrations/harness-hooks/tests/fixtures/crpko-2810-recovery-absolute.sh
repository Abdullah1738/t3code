cat > /Users/ardud/checkouts/custody-recovery-main/tmp/implement_recovery.py <<'PY'
from pathlib import Path
p=Path('/Users/ardud/checkouts/custody-recovery-main/internal/adapters/kafka/registry_cache_runtime.go')
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
p=Path('/Users/ardud/checkouts/custody-recovery-main/internal/adapters/kafka/kyc_profile_cache_runtime.go');s=p.read_text().replace('RestartBackoff             time.Duration','RestartBackoff             time.Duration\n\tNow                        func() time.Time\n\tliveRecovery               *cacheLiveRecovery')
a=s.index('func (service KYCProfileCacheConsumerService) runConsumerLoop(');b=s.index('\nfunc (service KYCProfileCacheConsumerService) replayKYCProfileBootstrapRecordBuffer',a)
t=s[a:b].replace('\trestartBackoff :=','\tservice.liveRecovery = newCacheLiveRecovery(service.Logger, service.Now, "kyc profile cache consumer")\n\trestartBackoff :=')
t=t.replace('service.CacheState.RecordConsumerFailure(err)','service.liveRecovery.failed(ctx, err, "kyc profile cache consumer recovery failed", registryCacheFailureLogAttrs("live_recovery", err)...)\n\tservice.CacheState.RecordConsumerFailure(err)')
t=t.replace('service.CacheState.MarkCatchUpComplete()','service.CacheState.MarkCatchUpComplete()\n\tservice.liveRecovery.recovered(ctx)')
t=t.replace('service.CacheState.RecordConsumerFailure(consumeErr)','service.liveRecovery.failed(ctx, consumeErr, "kyc profile cache consumer failed", registryCacheFailureLogAttrs("live_consume", consumeErr)...)\n\tservice.CacheState.RecordConsumerFailure(consumeErr)')
s=s[:a]+t+s[b:]
a=s.index('func (service KYCProfileCacheConsumerService) kycProfileRecoveryCatchUpTargets(');b=s.index('\nfunc (service KYCProfileCacheConsumerService) consumeKYCProfileRecords',a)
t=s[a:b].replace('\tif partitionProgress == nil {','\tif service.liveRecovery == nil { service.liveRecovery = newCacheLiveRecovery(service.Logger, service.Now, "kyc profile cache consumer") }\n\tif partitionProgress == nil {')
t=t.replace('runKafkaStartupStep(ctx, startupRetry, kafkaStartupStageStartOffsets,','runCacheLiveRecoveryStep(ctx, startupRetry, service.liveRecovery, kafkaStartupStageStartOffsets,')
s=s[:a]+t+s[b:]
a=s.index('func (service KYCProfileCacheConsumerService) consumeKYCProfileRecords(');b=s.index('\nfunc (service KYCProfileCacheConsumerService) kycProfileCatchUpCompleteAfterFreshHorizon',a)
t=s[a:b].replace('\tif partitionProgress == nil {','\tif service.liveRecovery == nil { service.liveRecovery = newCacheLiveRecovery(service.Logger, service.Now, "kyc profile cache consumer") }\n\tif partitionProgress == nil {').replace('service.CacheState.MarkCatchUpComplete()','service.CacheState.MarkCatchUpComplete()\n\tservice.liveRecovery.recovered(ctx)')
s=s[:a]+t+s[b:]
s=s.replace('freshTargets, err := runKafkaStartupStep(ctx, startupRetry, kafkaStartupStageFreshHorizon,','runStep := runKafkaStartupStep[[]RegistryCatchUpTarget]\n\tif service.liveRecovery != nil {\n\t\trunStep = func(ctx context.Context, retry kafkaStartupRetry, stage string, step func(context.Context) ([]RegistryCatchUpTarget, error)) ([]RegistryCatchUpTarget, error) {\n\t\t\treturn runCacheLiveRecoveryStep(ctx, retry, service.liveRecovery, stage, step)\n\t\t}\n\t}\n\tfreshTargets, err := runStep(ctx, startupRetry, kafkaStartupStageFreshHorizon,')
p.write_text(s)
PY
python3 /Users/ardud/checkouts/custody-recovery-main/tmp/implement_recovery.py