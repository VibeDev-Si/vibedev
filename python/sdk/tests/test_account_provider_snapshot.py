"""Project the recorded account cancellation through the real Python SDK."""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'


@pytest.mark.skipif(not CLI.exists(), reason='requires the built dsh profile runtime')
def test_account_provider_signout_snapshot(tmp_path: Path) -> None:
    patch = str(ROOT / 'snapshots' / 'sdk' / 'account-provider-signout' / 'cordis.yml')
    launch_args = None
    if os.name == 'nt':
        node = shutil.which('node')
        if node is None:
            raise FileNotFoundError('requires Node to launch the built dsh profile on Windows')
        launch_args = (node, str(CLI), '--profile', 'sdk', '--patch', patch)
    with DeepSeekHarness(
        dsh_bin=str(CLI),
        dsh_home=str(tmp_path / 'home'),
        cwd=str(tmp_path),
        profile='sdk',
        patches=(patch,),
        _launch_args=launch_args,
        provider='deepseek-account',
        model='deepseek-v4-flash',
        env={'DSH_HOME': str(tmp_path / 'home'), 'DSH_TELEMETRY_DISABLED': '1', 'DSH_SNAPSHOT': 'replay'},
    ) as harness:
        result = harness.run('Reply with exactly: SDK snapshot')
    ending = next(event for event in reversed(result.events) if event['type'] == 'turn/end')
    actual = {
        'final_response': result.final_response,
        'finish_reason': result.finish_reason,
        'reason': ending['data']['reason'],
    }
    expected = Path(__file__).with_name('expected') / 'account-provider-signout.json'
    assert actual == json.loads(expected.read_text())
