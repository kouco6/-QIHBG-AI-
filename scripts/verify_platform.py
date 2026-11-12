"""Verify the running integration with temporary accounts and capture paired screenshots."""

import argparse
import json
import os
import secrets
import subprocess
import sys
import tempfile
from http.cookiejar import CookieJar
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, ProxyHandler, Request, build_opener

from platform_identity import Identity
from platform_local import account_add
from platform_runtime import Settings
from prepare_sources import ROOT
from verify_originals import launch, port, wait, require_manual_acceptance, acceptance_output


def verify_restart(url, identity, password):
    opener = build_opener(ProxyHandler({}), HTTPCookieProcessor(CookieJar()))

    def request(path, data=None):
        headers = {"Origin": url, "Content-Type": "application/json", "Accept": "application/json"}
        body = json.dumps(data).encode() if data is not None else None
        with opener.open(Request(url + path, data=body, headers=headers), timeout=10) as response:
            return json.load(response)

    request("/platform/login", {"login": "baseline-admin", "password": password, "remember": True})
    assert request("/bg/api/state")["state"]["projects"][0]["name"] == "匿名基线项目"
    assert request("/experience/api/v1/projects")["items"][0]["name"] == "匿名体验项目"
    tasks = request("/ai/api/tasks")
    assert "匿名回归草稿" in json.dumps(tasks, ensure_ascii=False)
    identity.set_active("baseline-admin", False)
    identity.set_active("baseline-admin", True)
    try:
        request("/bg/api/state")
    except HTTPError as error:
        assert error.code == 401
    else:
        raise AssertionError("Re-enabling an account restored a revoked session")
    print("PASS: module data survived restart and account disable revoked the old session", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live-ai", action="store_true",
                        help="Dispatch one synthetic read-only task through the configured original Codex runner.")
    args = parser.parse_args()
    require_manual_acceptance()
    output = acceptance_output() / "screenshots/after"
    output.mkdir(parents=True, exist_ok=True)
    logs = ROOT / "logs/platform-verification"
    logs.mkdir(parents=True, exist_ok=True)
    (ROOT / "data-dev").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="platform-verify-", dir=ROOT / "data-dev") as temporary:
        location = Path(temporary)
        config_file = location / "config.json"
        config_file.write_text(json.dumps({"port": port(), "data_dir": str(location / "data"),
                                           "log_dir": str(logs)}))
        settings = Settings(config_file)
        identity = Identity(settings.data / "identity.sqlite3")
        password = "Local!" + secrets.token_urlsafe(24)
        settings.prepare()
        for login, name, modules in (("baseline-admin", "本地测试员", "bg,ai,experience"),
                                     ("baseline-member", "第二测试员", "bg,experience")):
            account_add(settings, identity, argparse.Namespace(login=login, name=name, modules=modules,
                        experience_login=None, new_experience=True), password)
        platform = [sys.executable, str(ROOT / "scripts/platform_local.py"), "--config", str(config_file)]
        env = dict(os.environ, PYTHONUTF8="1")
        url = f"http://127.0.0.1:{settings.port}"
        with launch([*platform, "start"], ROOT, env, logs / "launcher.log") as child:
            try:
                wait(url + "/platform/session", child, (401,))
                subprocess.run([*platform, "check"], cwd=ROOT, check=True, env=env)
                subprocess.run(
                    [settings.node, str(ROOT / "scripts/verify_platform_ui.mjs"), url, str(output)],
                    cwd=ROOT, env=env, text=True,
                    input=json.dumps({"password": password, "liveAi": args.live_ai}),
                    check=True, timeout=220,
                )
            finally:
                if child.poll() is None and settings.control.exists():
                    subprocess.run([*platform, "stop"], cwd=ROOT, check=True, env=env, timeout=40)
        # Check a clean restart after shutdown without rebuilding or resetting stored data.
        with launch([*platform, "start"], ROOT, env, logs / "launcher-restart.log") as child:
            try:
                wait(url + "/platform/session", child, (401,))
                subprocess.run([*platform, "check"], cwd=ROOT, check=True, env=env)
                verify_restart(url, identity, password)
            finally:
                if child.poll() is None and settings.control.exists():
                    subprocess.run([*platform, "stop"], cwd=ROOT, check=True, env=env, timeout=40)


if __name__ == "__main__":
    main()
