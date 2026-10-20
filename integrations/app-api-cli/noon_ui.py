"""Read-only NowNow fallback. Search and scroll only; never press product/add/cart."""
import importlib.util
import json
import re
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent/'capture'))
from phone_guard import held
from common import item_matches, money


def search(query, limit=10, timeout=60):
    spec = importlib.util.spec_from_file_location('noon_phone', Path.home()/'.config/opencode/skills/productivity/android-phone/scripts/ph.py')
    ph = importlib.util.module_from_spec(spec); spec.loader.exec_module(ph)
    deadline = time.monotonic()+timeout
    def guard():
        if held(): raise ValueError('PHONE_BUSY')
        if time.monotonic() > deadline: raise ValueError('UI_TIMEOUT')
    def nodes():
        guard()
        for attempt in range(3):
            try:return ph.nodes()
            except (ConnectionError, OSError):
                if attempt==2:raise
                time.sleep(.5)
    def act(fn, *args, **kw):
        guard(); return fn(*args, **kw)
    def find(ns, rid):
        return next((n for n in ns if n['pkg']=='com.noon.buyerapp' and n['rid']==rid), None)
    def tap(n):
        act(ph.d().click, n['x'], n['y'])
    def wait(rid):
        while True:
            n=find(nodes(), rid)
            if n:return n
            time.sleep(.3)
    # Launch through adb; uiautomator's app_start occasionally disconnects its
    # instrumentation server when the prior search process just exited.
    import subprocess
    act(subprocess.run,['adb','-s',ph.SERIAL,'shell','monkey','-p','com.noon.buyerapp','1'],capture_output=True,timeout=10)
    time.sleep(.5)
    # Return to a fresh home header to verify the selected address on every call.
    for _ in range(8):
        ns=nodes()
        if find(ns,'address-bar') or find(ns,'switcher_button_noonnownow'):break
        act(ph.d().press,'back');time.sleep(.4)
    ns=nodes()
    if find(ns,'switcher_button_noonnownow'):tap(find(ns,'switcher_button_noonnownow'))
    header=wait('address-bar')
    if not ('banyan' in (header['t']+header['c']).lower() and '2104' in header['t']+header['c']):
        raise ValueError('HOME_MISMATCH')
    tap(wait('search_bar'))
    field=wait('nownow_search_input');tap(field)
    act(ph.d().send_keys, query, clear=True)
    for _ in range(15):
        if wait('nownow_search_input')['t'] == query:break
        time.sleep(.2)
    else:raise ValueError('QUERY_NOT_ENTERED')
    act(ph.d().press,'enter')
    seen, groups = set(), {}
    current=None
    for screen in range(4):
        while True:
            ns=nodes()
            if any(n['rid'].startswith(('nownow_product_','nownow_store_')) for n in ns):break
            if any('no result' in n['t'].lower() or 'couldn’t find' in n['t'].lower() or 'could not find' in n['t'].lower() for n in ns):
                return result([], query)
            time.sleep(.3)
        guard();root=ET.fromstring(ph.d().dump_hierarchy(compressed=False))
        current=None  # Never associate a clipped prior store's products with the last store on another screen.
        flat=list(root.iter('node'))
        for index,n in enumerate(flat):
            rid=n.get('resource-id','').split('/')[-1]
            if rid.startswith('nownow_store_'):
                label=n.get('content-desc','');parts=[p.strip() for p in label.split(',')]
                current=rid.removeprefix('nownow_store_')
                eta=re.search(r'(\d+)\s*,?\s*mins',label)
                fee=re.search(r'Delivery:\s*,?\s*\ue001\s*([\d.]+)',label)
                groups.setdefault(current,{'store_id':current,'store':parts[0] if parts else current,
                    'area':parts[1] if len(parts)>1 else None,'eta':eta.group(1)+' mins' if eta else None,
                    'delivery_fee':money(fee.group(1)) if fee else None,'status':'unknown','items':[]})
            if rid.startswith('nownow_product_') and current and (current,rid) not in seen:
                tail=[]
                for x in flat[index+1:]:
                    if x.get('resource-id','').startswith(('nownow_product_','nownow_store_')):break
                    tail.append(x)
                texts=[x.get('text') for x in tail if x.get('text')]
                labels=[x.get('content-desc') for x in tail if x.get('content-desc') and x.get('content-desc')!='ADD']
                name=labels[0] if labels else ''
                if not name or not item_matches(query,name):continue
                price=None
                for i,s in enumerate(texts):
                    if s=='\ue001' and i+1<len(texts):price=money(texts[i+1]);break
                if price is None:continue
                seen.add((current,rid))
                groups[current]['items'].append({'id':rid.removeprefix('nownow_product_'),'name':name,'price':price,
                    'currency':'AED','availability':'listed_in_app','size':next((s for s in texts if re.search(r'\d\s*(?:L|ml|g|kg|pcs)\b',s)),None)})
        if len(seen)>=limit:break
        act(ph.d().swipe_ext,'up',scale=.65);time.sleep(.4)
    return result([g for g in groups.values() if g['items']],query)


def result(groups,query):
    return {'ok':True,'service':'noon-nownow','source':'android_ui','query':query,'stores':groups,
        'account':{'authenticated':True,'pricing':'app'},'location':{'name':'BanyanTree Hillside - Flat 2104','saved_address_verified':True},
        'fallbacks':[{'step':'nownow_search','reason':'Native catalog route returned HTTP 503; used original logged-in Android app'}],
        'scope':'four visible screens; not exhaustive','notes':['Open status is unknown; listing is not orderability.']}


if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser();p.add_argument('query');p.add_argument('--limit',type=int,default=10);p.add_argument('--timeout',type=int,default=60)
    o=p.parse_args();start=time.monotonic()
    try:
        d=search(o.query,o.limit,max(o.timeout,60));d['elapsed_seconds']=round(time.monotonic()-start,2);print(json.dumps(d))
    except Exception as e:
        print(json.dumps({'ok':False,'error':{'code':str(e) if isinstance(e,ValueError) else 'UI_FAILED','exception_type':type(e).__name__,'message':'NowNow read-only UI search could not complete.'}}));raise SystemExit(1)
