from pathlib import Path
import re
pat=re.compile(r'^<<<<<<< HEAD\n(.*?)^=======\n(.*?)^>>>>>>> origin/main-dev\n',re.M|re.S)
def resolve(file,fn):
 p=Path(file); i=0
 def sub(m):
  nonlocal i
  i+=1
  return fn(i,m[1],m[2])
 s=pat.sub(sub,p.read_text()); assert '<<<<<<<' not in s; p.write_text(s)
for f in ['app/domain/bonus/conditions.py','app/domain/kol/service.py','app/worker/campaign_trigger_preparation.py','app/worker/metrics_runtime.py']:
 resolve(f,lambda i,a,b:a+b)
resolve('tests/test_grant_completion_evidence.py',lambda i,a,b:a.replace('_window_executor','window_executor'))
def runtime(i,a,b):
 if i==1:return a+b
 if i==2:return a.replace('and not self._anchor_recovery_only','and not self._anchor_recovery_only\n            and not self.periodic_recovery_only').replace('request.campaign.status == "ACTIVE" or self._anchor_recovery_only','request.campaign.status == "ACTIVE"\n            or self._anchor_recovery_only\n            or self.periodic_recovery_only')
 if i==3:return a+'                and not self.periodic_recovery_only\n'
 if i==4:
  prefix=b[:b.index('            paused_non_trade_goal')]
  return prefix+a.replace('if existing_goal_row is None and not self._anchor_recovery_only:', 'if (\n                    existing_goal_row is None\n                    and not self._anchor_recovery_only\n                    and not self.periodic_recovery_only\n                ):')
 if i==5:
  return a[:a.index('            updated_goal_row, should_grant')] + b.replace('            if activate_dependent and existing_goal_row is not None:', '            should_grant = False\n            if activate_dependent and existing_goal_row is not None:').replace('updated_goal_row = self._evaluate_goal_for_account(goal_request)','updated_goal_row, should_grant = self._evaluate_goal_for_account(goal_request)')
 raise RuntimeError(i)
resolve('app/worker/campaign_progress_runtime.py',runtime)
p=Path('app/worker/campaign_progress_runtime.py');s=p.read_text();s=s.replace('            return request.existing_goal_row\n\n        snapshot =','            return request.existing_goal_row, False\n\n        snapshot =');p.write_text(s)
def data(i,a,b):
 if i in [1,2,3,10]:return a+b
 if i==4:return '        target_shard_id = routing.shard_id if window_shard_id is None else window_shard_id\n'+a
 if i==5:return a.replace('shard_id=routing.shard_id','shard_id=target_shard_id')
 if i==6:return a+'            )\n'+b
 if i==7:return '        preparation: _ShardMutationPreparation,\n'+a[a.index('        anchor_goals:'):]
 if i==8:return a.replace('        mutation = CampaignProgressRuntimeService(','        campaign_runtime = CampaignProgressRuntimeService(')
 if i==9:
  args=a[:a.index('        ).apply_trigger(')]
  after=a[a.index('        # A different close'):]
  periodic=b[:b.index('        existing_grant_state = self._load_grant_state_for_account(')]
  return args+periodic+after
 raise RuntimeError(i)
resolve('app/data/trigger_mutations.py',data)
p=Path('app/data/trigger_mutations.py');s=p.read_text();s=s.replace('            prepared = self._prepare_campaign_trigger(trigger=trigger, now_ms=now_ms)','            prepared = (\n                PreparedCampaignTrigger(None, PreparedCampaignFacts({}), {})\n                if window_operation is not None\n                else self._prepare_campaign_trigger(trigger=trigger, now_ms=now_ms)\n            )');p.write_text(s)
