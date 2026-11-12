"""Build and run isolated development snapshots; never touch the stable runtime or data.

All inputs are tracked public source files. Dependencies, builds and sessions are
new directories under each workspace's ignored data-dev/dev-001 directory.
"""

import argparse
import ast
import hashlib
import importlib.util
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import time
import uuid
from http.cookiejar import CookieJar
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import HTTPCookieProcessor, ProxyHandler, Request, build_opener


TOOL_ROOT = Path(__file__).resolve().parents[1]


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def dump(path, value):
    with path.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
    path.chmod(0o600)


def read(path):
    return json.loads(path.read_text())


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(workspace, *args):
    return subprocess.check_output(['git', '-C', str(workspace), *args])


def state(workspace):
    require(Path(git(workspace, 'rev-parse', '--show-toplevel').decode().strip()).resolve() == workspace,
            'Workspace must be the Git root')
    base = workspace / 'data-dev/dev-001'
    require(not base.is_symlink() and base.resolve().is_relative_to(workspace),
            'Refusing development directory outside this workspace')
    base.mkdir(mode=0o700, parents=True, exist_ok=True)
    owner = base / 'owner.json'
    if owner.exists():
        require(read(owner)['workspace'] == str(workspace), 'Development directory owner mismatch')
    else:
        dump(owner, {'workspace': str(workspace), 'purpose': 'DEV-001 isolated development tests'})
    return base


def fresh(base, kind):
    parent = base / kind
    require(not parent.is_symlink() and parent.resolve().is_relative_to(base), 'Unsafe development parent')
    parent.mkdir(mode=0o700, exist_ok=True)
    target = parent / (time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:8])
    target.mkdir(mode=0o700)
    return target


def environment(home, node, codex=None):
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    env = {
        'PATH': str(node.parent) + ':/usr/bin:/bin:/usr/sbin:/sbin',
        'HOME': str(home), 'USERPROFILE': str(home), 'TMPDIR': str(home),
        'PYTHONUTF8': '1', 'PYTHONDONTWRITEBYTECODE': '1',
        'PYTHONNOUSERSITE': '1', 'PIP_CONFIG_FILE': os.devnull,
        'PIP_DISABLE_PIP_VERSION_CHECK': '1', 'npm_config_userconfig': os.devnull,
        'PROVIDER_MODE': 'mock', 'FEISHU_APP_ID': '', 'FEISHU_APP_SECRET': '',
        'AI_API_KEY': '', 'AI_ENDPOINT': '',
        'WORKBUDDY_RUNNER_MODE': 'exec',
    }
    if codex:
        env['WORKBUDDY_CODEX_HOME'] = str(codex)
    return env


def run(command, cwd, env, log, timeout=240):
    with log.open('xb') as stream:
        process = subprocess.run(command, cwd=cwd, env=env, stdout=stream,
                                 stderr=subprocess.STDOUT, timeout=timeout)
    log.chmod(0o600)
    if process.returncode:
        raise RuntimeError(f'Command failed ({process.returncode}); inspect local log: {log}')


