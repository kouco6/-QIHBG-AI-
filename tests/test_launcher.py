"""Check duplicate launch, startup failure and browser timing without real accounts."""
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import URLError

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('v2_launcher', ROOT / 'scripts/launch.py')
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class LauncherTests(unittest.TestCase):
    def test_running_application_opens_without_build_or_second_process(self):
        with patch.object(launcher, 'running_v2', return_value=True), \
             patch.object(launcher, 'open_browser') as browser, \
             patch.object(launcher.subprocess, 'run') as build, \
             patch.object(launcher.subprocess, 'Popen') as start:
            self.assertEqual(launcher.launch(), 0)
            browser.assert_called_once_with('http://127.0.0.1:8793/')
            build.assert_not_called()
            start.assert_not_called()

    def test_new_application_opens_after_ready_and_stays_attached(self):
        events = []
        child = MagicMock()
        child.poll.side_effect = [None, 0]
        child.wait.side_effect = lambda *args, **kwargs: events.append('wait') or 0
        def probe(url):
            events.append('probe')
            return events.count('probe') > 1
        with patch.object(launcher, 'running_v2', side_effect=probe), \
             patch.object(launcher, 'open_browser', side_effect=lambda url: events.append('open')), \
             patch.object(launcher.subprocess, 'run', side_effect=lambda *a, **kw: events.append('build')), \
             patch.object(launcher.subprocess, 'Popen', return_value=child):
            self.assertEqual(launcher.launch(), 0)
        self.assertEqual(events, ['probe', 'build', 'probe', 'open', 'wait'])
        child.terminate.assert_not_called()

    def test_failed_start_never_opens_browser(self):
        child = MagicMock()
        child.poll.return_value = 1
        with patch.object(launcher, 'running_v2', return_value=False), \
             patch.object(launcher, 'open_browser') as browser, \
             patch.object(launcher.subprocess, 'run'), \
             patch.object(launcher.subprocess, 'Popen', return_value=child):
            with self.assertRaisesRegex(RuntimeError, '服务启动失败'):
                launcher.launch()
            browser.assert_not_called()

    def test_failed_build_never_starts_service(self):
        with patch.object(launcher, 'running_v2', return_value=False), \
             patch.object(launcher.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'build')), \
             patch.object(launcher.subprocess, 'Popen') as start:
            with self.assertRaises(subprocess.CalledProcessError):
                launcher.launch()
            start.assert_not_called()

    def test_refused_port_is_available_but_unrelated_page_is_rejected(self):
        opener = MagicMock()
        with patch.object(launcher, 'build_opener', return_value=opener):
            opener.open.side_effect = URLError(ConnectionRefusedError())
            self.assertFalse(launcher.running_v2('http://127.0.0.1:8793/'))
            opener.open.side_effect = None
            opener.open.return_value.__enter__.return_value.read.return_value = b'unrelated service'
            with self.assertRaisesRegex(RuntimeError, '其他服务占用'):
                launcher.running_v2('http://127.0.0.1:8793/')


if __name__ == '__main__':
    unittest.main()
