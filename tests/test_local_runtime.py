import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from scripts import local_runtime as runtime


class RuntimeTests(unittest.TestCase):
    def test_reused_pid_cannot_be_stopped_as_our_server(self):
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory)/'app.pid'
            value=dict(pid=123,created=456,instance='12345678-1234-5678-1234-567812345678')
            p.write_text(json.dumps(value),encoding='utf-8')
            with patch.object(runtime,'PID_FILE',p),patch.object(runtime,'process_stamp',return_value=789):
                self.assertIsNone(runtime.record())
            with patch.object(runtime,'PID_FILE',p),patch.object(runtime,'process_stamp',return_value=456):
                self.assertEqual(runtime.record(),value)

    def test_invalid_record_is_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory)/'app.pid'
            p.write_text('{broken',encoding='utf-8')
            with patch.object(runtime,'PID_FILE',p):self.assertIsNone(runtime.record())
