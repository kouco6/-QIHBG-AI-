"""Run the frozen originals on loopback and capture baseline evidence with fresh data."""

import argparse
import contextlib
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, build_opener

from prepare_sources import ROOT, SOURCES, extract, verify


def require_manual_acceptance():
    if os.environ.get('PLATFORM_MANUAL_ACCEPTANCE') != '1':
        raise SystemExit('逐页验收取证默认关闭；仅用户明确要求时设置 PLATFORM_MANUAL_ACCEPTANCE=1。日常开发只做相关基础测试。')
    acceptance_output()


def acceptance_output():
    value = os.environ.get('PLATFORM_ACCEPTANCE_OUTPUT')
    if not value:
        raise SystemExit('请显式设置源码目录之外的 PLATFORM_ACCEPTANCE_OUTPUT。')
    output = Path(value).expanduser().resolve()
    container = next((p for p in (ROOT, *ROOT.parents)
                      if (p / '.worktrees').is_dir() and (p / 'integration').is_dir()), ROOT)
    if output.is_relative_to(container):
        raise SystemExit('验收产物不得写入源码工程或其工作区。')
    return output


def port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def wait(url, child, accepted=(200,)):
    opener = build_opener(ProxyHandler({}))
    deadline = time.monotonic() + 25
    while child.poll() is None and time.monotonic() < deadline:
        try:
            with opener.open(url, timeout=1) as response:
                if response.status in accepted:
                    return
        except HTTPError as error:
            if error.code in accepted:
                return
        except (URLError, TimeoutError):
            pass
        time.sleep(0.2)
    raise RuntimeError(f"Service not ready: {url}; exit={child.poll()}")


@contextlib.contextmanager
def launch(command, cwd, env, log):
    with log.open("wb") as stream:
        child = subprocess.Popen(command, cwd=cwd, env=env, stdout=stream, stderr=subprocess.STDOUT)
        try:
            yield child
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()


def run(module, args, data, logs):
    name, wrapper, digest, encoding = SOURCES[module]
    backup = ROOT / "backups" / name
    verify(backup, digest)
    # Do not inherit credentials, provider settings, proxy configuration or storage paths.
    env = {key: os.environ[key] for key in (
        "PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR",
        "PLAYWRIGHT_MODULE", "CHROME_PATH",
        "PLATFORM_MANUAL_ACCEPTANCE", "PLATFORM_ACCEPTANCE_OUTPUT",
    ) if key in os.environ}
    env.update(PYTHONUTF8="1", PYTHONDONTWRITEBYTECODE="1")
    work = data / module
    work.mkdir()
    with contextlib.ExitStack() as children:
        local_port = port()
        base = f"http://127.0.0.1:{local_port}"
        token = ""
        if module == "bg":
            extract(backup, work, wrapper, encoding)
            for suffix in ("", "-wal", "-shm"):
                (work / f"platform.sqlite3{suffix}").unlink(missing_ok=True)
            server = children.enter_context(launch(
                [sys.executable, "server.py", "--port", str(local_port)], work, env, logs / "bg.log",
            ))
            wait(base + "/api/health", server)
        elif module == "ai-gateway":
            extract(backup, work, wrapper, encoding)
            (work / "state").mkdir()
            (work / "state" / "update.json").write_text('{"settings":{"autoCheck":false,"autoInstall":false}}')
            token = secrets.token_urlsafe(32)
            (work / "home").mkdir()
            env.update(
                WORKBUDDY_GATEWAY_TOKEN=token, WORKBUDDY_PORT=str(local_port),
                WORKBUDDY_HOST="127.0.0.1", WORKBUDDY_RUNNER_MODE="exec",
                WORKBUDDY_ALLOWED_ROOTS=str(work),
                WORKBUDDY_KNOWLEDGE_VAULT=str(work / "vault"),
                WORKBUDDY_KNOWLEDGE_BACKUP=str(work / "knowledge-backups"),
            )
            server = children.enter_context(launch(
                [args.node, "src/server.mjs"], work,
                {**env, "HOME": str(work / "home"), "USERPROFILE": str(work / "home")},
                logs / "ai-gateway.log",
            ))
            wait(base + "/health", server, (200, 503))
        else:
            # Dependencies are installed in the isolated source copy. The DB is per run.
            source = ROOT / "modules" / module
            backend = source / "backend"
            frontend = source / "frontend"
            env.update(
                DATABASE_URL=f"sqlite:///{(work / 'uei.db').as_posix()}",
                PROVIDER_MODE="mock", FEISHU_APP_ID="", FEISHU_APP_SECRET="",
                AI_API_KEY="", AI_ENDPOINT="", SECRET_KEY=secrets.token_urlsafe(32),
            )
            with (logs / "experience-migration.log").open("wb") as stream:
                subprocess.run(
                    [args.experience_python, "-m", "alembic", "upgrade", "head"], cwd=backend, env=env,
                    stdout=stream, stderr=subprocess.STDOUT, check=True, timeout=45,
                )
                subprocess.run(
                    [args.experience_python, "-c",
                     "from app.core.db import SessionLocal; from app.seeds import seed_all\n"
                     "with SessionLocal() as db:\n print(seed_all(db)); db.commit()"],
                    cwd=backend, env=env, stdout=stream, stderr=subprocess.STDOUT, check=True, timeout=45,
                )
            api_port = port()
            api_url = f"http://127.0.0.1:{api_port}"
            api = children.enter_context(launch(
                [args.experience_python, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
                 "--port", str(api_port)], backend, env, logs / "experience-api.log",
            ))
            wait(api_url + "/api/health", api)
            env["VITE_API_TARGET"] = api_url
            web = children.enter_context(launch(
                [args.node, "node_modules/vite/bin/vite.js", "--host", "127.0.0.1",
                 "--port", str(local_port), "--strictPort"], frontend, env, logs / "experience-web.log",
            ))
            wait(base + "/api/health", web)

        screenshot_dir = acceptance_output() / "screenshots" / "before" / module
        screenshot_dir.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            [args.node, str(ROOT / "scripts" / "verify_originals_ui.mjs"), module, base, str(screenshot_dir)],
            input=json.dumps({"token": token}), text=True, env=env, timeout=110,
        )
        if result.returncode:
            raise RuntimeError(f"Browser baseline failed for {module} ({result.returncode})")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--module", choices=SOURCES, action="append")
    parser.add_argument("--node", default=shutil.which("node") or "node")
    parser.add_argument("--experience-python", default=sys.executable)
    args = parser.parse_args()
    require_manual_acceptance()
    data = ROOT / "data-dev"
    logs = ROOT / "logs" / "baseline"
    data.mkdir(exist_ok=True)
    logs.mkdir(parents=True, exist_ok=True)
    failed = []
    with tempfile.TemporaryDirectory(prefix="originals-", dir=data) as temporary:
        for module in args.module or SOURCES:
            try:
                run(module, args, Path(temporary), logs)
            except (OSError, RuntimeError, subprocess.SubprocessError, ValueError) as error:
                print(f"{module}: {error}; logs: {logs}", file=sys.stderr)
                failed.append(module)
    return int(bool(failed))


if __name__ == "__main__":
    sys.exit(main())
