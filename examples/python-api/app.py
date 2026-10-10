import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    build_id = os.environ.get("BUILD_ID", "")

    def do_GET(self):
        if self.path.split("?")[0] != "/api/health":
            self.send_error(404)
            return
        body = json.dumps({"build_id": self.build_id}).encode()
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
    serve(int(os.environ.get("PORT", "8080"))).serve_forever()