def install(args, workspace):
    base = state(workspace)
    dest = fresh(base, 'dependencies')
    node = args.node.resolve()
    require(node.is_file(), 'Node executable missing')
    codex = args.codex.resolve()
    require(codex.is_file(), 'Codex executable missing')
    env = environment(dest / 'home', node, codex)
    lock = TOOL_ROOT / 'config/dev-python-macos-arm64.lock'
    if sys.version_info[:2] != (3, 12) or sys.platform != 'darwin':
        raise RuntimeError('Verified Python wheel lock requires Python 3.12 on macOS arm64')
    run([sys.executable, '-m', 'venv', str(dest / 'python')], dest, env, dest / 'venv.log')
    python = dest / 'python/bin/python'
    run([str(python), '-m', 'pip', 'install', '--no-index', '--require-hashes',
         '--find-links', str(args.wheelhouse.resolve()), '-r', str(lock)],
        dest, env, dest / 'pip-install.log')
    run([str(python), '-m', 'pip', 'check'], dest, env, dest / 'pip-check.log')
    frontend = dest / 'frontend'
    frontend.mkdir()
    for name in ('package.json', 'package-lock.json'):
        shutil.copyfile(workspace / 'modules/experience/frontend' / name, frontend / name)
    cache = dest / 'npm-cache'
    cache.mkdir()
    # Only public package content and integrity index; no .npmrc, logs or user home.
    shutil.copytree(args.npm_cache.resolve() / '_cacache', cache / '_cacache')
    npm = node.parent / 'npm'
    run([str(node), str(npm.resolve()), 'ci', '--offline', '--ignore-scripts',
         '--no-audit', '--no-fund', '--cache', str(cache)], frontend, env, dest / 'npm-ci.log')
    versions = {
        'python': subprocess.check_output([str(python), '--version'], text=True).strip(),
        'node': subprocess.check_output([str(node), '--version'], text=True).strip(),
        'codex': subprocess.check_output([str(codex), '--version'], env=env, text=True, stderr=subprocess.PIPE).strip(),
    }
    record = {'status': 'PASS', 'workspace': str(workspace), 'dependency_dir': str(dest),
              'python': str(python), 'node': str(node), 'npm': str(npm.resolve()), 'codex': str(codex),
              'codex_sha256': sha(codex),
              'python_lock_sha256': sha(lock),
              'package_lock_sha256': sha(frontend / 'package-lock.json'), 'versions': versions}
    dump(dest / 'ready.json', record)
    return record


def build(args, workspace):
    base = state(workspace)
    deps = read(args.deps.resolve() / 'ready.json')
    require(deps['workspace'] == str(workspace), 'Refusing another workspace dependency directory')
    require(deps['package_lock_sha256'] == sha(workspace / 'modules/experience/frontend/package-lock.json'),
            'Package lock changed; install fresh dependencies')
    require(deps['python_lock_sha256'] == sha(TOOL_ROOT / 'config/dev-python-macos-arm64.lock'),
            'Python lock changed; install fresh dependencies')
    dest = fresh(base, 'builds')
    names = [n.decode() for n in git(workspace, 'ls-files', '-z').split(b'\0') if n]
    inputs = {}
    for name in names:
        if not name.startswith(('modules/', 'scripts/', 'portal/')):
            continue
        if name == 'scripts/platform_identity.py':
            raise RuntimeError('Real identity module must never be a build input')
        source = workspace / name
        if source.is_symlink() or not source.is_file():
            raise RuntimeError('Build input must be a regular tracked file: ' + name)
        content = source.read_bytes()
        if content.startswith(b'SQLite format 3\0'):
            raise RuntimeError('Refusing database as source input')
        inputs[name] = hashlib.sha256(content).hexdigest()
        relative = 'runtime/' + name[len('modules/'):] if name.startswith('modules/') else name
        target = dest / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    # Public credential-free template and tool may be newer than workspace HEAD.
    template = TOOL_ROOT / 'scripts/dev_support/identity.py'
    target = dest / 'scripts/dev_support/identity.py'
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(template, target)
    inputs['dev-tool/identity.py'] = sha(template)
    inputs['dev-tool/dev_environment.py'] = sha(Path(__file__))
    inputs['dev-tool/python.lock'] = deps['python_lock_sha256']
    probe = None
    if args.probe:
        # An explicitly declared test-only source overlay in the NEW snapshot.
        probe = 'DEV001_' + uuid.uuid4().hex
        p = dest / 'runtime/experience/frontend/src/main.tsx'
        with p.open('a') as stream:
            stream.write('\ndocument.documentElement.dataset.dev001Probe = ' + json.dumps(probe) + '\n')
        inputs['test-only-overlay/main.tsx'] = sha(p)
        for module, path in [('bg', 'runtime/bg/index.html'), ('ai', 'runtime/ai-gateway/public/index.html')]:
            p = dest / path
            with p.open('a') as stream:
                stream.write('\n<!-- ' + probe + '_' + module + ' -->\n')
            inputs['test-only-overlay/' + module] = sha(p)
    # Reuse existing integration transforms without invoking their ZIP rebuild.
    old_path = list(sys.path)
    try:
        sys.path.insert(0, str(workspace / 'scripts'))
        spec = importlib.util.spec_from_file_location('dev001_adapters', workspace / 'scripts/adapt_sources.py')
        adapters = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(adapters)
        for module, transform in [('bg', adapters.bg), ('ai-gateway', adapters.ai), ('experience', adapters.experience)]:
            transform(dest / 'runtime' / module)
    finally:
        sys.path[:] = old_path
    frontend = dest / 'runtime/experience/frontend'
    (frontend / 'node_modules').symlink_to(Path(deps['dependency_dir']) / 'frontend/node_modules', target_is_directory=True)
    env = environment(dest / 'home', Path(deps['node']))
    run([deps['node'], 'node_modules/typescript/bin/tsc', '-b'], frontend, env, dest / 'typecheck.log')
    run([deps['node'], 'node_modules/vite/bin/vite.js', 'build', '--base', '/experience/'],
        frontend, env, dest / 'vite-build.log')
    fingerprint = hashlib.sha256(json.dumps(inputs, sort_keys=True).encode()).hexdigest()
    outputs = {}
    for parent in ('runtime', 'portal', 'scripts'):
        for p in (dest / parent).rglob('*'):
            if p.is_file() and not p.is_symlink() and 'node_modules' not in p.parts:
                outputs[str(p.relative_to(dest))] = sha(p)
    record = {'status': 'PASS', 'workspace': str(workspace), 'build_dir': str(dest),
              'git_head': git(workspace, 'rev-parse', 'HEAD').decode().strip(),
              'source_fingerprint': fingerprint, 'inputs': inputs, 'outputs': outputs,
              'dependencies': deps, 'test_only_probe': probe}
    dump(dest / 'manifest.json', record)
    return {k: v for k, v in record.items() if k not in ('inputs', 'outputs', 'dependencies')}


