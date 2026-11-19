"""Private AI processes owned by this V2 installation; no other platform modules."""
import hashlib, os, secrets, shutil, socket, subprocess, threading, time, tempfile
from contextlib import contextmanager
from pathlib import Path
from urllib.request import build_opener, ProxyHandler
from urllib.error import HTTPError, URLError
from ai_adapter import ai
ROOT = Path(__file__).resolve().parents[1]

class Settings:
    def __init__(self, port=8780, data=None, node=None):
        self.port = port
        self.data = Path(data).resolve() if data else ROOT / 'data'
        self.logs = self.data / 'logs'
        self.node = node or shutil.which('node')
        if not self.node: raise ValueError('需要 Node.js 22.18+')
        version = subprocess.check_output([self.node,'--version'],text=True).strip()
        if tuple(map(int,version.lstrip('v').split('.')[:2])) < (22,18): raise ValueError('需要 Node.js 22.18+')
        self.data.mkdir(parents=True,exist_ok=True)
        self.logs.mkdir(exist_ok=True)
        self.runtime = ROOT / '.runtime'
        self.runtime.mkdir(exist_ok=True)
        source = ROOT / 'services/ai-gateway'
        fingerprint = hashlib.sha256()
        ignored = {'node_modules','__pycache__'}
        for path in sorted(source.rglob('*')):
            if path.is_file() and not ignored.intersection(path.relative_to(source).parts):
                fingerprint.update(str(path.relative_to(source)).encode());fingerprint.update(path.read_bytes())
        self.ai_source = self.runtime / fingerprint.hexdigest()[:20]
        if not (self.ai_source / '.complete').is_file():
            with tempfile.TemporaryDirectory(prefix='building-',dir=self.runtime) as temporary:
                stage = Path(temporary) / 'ai-gateway'
                shutil.copytree(source,stage,ignore=shutil.ignore_patterns('node_modules','__pycache__','*.log'))
                ai(stage)
                (stage / '.complete').write_text(fingerprint.hexdigest())
                try:stage.rename(self.ai_source)
                except FileExistsError:
                    if not (self.ai_source / '.complete').is_file():raise

    @staticmethod
    def provision_account(login,name,previous):
        return previous or 'v2-' + login

class Modules:
    def __init__(self, config):
        self.config = config
        self.key = secrets.token_urlsafe(32)
        self.children = {}
        self.lock = threading.RLock()
    def get(self, service, account):
        if service != 'ai': raise ValueError('V2 只启动 AI 调度服务')
        with self.lock:
            live = self.children.get(account)
            if live and live[2].poll() is None: return live[:2]
            with socket.socket() as probe:
                probe.bind(('127.0.0.1',0)); port = probe.getsockname()[1]
            data = self.config.data / 'ai' / account
            data.mkdir(parents=True,exist_ok=True)
            token_path = data / 'private-token'
            if not token_path.exists(): token_path.write_text(secrets.token_urlsafe(32)); token_path.chmod(0o600)
            token = token_path.read_text().strip()
            env = dict(os.environ)
            for key in list(env):
                if key.startswith('WORKBUDDY_'): env.pop(key)
            env.update(WORKBUDDY_PLATFORM_MANAGED='1', WORKBUDDY_GATEWAY_TOKEN=token,
                WORKBUDDY_CONFIG_FILE=str(data / 'gateway.config.json'), WORKBUDDY_ALLOWED_ROOTS=str(data),
                WORKBUDDY_HOST='127.0.0.1', WORKBUDDY_PORT=str(port),
                WORKBUDDY_RESEARCH_KEY=self.key, WORKBUDDY_RESEARCH_OWNER=account,
                WORKBUDDY_RESEARCH_AUTH_DIR=str(data / 'research-authorization'))
            with (self.config.logs / ('ai-' + account + '.log')).open('ab') as log:
                child = subprocess.Popen([self.config.node,'src/server.mjs'],cwd=self.config.ai_source,env=env,stdout=log,stderr=subprocess.STDOUT)
            opener = build_opener(ProxyHandler({}))
            deadline = time.monotonic()+30
            while time.monotonic() < deadline:
                if child.poll() is not None: raise RuntimeError('调度启动失败，请查看本实例日志')
                try:
                    with opener.open(f'http://127.0.0.1:{port}/health',timeout=.5): break
                except HTTPError as error:
                    if error.code==503: break
                except (OSError,URLError): pass
                time.sleep(.1)
            else:
                child.terminate();child.wait();raise RuntimeError('调度启动超时')
            self.children[account]=(port,token,child)
            return port,token
    def close(self):
        for _,_,child in self.children.values():
            if child.poll() is None:
                child.terminate()
                try: child.wait(timeout=5)
                except subprocess.TimeoutExpired: child.kill();child.wait()


@contextmanager
def workspace_lock(data):
    with (data / '.instance.lock').open('a+b') as stream:
        try:
            if os.name == 'nt':
                import msvcrt
                if stream.seek(0,2)==0:stream.write(b'0');stream.flush()
                stream.seek(0);msvcrt.locking(stream.fileno(),msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError as error:raise ValueError('已有实例正在使用该 V2 数据目录。') from error
        yield
