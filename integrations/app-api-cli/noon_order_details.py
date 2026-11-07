"""Allowlisted order merchandise projection. Never return raw payment/customer data."""
import math
import re
from decimal import Decimal
import noon_http_orders as core
import noon_vertical_reads as vertical


def number(value):
    if isinstance(value, Decimal): value=float(value)
    return value if type(value) in (int,float) and math.isfinite(value) else None


def food(row, order):
    if row.get('orderNr') != order or not isinstance(row.get('items'), list):
        raise core.NoonError('ORDER_MISMATCH_OR_SCHEMA_CHANGED')
    menu = row.get('menuInfo') or {}
    catalog = {i['itemCode']: i for i in menu.get('items',[]) if isinstance(i,dict) and i.get('itemCode')}
    groups = {g['modifierCode']:g for g in menu.get('modifiers',[]) if isinstance(g,dict) and g.get('modifierCode')}
    lines=[]
    for line in row['items']:
        code, qty=line.get('itemCode'),line.get('qty')
        if not isinstance(code,str) or type(qty) is not int or qty<1:
            raise core.NoonError('ORDER_ITEM_SCHEMA_CHANGED')
        item=catalog.get(code,{})
        choices=[]
        for group, selected in (line.get('modifiers') or {}).items():
            g=groups.get(group,{})
            prices={o.get('itemCode'):number(o.get('price')) for o in g.get('options',[])}
            for option,count in selected.items():
                choices.append({'group_id':group,'group':core.text(g.get('name')),'item_code':option,
                                'name':core.text(catalog.get(option,{}).get('name')),
                                'qty_per_item':count,'price':prices.get(option)})
        notes=line.get('notes') if isinstance(line.get('notes'),str) else None
        detail='; '.join((c['name'] or c['item_code'])+' x'+str(c['qty_per_item']) for c in choices)
        image=item.get('image')
        lines.append({'item_code':code,'name':core.text(item.get('name')),'qty':qty,
                      'price':number(line.get('price')),'line_total':number(line.get('totalPrice')),
                      'options':choices,'notes':notes,'detail':detail or None,
                      'description':core.text(item.get('desc')),
                      'image_url':'https://f.nooncdn.com/food_production/'+image if isinstance(image,str) and image.startswith('food/') else None})
    return {'ok':True,'app':'noon','order':order,'vertical':'food',
            'vendor_name':core.text((row.get('outletInfo') or {}).get('name')),
            'items':lines,'total':number(row.get('orderTotal')),'currency':'AED',
            'notes':row.get('notes') if isinstance(row.get('notes'),str) else None,
            'price_breakdown':{k:number(row.get(k)) for k in ('orderSubtotal','orderSubtotalDiscounted','orderDiscount',
                                'orderDeliveryFee','orderServiceFee','orderSmallOrderFee')},
            'source':'exact_native_order_detail','items_complete':True,'account_verified':True}


def details(order, service, timeout=12):
    deadline=core.operation_deadline(timeout)
    extra={}
    if service=='food':
        headers=vertical._headers('food',deadline)
        return food(vertical._food_data(vertical._read('food_detail',headers,deadline,order)),order)
    if service=='nownow':
        headers=vertical._headers('nownow',deadline)
        row=vertical._nownow_data(vertical._read('nownow_detail',headers,deadline,order))
        raw=row.get('products'); store=core.text((row.get('storeInfo') or {}).get('name'))
    elif service=='minutes':
        import noon_minutes_checkout as minutes
        headers=core.verified_session('minutes',deadline)
        row=minutes.native_request('order_get',headers,deadline,{'orderNr':order},response_observer=lambda *a,**k:None)
        raw=row.get('items'); store='noon Minutes'
    elif service in ('main','supermall','marketplace'):
        headers=vertical._headers('marketplace',deadline)
        row=vertical._read('marketplace_manifest',headers,deadline,order)
        groups=row.get('itemGroups')
        if not isinstance(groups,list):raise core.NoonError('ORDER_ITEM_SCHEMA_CHANGED')
        raw=[i for g in groups for i in g.get('items',[])];store='noon'
        count=vertical._invoice_count(row.get('invoice'))
        extra={'declared_item_units':count,'observed_item_units':sum(i.get('quantity',0) for i in raw),
               'eta_text':' / '.join(dict.fromkeys(core.text(g.get('text')) for g in groups
                    if isinstance(g.get('text'),str) and g['text'].startswith('Arriving '))) or None,
               'status_text':' / '.join(dict.fromkeys(core.text((g.get('subStatus') or {}).get('highStatus'))
                    if (g.get('subStatus') or {}).get('highStatusCode') in ('cancelled','canceled','delivered')
                    else core.text(g.get('subText')) for g in groups)) or None}
        totals=[]
        for section in (row.get('invoice') or {}).get('sections',[]):
            for entry in section.get('entries',[]):
                label=re.sub('<[^>]+>','',entry.get('title') or '').strip()
                if label=='Total (inc. VAT)':
                    amount=re.sub('<[^>]+>','',entry.get('amount') or '').replace('\ue001','').strip()
                    if re.fullmatch(r'\d+(?:,\d{3})*\.\d{2}',amount):totals.append(float(amount.replace(',','')))
        row={**row,'orderTotal':totals[0] if len(totals)==1 else None}
    else:raise core.NoonError('ORDER_DETAILS_VERTICAL_NOT_IMPLEMENTED')
    if row.get('orderNr')!=order or not isinstance(raw,list):raise core.NoonError('ORDER_MISMATCH_OR_SCHEMA_CHANGED')
    lines=[]
    for item in raw:
        qty=number(item.get('qty',item.get('quantity')))
        if qty is None or qty<=0:raise core.NoonError('ORDER_ITEM_SCHEMA_CHANGED')
        price=None if service=='minutes' else number(item.get('unitPrice',item.get('price')))
        notes=item.get('notes') if isinstance(item.get('notes'),str) else None
        choices=core.text(item.get('customizationSubtitle'))
        detail=choices
        media=item.get('media') or []
        image=item.get('imageUrl') or next((m.get('path') for m in media if m.get('type')=='image' and m.get('isAbsolutePath')),None)
        if not image and item.get('images'):image='https://f.nooncdn.com/'+item['images'][0]
        lines.append({'item_code':item.get('itemCode') or item.get('productCode') or item.get('sku'),
                      'name':core.text(item.get('name') or item.get('title')),'qty':int(qty) if qty==int(qty) else qty,
                      'price':price,'line_total':number(item.get('totalPrice')),'notes':notes,
                      'detail':detail,'options':None,'image_url':image,
                      'options_coverage':'native_display_label' if choices else 'not_exposed'})
    return {'ok':True,'app':'noon','order':order,'vertical':service,'vendor_name':store,
            'items':lines,'total':number(row.get('orderTotal')),'currency':'AED',
            'items_complete':not extra or extra['declared_item_units']==extra['observed_item_units'],
            'source':'exact_native_order_detail','account_verified':True,**extra}
