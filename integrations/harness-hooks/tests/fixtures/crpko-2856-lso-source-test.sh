cat > /Users/ardud/checkouts/kafka-lso-lag-2856/scripts/localstack/kafka-lso-lag-telemetry-proof.sh <<'EOF'
#!/usr/bin/env bash
# Isolated, authorizer-enabled Kafka 3.9 proof. Run with offbox, never on dev.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p tmp/card-lso-lag-telemetry/proof-evidence
uv venv --allow-existing tmp/lso-proof-venv
uv pip install --python tmp/lso-proof-venv/bin/python confluent-kafka==2.12.0 boto3
exec tmp/lso-proof-venv/bin/python scripts/localstack/kafka_lso_lag_telemetry_proof.py
EOF
chmod +x /Users/ardud/checkouts/kafka-lso-lag-2856/scripts/localstack/kafka-lso-lag-telemetry-proof.sh
cat > /Users/ardud/checkouts/kafka-lso-lag-2856/scripts/localstack/kafka_lso_lag_telemetry_proof.py <<'PY'
"""Real SCRAM/StandardAuthorizer + JMX + LocalStack proof, entirely disposable."""
import concurrent.futures
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import threading
import time

import boto3
from confluent_kafka import Producer, Consumer

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'tmp/card-lso-lag-telemetry/proof-evidence'
OUT.mkdir(parents=True, exist_ok=True)
PREFIX = 'lso2856'
IMAGE = 'apache/kafka:3.9.0@sha256:fbc7d7c428e3755cf36518d4976596002477e4c052d1f80b5b9eafd06d0fff2f'
LS_IMAGE = 'localstack/localstack:4.10.0'
NAMES = [f'{PREFIX}-k{i}' for i in range(1, 4)]
spec = importlib.util.spec_from_file_location('lso', ROOT / 'terraform/modules/kafka-ec2/files/crpko_kafka_lso_lag_exporter.py')
lso = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lso)


def command(args, timeout=120, check=True):
    r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    with (OUT / 'commands.log').open('a') as f:
        f.write(json.dumps({'argv': args, 'exit': r.returncode, 'stdout': r.stdout, 'stderr': r.stderr}) + '\n')
    if check and r.returncode:
        raise RuntimeError(f'{args[:3]} exit={r.returncode}: {r.stderr[-1800:]} {r.stdout[-1000:]}')
    return r.stdout


def ktool(name, tool, *args):
    return command(['docker', 'exec', '-e', 'JMX_PORT=', '-e', 'KAFKA_JMX_OPTS=', '-e', 'KAFKA_HEAP_OPTS=-Xmx256M',
                    name, '/opt/kafka/bin/' + tool, '--bootstrap-server', NAMES[0] + ':9092', '--command-config', '/proof/admin.properties', *args])


def wait_for(fn, timeout=120):
    end = time.monotonic() + timeout
    while True:
        try:
            result = fn()
            if result:
                return result
        except Exception:
            if time.monotonic() >= end:
                raise
        if time.monotonic() >= end:
            raise AssertionError('condition timed out')
        time.sleep(2)


