"""Exercise request metrics over HTTP with the same MCP SDK as the services."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'shared'))
import request_log
import serve


class RequestMetrics(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {'TOOLLOG_ROOT': self.temp.name})
        self.env.start()

    async def asyncTearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def rows(self):
        day = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        return list(request_log.toollog.read('agent-tools', day, name='mcp.request'))

    @asynccontextmanager
    async def server(self, writer=None):
        import uvicorn
        from mcp.server.fastmcp import FastMCP
        mcp = FastMCP('metrics-fixture')
        loop = asyncio.get_running_loop()
        started = asyncio.Event()

        @mcp.tool()
        def slow(secret: str = '') -> str:
            loop.call_soon_threadsafe(started.set)
            time.sleep(3)
            return 'done'

        ready = asyncio.Event()

        class Server(uvicorn.Server):
            async def startup(self, sockets=None):
                await super().startup(sockets=sockets)
                ready.set()

        with ThreadPoolExecutor(max_workers=1) as pool, socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            serve.offload_sync_tools(mcp, pool)
            # Use the actual configure/run app factory, including SDK lifespan.
            serve.configure(mcp, sock.getsockname()[1], 'flighty')
            app = mcp.streamable_http_app()
            if writer is not None:
                app.user_middleware[0].kwargs['writer'] = writer
            server = Server(uvicorn.Config(app, log_level='error', lifespan='on'))
            task = asyncio.create_task(server.serve(sockets=[sock]))
            await asyncio.wait_for(ready.wait(), 10)
            logger = app.middleware_stack.app
            self.assertIsInstance(logger, request_log.RequestLogMiddleware)
            try:
                yield f'http://127.0.0.1:{sock.getsockname()[1]}/mcp', logger, started
            finally:
                server.should_exit = True
                await asyncio.wait_for(task, 10)
                await asyncio.to_thread(logger.worker.join, 2)
                self.assertFalse(logger.worker.is_alive())

    async def post(self, client, url, method, params=None):
        return await client.post(url, json={'jsonrpc': '2.0', 'id': 1, 'method': method,
                                           **({'params': params} if params is not None else {})},
                                 headers={'Accept': 'application/json, text/event-stream'})

    async def test_slow_tool_does_not_block_list_and_each_request_logs_once(self):
        import httpx
        async with self.server() as (url, logger, started), httpx.AsyncClient(timeout=10) as client:
            slow = asyncio.create_task(self.post(client, url, 'tools/call',
                                                {'name': 'slow', 'arguments': {'secret': 'DO_NOT_LOG'}}))
            await asyncio.wait_for(started.wait(), 5)
            begin = time.perf_counter()
            response = await self.post(client, url, 'tools/list')
            latency = time.perf_counter() - begin
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['result']['tools'][0]['name'], 'slow')
            self.assertLess(latency, .5)
            self.assertFalse(slow.done())
            self.assertEqual((await slow).status_code, 200)
            await asyncio.wait_for(asyncio.to_thread(logger.pending.join), 3)
            rows = self.rows()
            self.assertEqual(len(rows), 2)
            self.assertNotIn('DO_NOT_LOG', json.dumps(rows))
            self.assertNotIn('arguments', json.dumps(rows))
            self.assertEqual({r['props']['method'] for r in rows}, {'tools/list', 'tools/call'})
            call = next(r for r in rows if r['props']['method'] == 'tools/call')
            self.assertEqual(call['props']['toolName'], 'slow')
            self.assertGreaterEqual(call['durationMs'], 2900)
            self.assertTrue(all(k in call['props'] for k in ('load1', 'load5', 'load15')))
            listing = next(r for r in rows if r['props']['method'] == 'tools/list')
            self.assertNotIn('load1', listing['props'])
            for row in rows:
                self.assertEqual(row['ids']['serverId'], 'flighty')
                self.assertEqual(row['props']['status'], 200)
                print('TOOLLOG_SAMPLE ' + json.dumps(row), file=sys.__stdout__)
            print(f'tools/list concurrent latency: {latency * 1000:.3f} ms', file=sys.__stdout__)

    async def test_unwritable_log_directory_still_returns_200(self):
        import httpx
        # A file as the root is unwritable as a directory, including under root.
        blocked = Path(self.temp.name) / 'not-a-directory'
        blocked.touch()
        with patch.dict(os.environ, {'TOOLLOG_ROOT': str(blocked)}):
            async with self.server() as (url, logger, _), httpx.AsyncClient() as client:
                self.assertEqual((await self.post(client, url, 'tools/list')).status_code, 200)
                await asyncio.wait_for(asyncio.to_thread(logger.pending.join), 3)
        self.assertEqual(self.rows(), [])

    async def test_stuck_and_raising_writers_do_not_delay_responses(self):
        import httpx
        entered = threading.Event()
        release = threading.Event()

        def stuck(*args):
            entered.set()
            release.wait(10)
            raise OSError('DO_NOT_LOG')

        async with self.server(writer=stuck) as (url, logger, _), httpx.AsyncClient() as client:
            try:
                self.assertEqual((await self.post(client, url, 'tools/list')).status_code, 200)
                self.assertTrue(await asyncio.to_thread(entered.wait, 2))
                # Fill the queue without waiting for the blocked disk writer.
                for _ in range(70):
                    begin = time.perf_counter()
                    response = await self.post(client, url, 'tools/list')
                    self.assertEqual(response.status_code, 200)
                    self.assertLess(time.perf_counter() - begin, .5)
                self.assertLessEqual(logger.pending.qsize(), 64)
            finally:
                release.set()
                await asyncio.wait_for(asyncio.to_thread(logger.pending.join), 3)
        self.assertEqual(self.rows(), [])

    async def test_metadata_handles_bad_chunked_and_oversized_bodies(self):
        async def app(scope, receive, send):
            while (await receive()).get('more_body'):
                pass
            await send({'type': 'http.response.start', 'status': 200})
            await send({'type': 'http.response.body', 'body': b'ok'})

        logger = request_log.RequestLogMiddleware(app, 'inbody', {'slow'})
        cases = [
            (b'{', 'unknown', None),
            (b'[]', 'unknown', None),
            (b'{"method":{"secret":"DO_NOT_LOG"}}', 'unknown', None),
            (b'{"method":"DO_NOT_LOG"}', 'unknown', None),
            (b'{"method":"notifications/initialized"}', 'notifications/initialized', None),
            (b'{"method":"tools/call","params":null}', 'tools/call', None),
            (b'{"method":"tools/call","params":{"name":"DO_NOT_LOG"}}', 'tools/call', None),
            (b'{"method":"tools/call","params":{"name":"slow","arguments":{"secret":"DO_NOT_LOG"}}}', 'tools/call', 'slow'),
            (b' ' * 65537, 'unknown', None),
        ]
        try:
            for body, method, tool in cases:
                messages = iter([{'type': 'http.request', 'body': body[:12], 'more_body': True},
                                 {'type': 'http.request', 'body': body[12:], 'more_body': False}])
                async def receive():
                    return next(messages)
                async def send(message):
                    pass
                await logger({'type': 'http'}, receive, send)
            await asyncio.wait_for(asyncio.to_thread(logger.pending.join), 3)
            rows = self.rows()
            self.assertEqual(len(rows), len(cases))
            for row, (_, method, tool) in zip(rows, cases):
                self.assertEqual(row['props']['method'], method)
                self.assertEqual(row['props'].get('toolName'), tool)
            self.assertNotIn('DO_NOT_LOG', json.dumps(rows))
        finally:
            logger.closed.set()
            await asyncio.to_thread(logger.worker.join, 2)


if __name__ == '__main__':
    unittest.main()
