cat > tmp/implement.py <<'PY'
from pathlib import Path
p=Path('internal/registry/consumer.go');s=p.read_text().replace('"sync"','"sync"\n "sync/atomic"')
s=s.replace('registryPartitionStartBound = 3 * time.Second','registryPartitionStartBound = 3 * time.Second\n // The overall budget is observed until dev bootstrap timing is measured.\n registryBootstrapBound = 10 * time.Second\n registryBootstrapBoundEnforced = false')
s=s.replace('type Consumer struct {','type Consumer struct {\n bootstrapBound time.Duration\n enforceBootstrapBound *bool')
s=s.replace('conns    []net.Conn','conns    []io.Closer')
pos=s.index('// closeAll ends start-up:')
s=s[:pos]+'''// adopt takes ownership of an authenticated connection after its attempt ends.
func (s *startSockets) adopt(c io.Closer) bool {
 s.mu.Lock()
 defer s.mu.Unlock()
 if s.closed || s.detached { return false }
 s.conns = append(s.conns, c)
 return true
}

'''+s[pos:]
s=s.replace('type KafkaBootstrapper struct {','type KafkaBootstrapper struct {\n bootstrapBound time.Duration\n enforceBootstrapBound *bool\n perSeed time.Duration\n progressWindow time.Duration\n goodSeed atomic.Int32')
a=s.index('func (b *KafkaBootstrapper) BootstrapPartitions(');z=s.index('type partitionConn interface',a)
s=s[:a]+'''func (b *KafkaBootstrapper) BootstrapPartitions(ctx context.Context, selected []int) (map[int]int64, error) {
 marks, _, err := b.bootstrapPartitionsWithLeaders(ctx, selected)
 return marks, err
}

'''+s[z:]
# optional progress-window preserves existing test fake interface
s=s.replace('handle func(kafka.Message) error) (int64, error) {\n\tfor {','handle func(kafka.Message) error, windows ...time.Duration) (int64, error) {\n window := registryFetchHealthWindow\n if len(windows)>0 { window=windows[0] }\n for {')
s=s.replace('\t\tmsg, err := conn.ReadMessage(bootstrapMaxMessageBytes)','\t\tif d, ok := conn.(interface{ SetDeadline(time.Time) error }); ok { d.SetDeadline(time.Now().Add(window)) }\n\t\tmsg, err := conn.ReadMessage(bootstrapMaxMessageBytes)')
s=s.replace('if err == io.EOF && ctx.Err() != nil {\n\t\t\t\treturn 0, ctx.Err()\n\t\t\t}', 'if ctx.Err() != nil { return 0, fmt.Errorf("read_partition_%d_offset_%d: %w", partition, offset, ctx.Err()) }\n if replayTimeout(err) { return 0, replayProgressError(partition, window, err) }')
# helper returns leaders without changing existing callers
s=s.replace('return bootstrapper.BootstrapPartitions(ctx, partitions)','return bootstrapper.BootstrapPartitions(ctx, partitions)')
pos=s.index('func (c *Consumer) consumeAssignedPartition(')
s=s[:pos]+'''func (c *Consumer) bootstrapWithLeaders(ctx context.Context, partitions []int) (map[int]int64, map[int]kafka.Partition, error) {
 if b, ok := c.bootstrap.(*KafkaBootstrapper); ok {
  if c.bootstrapBound > 0 { b.bootstrapBound = c.bootstrapBound }
  if c.enforceBootstrapBound != nil { b.enforceBootstrapBound = c.enforceBootstrapBound }
  return b.bootstrapPartitionsWithLeaders(ctx, partitions)
 }
 // Non-Kafka test bootstrappers retain their caller-controlled lifetime.
 marks, err := c.bootstrapPartitions(ctx, partitions)
 return marks, nil, err
}

'''+s[pos:]
s=s.replace('observe func(string, error)) (result error) {\n\t// Start-up','observe func(string, error), leaders ...kafka.Partition) (result error) {\n\t// Start-up')
a=s.index('\tstartDialer := *dialer');z=s.index('\tif ctx.Err() != nil {',a)
s=s[:a]+''' var conn *kafka.Conn
 var err error
 good := &atomic.Int32{}
 if b, ok := c.bootstrap.(*KafkaBootstrapper); ok { good = &b.goodSeed }
 r := &liveKafkaBootstrapReader{brokers:c.brokers, topic:c.topic, dialer:dialer, outer:sockets, perSeed:time.Second, goodSeed:good}
 if len(leaders)>0 && leaders[0].Leader.Host!="" {
  // Leave time for fallback metadata if the advertised leader moved.
  kept, e := r.attempt(startCtx, leaderAddress(leaders[0]), func(ac context.Context, d *kafka.Dialer) (io.Closer,error) {
   return d.DialPartition(ac, "tcp", "", leaders[0])
  })
  err=e
  if e==nil { conn=kept.(*kafka.Conn) }
 }
 if conn==nil {
  for i, index := range seedOrder(len(c.brokers), good.Load()) {
   if startCtx.Err()!=nil { break }
   deadline,_ := startCtx.Deadline()
   r.perSeed = time.Until(deadline)/time.Duration(len(c.brokers)-i)
   if r.perSeed < 250*time.Millisecond { r.perSeed=250*time.Millisecond }
   kept,e := r.attempt(startCtx,c.brokers[index],func(ac context.Context,d *kafka.Dialer)(io.Closer,error){return d.DialLeader(ac,"tcp",c.brokers[index],c.topic,assignment.ID)})
   err=e
   if e==nil { good.Store(int32(index));conn=kept.(*kafka.Conn);break }
  }
 }
 if conn==nil && err==nil { err=fmt.Errorf("registry bootstrap broker is required") }
'''+s[z:]
# local leader map passed to workers; missing fake uses zero value
s=s.replace('highWaterMarks := map[int]int64{}','highWaterMarks := map[int]int64{}\n leaders := map[int]kafka.Partition{}')
s=s.replace('highWaterMarks, err = c.bootstrapPartitions(runCtx, partitions)','''bound:=durationOr(c.bootstrapBound,registryBootstrapBound)
 bootCtx:=runCtx
 cancelBoot:=func(){}
 if boundEnforced(c.enforceBootstrapBound) { bootCtx,cancelBoot=context.WithTimeout(runCtx,bound) }
 defer cancelBoot()
 highWaterMarks, leaders, err = c.bootstrapWithLeaders(bootCtx, partitions)''')