def setup():
    command(['docker', 'network', 'create', PREFIX])
    command(['docker', 'run', '-d', '--name', PREFIX + '-ls', '--network', PREFIX,
             '-p', '14586:4566', '-e', 'SERVICES=cloudwatch', LS_IMAGE])
    voters = ','.join(f'{i}@{n}:9093' for i, n in enumerate(NAMES, 1))
    for i, name in enumerate(NAMES, 1):
        d = OUT / name
        d.mkdir(exist_ok=True)
        (d / 'admin.properties').write_text('security.protocol=SASL_PLAINTEXT\nsasl.mechanism=SCRAM-SHA-512\nsasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="admin" password="proof-admin";\n')
        (d / 'telemetry.properties').write_text((d / 'admin.properties').read_text().replace('admin', 'telemetry'))
        (d / 'jmxremote.password').write_text('crpkoexporter proof-jmx\n')
        (d / 'jmxremote.password').chmod(0o600)
        (d / 'jmxremote.access').write_text('crpkoexporter readonly\n')
        port = 19090 + i
        props = f'''process.roles=broker,controller
node.id={i}
controller.quorum.voters={voters}
listeners=BROKER://:9092,CONTROLLER://:9093,EXTERNAL://:{port}
advertised.listeners=BROKER://{name}:9092,EXTERNAL://localhost:{port}
listener.security.protocol.map=BROKER:SASL_PLAINTEXT,CONTROLLER:PLAINTEXT,EXTERNAL:SASL_PLAINTEXT
controller.listener.names=CONTROLLER
inter.broker.listener.name=BROKER
sasl.enabled.mechanisms=SCRAM-SHA-512
sasl.mechanism.inter.broker.protocol=SCRAM-SHA-512
listener.name.broker.scram-sha-512.sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="admin" password="proof-admin";
listener.name.external.scram-sha-512.sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="admin" password="proof-admin";
authorizer.class.name=org.apache.kafka.metadata.authorizer.StandardAuthorizer
super.users=User:admin;User:ANONYMOUS
allow.everyone.if.no.acl.found=false
log.dirs=/tmp/kraft-data
num.partitions=3
default.replication.factor=3
min.insync.replicas=2
offsets.topic.replication.factor=3
offsets.topic.num.partitions=3
transaction.state.log.replication.factor=3
transaction.state.log.min.isr=2
transaction.state.log.num.partitions=3
group.initial.rebalance.delay.ms=0
'''
        (d / 'server.properties').write_text(props)
        start = '/opt/kafka/bin/kafka-storage.sh format -t Y3Jwa28tZGV2LWthZmthLTE -c /proof/server.properties --add-scram \'SCRAM-SHA-512=[name=admin,password=proof-admin]\' --add-scram \'SCRAM-SHA-512=[name=telemetry,password=proof-telemetry]\' && export JMX_PORT=9999 KAFKA_JMX_OPTS="-Dcom.sun.management.jmxremote=true -Dcom.sun.management.jmxremote.authenticate=true -Dcom.sun.management.jmxremote.ssl=false -Dcom.sun.management.jmxremote.host=127.0.0.1 -Djava.rmi.server.hostname=127.0.0.1 -Dcom.sun.management.jmxremote.password.file=/proof/jmxremote.password -Dcom.sun.management.jmxremote.password.toHashes=false -Dcom.sun.management.jmxremote.access.file=/proof/jmxremote.access" && exec /opt/kafka/bin/kafka-server-start.sh /proof/server.properties'
        command(['docker', 'run', '-d', '--user', '0', '--name', name, '--network', PREFIX,
                 '-p', f'{port}:{port}', '-v', f'{d}:/proof', '-e', 'KAFKA_HEAP_OPTS=-Xmx512M', '--entrypoint', '/bin/bash', IMAGE, '-c', start])
    wait_for(lambda: 'ClusterId' in ktool(NAMES[0], 'kafka-metadata-quorum.sh', 'describe', '--status'), 180)
    for t in ['evt.registry.instrument.updated.v1', '__remote_log_metadata']:
        ktool(NAMES[0], 'kafka-topics.sh', '--create', '--topic', t, '--partitions', '3', '--replication-factor', '3')
    rows = [r for r in json.loads((ROOT / 'plan/kafka/acl-manifest.dev.v1.json').read_text())['rows'] if r['principal'] == 'User:telemetry']
    (OUT / 'telemetry-rows.json').write_text(json.dumps(rows, indent=2))
    # Apply exactly the generated rows, including grants on topics absent in this small cluster.
    # One invocation per operation with many --topic flags keeps bootstrap bounded.
    for operation in ['DESCRIBE', 'DESCRIBE_CONFIGS']:
        topics = [r['resource_name'] for r in rows if r['resource_type'] == 'TOPIC' and r['operation'] == operation]
        argv = ['--add', '--allow-principal', 'User:telemetry', '--operation', operation.title().replace('_', ''), '--resource-pattern-type', 'literal']
        for topic in topics:
            argv += ['--topic', topic]
        ktool(NAMES[0], 'kafka-acls.sh', *argv)
    ktool(NAMES[0], 'kafka-acls.sh', '--add', '--allow-principal', 'User:telemetry', '--operation', 'Describe', '--cluster')
    return rows


