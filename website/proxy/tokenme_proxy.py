#!/usr/bin/env python3
"""Local CORS proxy for TokenMe TTS. Key comes from the request Authorization header (never stored)."""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = 8765
UPSTREAM = "https://api.tokenme.limited/api/v1/audio/speech"


class Handler(BaseHTTPRequestHandler):
    server_version = "TokenMeProxy/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path == "/health":
            body = json.dumps({"ok": True, "version": "tokenme-proxy/1.0", "upstream": UPSTREAM}).encode()
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404)

    def do_POST(self):
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path != "/tts" and path != "/v1/audio/speech":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        auth = self.headers.get("Authorization") or ""
        if not auth.lower().startswith("bearer "):
            msg = b'{"error":"missing Authorization: Bearer <key>"}'
            self.send_response(401)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)
            return
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception:
            data = {}
        payload = {
            "model": data.get("model") or "paxa/paxa-tts-flash-v2",
            "input": (data.get("input") or data.get("text") or "")[:800],
            "voice": data.get("voice") or "mocha",
            "response_format": data.get("response_format") or "mp3",
        }
        if not payload["input"]:
            msg = b'{"error":"missing input"}'
            self.send_response(400)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)
            return
        req = urllib.request.Request(
            UPSTREAM,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": auth,
                "Content-Type": "application/json",
                "Accept": "audio/mpeg, application/json, */*",
                "User-Agent": "TwitchChatTTS-Proxy/1.0",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                audio = resp.read()
                ctype = resp.headers.get("Content-Type") or "audio/mpeg"
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(audio)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(audio)
        except urllib.error.HTTPError as e:
            err_body = e.read() or str(e.reason).encode()
            self.send_response(e.code)
            self._cors()
            self.send_header("Content-Type", e.headers.get("Content-Type") or "text/plain")
            self.send_header("Content-Length", str(len(err_body)))
            self.end_headers()
            self.wfile.write(err_body)
        except Exception as e:
            msg = str(e).encode("utf-8", errors="replace")
            self.send_response(502)
            self._cors()
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)


def main():
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"TokenMe TTS proxy on http://{HOST}:{PORT}")
    print("POST /tts  (Authorization: Bearer <TOKENME_API_KEY>)")
    print("GET  /health")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
        httpd.server_close()


if __name__ == "__main__":
    main()
