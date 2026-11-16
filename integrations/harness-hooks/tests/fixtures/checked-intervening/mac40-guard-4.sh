python3 -I - <<'PY'
from pathlib import Path
p=Path('integrations/dev-resource-janitor/tests/test_active_sessions.py');s=p.read_text();a=s.index('                if url.path == "/api/session/active":');b=s.index('                return self._send(404, {})',a);s=s[:b]+'''                if url.path.startswith("/api/session/"):
                    return self._send(200, {"data": {"directory": "/work/service"}})
'''+s[b:];s=s.replace('self.assertEqual(native, {"thread-root": "/Users/x/repo"})','self.assertEqual(native, {"ses_a": "/work/service", "thread:thread-root": "/Users/x/repo"})');p.write_text(s)
PY
python3 -m unittest discover -s integrations/dev-resource-janitor/tests -p 'test_*.py' -q