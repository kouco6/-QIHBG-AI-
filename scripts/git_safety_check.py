"""Read-only checks for staged files. No credentials are printed; no app is imported."""

import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BLOCKED_PARTS = {
    'node_modules', '.venv', 'venv', '__pycache__', 'data-dev', 'runtime',
    'backups', 'release', 'logs', 'uploads', 'storage', 'instance',
    '.ssh', '.aws', 'screenshots', 'controls',
}
BLOCKED_NAMES = {
    'platform_identity.py', 'local.json', 'private-token', 'session-key',
    'control.json', '.npmrc', '.netrc', '.pypirc', 'credentials.json',
}
TOKEN = re.compile(
    rb'sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|'
    rb'AIza[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16}|'
    rb'xox[baprs]-[A-Za-z0-9-]{10,}|'
    rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|'
    rb'(?i:postgres(?:ql)?|mysql|mongodb|redis|https?)://[^\s/:]+:[^\s/@]+@'
)
DATA_SUFFIX = re.compile(r'\.(?:db|sqlite3?)(?:-.*)?$|\.(?:pem|key|p12|pfx|zip|7z|rar|har|log|pyc|exe|dll)$', re.I)
DOC_OUTPUT = re.compile(r'\.(?:png|jpe?g|webp|gif|bmp|mp4|webm)$|-(?:report\.md|test-records\.json|results\.json|evidence-manifest\.json)$|^[^/]*-verify-', re.I)


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args])


def main():
    if sys.argv[1:] not in ([], ['--staged']):
        raise SystemExit('Usage: python3 scripts/git_safety_check.py [--staged]')
    # The complete proposed tree is checked, including unchanged tracked files.
    names = [p.decode('utf-8') for p in git('ls-files', '-z').split(b'\0') if p]
    errors = []
    for name in names:
        p = Path(name)
        env = p.name == '.env' or p.name.startswith('.env.') and p.name not in {
            '.env.example', '.env.sample', '.env.template',
        }
        if name.startswith('docs/') and DOC_OUTPUT.search(p.name):
            errors.append((name, 'generated screenshot/report; keep outside the source repository'))
            continue
        if BLOCKED_PARTS.intersection(p.parts) or p.name in BLOCKED_NAMES or env or DATA_SUFFIX.search(name):
            errors.append((name, 'sensitive path or generated file'))
            continue
        try:
            content = git('show', ':' + name)
        except subprocess.CalledProcessError:
            errors.append((name, 'cannot read staged content'))
            continue
        if content.startswith(b'SQLite format 3\0'):
            errors.append((name, 'database content'))
        if TOKEN.search(content):
            errors.append((name, 'possible credential; value withheld'))
        if p.suffix == '.py' and re.search(rb'^DEFAULT_(?:SALT|HASH)\s*=', content, re.M):
            errors.append((name, 'embedded account password verifier'))
    for name, reason in errors:
        print(f'BLOCK {name}: {reason}')
    print(f'Checked {len(names)} proposed tracked files; blocked {len(errors)} findings.')
    print('Heuristics do not replace review of passwords, personal data, screenshots or business records.')
    return 1 if errors else 0


if __name__ == '__main__':
    raise SystemExit(main())
