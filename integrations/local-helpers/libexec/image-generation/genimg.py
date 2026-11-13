#!/usr/bin/env python3
"""Generate an image via local 9router (Codex sub)."""
import argparse
import base64
import json
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request

try:
    source = Path(__file__).resolve().parents[3] / 'router-logging'
    sys.path.insert(0, str(source if source.is_dir() else Path.home() / '.local/share/router-logging'))
    from toollog import emit
except Exception:
    def emit(*_args, **_kwargs):
        pass


def error_tag(error):
    if isinstance(error, urllib.error.HTTPError):
        # Classify a known provider code in memory; never retain the response text.
        try:
            body = error.read(4096).lower()
        except Exception:
            body = b''
        return 'http_' + str(error.code) + ('_not_entitled' if b'not_entitled' in body else '')
    return 'image_failed'


def request_image(model, size, prompt, n, opener=urllib.request.urlopen, fallback=None):
    start = time.monotonic()
    fields = {'model': model, 'size': size, 'count': n}
    emit('image', 'img.request', props=fields)
    try:
        body = json.dumps(dict(model=model, prompt=prompt, size=size, n=n)).encode()
        req = urllib.request.Request('http://localhost:20128/v1/images/generations', body, {'content-type': 'application/json'})
        with opener(req, timeout=300) as response:
            data = json.load(response)
        if not data.get('data'):
            raise ValueError('no image returned')
        emit('image', 'img.result', kind='perf', ok=True, durationMs=(time.monotonic() - start) * 1000, props=fields)
        return data
    except Exception as error:
        tag = error_tag(error)
        emit('image', 'img.result', kind='error', ok=False, durationMs=(time.monotonic() - start) * 1000, props=fields, error={'tag': tag})
        # The CLI has no paid fallback. A caller that already owns an authorized
        # OpenRouter fallback may supply it; logging does not enable one.
        if fallback is None:
            raise RuntimeError(tag) from None
        fallback_start = time.monotonic()
        emit('image', 'img.fallback', props={**fields, 'tag': tag, 'source': 'openrouter'})
        try:
            result = fallback(model, size, prompt, n)
            emit('image', 'img.fallback.result', kind='perf', ok=True, durationMs=(time.monotonic() - fallback_start) * 1000)
            return result
        except Exception:
            emit('image', 'img.fallback.result', kind='error', ok=False, durationMs=(time.monotonic() - fallback_start) * 1000, error={'tag': 'fallback_failed'})
            raise RuntimeError('fallback_failed') from None


def main():
    p = argparse.ArgumentParser()
    p.add_argument('prompt')
    p.add_argument('out')
    p.add_argument('--size', default='1024x1024')
    p.add_argument('--model', default='cx/gpt-image-2')
    p.add_argument('--n', type=int, default=1)
    args = p.parse_args()
    try:
        data = request_image(args.model, args.size, args.prompt, args.n)
        outs = []
        start = time.monotonic()
        try:
            for i, item in enumerate(data['data']):
                path = args.out if i == 0 else args.out.replace('.png', '-%d.png' % (i + 1))
                if item.get('b64_json'):
                    Path(path).write_bytes(base64.b64decode(item['b64_json']))
                elif item.get('url'):
                    urllib.request.urlretrieve(item['url'], path)
                else:
                    raise ValueError('missing image')
                outs.append(path)
            emit('image', 'img.write', kind='perf', ok=True, durationMs=(time.monotonic() - start) * 1000, props={'count': len(outs)})
        except Exception:
            emit('image', 'img.write', kind='error', ok=False, durationMs=(time.monotonic() - start) * 1000, error={'tag': 'write_failed'})
            raise RuntimeError('write_failed') from None
        print('\n'.join(outs))
    except Exception as error:
        sys.exit(str(error))

if __name__ == '__main__':
    main()
