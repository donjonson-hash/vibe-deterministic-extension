"""Scan an exact candidate copy without executing it; emit bounded import evidence."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--candidate', required=True, type=Path)
    p.add_argument('--shipit', required=True, type=Path)
    p.add_argument('--python', required=True, type=Path)
    p.add_argument('--output', required=True, type=Path)
    args = p.parse_args()
    candidate = args.candidate.resolve(strict=True)
    if candidate.suffix.lower() not in {'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'}:
        p.error('Only TS/JS candidates are supported')
    if candidate.stat().st_size > 1048576:
        p.error('Candidate exceeds 1 MiB')
    body = candidate.read_bytes()
    body.decode('utf-8', errors='strict')
    if args.output.resolve() == candidate:
        p.error('Output must not overwrite the candidate')
    with tempfile.TemporaryDirectory(prefix='vibe-drydock-') as temp:
        root = Path(temp)
        project = root / 'candidate'
        project.mkdir()
        copied = project / candidate.name
        copied.write_bytes(body)
        with (root / 'stdout').open('wb') as stdout, (root / 'stderr').open('wb') as stderr:
            result = subprocess.run([
                str(args.python.resolve()), '-m', 'app.local_cli', '--state-dir', str(root / 'state'),
                'scan', str(project), '--json'], cwd=args.shipit.resolve(),
                stdout=stdout, stderr=stderr, timeout=120, check=False)
        if result.returncode not in (0, 1, 2) or (root / 'stdout').stat().st_size > 1900000:
            raise RuntimeError('Drydock failed or exceeded the report limit')
        report = json.loads((root / 'stdout').read_text())
        if copied.read_bytes() != body or candidate.read_bytes() != body:
            raise RuntimeError('Candidate changed during scanning')
        if not isinstance(report.get('findings'), list) or not report.get('engine_version'):
            raise ValueError('Incomplete Drydock report envelope')
        # Reproduce local_cli.snapshot's path/content fingerprint. This proves the
        # report covered exactly the copied candidate rather than another file set.
        expected = hashlib.sha256(candidate.name.encode() + b'\0' + hashlib.sha256(body).digest() + b'{}').hexdigest()
        if report['snapshot']['sha256'] != expected:
            raise ValueError('Drydock snapshot does not match the candidate')
        evidence = {
            'schema': 'vibe-drydock-evidence-v1', 'file': candidate.name,
            'candidate_sha256': hashlib.sha256(body).hexdigest(),
            'source_snapshot_sha256': expected,
            'catalog_sha256': report['catalog']['sha256'],
            'engine_version': report['engine_version'],
            'runtime_verified': False,
            # A single-file scan never attests to a complete project or dependency graph.
            'status': 'partial',
            'limitations': list(dict.fromkeys(['single_file_only', 'project_dependencies_not_checked',
                                              *report.get('limitations', [])])),
            'findings': report['findings'], 'report': report,
        }
        text = json.dumps(evidence, ensure_ascii=False, indent=2) + '\n'
        if len(text.encode()) > 2000000:
            raise ValueError('Evidence exceeds the import limit')
        args.output.write_text(text, encoding='utf-8')
        print(f"Evidence written: {args.output}; partial, single file only")


if __name__ == '__main__':
    main()
