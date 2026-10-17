"""Common catalog presentation and bounded, credential-free image downloads."""
import concurrent.futures as cf
import hashlib
import json
import re
import sys
import urllib.request
from pathlib import Path


def image(value, prefix=''):
    if isinstance(value, list):
        return next((u for x in value if (u := image(x, prefix))), None)
    if isinstance(value, dict):
        for key in ('image_url', 'image_urls', 'imageUrl', 'image', 'images', 'img', 'image_path', 'imageKey', 'image_key', 'src'):
            if value.get(key):
                u = image(value[key], prefix)
                if u:
                    return u
        # A bare URL wrapper occurs inside image arrays; product URLs are not images.
        if set(value) == {'url'} or value.get('type') == 'image':
            return image(value['url'], prefix)
        return None
    if not isinstance(value, str) or not value.strip():
        return None
    if value.startswith('https://'):
        return value
    if prefix:
        return prefix + value.lstrip('/') + ('.jpg' if prefix.endswith('/p/') and not re.search(r'\.(jpg|png|webp)$', value) else '')
    return None


def normalize(value):
    if isinstance(value, list):
        return [normalize(v) for v in value]
    if not isinstance(value, dict):
        return value
    out = {k: normalize(v) for k, v in value.items()}
    if 'name' in out and ('price' in out or 'id' in out):
        out.setdefault('image_url', image(out))
        out.setdefault('calories_kcal', None)
        desc = str(out.get('description') or '') + ' ' + str(out.get('name') or '')
        kcal = re.search(r'(\d+(?:\.\d+)?)\s*(?:kcal|calories)', desc, re.I)
        if kcal and out['calories_kcal'] is None:
            out['calories_kcal'] = float(kcal[1])
        size = str(out.get('size') or out.get('name') or '')
        m = re.search(r'(?<![\d.])(\d+(?:\.\d+)?)\s*(kg|ml|litres?|liters?|l|g)\b', size, re.I)
        out.setdefault('size', None)
        out.setdefault('unit_price', None)
        out.setdefault('unit_price_unit', None)
        if m and isinstance(out.get('price'), (int, float)):
            quantity, unit = float(m[1]), m[2].lower()
            # Ambiguous multipacks must be reviewed, never priced as one bottle.
            if quantity and not re.search(r'\b\d+\s*[x×]|[x×]\s*\d+|pack of', size, re.I):
                quantity *= .001 if unit in ('ml', 'g') else 1
                out['unit_price'] = round(out['price'] / quantity, 2)
                out['unit_price_unit'] = 'AED/kg' if unit in ('g', 'kg') else 'AED/L'
    if any(k in out for k in ('eta', 'delivery_fee', 'store_id', 'merchant_id')):
        eta = str(out.get('eta') or '')
        nums = re.findall(r'\d+(?:\.\d+)?', eta)
        unit = 60 if re.search(r'\bh(?:ou)?rs?\b|hour', eta, re.I) else 1
        valid = bool(nums) and (re.search(r'min|hour|\bhr', eta, re.I) or eta.isdecimal())
        out.setdefault('eta_minutes', max(float(n) for n in nums[:2]) * unit if valid else None)
        out.setdefault('delivery_fee', None)
        out.setdefault('min_order', None)
        out.setdefault('status', 'unknown')
    return out


def rows(value):
    if isinstance(value, dict):
        if value.get('image_url'):
            yield value
        for v in value.values():
            yield from rows(v)
    elif isinstance(value, list):
        for v in value:
            yield from rows(v)


def download(data, directory):
    dest = Path(directory).expanduser().resolve()
    dest.mkdir(parents=True, exist_ok=True)
    grouped = {}
    for row in rows(data):
        grouped.setdefault(row['image_url'], []).append(row)
    def one(pair):
        url, refs = pair
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'CatalogImages/1.0'})
            with urllib.request.urlopen(req, timeout=12) as response:
                kind = response.headers.get_content_type()
                if not kind.startswith('image/'):
                    raise ValueError('not_image')
                content = response.read(8 * 1024 * 1024 + 1)
                if len(content) > 8 * 1024 * 1024:
                    raise ValueError('too_large')
                suffix = {'image/png': '.png', 'image/webp': '.webp'}.get(kind, '.jpg')
                path = dest / (hashlib.sha256(url.encode()).hexdigest()[:20] + suffix)
                path.write_bytes(content)
                for row in refs:
                    row['image_path'] = str(path)
                    row['image_http_status'] = response.status
        except Exception:
            for row in refs:
                row['image_download_error'] = 'IMAGE_UNAVAILABLE'
    with cf.ThreadPoolExecutor(12) as pool:
        list(pool.map(one, grouped.items()))
    return data


if __name__ == '__main__':
    result = normalize(json.load(sys.stdin))
    if len(sys.argv) > 1:
        download(result, sys.argv[1])
    print(json.dumps(result))
