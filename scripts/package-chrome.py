"""Reproducible package: sorted paths and fixed ZIP metadata, without compression."""
from pathlib import Path
import hashlib
import io
import zipfile
root = Path('dist-chrome')
files = sorted(p for p in root.rglob('*') if p.is_file())
def package(order):
    output = io.BytesIO()
    for_paths = sorted(order)
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_STORED) as archive:
        for path in for_paths:
            entry = zipfile.ZipInfo(path.relative_to(root).as_posix(), (1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, path.read_bytes())
    return output.getvalue()
body = package(files)
assert body == package(list(reversed(files)))
Path('artifacts').mkdir(exist_ok=True)
Path('artifacts/vibe-chrome-0.2.0.zip').write_bytes(body)
Path('artifacts/vibe-chrome-0.2.0.zip.sha256').write_text(hashlib.sha256(body).hexdigest() + '\n')
print('Reproducible Chrome ZIP:', hashlib.sha256(body).hexdigest())