s=s.replace('if err != nil {\n\t\t\t\t\tbootstrapFailed = true','''if bootCtx.Err()==context.DeadlineExceeded { err=fmt.Errorf("registry_bootstrap_not_complete_within_%s: %w",bound,context.DeadlineExceeded) }
 if err != nil {
                    bootstrapFailed = true''',1)
s=s.replace('committer.commit(runCtx, nil, false)','committer.commit(bootCtx, nil, false)')
s=s.replace('commitErr = gen.CommitOffsets(', '// Generation.CommitOffsets has its own 5 s deadline and no context.\n commitErr = gen.CommitOffsets(')
s=s.replace('if err := commitErr; err != nil {','''if bootCtx.Err()==context.DeadlineExceeded { bootstrapFailed=true;commitErr=fmt.Errorf("registry_bootstrap_not_complete_within_%s: %w",bound,context.DeadlineExceeded) }
 cancelBoot()
 if err := commitErr; err != nil {''',1)
# close callback at group worker ending
needle='''observeOperation(assignment.ID, operation, err)
					})'''
if needle in s:s=s.replace(needle,'''observeOperation(assignment.ID, operation, err)
                    }, leaders[assignment.ID])''')
else:
 a=s.index('partitionErrors <- c.consumeAssignedPartitionWithCommitter');print(s[a:a+420])
p.write_text(s)
PY
python3 tmp/implement.py