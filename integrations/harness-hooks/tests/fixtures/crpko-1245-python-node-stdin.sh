mkdir -p tmp/native-init-floors
python3 - <<'PY'
from pathlib import Path
import subprocess
root=Path('.')
broker=subprocess.check_output(['git','-C','/Users/ardud/CrpkoArchitectureBroker','show','origin/native-v1:shared/ClickHouse.md'],text=True)
start=broker.index('CREATE TABLE IF NOT EXISTS crpko.clickhouse_native_init_floors_v1 ON CLUSTER crpko_cluster')
end=broker.index(';',start)+1
floor=broker[start:end]
p=root/'plan/clickhouse/crpko-clickhouse-ddl.sql'
s=p.read_text(); marker='CREATE TABLE IF NOT EXISTS crpko.clickhouse_ingestion_offset_holes_v1 ON CLUSTER crpko_cluster'; assert marker in s; s=s.replace(marker,floor+'\n\n'+marker,1);p.write_text(s)
p=root/'terraform/modules/clickhouse-ec2/user_data.sh.tftpl';s=p.read_text();start=s.index('    <$native_init_username_xml>');end=s.index('    </$native_init_username_xml>',start);block=s[start:end];needle='        <query>GRANT SELECT, INSERT ON crpko.balance_bonus_components_snapshot_v2</query>';assert block.count(needle)==1;block=block.replace(needle,needle+'\n        <query>GRANT SELECT, INSERT ON crpko.clickhouse_native_init_floors_v1</query>');p.write_text(s[:start]+block+s[end:])
for filename,var in [('scripts/runbooks/apply-clickhouse-users.mjs','nativeInitTables'),('scripts/test-native-init-clickhouse-users.mjs','insertTables')]:
 p=root/filename;s=p.read_text();start=s.index('const '+var+' = [');end=s.index('\n];',start);block=s[start:end];block=block.replace('  "balance_bonus_components_snapshot_v2"','  "balance_bonus_components_snapshot_v2",\n  "clickhouse_native_init_floors_v1"');s=s[:start]+block+s[end:];s=s.replace('exactly the nine statements below (17 system.grants rows)','exactly the ten statements below (19 system.grants rows)').replace('privilege, 17 rows in total.','privilege, 19 rows in total.');p.write_text(s)
p=root/'scripts/test-clickhouse-users-runbook.mjs';s=p.read_text().replace('is the 17 rows','is the 19 rows');s=s.replace('"balance_cash_components_snapshot_v2", "balance_bonus_components_snapshot_v2"]','"balance_cash_components_snapshot_v2", "balance_bonus_components_snapshot_v2", "clickhouse_native_init_floors_v1"]');start=s.index('const nativeInitGrants = [');end=s.index('\n];',start);block=s[start:end];needle='  "GRANT SELECT, INSERT ON crpko.balance_bonus_components_snapshot_v2",';assert needle in block;block=block.replace(needle,needle+'\n  "GRANT SELECT, INSERT ON crpko.clickhouse_native_init_floors_v1",');p.write_text(s[:start]+block+s[end:])
p=root/'scripts/runbooks/native-init-clickhouse-user.md';s=p.read_text();start=s.index('`clickhouse_native_init` has exactly');end=s.index('\n```',start);s=s[:start]+'''`clickhouse_native_init` has exactly these 10 `GRANT` statements (19 `system.grants` rows), in this order, and
nothing else, as listed in ClickHouse.md §1.5. It uses the `position_bonus_profile` settings profile
(quota `default`, networks `::/0`), so the initializer can set the quorum insert settings.
'''+s[end:];needle='GRANT SELECT, INSERT ON crpko.balance_bonus_components_snapshot_v2';s=s.replace(needle,needle+'\nGRANT SELECT, INSERT ON crpko.clickhouse_native_init_floors_v1',1);needle="- The two balance snapshot tables are the projector's empty component seeds.";s=s.replace(needle,needle+'\n- `clickhouse_native_init_floors_v1` is the durable floor copy used by Edge\'s signed positions read\n  (ClickHouse.md §1.5.2 and edge-api Deployment.md §4.4).');p.write_text(s)
p=root/'scripts/test-native-init-clickhouse-users.mjs';s=p.read_text();s=s.replace('  "ALTER TABLE crpko.kafka_ingestion_watermarks DELETE WHERE 0",','  "ALTER TABLE crpko.kafka_ingestion_watermarks DELETE WHERE 0",\n  "ALTER TABLE crpko.clickhouse_native_init_floors_v1 DELETE WHERE 1",');needle='      assert.equal(readback, "1", "nonempty initializer watermark is read back on the second replica");';assert needle in s;s=s.replace(needle,needle+'''
      const floor = {
        topic: "native-init-floor-probe",
        partition: 0,
        consumer_group: "clickhouse-direct-canonical-dev",
        verified_log_start_offset: 0,
        plan_sha256: "a".repeat(64),
        t0_ms: 1767225600000
      };
      expectAllowed(userName, userPassword,
        `INSERT INTO crpko.clickhouse_native_init_floors_v1 FORMAT JSONEachRow ${JSON.stringify(floor)}`,
        container,
        ["--insert_quorum=2", "--insert_quorum_parallel=0", "--insert_deduplication_token=native-init:clickhouse_native_init_floors_v1:dev:1767225600000:test"]);
      sql("SYSTEM SYNC REPLICA crpko.clickhouse_native_init_floors_v1", [], replicas[1]);
      const floorRows = expectAllowed(userName, userPassword,
        "SELECT * FROM crpko.clickhouse_native_init_floors_v1 FORMAT JSONEachRow", replicas[1]).trim();
      assert.deepEqual(floorRows.split("\\n").map((row) => JSON.parse(row)), [floor],
        "every floor column, including a zero offset, is read back on the second replica");''');s=s.replace('      for (const replica of replicas) {\n        const rows = sql(', '      assert.equal(expected.length, 19, "native init grants contain exactly 19 rows");\n      for (const replica of replicas) {\n        const rows = sql(',1);p.write_text(s)
PY
node --input-type=module - <<'JS'
import fs from 'node:fs';
const p='plan/devops-terraform-build-spec.json'; const j=JSON.parse(fs.readFileSync(p,'utf8'));j.files['clickhouse/crpko-clickhouse-ddl.sql']=fs.readFileSync('plan/clickhouse/crpko-clickhouse-ddl.sql','utf8');fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');
JS
npm run validate:plan
node --test scripts/test-clickhouse-users-runbook.mjs