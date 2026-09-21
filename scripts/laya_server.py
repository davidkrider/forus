#!/usr/bin/env python3
"""Serve laya-mlx behind Jev's System One JSON contract.

Apple Silicon, Python 3.11+, macOS 14+. First run downloads the checkpoint.

    pip install laya-mlx
    python scripts/laya_server.py

Then point ForUs at http://127.0.0.1:8765/v1/systemone (the popup default).

Env:
    LAYA_PORT   default 8765
    LAYA_MODEL  default aac6fef/laya-mlx
    LAYA_DTYPE  float16 | float32  (default float16)
"""

from __future__ import annotations

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import laya_mlx as laya
except ImportError:
    sys.stderr.write("laya-mlx is not installed. Run: pip install laya-mlx\n")
    sys.exit(1)

PORT = int(os.environ.get("LAYA_PORT", "8765"))
MODEL = os.environ.get("LAYA_MODEL", "aac6fef/laya-mlx")
DTYPE = os.environ.get("LAYA_DTYPE", "float16")

print(f"laya: loading {MODEL} ({DTYPE})…", flush=True)
agent = laya.load(
    MODEL,
    dtype=DTYPE,
    batch_size=16,
    cache_prompts=True,
)
predict = getattr(agent, "system_one", None) or agent.predict
LOCK = threading.Lock()
print(f"laya: serving System One on http://127.0.0.1:{PORT}/v1/systemone", flush=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-headers", "content-type, authorization")
        self.send_header("access-control-allow-methods", "POST, GET, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802
        self._send(204, {})

    def do_GET(self):  # noqa: N802
        if self.path.rstrip("/") in ("/health", "/v1/health"):
            self._send(200, {"ok": True, "model": MODEL})
            return
        self._send(404, {"detail": "not found"})

    def do_POST(self):  # noqa: N802
        if self.path.rstrip("/") != "/v1/systemone":
            self._send(404, {"detail": "not found"})
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            state = req["state"]
            questions = req["questions"]
            with LOCK:
                result = predict(state, questions)
            answers = result["answers"] if isinstance(result, dict) and "answers" in result else result
            usage = result.get("usage") if isinstance(result, dict) else None
            self._send(
                200,
                {
                    "model": req.get("model") or MODEL,
                    "answers": answers,
                    "usage": usage or {"input_tokens": 0, "output_tokens": 0},
                },
            )
        except (KeyError, ValueError, TypeError) as exc:
            self._send(422, {"detail": f"{type(exc).__name__}: {exc}"})
        except Exception as exc:  # noqa: BLE001
            self._send(500, {"detail": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nlaya: stopped", flush=True)
