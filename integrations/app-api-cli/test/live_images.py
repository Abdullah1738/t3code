"""Read-only per-section CLI and CDN smoke checks; writes projected evidence only."""
import concurrent.futures as cf
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from catalog_schema import rows

CASES = [
 ('noon-main','noon-search',['iphone']),('noon-rocket','noon-search',['--rocket','iphone']),
 ('noon-minutes','noon-search',['--minutes','milk']),('noon-nownow','noon-search',['nownow','milk']),
 ('noon-food','noon-search',['food','sushi']),('noon-food-menu','noon-search',['food-menu','SSHZNKNBDI']),
 ('talabat-food','talabat-search',['sushi']),('talabat-menu','talabat-search',['menu','717327']),
 ('talabat-mart','talabat-search',['--mart','milk']),('talabat-groceries','talabat-search',['groceries','milk']),
 ('talabat-pharmacies','talabat-search',['pharmacies','panadol']),('talabat-flowers','talabat-search',['flowers','rose']),
 ('careem-food','careem-search',['food','sushi']),('careem-menu','careem-search',['menu','1054428']),
 ('careem-quik','careem-search',['quik','milk']),('careem-shops','careem-search',['shops','milk']),
 ('careem-electronics','careem-search',['electronics','charger'])]

def check(case):
 name,app,args=case
 try:
  p=subprocess.run([str(Path.home()/'.local/bin'/app),*args,'--limit','5','--json'],capture_output=True,text=True,timeout=150,env=dict(os.environ,APP_SEARCH_NO_UI='1'))
  d=json.loads(p.stdout)
  candidates=list(rows(d))
  evidence={'section':name,'cli_ok':p.returncode==0,'image_count':len(candidates),'samples':[]}
  for item in candidates[:2]:
   try:
    with urllib.request.urlopen(item['image_url'],timeout=15) as r:
     evidence['samples'].append({'name':item.get('name'),'image_url':item['image_url'],'status':r.status,'content_type':r.headers.get_content_type()})
   except Exception as e:
    evidence['samples'].append({'image_url':item['image_url'],'error':type(e).__name__})
  return evidence
 except Exception as e:
  return {'section':name,'cli_ok':False,'error':type(e).__name__}

if __name__=='__main__':
 with cf.ThreadPoolExecutor(4) as pool:
  results=list(pool.map(check,CASES))
 print(json.dumps(results,indent=2))