def verified_build(workspace, location):
    base = state(workspace)
    location = location.resolve()
    require(location.is_relative_to(base / 'builds'), 'Refusing stable runtime or foreign build directory')
    manifest = read(location / 'manifest.json')
    require(manifest['workspace'] == str(workspace), 'Build workspace mismatch')
    for name, expected in manifest['outputs'].items():
        require((location / name).resolve().is_relative_to(location), 'Build manifest path escapes snapshot')
        if sha(location / name) != expected:
            raise RuntimeError('Build output changed since manifest: ' + name)
    return manifest


def worker(args, workspace):
    manifest = verified_build(workspace, args.build)
    credentials = json.load(sys.stdin)
    build_root = args.build.resolve()
    session = args.session.resolve()
    require(session.is_relative_to(state(workspace) / 'sessions'), 'Refusing non-test session')
    spec = importlib.util.spec_from_file_location('platform_identity', build_root / 'scripts/dev_support/identity.py')
    identity = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(identity)
    # All account material is synthetic, approved DEV-001 fixture data, in memory.
    identity.DEFAULT_LOGIN = 'dev-001'
    identity.DEFAULT_NAME = 'DEV-001 synthetic account'
    identity.DEFAULT_SALT = secrets.token_hex(16)
    identity.DEFAULT_HASH = identity.Identity.password_hash(credentials['password'], identity.DEFAULT_SALT)
    sys.modules['platform_identity'] = identity
    sys.path.insert(0, str(build_root / 'scripts'))
    from platform_identity import Identity
    from platform_local import launch
    from platform_runtime import Settings
    values = read(session / 'config.json')
    for key, directory in [('data_dir', 'data'), ('log_dir', 'logs')]:
        expected = session / directory
        if Path(values[key]) != expected or expected.is_symlink():
            raise RuntimeError('Refusing non-session data or log directory')
    config = Settings(session / 'config.json')
    config.runtime = build_root / 'runtime'
    # This entry uses an already validated build, never the legacy ZIP builder.
    config.prepare = lambda: None
    launch(config, Identity(config.data / 'identity.sqlite3'), args.open)


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def start(args, workspace):
    manifest = verified_build(workspace, args.build)
    deps = manifest['dependencies']
    session = fresh(state(workspace), 'sessions')
    port = free_port()
    dump(session / 'config.json', {'port': port, 'data_dir': str(session / 'data'),
                                'log_dir': str(session / 'logs'), 'node': deps['node'], 'npm': deps['npm']})
    env = environment(session / 'home', Path(deps['node']), deps.get('codex'))
    command = [deps['python'], '-B', str(Path(__file__).resolve()), '--workspace', str(workspace),
               'worker', '--build', str(args.build.resolve()), '--session', str(session)]
    if args.open:
        command.append('--open')
    print(f'DEV-001 fresh test instance: http://127.0.0.1:{port}/', flush=True)
    print(f'Synthetic data and local logs: {session}; Ctrl-C stops this instance.', flush=True)
    child = subprocess.Popen(command, cwd=workspace, env=env, stdin=subprocess.PIPE, text=True)
    child.stdin.write(json.dumps({'password': secrets.token_urlsafe(30)}))
    child.stdin.close()
    try:
        status = child.wait()
    except KeyboardInterrupt:
        child.terminate()
        status = child.wait(timeout=30)
    return {'status': 'PASS' if status == 0 else 'FAIL', 'session_dir': str(session), 'exit': status}