class ProofCollector(lso.Collector):
    def __init__(self, broker):
        cw_contract = {'namespace': 'CrpkoKafka', 'cycle': 'LsoLagCollectorCycle', 'unresolved': 'LsoLagUnresolvedPartitions',
                       'dimensions': {'ClusterName': 'proof', 'NodeName': NAMES[broker - 1]}}
        keys = ['led_partitions', 'published_partitions', 'leader_moved_partitions', 'unresolved_partitions', 'describe_partition_count', 'read_ok', 'cycle_timestamp_seconds']
        contract = {'cloudwatch': cw_contract, 'better_stack': dict(partition='kafka_partition_last_stable_offset_lag', **{k: 'kafka_lso_lag_' + k for k in keys})}
        super().__init__({'LSO_METRIC_CONTRACT': json.dumps(contract), 'NODE_ID': str(broker), 'ENVIRONMENT': 'dev',
                         'CLUSTER_ID': 'proof', 'BOOTSTRAP_SERVER': NAMES[0] + ':9092', 'CLIENT_CONFIG': '/proof/telemetry.properties',
                         'JMX_PASSWORD_FILE': str(OUT / NAMES[broker - 1] / 'jmxremote.password')})
        self.name = NAMES[broker - 1]
        self.samples = []

    def run_command(self, args, timeout=25):
        if args[0].startswith('/opt/kafka/'):
            return command(['docker', 'exec', '-e', 'JMX_PORT=', '-e', 'KAFKA_JMX_OPTS=', '-e', 'KAFKA_HEAP_OPTS=-Xmx256M', self.name, *args], timeout=60)
        return super().run_command(args, timeout)

    def cloudwatch(self, successful, unresolved, jmx_ok):
        data = []
        if successful:
            data.append({'MetricName': 'LsoLagCollectorCycle', 'Value': 1})
        if jmx_ok:
            data.append({'MetricName': 'LsoLagUnresolvedPartitions', 'Value': unresolved})
        for d in data:
            d['Dimensions'] = [{'Name': k, 'Value': v} for k, v in self.contract['cloudwatch']['dimensions'].items()]
        if data:
            CW.put_metric_data(Namespace='CrpkoKafka', MetricData=data)

    def push(self, samples):
        self.samples.extend(samples)
        with (OUT / (self.name + '-samples.jsonl')).open('a') as f:
            for payload in lso.otlp_batches(samples, 900000):
                f.write(payload.decode() + '\n')


def cycles(collectors):
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(lambda c: c.cycle(), collectors))
    assert all(cov['read_ok'] == 1 for _, cov in results), results
    return results


def state(expected):
    value = CW.describe_alarms(AlarmNames=['lso-proof-cycle'])['MetricAlarms'][0]['StateValue']
    print('alarm', value, 'want', expected, flush=True)
    return value == expected


