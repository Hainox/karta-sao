import subprocess
from pathlib import Path


def test_point_direction_rendering():
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(['node', '--test', str(root / 'tests/district-point-arrows.test.cjs')], cwd=root, capture_output=True, text=True, encoding='utf-8')
    assert result.returncode == 0, result.stdout + result.stderr
