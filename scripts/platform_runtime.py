"""Settings, module processes and the experience account bridge."""

import contextlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from zoneinfo import ZoneInfo

from adapt_sources import prepare_runtime
from prepare_sources import ROOT
from verify_originals import port, wait


class Settings:
    def __init__(self, path):
        config = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        self.port = int(config.get("port", 8780))
        if not 1 <= self.port <= 65535:
            raise ValueError("平台端口须为 1–65535。")
        self.ai_port = int(config["ai_port"]) if config.get("ai_port") else None
        if self.ai_port and (not 1 <= self.ai_port <= 65535 or self.ai_port == self.port):
            raise ValueError("AI 私有端口须与统一入口不同，且在 1–65535 范围内。")
        self.data = self.path(config.get("data_dir", "data-dev/platform"))
        self.logs = self.path(config.get("log_dir", "logs/platform"))
        self.source_dir = self.path(config.get("source_dir", ".."))
        self.business_timezone = config.get('business_timezone', 'Asia/Shanghai')
        ZoneInfo(self.business_timezone)
        self.business_week_start = config.get('business_week_start', 0)
        if type(self.business_week_start) is not int or not 0 <= self.business_week_start <= 6:
            raise ValueError('业务周起始日须为0（周一）至6（周日）。')
        self.ai_config = self.path(config["ai_config_file"]) if config.get("ai_config_file") else None
        if self.ai_config and not self.ai_config.is_relative_to(self.data):
            raise ValueError("请将 AI 网关配置及数据复制到平台数据目录后，再设置 ai_config_file。")
        self.node = config.get("node") or shutil.which("node")
        self.npm = config.get("npm") or shutil.which("npm")
        self.runtime = ROOT / "runtime"
        self.data.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.logs.mkdir(parents=True, exist_ok=True, mode=0o700)

    @staticmethod
    def path(value):
        return (ROOT / value).expanduser().resolve()

    @property
    def control(self):
        return self.data / "control.json"

    def prepare(self):
        if sys.version_info < (3, 11):
            raise ValueError("需要 Python 3.11 或更新版本。")
        if not self.node or not self.npm:
            raise ValueError("请将 Node.js 22.18+ 和 npm 加入 PATH，或在配置中指定路径。")
        node_version = subprocess.check_output([self.node, "--version"], text=True).strip()
        if tuple(map(int, node_version.lstrip("v").split(".")[:2])) < (22, 18):
            raise ValueError("AI 网关需要 Node.js 22.18 或更新版本。")
        prepare_runtime(self.node, self.npm, self.source_dir)

    def experience_env(self):
        base = self.data / "experience"
        base.mkdir(exist_ok=True, mode=0o700)
        env = dict(os.environ)
        env.pop("EXPERIENCE_INTEGRATION_KEY", None)
        env.update(DATABASE_URL=f"sqlite:///{(base / 'uei.db').as_posix()}",
                   PYTHONUTF8="1", PYTHONDONTWRITEBYTECODE="1")
        env["SECRET_KEY"] = local_secret(base / "session-key")
        return env

    def prepare_experience(self):
        backend = self.runtime / "experience/backend"
        env = self.experience_env()
        with (self.logs / "experience-setup.log").open("ab") as log:
            subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"],
                           cwd=backend, env=env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
            subprocess.run([sys.executable, "-c",
                            "from app.core.db import SessionLocal; from app.seeds import seed_all\n"
                            "with SessionLocal() as db:\n print(seed_all(db)); db.commit()"],
                           cwd=backend, env=env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)

    def experience_account(self, login, name, create):
        # Use original account creation and lookup. The platform password never enters this process.
        source = """
import json, secrets, sys
from app.core.db import SessionLocal
from app.services import accounts
data = json.load(sys.stdin)
with SessionLocal() as db:
    if data['create']:
        fn = accounts.create_account if accounts.count_accounts(db) else accounts.create_primary_account
        result = fn(db, account=data['login'], name=data['name'], password='A9!' + secrets.token_urlsafe(24))
    else:
        result = accounts.get_account_by_login(db, data['login'])
    print(result.id if result and result.is_active else '')
"""
        result = subprocess.run([sys.executable, "-c", source], cwd=self.runtime / "experience/backend",
                                input=json.dumps({"login": login, "name": name, "create": create}),
                                capture_output=True, text=True, env=self.experience_env(), timeout=30)
        if result.returncode or not result.stdout.strip():
            raise ValueError("体验账号无法绑定。请核对原账号是否存在并启用，或选用未占用的账号名新建。")
        return result.stdout.strip()


def local_secret(path):
    if not path.exists():
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as stream:
                stream.write(secrets.token_urlsafe(32))
        except FileExistsError:
            pass
    return path.read_text().strip()


@contextlib.contextmanager
def workspace_lock(path):
    with path.open("a+b") as stream:
        try:
            if os.name == "nt":
                import msvcrt
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise ValueError("已有实例正在使用该平台数据目录。") from error
        yield


