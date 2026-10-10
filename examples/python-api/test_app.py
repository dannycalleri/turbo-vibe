import json
import threading
import unittest
import urllib.error
import urllib.request

import app


class HealthTest(unittest.TestCase):
    def setUp(self):
        app.Handler.build_id = "abc123"
        self.server = app.serve(0)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_health_reports_the_build_id(self):
        with urllib.request.urlopen(f"{self.base}/api/health") as response:
            self.assertEqual(json.load(response), {"build_id": "abc123"})

    def test_other_paths_are_not_found(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(f"{self.base}/elsewhere")
        self.assertEqual(caught.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
