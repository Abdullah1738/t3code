#!/usr/bin/env python3
"""Generate images via 9router, with an optional paid OpenRouter fallback."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

try:
    source = Path(__file__).resolve().parents[3] / 'router-logging'
    sys.path.insert(0, str(source if source.is_dir() else Path.home() / '.local/share/router-logging'))
    from toollog import emit
except Exception:
    def emit(*_args, **_kwargs):
        pass

OPENROUTER_MODEL = 'openai/gpt-5.4-image-2'
KEY_FILE = Path.home() / '.config/opencode/openrouter-key'
_secrets = []


def safe_text(value):
    text = str(value)
    for secret in _secrets:
        text = text.replace(secret, '[redacted]')
    text = re.sub(r'sk-[A-Za-z0-9_-]+', '[redacted]', text)
    return ' '.join(text.split())


def error_tag(error, body=b''):
    if isinstance(error, urllib.error.HTTPError):
        return 'http_' + str(error.code) + ('_not_entitled' if b'not_entitled' in body.lower() else '')
    return 'image_failed'


class ImageFailure(RuntimeError):
    def __init__(self, error):
        self.tag = error_tag(error)
        if isinstance(error, urllib.error.HTTPError):
            try:
                with error:
                    body = error.read(4096)
            except Exception:
                body = b''
            self.tag = error_tag(error, body)
            detail = safe_text(body.decode(errors='replace'))
            self.reason = '{}: {}'.format(error.code, detail[:120])
            message = 'error {}: {}'.format(error.code, detail[:500])
        else:
            detail = safe_text(error) or self.tag
            self.reason = '{}: {}'.format(type(error).__name__, detail[:120])
            message = detail[:300]
        super().__init__(message)


def router_url():
    url = os.environ.get('GENIMG_9ROUTER_URL', 'http://localhost:20128/v1/images/generations')
    try:
        parsed = urllib.parse.urlsplit(url)
        # urllib unquotes the authority before HTTPConnection validates it.
        authority = urllib.parse.unquote(parsed.netloc)
        decoded = urllib.parse.urlsplit(parsed.scheme + '://' + authority)
        if (parsed.scheme not in ('http', 'https') or not decoded.hostname
                or decoded.netloc != authority
                or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in url + authority)
                or decoded.username is not None or decoded.password is not None or parsed.fragment
                or (decoded.port is not None and not 1 <= decoded.port <= 65535)):
            raise ValueError()
        request = urllib.request.Request(url)
        request.selector.encode('ascii')
        request.host.encode('ascii')
        decoded.hostname.encode('idna')
    except ValueError:
        raise ValueError('invalid GENIMG_9ROUTER_URL: expected an HTTP(S) URL without credentials') from None
    return url


def request_image(model, size, prompt, n, opener=None, fallback=None):
    # Configuration errors are local and must not activate paid fallback callbacks.
    url = router_url()
    start = time.monotonic()
    fields = {'model': model, 'size': size, 'count': n}
    emit('image', 'img.request', props=fields)
    try:
        body = json.dumps(dict(model=model, prompt=prompt, size=size, n=n, stream=False)).encode()
        req = urllib.request.Request(url, body, {'content-type': 'application/json'})
        with (opener or urllib.request.urlopen)(req, timeout=300) as response:
            data = json.load(response)
        if not isinstance(data, dict) or not data.get('data'):
            raise ValueError('no image returned')
        emit('image', 'img.result', kind='perf', ok=True, durationMs=(time.monotonic() - start) * 1000, props=fields)
        return data
    except Exception as error:
        failure = ImageFailure(error)
        emit('image', 'img.result', kind='error', ok=False, durationMs=(time.monotonic() - start) * 1000, props=fields, error={'tag': failure.tag})
        # Preserve the existing caller-supplied fallback API; the CLI routes below.
        if fallback is None:
            raise failure from None
        fallback_start = time.monotonic()
        emit('image', 'img.fallback', props={**fields, 'tag': failure.tag, 'source': 'openrouter'})
        try:
            result = fallback(model, size, prompt, n)
            emit('image', 'img.fallback.result', kind='perf', ok=True, durationMs=(time.monotonic() - fallback_start) * 1000)
            return result
        except Exception:
            emit('image', 'img.fallback.result', kind='error', ok=False, durationMs=(time.monotonic() - fallback_start) * 1000, error={'tag': 'fallback_failed'})
            raise RuntimeError('fallback_failed') from None


def router_images(data):
    items = data.get('data')
    if not isinstance(items, list):
        raise ImageFailure(ValueError('no image returned'))
    failure = None
    for item in items:
        try:
            if item.get('b64_json'):
                content = base64.b64decode(item['b64_json'], validate=True)
            elif item.get('url'):
                with urllib.request.urlopen(item['url'], timeout=300) as response:
                    content = response.read()
            else:
                continue
        except Exception as error:
            failure = ImageFailure(error)
            continue
        if content:
            yield content, 'image/png'
    if failure:
        raise failure


def openrouter_images(size, prompt, n):
    try:
        key = KEY_FILE.read_text(encoding='utf-8').strip()
    except OSError:
        raise RuntimeError('OpenRouter key missing or unreadable: {}'.format(KEY_FILE)) from None
    if not key:
        raise RuntimeError('OpenRouter key empty: {}'.format(KEY_FILE))
    _secrets.append(key)
    if any(c.isspace() for c in key):
        raise RuntimeError('OpenRouter key must be one token: {}'.format(KEY_FILE))
    # This model's current endpoint does not advertise image_config support.
    body = json.dumps({
        'model': OPENROUTER_MODEL,
        'messages': [{'role': 'user', 'content': prompt + '\nImage size {}.'.format(size)}],
        'modalities': ['image', 'text'],
    }).encode()
    for _ in range(n):
        req = urllib.request.Request('https://openrouter.ai/api/v1/chat/completions', body, {
            'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'X-Title': 'genimg',
        })
        try:
            with urllib.request.urlopen(req, timeout=300) as response:
                data = json.load(response)
            url = data['choices'][0]['message']['images'][0]['image_url']['url']
            match = re.fullmatch(r'data:(image/[A-Za-z0-9.+-]+);base64,(.+)', url, re.DOTALL)
            if not match:
                raise ValueError('no base64 image returned')
            content = base64.b64decode(match.group(2), validate=True)
            if not content:
                raise ValueError('no image returned')
            yield content, match.group(1).lower()
        except Exception as error:
            raise ImageFailure(error) from None


def output_paths(out, count):
    path = Path(out)
    return [out if i == 0 else str(path.with_name('{}-{}{}'.format(path.stem, i + 1, path.suffix))) for i in range(count)]


def check_output(paths):
    # Catch local errors before a paid request, without truncating existing files.
    for name in paths:
        path = Path(name)
        if path.exists():
            with path.open('ab'):
                pass
        with tempfile.TemporaryFile(dir=str(path.parent)):
            pass


def write_images(images, paths):
    start = time.monotonic()
    try:
        for (content, mime), path in zip(images, paths):
            if mime != 'image/png':
                with tempfile.TemporaryDirectory(prefix='genimg-') as directory:
                    suffix = mime.split('/')[1].split('+')[0]
                    source = Path(directory) / ('source.' + suffix)
                    converted = Path(directory) / 'out.png'
                    source.write_bytes(content)
                    result = subprocess.run(['sips', '-s', 'format', 'png', str(source), '--out', str(converted)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    if result.returncode != 0:
                        raise RuntimeError('sips PNG conversion failed')
                    content = converted.read_bytes()
            Path(path).write_bytes(content)
        emit('image', 'img.write', kind='perf', ok=True, durationMs=(time.monotonic() - start) * 1000, props={'count': len(paths)})
    except Exception:
        emit('image', 'img.write', kind='error', ok=False, durationMs=(time.monotonic() - start) * 1000, error={'tag': 'write_failed'})
        raise RuntimeError('write_failed') from None


def positive_int(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError('must be positive')
    return number


def main():
    p = argparse.ArgumentParser()
    p.add_argument('prompt')
    p.add_argument('out')
    p.add_argument('--size', default='1024x1024')
    p.add_argument('--model', default='cx/gpt-image-2')
    p.add_argument('--n', type=positive_int, default=1)
    p.add_argument('--route', choices=('auto', '9router', 'openrouter'), default=os.environ.get('GENIMG_ROUTE', 'auto'))
    args = p.parse_args()
    if args.route not in ('auto', '9router', 'openrouter'):
        p.error('invalid GENIMG_ROUTE: {}'.format(safe_text(args.route)))
    if not re.fullmatch(r'[1-9][0-9]*x[1-9][0-9]*', args.size):
        p.error('--size must be WxH with positive integers')
    route = '9router' if os.environ.get('GENIMG_NO_FALLBACK') == '1' else args.route
    line = None
    written = 0
    try:
        if route != 'openrouter':
            router_url()
        paths = output_paths(args.out, args.n)
        try:
            check_output(paths)
        except OSError:
            emit('image', 'img.write', kind='error', ok=False, error={'tag': 'write_failed'})
            raise RuntimeError('write_failed') from None
        router_failure = None
        if route != 'openrouter':
            line = 'genimg: route=9router {}'.format(args.model)
            try:
                for image in router_images(request_image(args.model, args.size, args.prompt, args.n)):
                    write_images([image], [paths[written]])
                    print(paths[written], flush=True)
                    written += 1
                    if written == args.n:
                        break
                if written < args.n:
                    message = 'no image returned' if not written else 'only {} of {} images returned'.format(written, args.n)
                    raise ImageFailure(ValueError(message))
            except ImageFailure as error:
                router_failure = error
                if route == '9router':
                    line = 'genimg: route=9router {}; {}'.format(args.model, error)
                    raise
        if route == 'openrouter' or router_failure is not None:
            line = 'genimg: {}route=openrouter {} (paid)'.format(
                '9router failed ({}); '.format(router_failure.reason) if router_failure else '', OPENROUTER_MODEL)
            start = time.monotonic()
            emit('image', 'img.fallback', props={'source': 'openrouter', 'model': OPENROUTER_MODEL, 'size': args.size, 'count': args.n - written})
            try:
                # Consume lazily: persist each paid result before the next request.
                for image in openrouter_images(args.size, args.prompt, args.n - written):
                    write_images([image], [paths[written]])
                    print(paths[written], flush=True)
                    written += 1
            except Exception as error:
                emit('image', 'img.fallback.result', kind='error', ok=False, durationMs=(time.monotonic() - start) * 1000, error={'tag': 'fallback_failed'})
                if str(error) != 'write_failed':
                    line += '; OpenRouter failed ({})'.format(error.reason if isinstance(error, ImageFailure) else error)
                raise
            emit('image', 'img.fallback.result', kind='perf', ok=True, durationMs=(time.monotonic() - start) * 1000)
    except Exception as error:
        if line:
            if str(error) == 'write_failed':
                line += '; write_failed'
            if written:
                line += '; wrote {} of {} images'.format(written, args.n)
            print(safe_text(line), file=sys.stderr)
        else:
            print(safe_text(error), file=sys.stderr)
        return 1
    print(safe_text(line), file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
