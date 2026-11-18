"""Atomic private JSON writes shared by state and the order detail cache."""
import json
import os
import tempfile
from data_io import materialize_io


def write_json(path, obj, timing=None):
    materialize_io(lambda: path.parent.mkdir(parents=True, exist_ok=True), path.parent)
    fd, tmp = materialize_io(lambda: tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent), path)

    def put(text):
        pending = memoryview(text.encode('utf-8'))
        while pending:
            written = materialize_io(lambda: os.write(fd, pending), path)
            if not written:
                raise OSError('could not write temporary JSON file')
            pending = pending[written:]

    try:
        # No buffered stream: closing after an interrupted flush must not retry the write.
        put(json.dumps(obj, ensure_ascii=False, indent=1) + '\n')
        materialize_io(lambda: os.fsync(fd), path)
        if timing is not None:
            # Sample after the data fsync; the timing footer and its fsync are also bounded.
            materialize_io(lambda: os.lseek(fd, -2, os.SEEK_END), path)
            put(',\n "timing": ' + json.dumps(timing(), ensure_ascii=False) + '\n}\n')
            materialize_io(lambda: os.fsync(fd), path)
        materialize_io(lambda: os.chmod(tmp, 0o600), path)
        materialize_io(lambda: os.replace(tmp, path), path)
    finally:
        os.close(fd)
        try:
            # Directory-entry cleanup cannot commit a book. It must still run
            # after the I/O scope aborts, and must never replace that abort.
            os.unlink(tmp)
        except OSError:
            pass
