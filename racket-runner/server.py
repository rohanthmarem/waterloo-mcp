"""Private per-user runner. No credentials, persistent mounts, or shell execution."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import selectors
import subprocess
import threading
import time

LANGUAGES = {"racket", "htdp/bsl", "htdp/bsl+", "htdp/isl", "htdp/isl+", "htdp/asl"}
LOCK = threading.Lock()
MAX_OUTPUT = 32768


def execute(payload):
    started = time.monotonic()
    proc = subprocess.Popen(
        ["racket", "/runner/evaluate.rkt"], stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env={"PATH": "/usr/bin:/bin", "HOME": "/tmp", "LANG": "C.UTF-8"},
        cwd="/tmp", start_new_session=True,
    )
    output = {"stdout": bytearray(), "stderr": bytearray()}
    reason = None
    try:
        proc.stdin.write(json.dumps(payload).encode())
        proc.stdin.close()
        with selectors.DefaultSelector() as streams:
            streams.register(proc.stdout, selectors.EVENT_READ, "stdout")
            streams.register(proc.stderr, selectors.EVENT_READ, "stderr")
            while streams.get_map():
                if time.monotonic() - started > 10:
                    reason = "RACKET_TIME_LIMIT"
                    break
                for key, _ in streams.select(0.1):
                    chunk = os.read(key.fileobj.fileno(), 4096)
                    if not chunk:
                        streams.unregister(key.fileobj)
                        continue
                    remaining = MAX_OUTPUT - sum(map(len, output.values()))
                    output[key.data].extend(chunk[:remaining])
                    if len(chunk) > remaining:
                        reason = "RACKET_OUTPUT_LIMIT"
                        break
                if reason:
                    break
        if not reason:
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                reason = "RACKET_TIME_LIMIT"
    finally:
        # Terminate the whole process group, including unexpected descendants.
        try:
            os.killpg(proc.pid, 9)
        except ProcessLookupError:
            pass
        proc.wait()
        proc.stdout.close()
        proc.stderr.close()
    return {"status": "error" if reason or proc.returncode else "completed",
            "code": reason or ({124: "RACKET_TIME_LIMIT", 125: "RACKET_MEMORY_LIMIT"}.get(proc.returncode, "RACKET_PROGRAM_ERROR" if proc.returncode else None)),
            "stdout": output["stdout"].decode("utf8", errors="replace"),
            "stderr": output["stderr"].decode("utf8", errors="replace"),
            "durationMs": round((time.monotonic() - started) * 1000)}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Do not log submitted code or output.

    def respond(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.respond(200 if self.path == "/health" else 404, {"ready": self.path == "/health", "busy": LOCK.locked()})

    def do_POST(self):
        self.connection.settimeout(5)
        if self.path != "/run":
            return self.respond(404, {"code": "NOT_FOUND"})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 65536:
                raise ValueError()
            value = json.loads(self.rfile.read(size))
            if set(value) != {"language", "code"} or value["language"] not in LANGUAGES:
                raise ValueError()
            if not isinstance(value["code"], str) or len(value["code"].encode()) > 32768:
                raise ValueError()
        except (ValueError, TypeError, TimeoutError):
            return self.respond(400, {"code": "INPUT_INVALID"})
        if not LOCK.acquire(blocking=False):
            return self.respond(503, {"code": "RACKET_BUSY"})
        try:
            self.respond(200, execute(value))
        except Exception:
            self.respond(503, {"code": "RACKET_UNAVAILABLE"})
        finally:
            LOCK.release()


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8010), Handler).serve_forever()
