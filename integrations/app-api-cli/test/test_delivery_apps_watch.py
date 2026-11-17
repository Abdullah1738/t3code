import io
import json
import os
import subprocess
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest.mock import Mock, patch

import delivery_apps_watch as watch
from phone_hold_fixture import FakePhTests


class DeliveryAppsWatchTests(FakePhTests):
    def setUp(self):
        super().setUp()
        p = patch.dict(os.environ, {'WATCH_DIR': str(self.folder)})
        p.start()
        self.addCleanup(p.stop)
        self.adb = Mock(return_value=SimpleNamespace(
            stdout='package:com.deliveroo.orderapp\npackage:com.example.app\n'))
        real_run = subprocess.run

        def run(args, **kwargs):
            if args[0] == '/opt/homebrew/bin/adb':
                return self.adb(*args, **kwargs)
            return real_run(args, **kwargs)

        p = patch.object(watch.subprocess, 'run', side_effect=run)
        p.start()
        self.addCleanup(p.stop)

    def test_present_hold_returns_before_inventory(self):
        self.respond(present=True)
        watch.main()
        self.adb.assert_not_called()
        self.assertFalse((self.folder / 'delivery-packages.json').exists())

    def test_absent_hold_runs_inventory_and_detects_new_apps(self):
        state = self.folder / 'delivery-packages.json'
        state.write_text('["com.example.app"]')
        output = io.StringIO()
        with redirect_stdout(output):
            watch.main()
        self.adb.assert_called_once()
        self.assertIn('New delivery app: Deliveroo', output.getvalue())
        self.assertEqual(json.loads(state.read_text()),
                         ['com.deliveroo.orderapp', 'com.example.app'])

    def test_unreadable_status_returns_before_inventory(self):
        self.configure(exit_code=1)
        watch.main()
        self.adb.assert_not_called()