def smoke(args, workspace):
    manifest = verified_build(workspace, args.build)
    deps = manifest['dependencies']
    session = fresh(state(workspace), 'sessions')
    port = free_port()
    base = f'http://127.0.0.1:{port}'
    dump(session / 'config.json', {'port': port, 'data_dir': str(session / 'data'),
                                'log_dir': str(session / 'logs'), 'node': deps['node'], 'npm': deps['npm']})
    password = secrets.token_urlsafe(30)
    env = environment(session / 'home', Path(deps['node']), deps.get('codex'))
    command = [deps['python'], '-B', str(Path(__file__).resolve()), '--workspace', str(workspace),
               'worker', '--build', str(args.build.resolve()), '--session', str(session)]
    jar = CookieJar()
    opener = build_opener(ProxyHandler({}), HTTPCookieProcessor(jar))
    def request(path, data=None):
        body = json.dumps(data).encode() if data is not None else None
        headers = {'Origin': base, 'Content-Type': 'application/json'}
        try:
            with opener.open(Request(base + path, data=body, headers=headers), timeout=20) as response:
                return response.status, response.read()
        except HTTPError as error:
            return error.code, error.read()
    checks = []
    with (session / 'worker.log').open('xb') as log:
        child = subprocess.Popen(command, cwd=workspace, env=env, stdin=subprocess.PIPE,
                                 stdout=log, stderr=subprocess.STDOUT, text=True)
        child.stdin.write(json.dumps({'password': password})); child.stdin.close()
        try:
            deadline = time.monotonic() + 80
            while True:
                if child.poll() is not None:
                    raise RuntimeError(f'Development launcher exited {child.returncode}; inspect {session / "worker.log"}')
                try:
                    if request('/platform/session')[0] == 401:
                        break
                except (URLError, OSError):
                    pass
                if time.monotonic() >= deadline:
                    raise RuntimeError('Development launcher readiness timeout')
                time.sleep(0.2)
            status, _ = request('/platform/login', {'login': 'dev-001', 'password': password})
            checks.append({'check': 'synthetic platform login', 'status': status, 'pass': status == 200})
            for path in ['/', '/bg/', '/bg/api/health', '/bg/api/state', '/ai/', '/ai/health',
                         '/ai/api/tasks', '/experience/', '/experience/api/health', '/experience/api/v1/projects']:
                status, body = request(path)
                ok = status == 200
                if path == '/bg/api/state' and ok:
                    ok = json.loads(body)['state']['projects'] == []
                if path == '/experience/api/v1/projects' and ok:
                    ok = json.loads(body)['items'] == []
                checks.append({'check': path, 'status': status, 'pass': ok})
                if manifest['test_only_probe'] and path in {'/bg/', '/ai/', '/experience/'}:
                    if path == '/experience/':
                        import re
                        assets = re.findall(rb'(?:src|href)="(/experience/assets/[^" ]+\.js)"', body)
                        found = any(manifest['test_only_probe'].encode() in request(a.decode())[1] for a in assets)
                    else:
                        found = manifest['test_only_probe'].encode() in body
                    checks.append({'check': path + ' source overlay reflected over HTTP', 'pass': found})
            if args.playwright and args.chrome:
                browser_options = {'base': base, 'password': password,
                                   'playwright': str(args.playwright.resolve()),
                                   'chrome': str(args.chrome.resolve()), 'probe': manifest['test_only_probe']}
                browser = subprocess.run([deps['node'], str(TOOL_ROOT / 'scripts/dev_browser_smoke.mjs')],
                                         input=json.dumps(browser_options), text=True, capture_output=True,
                                         env=env, timeout=100)
                try:
                    browser_result = json.loads(browser.stdout)
                    checks.extend(browser_result['checks'])
                    checks.append({'check': 'browser smoke completed', 'pass': browser.returncode == 0})
                except (ValueError, KeyError):
                    checks.append({'check': 'browser smoke completed', 'pass': False,
                                   'error': 'browser did not return a valid sanitized result'})
        finally:
            if child.poll() is None:
                control = session / 'data/control.json'
                if control.exists():
                    secret = read(control)['secret']
                    try:
                        req = Request(base + '/platform/control/stop', data=b'', headers={'X-Platform-Control': secret})
                        with opener.open(req, timeout=5):
                            pass
                    except (URLError, OSError):
                        pass
                try:
                    child.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    child.terminate()
                    child.wait(timeout=15)
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=1):
            stopped = False
    except OSError:
        stopped = True
    checks.append({'check': 'test listener stopped', 'pass': stopped})
    report = {'status': 'PASS' if checks and all(c['pass'] for c in checks) else 'FAIL',
              'workspace': str(workspace), 'build_dir': str(args.build.resolve()),
              'source_fingerprint': manifest['source_fingerprint'], 'session_dir': str(session),
              'test_data': 'fresh synthetic data only; no credentials in report',
              'base_url_used': base, 'checks': checks, 'launcher_exit': child.returncode}
    dump(session / 'result.json', report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, default=TOOL_ROOT)
    commands = parser.add_subparsers(dest='command', required=True)
    p = commands.add_parser('install')
    p.add_argument('--node', type=Path, required=True)
    p.add_argument('--codex', type=Path, required=True, help='Public Codex binary only; no auth/profile is copied')
    p.add_argument('--wheelhouse', type=Path, required=True)
    p.add_argument('--npm-cache', type=Path, required=True)
    p = commands.add_parser('build')
    p.add_argument('--deps', type=Path, required=True)
    p.add_argument('--probe', action='store_true', help='Add a declared source overlay in the NEW test snapshot only')
    for name in ('smoke', 'worker', 'start'):
        p = commands.add_parser(name)
        p.add_argument('--build', type=Path, required=True)
        if name == 'smoke':
            p.add_argument('--playwright', type=Path)
            p.add_argument('--chrome', type=Path)
        if name == 'worker':
            p.add_argument('--session', type=Path, required=True)
        if name in ('worker', 'start'):
            p.add_argument('--open', action='store_true')
    args = parser.parse_args()
    workspace = args.workspace.resolve()
    if args.command == 'worker':
        worker(args, workspace)
        return
    result = {'install': install, 'build': build, 'smoke': smoke, 'start': start}[args.command](args, workspace)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if result['status'] != 'PASS':
        raise SystemExit(1)


if __name__ == '__main__':
    main()
