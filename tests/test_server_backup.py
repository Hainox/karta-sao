import importlib.util
import json
import pathlib
import sys
import tarfile

import pytest

SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / 'deploy' / 'server-backup'
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location('server_backup', SCRIPTS / 'server-backup.py')
server_backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server_backup)


def complete_snapshot(root, name, size=10):
    path = root / name
    path.mkdir()
    encrypted = path / f'sao-{name}.tar.age'
    encrypted.write_bytes(b'x' * size)
    kind = name.rsplit('-', 1)[1]
    (path / 'result.json').write_text(json.dumps({'kind': kind, 'encrypted': {'file': encrypted.name, 'bytes': size}}))
    return path


def test_leftover_of_a_failed_run_is_removed(tmp_path):
    failed = tmp_path / '20261028T033111Z-database'
    (failed / 'payload').mkdir(parents=True)
    (failed / 'payload' / 'photo.dump').write_bytes(b'plaintext')
    (failed / 'payload.tar').write_bytes(b'plaintext')
    complete = complete_snapshot(tmp_path, '20261027T033116Z-database')

    assert server_backup.remove_leftovers(tmp_path, 'database') == ['20261028T033111Z-database']
    assert not failed.exists()
    assert complete.exists()


def test_unknown_files_are_never_removed_as_leftovers(tmp_path):
    foreign = tmp_path / '20261028T033111Z-database'
    foreign.mkdir()
    (foreign / 'notes.txt').write_text('kept by hand')

    assert server_backup.remove_leftovers(tmp_path, 'database') == []
    assert foreign.exists()


def test_failed_snapshot_leaves_nothing_behind(tmp_path):
    def broken_build(dest):
        (dest / 'payload').mkdir()
        (dest / 'payload' / 'photo.dump').write_bytes(b'plaintext')
        raise OSError('No space left on device')

    with pytest.raises(OSError):
        server_backup.create_snapshot(tmp_path, 'database', '20261028T033111Z', broken_build)
    assert list(tmp_path.iterdir()) == []


def test_required_space_covers_plaintext_and_encrypted_copy(tmp_path):
    complete_snapshot(tmp_path, '20261026T033016Z-database', size=100)
    complete_snapshot(tmp_path, '20261027T033116Z-database', size=1000)

    last = server_backup.last_snapshot_bytes(tmp_path, 'database')
    assert last == 1000
    assert server_backup.required_free_bytes(last) >= 2 * 1000 + server_backup.FREE_SPACE_MARGIN


def test_not_enough_space_stops_before_writing(tmp_path, monkeypatch):
    complete_snapshot(tmp_path, '20261027T033116Z-database', size=1000)
    monkeypatch.setattr(server_backup, 'free_bytes', lambda root: 10)

    with pytest.raises(SystemExit, match='места'):
        server_backup.ensure_free_space(tmp_path, 'database')


def test_payload_is_encrypted_as_a_stream_without_plaintext_tar(tmp_path):
    work = tmp_path / 'payload'
    work.mkdir()
    (work / 'photo.dump').write_bytes(b'dump')
    encrypted = tmp_path / 'out.tar.age'

    server_backup.encrypt_directory(work, encrypted, ['sh', '-c', 'cat > "$0"', str(encrypted)])

    assert not (tmp_path / 'payload.tar').exists()
    with tarfile.open(encrypted) as archive:
        assert './photo.dump' in archive.getnames()


def test_keeps_two_local_copies():
    assert server_backup.KEEP == 2
