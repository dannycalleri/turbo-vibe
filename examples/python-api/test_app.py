import json
import os
import signal
import subprocess
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request

import app


class HealthTest(unittest.TestCase):
    def setUp(self):
        app.Handler.build_id = "abc123"
        app.Handler.greeting_set = False
        self.server = app.serve(0)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_health_reports_the_build_id(self):
        with urllib.request.urlopen(f"{self.base}/api/health") as response:
            self.assertEqual(
                json.load(response), {"build_id": "abc123", "greeting_set": False}
            )

    def test_health_says_whether_the_declared_secret_reached_it(self):
        app.Handler.greeting_set = True
        with urllib.request.urlopen(f"{self.base}/api/health") as response:
            self.assertTrue(json.load(response)["greeting_set"])

    def test_other_paths_are_not_found(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(f"{self.base}/elsewhere")
        self.assertEqual(caught.exception.code, 404)


class ShutdownTest(unittest.TestCase):
    def test_exits_cleanly_on_sigterm_so_a_deploy_can_replace_it(self):
        process = subprocess.Popen(
            [sys.executable, "app.py"],
            cwd=os.path.dirname(os.path.abspath(__file__)),
            env={**os.environ, "PORT": "0"},
        )
        time.sleep(0.5)
        process.send_signal(signal.SIGTERM)
        self.assertEqual(process.wait(timeout=5), 0)


if __name__ == "__main__":
    unittest.main()
