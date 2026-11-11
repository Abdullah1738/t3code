mkdir -p tmp/card-2471
cat > tmp/card-2471/edit.py <<'PY'
import copy,json,re
from pathlib import Path
root=Path('.')
p=root/'terraform/modules/better-stack-alert-evaluator/src/alert_definitions/dev.json'
b=json.loads(p.read_text()); metric='kyc.backoffice_action.unresolved_dispatch.oldest_age_seconds'; aid='doc-kyc-backoffice-unresolved-dispatch-age-900-crp13697'
d=copy.deepcopy(next(x for x in b['definitions'] if x['id']=='doc-kyc-background-auth-retry-age-seconds-900-1b5da3aa3d'))
title=f'`{metric}` > `900` on any shard (maximum across tasks per `shard_id`)'
d.update(id=aid,name='CRPKO dev '+title)
d['query']=d['query'].replace('kyc.background.auth_retry_age_seconds',metric).replace("label('process')","label('shard_id')").replace("'process'","'shard_id'")
m=d['metadata'];m.update(title=title,source_doc='binaries/compliance-kyc/Alerts and Metrics.md:670',
 runbook={'label':'Backoffice action dispatch unresolved','target':'Alerts and Metrics.md#s2_15'},
 rationale='The gauge already measures the age since the last Sumsub send. A value above 900 pages without an additional hold. Each time bucket takes the maximum across tasks per shard, so another task reporting zero cannot hide an unresolved dispatch. The 900 second lookback overlaps the ten minute evaluator cadence and ingestion delay; a breach resolves once its last sample leaves that lookback.',
 expected_signal='Sev2: '+title+'\nMeaning: a provider-mutating Sumsub request has had no provable outcome for 15 minutes; its account refuses every other provider-mutating Backoffice action with 503. No automatic release exists.\nAction: read backoffice_dispatch_unresolved logs for account_id and details.reason; check Sumsub status and API availability, then check the applicant in the Sumsub dashboard with compliance. Release only with KYC_SUMSUB_DISPATCH_RELEASE after those checks, naming the log\'s action_id, attempt, details.send_count, and details.last_sent_at_ms. Never edit the progress row by hand.',
 metric_refs=[metric],selected_metric_ref=metric,selected_metric=metric,
 target_dashboard_id=1037570,target_dashboard_name='CRPKO dev runtime - compliance-kyc')
idx=next(i for i,x in enumerate(b['definitions']) if x['id']=='doc-kyc-background-connection-limit-retry-age-seconds-900-24e6911163')
b['definitions'].insert(idx+1,d);b['counts']['definitions']+=1;b['counts']['documented']+=1
p.write_text(json.dumps(b,indent=2,ensure_ascii=False)+'\n')
# Adjust only catalogue counts, leaving source line references and hashes intact.
p=Path('terraform/roots/dev/main.tf');p.write_text(p.read_text().replace('expected_static_definition_count = 469','expected_static_definition_count = 470'))
p=Path('scripts/test-better-stack-alert-evaluator.mjs');s=p.read_text().replace('expected_static_definition_count = 469','expected_static_definition_count = 470');s=s.replace('staticDefinitions.length, 469','staticDefinitions.length, 470').replace('counts.definitions, 469','counts.definitions, 470').replace('length, 440','length, 441').replace('    469,\n    "every retained','    470,\n    "every retained');p.write_text(s)
p=Path('terraform/modules/better-stack-alert-evaluator/tests/test_better_stack_alert_evaluator.py');s=p.read_text();s=re.sub(r'(?<=, )469(?=\))','470',s);s=s.replace('"documented"), 440)','"documented"), 441)');p.write_text(s)
# Only the expected-signal prose contains duration wording; the gauge encodes age.
p=Path('observability/betterstack/alerts/dev/duration-exemptions.json');e=json.loads(p.read_text());e['exemptions'][aid]='metric-semantics: the gauge value is already the unresolved dispatch age; > 900 seconds needs no additional hold duration';e['exemptions']=dict(sorted(e['exemptions'].items()));p.write_text(json.dumps(e,indent=2,ensure_ascii=False)+'\n')
# Managed desired state only; exported live charts remain untouched.
p=Path('observability/betterstack/managed/dev/charts.json');c=json.loads(p.read_text());charts=[]
for i,(name,line,series,expr,unit) in enumerate([
 ('kyc.backoffice_action.unresolved_dispatch.count',526,"label('shard_id')",'maxMerge(value_max)','shortened'),
 ('kyc.backoffice_action.order_outcome.count',534,"label('result')",'sum(value)','e/s'),
]):
 if i==0:
  sql=f"SELECT\n  {{{{time}}}} AS time,\n  {series} AS series,\n  {expr} AS value\nFROM {{{{metrics_source}}}}\nWHERE dt BETWEEN {{{{start_time}}}} AND {{{{end_time}}}}\n  AND name = '{name}'\n  AND label('env') = 'dev'\n  AND label('service') = 'compliance-kyc'\nGROUP BY time, series\nORDER BY time"
 else:
  sql=f"SELECT\n  time,\n  series,\n  sum(value) AS value\nFROM (\n  SELECT\n    {{{{time}}}} AS time,\n    {series} AS series,\n    series_id,\n    avgMerge(rate_avg) AS value\n  FROM {{{{metrics_source}}}}\n  WHERE dt BETWEEN {{{{start_time}}}} AND {{{{end_time}}}}\n    AND name = '{name}'\n    AND label('env') = 'dev'\n    AND label('service') = 'compliance-kyc'\n  GROUP BY time, series, series_id\n)\nGROUP BY time, series\nORDER BY time"
 charts.append({'name':'compliance-kyc '+name,'chart_type':'line_chart','description':f'Documented metric dashboard chart. Source: binaries/compliance-kyc/Alerts and Metrics.md:{line}.','x':i*6,'y':277,'w':6,'h':6,'settings':{'unit':unit,'legend':'shown_below','series_column':'series','value_columns':['value'],'treat_missing_values':'zero'},'queries':[{'query_type':'sql_expression','source_variable':'metrics_source','sql_query':sql}]})
c['dashboards'].append({'dashboard_id':1037570,'name':'CRPKO dev runtime - compliance-kyc','charts':charts});p.write_text(json.dumps(c,indent=2,ensure_ascii=False)+'\n')
PY
python3 tmp/card-2471/edit.py
git diff --stat
node scripts/check-better-stack-alert-durations.mjs