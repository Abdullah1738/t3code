import base64
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import urllib.error
import zlib

SCRIPT = Path(__file__).resolve().parents[1] / 'libexec/image-generation/genimg.py'
def png_chunk(kind, data):
    return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))


PNG = (b'\x89PNG\r\n\x1a\n'
       + png_chunk(b'IHDR', struct.pack('!2I5B', 8, 8, 8, 2, 0, 0, 0))
       + png_chunk(b'IDAT', zlib.compress((b'\0' + b'\xff\0\0' * 8) * 8))
       + png_chunk(b'IEND', b''))
KEY = 'sk-or-v1-fixture-never-print-this-key'


def response(data):
    return io.BytesIO(json.dumps(data).encode())


def router_response():
    return response({'data': [{'b64_json': base64.b64encode(PNG).decode()}]})


def paid_response(content=PNG, mime='image/png'):
    return response({'choices': [{'message': {'images': [{'image_url': {
        'url': 'data:{};base64,{}'.format(mime, base64.b64encode(content).decode())
    }}]}}]})


def http_error(code, body=b'upstream broken'):
    return urllib.error.HTTPError('http://localhost:20128', code, 'bad gateway', {}, io.BytesIO(body))


class GenimgTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='genimg-test-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.key = self.root / 'openrouter-key'
        self.key.write_text(KEY + '\n')
        self.out = self.root / 'out.png'
        logger = types.ModuleType('toollog')
        logger.emit = lambda *_a, **_kw: None
        spec = importlib.util.spec_from_file_location('genimg_test_subject', SCRIPT)
        self.script = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {'toollog': logger}):
            spec.loader.exec_module(self.script)
        self.script.KEY_FILE = self.key

    def run_cli(self, responses=(), args=(), env=None, out=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, {'GENIMG_ROUTE': 'auto', 'GENIMG_NO_FALLBACK': '0', 'GENIMG_9ROUTER_URL': 'http://localhost:20128/v1/images/generations', **(env or {})}), \
                patch.object(sys, 'argv', [str(SCRIPT), 'test prompt', str(out or self.out), *args]), \
                patch('urllib.request.urlopen', side_effect=responses) as opener, \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                code = self.script.main()
            except SystemExit as error:
                code = error.code
        self.assertNotIn(KEY, stdout.getvalue() + stderr.getvalue())
        self.assertNotIn('Traceback', stderr.getvalue())
        return code, stdout.getvalue(), stderr.getvalue(), opener.call_args_list

    def test_router_success_never_reads_key(self):
        self.key.unlink()
        code, out, err, calls = self.run_cli([router_response()])
        self.assertEqual(code, 0)
        self.assertEqual(out, str(self.out) + '\n')
        self.assertEqual(err, 'genimg: route=9router cx/gpt-image-2\n')
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.out.read_bytes(), PNG)
        req = calls[0].args[0]
        self.assertEqual(req.full_url, 'http://localhost:20128/v1/images/generations')
        self.assertIs(json.loads(req.data)['stream'], False)
        self.assertEqual(calls[0].kwargs['timeout'], 300)

    def test_http_errors_fall_back(self):
        for status in (400, 401, 429, 502):
            with self.subTest(status=status):
                code, out, err, calls = self.run_cli([http_error(status), paid_response()])
                self.assertEqual(code, 0)
                self.assertEqual(out, str(self.out) + '\n')
                self.assertEqual(self.out.read_bytes(), PNG)
                self.assertEqual(len(calls), 2)
                self.assertIn('9router failed ({}: upstream broken); route=openrouter'.format(status), err)
                self.assertIn('(paid)', err)
                self.assertEqual(len(err.splitlines()), 1)

    def test_network_timeout_json_and_empty_responses_fall_back(self):
        cases = [
            ('URLError', urllib.error.URLError('connection refused')),
            ('ConnectionRefusedError', ConnectionRefusedError('down')),
            (type(socket.timeout()).__name__, socket.timeout('timed out')),
            ('JSONDecodeError', io.BytesIO(b'invalid json')),
            ('ValueError', response({'data': []})),
            ('ValueError', response({'data': [{}]})),
            ('ValueError', response({'data': [{'b64_json': ''}]})),
            ('ValueError', response(None)),
            ('Error', response({'data': [{'b64_json': 'not base64'}]})),
        ]
        for reason, first in cases:
            with self.subTest(reason=reason, first=first):
                code, out, err, calls = self.run_cli([first, paid_response()])
                self.assertEqual(code, 0)
                self.assertEqual(len(calls), 2)
                self.assertIn('9router failed ({}:'.format(reason), err)
                self.assertEqual(self.out.read_bytes(), PNG)

    def test_router_only_and_no_fallback_override(self):
        for args, env in [
            (['--route', '9router'], {}),
            ([], {'GENIMG_NO_FALLBACK': '1'}),
            (['--route', 'openrouter'], {'GENIMG_NO_FALLBACK': '1'}),
            ([], {'GENIMG_ROUTE': 'openrouter', 'GENIMG_NO_FALLBACK': '1'}),
        ]:
            with self.subTest(args=args, env=env):
                code, out, err, calls = self.run_cli([http_error(502)], args, env)
                self.assertEqual(code, 1)
                self.assertEqual(out, '')
                self.assertEqual(len(calls), 1)
                self.assertIn('error 502: upstream broken', err)
                self.assertNotIn('route=openrouter', err)
                self.assertIn('localhost:20128', calls[0].args[0].full_url)

    def test_explicit_openrouter_request_shape(self):
        code, out, err, calls = self.run_cli([paid_response()], ['--route', 'openrouter'])
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 1)
        req = calls[0].args[0]
        self.assertEqual(req.full_url, 'https://openrouter.ai/api/v1/chat/completions')
        self.assertEqual(req.get_header('Authorization'), 'Bearer ' + KEY)
        self.assertEqual(req.get_header('X-title'), 'genimg')
        self.assertEqual(req.get_header('Content-type'), 'application/json')
        self.assertEqual(json.loads(req.data), {
            'model': 'openai/gpt-5.4-image-2',
            'messages': [{'role': 'user', 'content': 'test prompt\nImage size 1024x1024.'}],
            'modalities': ['image', 'text'],
        })
        self.assertEqual(calls[0].kwargs['timeout'], 300)
        self.assertEqual(err, 'genimg: route=openrouter openai/gpt-5.4-image-2 (paid)\n')

    def test_sizes_in_prompt_when_model_support_is_unadvertised(self):
        for size in ('1024x1024', '1536x1024', '1024x1536', '800x600'):
            with self.subTest(size=size):
                code, out, err, calls = self.run_cli([paid_response()], ['--route', 'openrouter', '--size', size])
                self.assertEqual(code, 0)
                body = json.loads(calls[0].args[0].data)
                self.assertNotIn('image_config', body)
                self.assertTrue(body['messages'][0]['content'].endswith('Image size {}.'.format(size)))

    def test_route_env_and_cli_precedence(self):
        for args, env, expected in [
            ([], {'GENIMG_ROUTE': 'openrouter'}, 'openrouter.ai'),
            (['--route', '9router'], {'GENIMG_ROUTE': 'openrouter'}, 'localhost:20128'),
            (['--route', 'openrouter'], {'GENIMG_ROUTE': 'invalid'}, 'openrouter.ai'),
        ]:
            with self.subTest(args=args, env=env):
                code, out, err, calls = self.run_cli([paid_response() if expected == 'openrouter.ai' else router_response()], args, env)
                self.assertEqual(code, 0)
                self.assertIn(expected, calls[0].args[0].full_url)

    def test_n_two_paid_requests_and_numbered_files(self):
        code, out, err, calls = self.run_cli([paid_response(), paid_response()], ['--route', 'openrouter', '--n', '2'])
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 2)
        self.assertEqual(out.splitlines(), [str(self.out), str(self.root / 'out-2.png')])
        self.assertEqual((self.root / 'out-2.png').read_bytes(), PNG)
        self.assertEqual(len(err.splitlines()), 1)

    def test_paid_results_survive_later_request_failures(self):
        failures = [
            ('http_502', lambda: http_error(502)),
            ('http_429', lambda: http_error(429)),
            ('url_error', lambda: urllib.error.URLError('down')),
            ('timeout', lambda: socket.timeout('timed out')),
            ('invalid_json', lambda: io.BytesIO(b'invalid json')),
            ('missing_image', lambda: response({'choices': [{'message': {'images': []}}]})),
            ('invalid_base64', lambda: response({
                'choices': [{'message': {'images': [{'image_url': {
                    'url': 'data:image/png;base64,???'
                }}]}}]
            })),
        ]
        for route in ('openrouter', 'auto'):
            for failed_request in (2, 3):
                for label, failure in failures:
                    with self.subTest(route=route, failed_request=failed_request, failure=label):
                        output = self.root / '{}-{}-{}.png'.format(route, failed_request, label)
                        paid_calls = []
                        def opener(req, **_kwargs):
                            if req.full_url.startswith('http://localhost:20128'):
                                raise http_error(502)
                            # Every earlier result must be on disk before the next charge.
                            for path in self.script.output_paths(str(output), len(paid_calls)):
                                self.assertEqual(Path(path).read_bytes(), PNG)
                            paid_calls.append(req)
                            if len(paid_calls) == failed_request:
                                result = failure()
                                if isinstance(result, Exception):
                                    raise result
                                return result
                            return paid_response()
                        code, out, err, calls = self.run_cli(opener, ['--route', route, '--n', '3'], out=output)
                        self.assertEqual(code, 1)
                        self.assertEqual(len(paid_calls), failed_request)
                        self.assertEqual(len(calls), failed_request + (route == 'auto'))
                        paths = self.script.output_paths(str(output), 3)
                        self.assertEqual(out.splitlines(), paths[:failed_request - 1])
                        for path in paths[:failed_request - 1]:
                            self.assertEqual(Path(path).read_bytes(), PNG)
                        self.assertFalse(Path(paths[failed_request - 1]).exists())
                        self.assertIn('OpenRouter failed', err)
                        self.assertIn('wrote {} of 3 images'.format(failed_request - 1), err)
                        self.assertEqual(len(err.splitlines()), 1)

    def test_paid_second_request_502_keeps_first_png(self):
        code, out, err, calls = self.run_cli([paid_response(), http_error(502)], ['--route', 'openrouter', '--n', '2'])
        self.assertEqual(code, 1)
        self.assertEqual(self.out.read_bytes(), PNG)
        self.assertFalse((self.root / 'out-2.png').exists())
        self.assertEqual(out, str(self.out) + '\n')
        self.assertEqual(len(calls), 2)
        self.assertIn('wrote 1 of 2 images', err)

    def test_router_url_override(self):
        url = 'http://127.0.0.1:1/v1/images/generations'
        code, out, err, calls = self.run_cli([urllib.error.URLError('down'), paid_response()], env={'GENIMG_9ROUTER_URL': url})
        self.assertEqual(code, 0)
        self.assertEqual(calls[0].args[0].full_url, url)
        self.assertEqual(calls[1].args[0].full_url, 'https://openrouter.ai/api/v1/chat/completions')
        self.assertIn('9router failed', err)

    def test_invalid_router_url_never_activates_paid_fallback(self):
        cases = [
            ('empty', ''),
            ('whitespace', '   '),
            ('relative', '/v1/images/generations'),
            ('no_scheme', 'localhost:20128/v1/images/generations'),
            ('unsupported_scheme', 'file:///tmp/image'),
            ('no_host', 'http:///v1/images/generations'),
            ('space_in_host', 'http://local host/images'),
            ('encoded_space_in_host', 'http://local%20host:20128/images'),
            ('encoded_newline_in_host', 'http://local%0ahost:20128/images'),
            ('encoded_del_in_host', 'http://local%7fhost:20128/images'),
            ('encoded_invalid_port', 'http://localhost%3Aabc/images'),
            ('encoded_host_separator', 'http://local%2fhost/images'),
            ('encoded_credentials', 'http://user%40localhost/images'),
            ('unescaped_unicode_path', 'http://localhost/é'),
            ('unicode_host', 'http://例え.テスト/images'),
            ('encoded_unicode_host', 'http://%E4%BE%8B%E3%81%88.example/images'),
            ('invalid_idna_host', 'http://' + 'a' * 64 + '.example/images'),
            ('control_in_path', 'http://localhost/images\x01'),
            ('delete_in_path', 'http://localhost/images\x7f'),
            ('invalid_port', 'http://localhost:abc/images'),
            ('port_too_high', 'http://localhost:65536/images'),
            ('zero_port', 'http://localhost:0/images'),
            ('unbalanced_ipv6', 'http://[::1/images'),
            ('credentials', 'http://user:' + KEY + '@localhost/images'),
            ('fragment', 'http://localhost/images#fragment'),
        ]
        for route in ('auto', '9router'):
            for label, url in cases:
                with self.subTest(route=route, case=label):
                    code, out, err, calls = self.run_cli([], ['--route', route], {'GENIMG_9ROUTER_URL': url})
                    self.assertEqual(code, 1)
                    self.assertEqual(out, '')
                    self.assertEqual(len(calls), 0)
                    self.assertIn('invalid GENIMG_9ROUTER_URL', err)
        for url in ('http://localhost:20128/images', 'https://router.example/images', 'http://[::1]:20128/images', 'http://%6cocalhost:20128/images'):
            with self.subTest(valid_url=url):
                code, out, err, calls = self.run_cli([router_response()], env={'GENIMG_9ROUTER_URL': url})
                self.assertEqual(code, 0)
                self.assertEqual(calls[0].args[0].full_url, url)

    def test_request_callback_does_not_fallback_on_invalid_url(self):
        for url in ('', 'http://local%20host:20128/images', 'http://localhost%3Aabc/images', 'http://例え.テスト/images'):
            with self.subTest(url=url):
                with patch.dict(os.environ, {'GENIMG_9ROUTER_URL': url}), \
                        patch('urllib.request.urlopen') as opener, patch.object(self.script, 'openrouter_images') as fallback:
                    with self.assertRaisesRegex(ValueError, 'invalid GENIMG_9ROUTER_URL'):
                        self.script.request_image('cx/gpt-image-2', '1024x1024', 'test', 1, opener=opener, fallback=fallback)
                opener.assert_not_called()
                fallback.assert_not_called()

    def test_router_partial_batch_only_generates_missing_images(self):
        for label, tail in [
            ('missing', []),
            ('empty', [{}]),
            ('invalid_base64', [{'b64_json': '???'}]),
            ('url_error', [{'url': 'https://images.example/out.png'}]),
        ]:
            with self.subTest(label=label):
                output = self.root / (label + '.png')
                paths = self.script.output_paths(str(output), 3)
                data = {'data': [{'b64_json': base64.b64encode(PNG).decode()}] + tail}
                paid_calls = []
                def opener(req, **_kwargs):
                    if isinstance(req, str):
                        raise urllib.error.URLError('download failed')
                    if req.full_url.startswith('http://localhost:20128'):
                        self.assertEqual(json.loads(req.data)['n'], 3)
                        return response(data)
                    for path in paths[:len(paid_calls) + 1]:
                        self.assertEqual(Path(path).read_bytes(), PNG)
                    paid_calls.append(req)
                    return paid_response()
                code, out, err, calls = self.run_cli(opener, ['--n', '3'], out=output)
                self.assertEqual(code, 0)
                self.assertEqual(len(paid_calls), 2)
                self.assertEqual(out.splitlines(), paths)
                for path in paths:
                    self.assertEqual(Path(path).read_bytes(), PNG)
                self.assertIn('route=openrouter', err)

    def test_router_partial_batch_free_only_keeps_output(self):
        code, out, err, calls = self.run_cli([router_response()], ['--route', '9router', '--n', '2'])
        self.assertEqual(code, 1)
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.out.read_bytes(), PNG)
        self.assertEqual(out, str(self.out) + '\n')
        self.assertIn('wrote 1 of 2 images', err)

    def test_router_keeps_valid_images_after_invalid_entries(self):
        valid = {'b64_json': base64.b64encode(PNG).decode()}
        data = {'data': [valid, {'b64_json': '???'}, valid]}
        code, out, err, calls = self.run_cli([response(data), paid_response()], ['--n', '3'])
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 2)
        paths = self.script.output_paths(str(self.out), 3)
        self.assertEqual(out.splitlines(), paths)
        for path in paths:
            self.assertEqual(Path(path).read_bytes(), PNG)

    def test_mixed_batch_keeps_free_and_paid_results_on_later_failure(self):
        code, out, err, calls = self.run_cli([router_response(), paid_response(), http_error(502)], ['--n', '3'])
        self.assertEqual(code, 1)
        paths = self.script.output_paths(str(self.out), 3)
        self.assertEqual(out.splitlines(), paths[:2])
        for path in paths[:2]:
            self.assertEqual(Path(path).read_bytes(), PNG)
        self.assertFalse(Path(paths[2]).exists())
        self.assertEqual(len(calls), 3)
        self.assertIn('9router failed', err)
        self.assertIn('OpenRouter failed', err)
        self.assertIn('wrote 2 of 3 images', err)

    def test_router_batch_write_failure_stops_without_paid_request(self):
        data = {'data': [{'b64_json': base64.b64encode(PNG).decode()} for _ in range(3)]}
        original = Path.write_bytes
        def write(path, content):
            if path.name == 'out-2.png':
                raise PermissionError('disk full')
            return original(path, content)
        with patch.object(Path, 'write_bytes', write):
            code, out, err, calls = self.run_cli([response(data)], ['--n', '3'])
        self.assertEqual(code, 1)
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.out.read_bytes(), PNG)
        self.assertEqual(out, str(self.out) + '\n')
        self.assertFalse((self.root / 'out-3.png').exists())
        self.assertNotIn('openrouter', err)
        self.assertIn('wrote 1 of 3 images', err)

    def test_paid_write_failure_stops_before_next_request(self):
        for route in ('openrouter', 'auto'):
            for failed_write in (1, 2):
                with self.subTest(route=route, failed_write=failed_write):
                    output = self.root / '{}-write-{}.png'.format(route, failed_write)
                    paths = self.script.output_paths(str(output), 3)
                    original = Path.write_bytes
                    def write(path, data):
                        if str(path) == paths[failed_write - 1]:
                            raise PermissionError('disk full')
                        return original(path, data)
                    responses = ([http_error(502)] if route == 'auto' else []) + [paid_response() for _ in range(3)]
                    with patch.object(Path, 'write_bytes', write):
                        code, out, err, calls = self.run_cli(responses, ['--route', route, '--n', '3'], out=output)
                    self.assertEqual(code, 1)
                    self.assertEqual(len(calls), failed_write + (route == 'auto'))
                    self.assertEqual(out.splitlines(), paths[:failed_write - 1])
                    for path in paths[:failed_write - 1]:
                        self.assertEqual(Path(path).read_bytes(), PNG)
                    self.assertFalse(Path(paths[failed_write - 1]).exists())
                    self.assertIn('write_failed', err)
                    self.assertEqual(len(err.splitlines()), 1)

    def test_paid_conversion_failure_stops_before_next_request(self):
        for route in ('openrouter', 'auto'):
            for failed_conversion in (1, 2):
                with self.subTest(route=route, failed_conversion=failed_conversion):
                    output = self.root / '{}-conversion-{}.png'.format(route, failed_conversion)
                    responses = ([http_error(502)] if route == 'auto' else []) + [
                        paid_response() for _ in range(failed_conversion - 1)
                    ] + [paid_response(b'jpeg bytes', 'image/jpeg'), paid_response()]
                    with patch('subprocess.run', return_value=subprocess.CompletedProcess(['sips'], 1, b'', b'')):
                        code, out, err, calls = self.run_cli(responses, ['--route', route, '--n', '3'], out=output)
                    self.assertEqual(code, 1)
                    self.assertEqual(len(calls), failed_conversion + (route == 'auto'))
                    paths = self.script.output_paths(str(output), 3)
                    self.assertEqual(out.splitlines(), paths[:failed_conversion - 1])
                    for path in paths[:failed_conversion - 1]:
                        self.assertEqual(Path(path).read_bytes(), PNG)
                    self.assertFalse(Path(paths[failed_conversion - 1]).exists())
                    self.assertIn('write_failed', err)
                    self.assertEqual(len(err.splitlines()), 1)

    def test_stdout_preserves_supplied_relative_path(self):
        old_cwd = os.getcwd()
        try:
            os.chdir(str(self.root))
            code, out, err, calls = self.run_cli([router_response()], out='./relative.png')
        finally:
            os.chdir(old_cwd)
        self.assertEqual(code, 0)
        self.assertEqual(out, './relative.png\n')
        self.assertEqual((self.root / 'relative.png').read_bytes(), PNG)

    def test_missing_empty_and_malformed_key_no_traceback(self):
        for value in (None, '', 'two tokens'):
            with self.subTest(value=value):
                if value is None:
                    self.key.unlink()
                else:
                    self.key.write_text(value)
                code, out, err, calls = self.run_cli([], ['--route', 'openrouter'])
                self.assertEqual(code, 1)
                self.assertEqual(len(calls), 0)
                self.assertEqual(out, '')
                self.assertIn(str(self.key), err)
                self.assertIn('OpenRouter key', err)

    def test_both_fail_one_stderr_line_no_secret(self):
        code, out, err, calls = self.run_cli([
            http_error(502, ('bad\n' + KEY + ' ' + 'x' * 200).encode()),
            http_error(401, ('Authorization Bearer ' + KEY).encode()),
        ])
        self.assertEqual(code, 1)
        self.assertEqual(out, '')
        self.assertEqual(len(calls), 2)
        self.assertEqual(len(err.splitlines()), 1)
        self.assertIn('9router failed (502:', err)
        self.assertIn('OpenRouter failed (401:', err)
        self.assertIn('[redacted]', err)

    def test_unprefixed_key_is_also_redacted(self):
        secret = 'fixture-secret-without-prefix'
        self.key.write_text(secret)
        code, out, err, calls = self.run_cli([http_error(401, secret.encode())], ['--route', 'openrouter'])
        self.assertEqual(code, 1)
        self.assertNotIn(secret, out + err)

    def test_remote_url_image_download_and_failure(self):
        first = lambda: response({'data': [{'url': 'https://images.example/out.png'}]})
        code, out, err, calls = self.run_cli([first(), io.BytesIO(PNG)])
        self.assertEqual(code, 0)
        self.assertEqual(self.out.read_bytes(), PNG)
        self.assertEqual(calls[1].kwargs['timeout'], 300)
        code, out, err, calls = self.run_cli([first(), urllib.error.URLError('download failed'), paid_response()])
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 3)
        self.assertIn('route=openrouter', err)

    def test_invalid_local_inputs_never_call_provider(self):
        cases = [
            (['--n', '0'], {}, self.out),
            (['--n', '-1'], {}, self.out),
            (['--n', 'bad'], {}, self.out),
            (['--size', 'broken'], {}, self.out),
            (['--size', '0x1024'], {}, self.out),
            ([], {'GENIMG_ROUTE': 'invalid'}, self.out),
            ([], {}, self.root / 'missing' / 'out.png'),
            (['--route', 'openrouter'], {}, self.root),
        ]
        for args, env, outpath in cases:
            with self.subTest(args=args, env=env, outpath=outpath):
                code, out, err, calls = self.run_cli([], args, env, outpath)
                self.assertNotEqual(code, 0)
                self.assertEqual(out, '')
                self.assertEqual(len(calls), 0)

    def test_write_failure_after_router_success_never_falls_back(self):
        with patch.object(Path, 'write_bytes', side_effect=PermissionError('read only')):
            code, out, err, calls = self.run_cli([router_response()])
        self.assertEqual(code, 1)
        self.assertEqual(len(calls), 1)
        self.assertEqual(out, '')
        self.assertIn('write_failed', err)
        self.assertNotIn('openrouter', err)

    def test_existing_output_not_truncated_on_failure(self):
        self.out.write_bytes(b'old image')
        code, out, err, calls = self.run_cli([http_error(502)], ['--route', '9router'])
        self.assertEqual(code, 1)
        self.assertEqual(self.out.read_bytes(), b'old image')

    def test_malformed_paid_responses_do_not_retry(self):
        responses = [
            b'invalid json',
            json.dumps({'choices': []}).encode(),
            json.dumps({'choices': [{'message': {'images': []}}]}).encode(),
            json.dumps({'choices': [{'message': {'images': [{'image_url': {'url': 'https://wrong'}}]}}]}).encode(),
            json.dumps({'choices': [{'message': {'images': [{'image_url': {'url': 'data:image/png;base64,???'}}]}}]}).encode(),
        ]
        for data in responses:
            with self.subTest(data=data):
                code, out, err, calls = self.run_cli([io.BytesIO(data)], ['--route', 'openrouter'])
                self.assertEqual(code, 1)
                self.assertEqual(len(calls), 1)
                self.assertEqual(out, '')
                self.assertIn('OpenRouter failed', err)

    @unittest.skipUnless(shutil.which('sips'), 'sips is macOS only')
    def test_jpeg_response_is_really_converted_to_png(self):
        source, jpeg = self.root / 'source.png', self.root / 'source.jpg'
        source.write_bytes(PNG)
        subprocess.run(['sips', '-s', 'format', 'jpeg', str(source), '--out', str(jpeg)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        code, out, err, calls = self.run_cli([paid_response(jpeg.read_bytes(), 'image/jpeg')], ['--route', 'openrouter'])
        self.assertEqual(code, 0, err)
        self.assertTrue(self.out.read_bytes().startswith(b'\x89PNG\r\n\x1a\n'))
        self.assertEqual(out, str(self.out) + '\n')
        self.assertEqual(len(err.splitlines()), 1)

    def test_conversion_failure_keeps_stdout_empty(self):
        with patch('subprocess.run', return_value=subprocess.CompletedProcess(['sips'], 1, b'noisy stdout', b'noisy stderr')):
            code, out, err, calls = self.run_cli([paid_response(b'jpeg bytes', 'image/jpeg')], ['--route', 'openrouter'])
        self.assertEqual(code, 1)
        self.assertEqual(len(calls), 1)
        self.assertEqual(out, '')
        self.assertNotIn('noisy', err)
        self.assertIn('write_failed', err)

    def test_legacy_request_callback_and_logging_privacy(self):
        events = []
        self.script.emit = lambda *args, **kwargs: events.append((args, kwargs))
        def fail(*_args, **_kwargs):
            raise http_error(502, ('not_entitled ' + KEY).encode())
        data = self.script.request_image('cx/gpt-image-2', '1024x1024', 'private prompt', 1, fail, lambda *_: {'data': [1]})
        self.assertEqual(data, {'data': [1]})
        self.assertIn('img.fallback.result', str(events))
        self.assertNotIn(KEY, str(events))
        self.assertNotIn('private prompt', str(events))


if __name__ == '__main__':
    unittest.main()
