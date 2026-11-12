"""Verify first run, browser entry and repeated launches with isolated data."""

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from platform_identity import DEFAULT_LOGIN, Identity
from platform_runtime import Settings
from prepare_sources import ROOT
from verify_originals import launch, port, wait, require_manual_acceptance


def await_browser_url(path):
    deadline = time.monotonic() + 15
    while not path.exists() and time.monotonic() < deadline:
        time.sleep(.1)
    if not path.exists():
        raise AssertionError("Launcher did not open the browser")
    return path.read_text()


def main():
    require_manual_acceptance()
    credentials = json.load(sys.stdin)
    (ROOT / "data-dev").mkdir(exist_ok=True)
    logs = ROOT / "logs/launcher-verification"
    logs.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="launcher-", dir=ROOT / "data-dev") as temporary:
        work = Path(temporary)
        config = work / "config.json"
        config.write_text(json.dumps({"port": port(), "data_dir": str(work / "data"), "log_dir": str(logs)}))
        settings = Settings(config)
        env = dict(os.environ, PYTHONUTF8="1")
        browser_url = work / "browser-url"
        capture = """
import sys, webbrowser
from pathlib import Path
import platform_local
destination = Path(sys.argv[1])
webbrowser.open = lambda url: destination.write_text(url)
sys.argv = ['platform_local', '--config', sys.argv[2], 'start', '--open']
platform_local.main()
"""
        command = [sys.executable, "-c", capture, str(browser_url), str(config)]
        env["PYTHONPATH"] = str(ROOT / "scripts")
        base = f"http://127.0.0.1:{settings.port}"
        for run in range(2):
            browser_url.unlink(missing_ok=True)
            with launch(command, ROOT, env, logs / f"start-{run}.log") as child:
                try:
                    wait(base + "/platform/session", child, (401,))
                    first_url = await_browser_url(browser_url)
                    identity = Identity(settings.data / "identity.sqlite3")
                    with identity.db() as db:
                        assert db.execute("SELECT COUNT(*) FROM account").fetchone()[0] == 1
                        account = db.execute("SELECT id, login FROM account").fetchone()
                        assert account["login"] == DEFAULT_LOGIN
                    if run == 0:
                        original_id = account["id"]
                        original_pid = json.loads(settings.control.read_text())["pid"]
                        browser_url.unlink()
                        subprocess.run(command, cwd=ROOT, env=env, check=True, timeout=15)
                        reopened_url = await_browser_url(browser_url)
                        assert json.loads(settings.control.read_text())["pid"] == original_pid
                        assert reopened_url != first_url
                        subprocess.run(
                            [settings.node, str(ROOT / "scripts/verify_launcher_ui.mjs"), base],
                            env=env, text=True, input=json.dumps({
                                "entry": first_url, "reopened": reopened_url, "password": credentials["password"],
                            }), check=True, timeout=35,
                        )
                    else:
                        assert account["id"] == original_id
                    print(f"PASS: launcher round {run + 1}, one persistent default account", flush=True)
                finally:
                    if settings.control.exists():
                        subprocess.run([sys.executable, str(ROOT / "scripts/platform_local.py"),
                                        "--config", str(config), "stop"], env=env, cwd=ROOT, check=True, timeout=40)


if __name__ == "__main__":
    main()
