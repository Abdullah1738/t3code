"""Run the harness cache-warming tail under errexit with a fake registry."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


RECIPE = Path(__file__).resolve().parents[2] / 'templates' / 'crpko-harness.sh'
DOCKER = '''#!/bin/bash
printf '%s\\n' "$*" >> "$DOCKER_CALLS"
stage="$1"
if [ "$1" = compose ]; then stage="$4"; fi
if [ "$stage" = "$FAIL_STAGE" ] || [ "$1" = pull ]; then
  echo 'toomanyrequests: Rate exceeded' >&2
  exit 42
fi
'''


def run_prewarm(root, fail_stage):
    """Exercise the recipe from its pre-warm through its ready message, without host provisioning."""
    bin_dir = root / 'bin'
    bin_dir.mkdir()
    docker = bin_dir / 'docker'
    docker.write_text(DOCKER)
    docker.chmod(0o755)
    platform = root / 'harness/platform'
    platform.mkdir(parents=True)
    (platform / 'compose.yaml').write_text('services: {}')
    calls = root / 'docker.calls'
    env = dict(os.environ, HOME=str(root), PATH=f'{bin_dir}:/usr/bin:/bin',
               DOCKER_CALLS=str(calls), FAIL_STAGE=fail_stage)
    tail = RECIPE.read_text().split('# Cache warming is optional:', 1)[1]
    script = 'set -euo pipefail\n# Cache warming is optional:' + tail
    result = subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True, timeout=10)
    return result, calls.read_text().splitlines()


class HarnessPrewarmTests(unittest.TestCase):
    def test_registry_failure_is_nonfatal_and_stops_dependent_warming(self):
        stages = ('pull', 'build', 'create', 'tag')
        for failed in stages:
            with self.subTest(stage=failed), tempfile.TemporaryDirectory() as tmp:
                result, calls = run_prewarm(Path(tmp), failed)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('toomanyrequests: Rate exceeded', result.stderr)
                self.assertEqual(result.stdout.count('offbox-harness-prewarm-skipped:'), 1)
                self.assertIn(f'{failed} failed (exit 42); images will be pulled when the harness first runs', result.stdout)
                warming = [c for c in calls if c.startswith(('compose ', 'tag '))]
                self.assertEqual(len(warming), stages.index(failed) + 1, calls)
                self.assertRegex(result.stdout, r'crpko-harness template ready:\s+0 images,\s+0 created containers')
                self.assertEqual(sum(c.startswith('pull -q ') for c in calls), 5)
                self.assertEqual(result.stdout.count('WARN: pull '), 5)

    def test_success_warms_all_stages_and_extra_pull_failures_still_warn(self):
        with tempfile.TemporaryDirectory() as tmp:
            result, calls = run_prewarm(Path(tmp), 'none')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn('offbox-harness-prewarm-skipped:', result.stdout)
            self.assertEqual(len([c for c in calls if c.startswith(('compose ', 'tag '))]), 4)
            self.assertIn('crpko-harness template ready:', result.stdout)
            self.assertEqual(result.stdout.count('WARN: pull '), 5)


if __name__ == '__main__':
    unittest.main()
