"""Read-only live catalog scenarios. Saves projected evidence, never credentials."""
import json
import subprocess
import sys
import time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from common import item_matches

OUT=Path('/Users/ardud/.config/openchamber/imessage/2026-10-03/session-7443a973-b926-4d39-a656-eaf82d4d5bca')
CASES=[]
def add(app,section,name,args,check='positive'):
    CASES.append((app,section,name,args,check))
for section,args,q in [('Main',['noon-search'],'marvis'),('Rocket',['noon-search','--rocket'],'iphone'),('Minutes',['noon-search','--minutes'],'milk'),('Food',['noon-search','food'],'sushi')]:
    add('noon',section,'single / prices',args+[q,'--limit','5','--json'])
    add('noon',section,'nonsense',args+['zzqvnomatch837','--json'],'empty')
add('noon','Food','open now',['noon-search','food','sushi','--open','--json'],'open')
add('noon','Food','menu',['noon-search','food-menu','SSHZNKNBDI','--query','salmon','--json'])
add('noon','Food','same-store sushi + salad',['noon-search','food-match','sushi','seaweed salad','--open','--json'],'match')
for section,mode in [('Minutes','minutes'),('Main','main')]:
    terms=['charger','cable'] if mode=='main' else ['milk','eggs']
    add('noon',section,'same-store / subtotal',['shop-search','match','noon',mode,*terms,'--json'],'match')
for section,args,q in [('Food',['talabat-search'],'sushi'),('Mart',['talabat-search','--mart'],'milk'),('Groceries',['talabat-search','groceries'],'milk'),('Pharmacy',['talabat-search','pharmacies'],'panadol'),('Flowers',['talabat-search','flowers'],'rose')]:
    extra=['--stores','4'] if section in ['Groceries','Pharmacy','Flowers'] else []
    add('Talabat',section,'single / prices',args+[q,'--limit','5','--json']+extra)
    add('Talabat',section,'nonsense',args+['zzqvnomatch837','--limit','3','--json']+extra,'empty')
add('Talabat','Food','open now',['talabat-search','sushi','--open','--limit','8','--json'],'open')
add('Talabat','Food','menu',['talabat-search','menu','799649','--query','salmon','--json'])
add('Talabat','Food','same-store sushi + salad',['talabat-search','menu-match','sushi','seaweed salad','--open','--limit','5','--json'],'match')
for section,mode in [('Mart','mart'),('Groceries','groceries'),('Pharmacy','pharmacies')]:
    terms=['panadol','vitamin'] if mode=='pharmacies' else ['milk','eggs']
    add('Talabat',section,'same-store / subtotal',['shop-search','match','talabat',mode,*terms,'--json'],'match')
for section,mode,q in [('Food','food','sushi'),('Quik','quik','milk'),('Shops','shops','milk'),('Electronics','electronics','charger')]:
    add('Careem',section,'single / prices',['careem-search',mode,q,'--limit','5'])
    add('Careem',section,'nonsense',['careem-search',mode,'zzqvnomatch837'],'empty')
    if mode!='quik':add('Careem',section,'open now',['careem-search',mode,q,'--open'],'open')
add('Careem','Food','menu',['careem-search','menu','1054428','--query','salmon'])
add('Careem','Food','same-store sushi + salad',['careem-search','menu-match','sushi','seaweed salad','--open'],'match')
for section,mode in [('Quik','quik'),('Shops','shops'),('Electronics','electronics')]:
    terms=['charger','cable'] if mode=='electronics' else ['milk','eggs']
    add('Careem',section,'same-store / subtotal',['shop-search','match','careem',mode,*terms,'--json'],'match')
add('noon','NowNow','single / prices',['noon-search','nownow','milk','--limit','5','--json'])
add('noon','NowNow','same-store / subtotal',['shop-search','match','noon','nownow','milk','eggs','--json'],'match')
add('noon','NowNow','nonsense',['noon-search','nownow','zzqvnomatch837','--json'],'empty')
for app,cmd in [('Talabat',['talabat-search','sushi']),('Careem',['careem-search','food','sushi'])]:
    add(app,'Guards','account required',cmd+['--require-account','--json'],'error')
for app,cmd in [('noon',['noon-search']),('Talabat',['talabat-search']),('Careem',['careem-search','food'])]:
    add(app,'Guards','empty input',cmd+['','--json'],'error')

def run(case):
    app,section,name,cmd,check=case;start=time.monotonic()
    try:
        p=subprocess.run(cmd,capture_output=True,text=True,timeout=360)
        d=json.loads(p.stdout); rows=d.get('items',d.get('results',d.get('stores',[])))
        ok=p.returncode==0 and not d.get('error') and d.get('ok') is not False
        if check=='error':ok=not ok
        elif check=='empty':ok=ok and not rows
        else:
            ok=ok and bool(rows)
            if check=='open':ok=ok and all(r.get('status')=='open' for r in rows)
            if check=='match':
                ok=ok and all(r.get('matches') and all(hits and all(item_matches(term,i['name']) for i in hits) for term,hits in r['matches'].items()) for r in rows)
        errors=d.get('error')
        result={'app':app,'section':section,'scenario':name,'status':'PASS' if ok else 'FAIL','seconds':round(time.monotonic()-start,2),'count':len(rows),'error':errors,'fallbacks':d.get('fallbacks',[]),'command':cmd}
        # Already field-projected CLI response; useful for checking actual prices/matches.
        result['evidence']=d
    except Exception as e:
        result={'app':app,'section':section,'scenario':name,'status':'FAIL','seconds':round(time.monotonic()-start,2),'error':type(e).__name__,'command':cmd}
    print(json.dumps({k:v for k,v in result.items() if k not in ['evidence','command','fallbacks']}),flush=True)
    return result

if __name__=='__main__':
    selected=CASES
    if len(sys.argv)>1:selected=[c for c in CASES if sys.argv[1].lower() in (c[0]+' '+c[1]+' '+c[2]).lower()]
    results=[]
    path=OUT/'search-scenarios.json'
    if len(sys.argv)>1 and path.exists():results=json.loads(path.read_text())
    for c in selected:
        r=run(c);results=[x for x in results if (x['app'],x['section'],x['scenario'])!=(r['app'],r['section'],r['scenario'])]+[r]
        path.write_text(json.dumps(results,indent=2))
