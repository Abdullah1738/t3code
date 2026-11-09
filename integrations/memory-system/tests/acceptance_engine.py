"""Adapter fixture bridge: real source-derived rules, no credentials or live stores."""
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from recall_engine import CheckEngine
from recall_classifier import deterministic
from test_recall_rules import RulesFixture


def evaluate(body):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        fixture = RulesFixture(root)
        index = fixture.index()

        def classifier(tool, arguments, **_kwargs):
            result = deterministic(tool, arguments)
            if result is None:
                raise AssertionError("fixture must not call Jev or another network model")
            return {"check": result, "p": float(result), "cost": 0, "latency_ms": 0, "classifier": "deterministic"}

        with patch.dict(os.environ, RECALL_DECISION_LOG=str(root / "decisions.jsonl")), \
             patch("recall_admission.cheap_note", return_value={"note": None, "sources": []}):
            # Transcript lookup itself is not part of this adapter test; source-derived
            # standing rules and conflict evaluation are the real shared implementation.
            result = CheckEngine(index.path, classifier=classifier).check(body)
        return result


if __name__ == "__main__":
    if sys.argv[1:] == ["--serve"]:
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                result = evaluate(json.loads(self.rfile.read(int(self.headers["Content-Length"])) ))
                data = json.dumps(result).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        print(json.dumps({"url": f"http://127.0.0.1:{server.server_port}"}), flush=True)
        server.serve_forever()
    else:
        print(json.dumps(evaluate(json.load(sys.stdin))))