class Modules:
    def __init__(self, config):
        self.config = config
        self.key = secrets.token_urlsafe(32)
        self.lock = threading.RLock()
        self.children = {}
        self.failed = {}
        self.closing = False

    def _start(self, service, account):
        cfg = self.config
        private_port = cfg.ai_port if service == "ai" and cfg.ai_port else port()
        env = dict(os.environ, PYTHONUTF8="1", PYTHONDONTWRITEBYTECODE="1")
        token = None
        if service == "bg":
            cwd = cfg.runtime / "bg"
            data = cfg.data / "bg" / account
            data.mkdir(parents=True, exist_ok=True, mode=0o700)
            env.update(BG_DATA_DIR=str(data), BG_INTEGRATION_KEY=self.key)
            env.update(PLATFORM_BUSINESS_TIMEZONE=cfg.business_timezone,
                       PLATFORM_BUSINESS_WEEK_START=str(cfg.business_week_start))
            command = [sys.executable, "server.py", "--port", str(private_port)]
            health = "/api/health"
        elif service == "ai":
            cwd = cfg.runtime / "ai-gateway"
            data = cfg.data / "ai" / account
            data.mkdir(parents=True, exist_ok=True, mode=0o700)
            conf = cfg.ai_config or data / "gateway.config.json"
            if cfg.ai_config:
                file_config = json.loads(conf.read_text(encoding="utf-8"))
                token_path = conf.parent / file_config.get("tokenFile", "secrets.json")
                token = json.loads(token_path.read_text(encoding="utf-8"))["token"].strip()
                if not token:
                    raise ValueError("AI 网关复制配置缺少有效服务令牌。")
                for field, fallback in (("stateFile", "state/tasks.jsonl"), ("eventFile", "state/events.jsonl"),
                                        ("skillDir", "skills"), ("agentSecretsFile", "agent-secrets.json"),
                                        ("tokenFile", "secrets.json")):
                    if not (conf.parent / file_config.get(field, fallback)).resolve().is_relative_to(cfg.data):
                        raise ValueError(f"AI 网关配置项 {field} 须位于平台数据目录。")
                knowledge = file_config.get("knowledge") or {}
                for field in ("vaultDir", "backupDir"):
                    if knowledge.get(field) and not Path(knowledge[field]).resolve().is_relative_to(cfg.data):
                        raise ValueError(f"AI 网关知识库 {field} 须位于平台数据目录。")
                env.pop("WORKBUDDY_GATEWAY_TOKEN", None)
            else:
                token = local_secret(data / "private-token")
                env["WORKBUDDY_GATEWAY_TOKEN"] = token
                env["WORKBUDDY_ALLOWED_ROOTS"] = str(data)
            env.update(WORKBUDDY_CONFIG_FILE=str(conf), WORKBUDDY_HOST="127.0.0.1",
                       WORKBUDDY_PORT=str(private_port))
            env.update(WORKBUDDY_RESEARCH_KEY=self.key, WORKBUDDY_RESEARCH_OWNER=account)
            # Dedicated NEW OAuth grants are outside ordinary model working roots.
            # Do not create/read/configure credentials merely by starting a module.
            env["WORKBUDDY_RESEARCH_AUTH_DIR"] = str(cfg.data / "workbuddy-authorization" / account)
            for name in ("WORKBUDDY_STATE_FILE", "WORKBUDDY_EVENT_FILE", "WORKBUDDY_SKILL_DIR",
                         "WORKBUDDY_KNOWLEDGE_VAULT", "WORKBUDDY_KNOWLEDGE_BACKUP"):
                env.pop(name, None)
            knowledge = (file_config.get("knowledge") or {}) if cfg.ai_config else {}
            env["WORKBUDDY_KNOWLEDGE_VAULT"] = knowledge.get("vaultDir") or str(data / "vault")
            env["WORKBUDDY_KNOWLEDGE_BACKUP"] = knowledge.get("backupDir") or str(data / "vault-backups")
            command = [cfg.node, "src/server.mjs"]
            health = "/health"
        else:
            cwd = cfg.runtime / "experience/backend"
            env = cfg.experience_env()
            env["EXPERIENCE_INTEGRATION_KEY"] = self.key
            command = [sys.executable, "-m", "uvicorn", "app.main:app",
                       "--host", "127.0.0.1", "--port", str(private_port), "--no-access-log"]
            health = "/api/health"
        log_path = cfg.logs / f"{service}-{account or 'shared'}.log"
        with log_path.open("ab") as log:
            child = subprocess.Popen(command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            ready = (200, 503) if service == "ai" else (403,)
            wait(f"http://127.0.0.1:{private_port}{health}", child, ready)
        except Exception:
            stop_child(child)
            raise
        return private_port, token, child

    def get(self, service, account=None):
        key = (service, account if service != "experience" else None)
        with self.lock:
            if self.closing:
                raise RuntimeError("平台正在停止。")
            live = self.children.get(key)
            if live and live[2].poll() is None:
                return live[:2]
            try:
                self.children[key] = self._start(*key)
                self.failed.pop(key, None)
            except Exception as error:
                self.failed[key] = str(error)
                print(f"{service} 启动失败，查看 {self.config.logs}：{error}", file=sys.stderr, flush=True)
                raise
            return self.children[key][:2]

    def close(self):
        with self.lock:
            self.closing = True
            children = [record[2] for record in self.children.values()]
        for child in children:
            stop_child(child)


def stop_child(child):
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
