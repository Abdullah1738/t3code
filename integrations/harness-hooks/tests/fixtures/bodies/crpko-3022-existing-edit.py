from pathlib import Path
import json
root=Path('/Users/ardud/checkouts/market-data-registry-3022')
def edit(path,old,new,count=None):
 p=root/path;s=p.read_text();n=s.count(old)
 assert n and (count is None or n==count),(path,n,old[:120])
 p.write_text(s.replace(old,new))
old='''    REGISTRY_ASSETS_TABLE           = lookup(var.dynamodb_table_names, "registry_assets", "registry_assets")
    REGISTRY_ENTITY_REVISIONS_TABLE = lookup(var.dynamodb_table_names, "registry_entity_revisions", "registry_entity_revisions")'''
new='''    REGISTRY_ASSETS_TABLE                     = lookup(var.dynamodb_table_names, "registry_assets", "registry_assets")
    REGISTRY_ENTITY_REVISIONS_TABLE           = lookup(var.dynamodb_table_names, "registry_entity_revisions", "registry_entity_revisions")
    REGISTRY_INSTRUMENTS_TABLE                = lookup(var.dynamodb_table_names, "registry_instruments", "registry_instruments")
    REGISTRY_EFFECTIVE_TIMELINE_CONTROL_TABLE = var.dynamodb_table_names["registry_effective_timeline_control"]'''
edit('terraform/modules/ecs-runtime/main.tf',old,new,1)
p=root/'plan/devops-runtime-values.json'; d=json.loads(p.read_text()); md=d['services']['market-data']
md['dynamodbScanOnlyTables'] += ['registry_instruments','crpko-<env>-registry-effective-timeline-control']
md['dynamodbScanOnlyTableNotes'].update({
 'registry_instruments': 'Assigned instrument-topic partition owners bootstrap every exact instrument row with ConsistentRead Scan before sealed Kafka replay. Market Data gets dynamodb:Scan only.',
 'crpko-<env>-registry-effective-timeline-control': 'Assigned-scope instrument bootstrap reads effective-timeline control metadata from the environment control table. Market Data gets dynamodb:Scan only; the asset bootstrap does not read this table.'})
for name,value,source in [('REGISTRY_INSTRUMENTS_TABLE','registry_instruments','market-data Deployment §3 DynamoDB exact instrument bootstrap; Terraform data-plane table name'),('REGISTRY_EFFECTIVE_TIMELINE_CONTROL_TABLE','crpko-<env>-registry-effective-timeline-control','Registry Deployment §2.1 effective-timeline control table; Terraform data-plane table name')]:
 md['env'][name]={'value':value,'source':source,'required':True}
p.write_text(json.dumps(d,indent=2,ensure_ascii=False)+'\n')
p=root/'plan/iam/roles/crpko-env-market-data-task-role.json'; d=json.loads(p.read_text()); s=next(s for s in d['inline_policy']['Statement'] if s['Sid']=='DynamoDBDeclaredScanOnlyTables')
s['Resource'] += ['arn:aws:dynamodb:<region>:<account_id>:table/registry_instruments','arn:aws:dynamodb:<region>:<account_id>:table/crpko-<env>-registry-effective-timeline-control']
p.write_text(json.dumps(d,indent=2,ensure_ascii=False)+'\n')
p=root/'plan/devops-terraform-build-spec.json';d=json.loads(p.read_text())
for f in ['devops-runtime-values.json','iam/roles/crpko-env-market-data-task-role.json']:
 if f in d['files']:d['files'][f]=(root/'plan'/f).read_text()
p.write_text(json.dumps(d,indent=2,ensure_ascii=False)+'\n')
old='''      REGISTRY_ASSETS_TABLE           = module.data_plane.dynamodb_table_names["registry_assets"]
      REGISTRY_ENTITY_REVISIONS_TABLE = module.data_plane.dynamodb_table_names["registry_entity_revisions"]'''
