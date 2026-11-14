"""Atomic private JSON writes shared by state and the order detail cache."""
import json
import os
import tempfile


def write_json(path, obj, timing=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)

    def put(text):
        pending = memoryview(text.encode('utf-8'))
        while pending:
            written = os.write(fd, pending)
            if not written:
                raise OSError('could not write temporary JSON file')
            pending = pending[written:]

    try:
        # No buffered stream: closing after an interrupted flush must not retry the write.
        put(json.dumps(obj, ensure_ascii=False, indent=1) + '\n')
        os.fsync(fd)
        if timing is not None:
            # Sample after the data fsync; the timing footer and its fsync are also bounded.
            os.lseek(fd, -2, os.SEEK_END)
            put(',\n "timing": ' + json.dumps(timing(), ensure_ascii=False) + '\n}\n')
            os.fsync(fd)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        os.close(fd)
        if os.path.exists(tmp):
            os.unlink(tmp)
