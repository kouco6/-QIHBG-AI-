"""Safety-boundary checks; uses only synthetic temporary files."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import dev_environment as dev


class DevelopmentSafetyTests(unittest.TestCase):
    def test_secrets_are_not_inherited(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {
            'OPENAI_API_KEY': 'synthetic-do-not-inherit',
            'WORKBUDDY_GATEWAY_TOKEN': 'synthetic-do-not-inherit',
            'DATABASE_URL': 'synthetic-do-not-inherit',
        }):
            env = dev.environment(Path(tmp) / 'home', Path('/usr/bin/node'))
            self.assertNotIn('OPENAI_API_KEY', env)
            self.assertNotIn('WORKBUDDY_GATEWAY_TOKEN', env)
            self.assertNotIn('DATABASE_URL', env)
            self.assertEqual(env['PROVIDER_MODE'], 'mock')
            self.assertEqual(env['WORKBUDDY_RUNNER_MODE'], 'exec')

    def test_stable_runtime_cannot_be_used_as_a_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve()
            with patch.object(dev, 'state', return_value=base):
                with self.assertRaisesRegex(RuntimeError, 'Refusing stable runtime'):
                    dev.verified_build(base, base / 'runtime')

    def test_modified_build_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve()
            build = base / 'builds/test'
            build.mkdir(parents=True)
            (build / 'source.txt').write_text('synthetic original')
            dev.dump(build / 'manifest.json', {
                'workspace': str(base), 'outputs': {'source.txt': dev.sha(build / 'source.txt')},
            })
            (build / 'source.txt').write_text('synthetic tampering')
            with patch.object(dev, 'state', return_value=base):
                with self.assertRaisesRegex(RuntimeError, 'Build output changed'):
                    dev.verified_build(base, build)

    def test_build_manifest_cannot_escape_its_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve()
            build = base / 'builds/test'
            build.mkdir(parents=True)
            dev.dump(build / 'manifest.json', {
                'workspace': str(base), 'outputs': {'../../outside.txt': 'synthetic'},
            })
            with patch.object(dev, 'state', return_value=base):
                with self.assertRaisesRegex(RuntimeError, 'escapes snapshot'):
                    dev.verified_build(base, build)


if __name__ == '__main__':
    unittest.main()
