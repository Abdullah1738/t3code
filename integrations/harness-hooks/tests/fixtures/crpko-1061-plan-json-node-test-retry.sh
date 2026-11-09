python3 - <<'PY'
import json
from pathlib import Path
p=Path('plan/devops-terraform-build-spec.json');s=json.loads(p.read_text())
for kind in ['task','execution']:
 name=f'iam/roles/crpko-env-clickhouse-native-init-{kind}-role.json';f=Path('plan')/name;j=json.loads(f.read_text());j['source']['architecture']='shared/ClickHouse.md §1.5; shared/Kafka Cluster.md §4.2';f.write_text(json.dumps(j,indent=2)+'\n');s['files'][name]=f.read_text()
p.write_text(json.dumps(s,indent=2)+'\n')
PY