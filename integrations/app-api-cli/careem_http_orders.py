"""Account-bound native Careem delivery tracking, static contract pending live QA.

Food only is enabled for first validation; Quik/Shops wire service/provider
bindings remain unverified. No guest fallback, login, refresh or UI calls.
"""
import argparse
import datetime as dt
import re
import sys
import time
import urllib.parse
import careem_account_auth as auth

HOST = 'https://sdui-activities.core.gw.prod.careem-rh.com'
PATH = '/v1/activity-tracker/food/'


class CareemError(Exception):
    pass


def project(data, order, service):
    info = data.get('info')
    if (not isinstance(info, dict) or str(info.get('reference_id')) != order
            or str(info.get('service', '')).lower() != service):
        raise CareemError('ORDER_IDENTITY_UNVERIFIED')
    raw = info.get('status')
    if not isinstance(raw, str) or not re.fullmatch(r'[A-Za-z_-]{1,64}', raw):
        raise CareemError('SCHEMA_CHANGED')
    # Static enum names alone are insufficient to certify arrival/completion.
    return {'ok': True, 'app': 'careem', 'order': order, 'service': service,
            'source': 'native_order_api', 'identity_verified': True,
            'account_verified': True, 'status': 'unknown', 'raw_status': raw,
            'eta': None, 'rider': None,
            'checked_at': dt.datetime.now(dt.timezone.utc).isoformat(),
            'coverage': 'native_contract_static; live_status_eta_rider_unverified'}


def track(order, timeout=12, *, service='food', latitude=None, longitude=None,
          provider_id=None, image_scale=None):
    if service != 'food':
        raise CareemError('DELIVERY_SERVICE_BINDING_UNVERIFIED')
    if not isinstance(order, str) or not re.fullmatch(r'[0-9]{1,20}', order):
        raise CareemError('INVALID_ORDER_ID')
    if not isinstance(timeout, (float, int)) or not 0 < timeout <= 30:
        raise CareemError('INVALID_TIMEOUT')
    deadline = time.monotonic()+timeout
    try:
        saved = auth.account()
        c = saved['client']
        auth.verify_customer(saved['auth']['access_token'], saved['identity']['phone_number'], c['headers'],
                             timeout=auth.remaining(deadline))
        h = dict(c['headers'])
        h['authorization'] = 'Bearer ' + saved['auth']['access_token']
        h.pop('x-careem-userid', None)
        query = {'military_time_format': 'false', 'time_zone': 'Asia/Dubai', 'language': 'en'}
        if image_scale is not None:
            if image_scale not in {'_mdpi', '_hdpi', '_xhdpi', '_xxhdpi', '_xxxhdpi'}:
                raise CareemError('INVALID_IMAGE_SCALE')
            query['image_scale'] = image_scale
        if provider_id is not None:
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', provider_id):
                raise CareemError('INVALID_PROVIDER_ID')
            query['provider_id'] = provider_id
        if (latitude is None) != (longitude is None):
            raise CareemError('INVALID_COORDINATES')
        if latitude is not None:
            if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
                raise CareemError('INVALID_COORDINATES')
            query.update(latitude=str(latitude), longitude=str(longitude))
        code, data = auth._transport('GET', HOST+PATH+order+'?'+urllib.parse.urlencode(query), h, None, False, deadline)
        if code != 200:
            raise CareemError('TRACK_HTTP_' + str(code))
        result = project(data, order, service)
        auth.remaining(deadline)
        return result
    except auth.AccountError as exc:
        raise CareemError(str(exc)) from None


def orders(*args, **kwargs):
    raise CareemError('ORDER_LIST_HOST_BINDING_UNVERIFIED')


def main():
    import json
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('order')
    p.add_argument('--service', default='food')
    p.add_argument('--timeout', type=float, default=12)
    args = p.parse_args()
    try:
        result = track(args.order, args.timeout, service=args.service)
    except Exception as exc:
        result = {'ok': False, 'app': 'careem', 'order': args.order, 'status': 'unknown',
                  'error': str(exc) if isinstance(exc, CareemError) else 'CAREEM_READ_FAILED'}
    print(json.dumps(result))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
