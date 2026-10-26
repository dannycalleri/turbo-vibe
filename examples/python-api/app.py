import json
import os
import signal
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    build_id = os.environ.get("BUILD_ID", "")
    greeting_set = bool(os.environ.get("EXAMPLE_GREETING"))

    def do_GET(self):
        if self.path.split("?")[0] != "/api/health":
            self.send_error(404)
            return
        body = json.dumps(
            {"build_id": self.build_id, "greeting_set": self.greeting_set}
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass


def serve(port):
    return ThreadingHTTPServer(("", port), Handler)


if __name__ == "__main__":
    # As the container's PID 1, Python would ignore SIGTERM, and Cloudflare waits 15 minutes before replacing it.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    serve(int(os.environ.get("PORT", "3000"))).serve_forever()