new='''      REGISTRY_ASSETS_TABLE                     = module.data_plane.dynamodb_table_names["registry_assets"]
      REGISTRY_ENTITY_REVISIONS_TABLE           = module.data_plane.dynamodb_table_names["registry_entity_revisions"]
      REGISTRY_INSTRUMENTS_TABLE                = module.data_plane.dynamodb_table_names["registry_instruments"]
      REGISTRY_EFFECTIVE_TIMELINE_CONTROL_TABLE = module.data_plane.dynamodb_table_names["registry_effective_timeline_control"]'''
edit('terraform/roots/dev/main.tf',old,new,1)
edit('terraform/roots/dev/main.tf','''      module.data_plane.dynamodb_table_names["registry_entity_revisions"],
    ]) && length(module.runtime_access_policies.declared_access_summary["market-data"].dynamodb_tables) == 0''','''      module.data_plane.dynamodb_table_names["registry_entity_revisions"],
      module.data_plane.dynamodb_table_names["registry_instruments"],
      module.data_plane.dynamodb_table_names["registry_effective_timeline_control"],
    ]) && length(module.runtime_access_policies.declared_access_summary["market-data"].dynamodb_tables) == 0''',1)
edit('terraform/roots/dev/main.tf','market-data must only have Scan access to registry_assets and registry_entity_revisions.','market-data must only have Scan access to registry_assets, registry_entity_revisions, registry_instruments and registry_effective_timeline_control.',1)
dev=(root/'terraform/roots/dev/main.tf').read_text();start=dev.index('  assert {\n    condition = module.ecs_runtime.market_data_registry_table_env');end=dev.index('\n}\n',start)
for env in ['staging','prod']:
 p=root/f'terraform/roots/{env}/main.tf';p.write_text(p.read_text()+'\ncheck "market_data_registry_runtime" {\n'+dev[start:end].replace('the dev DynamoDB','the '+env+' DynamoDB')+'\n}\n')
p=root/'scripts/validate-plan-package.mjs';s=p.read_text();start=s.index('  const marketDataRuntime =');end=s.index('  const vraRuntime =',start)
block=s[start:end].replace('[["REGISTRY_ASSETS_TABLE", "registry_assets"], ["REGISTRY_ENTITY_REVISIONS_TABLE", "registry_entity_revisions"]]','[["REGISTRY_ASSETS_TABLE", "registry_assets"], ["REGISTRY_ENTITY_REVISIONS_TABLE", "registry_entity_revisions"], ["REGISTRY_INSTRUMENTS_TABLE", "registry_instruments"], ["REGISTRY_EFFECTIVE_TIMELINE_CONTROL_TABLE", "crpko-<env>-registry-effective-timeline-control"]]').replace('registry_assets and registry_entity_revisions','registry_assets, registry_entity_revisions, registry_instruments and crpko-<env>-registry-effective-timeline-control').replace('["registry_assets", "registry_entity_revisions"]','["registry_assets", "registry_entity_revisions", "registry_instruments", "crpko-<env>-registry-effective-timeline-control"]')
s=s[:start]+block+s[end:];s=s.replace('registry scan resources must be exactly the registry_assets and registry_entity_revisions table ARNs','registry scan resources must be exactly the registry_assets, registry_entity_revisions, registry_instruments and effective-timeline control table ARNs').replace('["arn:aws:dynamodb:<region>:<account_id>:table/registry_assets", "arn:aws:dynamodb:<region>:<account_id>:table/registry_entity_revisions"]','["arn:aws:dynamodb:<region>:<account_id>:table/registry_assets", "arn:aws:dynamodb:<region>:<account_id>:table/registry_entity_revisions", "arn:aws:dynamodb:<region>:<account_id>:table/registry_instruments", "arn:aws:dynamodb:<region>:<account_id>:table/crpko-<env>-registry-effective-timeline-control"]');p.write_text(s)