def main():
    setup()
    conf = {'bootstrap.servers': 'localhost:19091,localhost:19092,localhost:19093',
            'security.protocol': 'SASL_PLAINTEXT', 'sasl.mechanism': 'SCRAM-SHA-512',
            'sasl.username': 'admin', 'sasl.password': 'proof-admin'}
    producer = Producer(dict(conf, **{'transactional.id': 'lso-proof', 'transaction.timeout.ms': 600000}))
    producer.init_transactions(90)
    # A real group commit creates __consumer_offsets.
    consumer = Consumer(dict(conf, **{'group.id': 'lso-proof', 'auto.offset.reset': 'earliest'}))
    producer.begin_transaction()
    producer.produce('evt.registry.instrument.updated.v1', b'first', partition=0)
    producer.flush(30)
    producer.commit_transaction(30)
    consumer.subscribe(['evt.registry.instrument.updated.v1'])
    message = wait_for(lambda: consumer.poll(1), 45)
    consumer.commit(message=message, asynchronous=False)
    consumer.close()
    collectors = [ProofCollector(i) for i in range(1, 4)]
    first = cycles(collectors)
    for c, (_, cov) in zip(collectors, first):
        desc = c.describe()
        assert {'__consumer_offsets', '__remote_log_metadata', '__transaction_state'} <= {p[0] for p in desc}
        assert cov['unresolved_partitions'] == 0, cov
    producer.begin_transaction()
    producer.produce('evt.registry.instrument.updated.v1', b'held', partition=0)
    producer.flush(30)
    held = cycles(collectors)
    assert any(s['value'] > 0 for samples, _ in held for s in samples if s['unit'] == 'offsets')
    producer.abort_transaction(30)
    cleared = cycles(collectors)
    assert all(s['value'] == 0 for samples, _ in cleared for s in samples if s['unit'] == 'offsets')
    p = ('evt.registry.instrument.updated.v1', 0)
    old = collectors[0].describe()[p]
    # Stop the current leader, elect another replica, then restart it. Kafka-only, isolated proof.
    command(['docker', 'stop', '-t', '20', NAMES[old - 1]])
    live = [c for c in collectors if c.broker != old]
    wait_for(lambda: live[0].describe().get(p, -1) not in [-1, old], 90)
    moved = cycles(live)
    new_sample = [s for samples, _ in moved for s in samples if s['unit'] == 'offsets' and s['labels']['topic'] == p[0] and s['labels']['partition'] == '0']
    assert len(new_sample) == 1
    all_samples = [s for c in collectors for s in c.samples if s['unit'] == 'offsets']
    latest = lso.newest_sample_per_partition(all_samples)
    assert all(time.time() - s['timestamp'] <= 180 for s in latest.values())
    assert all('broker_id' not in s['labels'] for s in all_samples)
    command(['docker', 'start', NAMES[old - 1]])
    wait_for(lambda: len(collectors[old - 1].jmx()) > 0, 90)
    cycles(collectors)
    for topic in ['__consumer_offsets', '__remote_log_metadata', '__transaction_state']:
        ktool(NAMES[0], 'kafka-acls.sh', '--remove', '--force', '--allow-principal', 'User:telemetry', '--operation', 'Describe', '--topic', topic)
    negative = cycles(collectors)
    assert all(cov['unresolved_partitions'] > 0 for _, cov in negative)
    metrics = CW.list_metrics(Namespace='CrpkoKafka', MetricName='LsoLagUnresolvedPartitions')['Metrics']
    assert len(metrics) == 3, metrics
    from datetime import datetime, timedelta, timezone
    for metric in metrics:
        points = CW.get_metric_statistics(Namespace='CrpkoKafka', MetricName='LsoLagUnresolvedPartitions',
            Dimensions=metric['Dimensions'], StartTime=datetime.now(timezone.utc)-timedelta(minutes=10),
            EndTime=datetime.now(timezone.utc)+timedelta(seconds=1), Period=60, Statistics=['Maximum'])['Datapoints']
        assert any(p['Maximum'] > 0 for p in points), points
    dims = collectors[0].contract['cloudwatch']['dimensions']
    CW.put_metric_alarm(AlarmName='lso-proof-cycle', Namespace='CrpkoKafka', MetricName='LsoLagCollectorCycle',
        Dimensions=[{'Name': k, 'Value': v} for k, v in dims.items()], Statistic='SampleCount', Period=60,
        EvaluationPeriods=3, DatapointsToAlarm=3, Threshold=1, ComparisonOperator='LessThanThreshold', TreatMissingData='breaching')
    # Run the actual collector, then stop its loop and observe missing-data alarm.
    stop = threading.Event()
    def loop():
        while not stop.is_set():
            collectors[0].cycle()
            stop.wait(45)
    worker = threading.Thread(target=loop)
    worker.start()
    wait_for(lambda: state('OK'), 240)
    stop.set()
    worker.join(90)
    stopped = time.time()
    wait_for(lambda: state('ALARM'), 240)
    (OUT / 'heartbeat-stop.json').write_text(json.dumps({'stopped': stopped, 'alarmed': time.time(), 'elapsed': time.time()-stopped}))
    stop.clear()
    worker = threading.Thread(target=loop)
    worker.start()
    try:
        wait_for(lambda: state('OK'), 240)
    finally:
        stop.set()
        worker.join(90)
    (OUT / 'result.json').write_text(json.dumps({'passed': True, 'brokers': 3, 'authorizer': 'StandardAuthorizer',
        'open_transaction_positive': True, 'abort_zero': True, 'handoff_fresh': True, 'negative_acl_unresolved': True,
        'heartbeat': 'OK -> ALARM -> OK'}, indent=2))
    print('PROOF PASSED', flush=True)


CW = boto3.client('cloudwatch', endpoint_url='http://localhost:14586', region_name='ap-south-1',
                  aws_access_key_id='test', aws_secret_access_key='test')
try:
    main()
finally:
    for name in NAMES + [PREFIX + '-ls']:
        command(['docker', 'logs', name], check=False)
        command(['docker', 'rm', '-f', name], check=False)
    command(['docker', 'network', 'rm', PREFIX], check=False)
PY