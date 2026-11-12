"""Prepare, start, and manage the local three-module platform."""

import argparse
import contextlib
import getpass
import json
import os
import secrets
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path
from urllib.error import URLError
from urllib.request import ProxyHandler, Request, build_opener

from platform_http import Server
from platform_identity import DEFAULT_HASH, DEFAULT_LOGIN, DEFAULT_NAME, DEFAULT_SALT, Identity, MODULES
from platform_runtime import Modules, Settings, workspace_lock
from prepare_sources import ROOT


def module_set(value):
    modules = set(value.split(",")) if value else set()
    if modules - set(MODULES):
        raise ValueError("模块只能为 bg、ai、experience。")
    return modules


def account_add(settings, identity, args, password=None):
    modules = module_set(args.modules)
    if password is None:
        password = getpass.getpass("平台密码（至少 12 个字符）: ")
        if password != getpass.getpass("再次输入平台密码: "):
            raise ValueError("两次输入的密码不一致。")
    if not 12 <= len(password) <= 128:
        raise ValueError("平台密码须为 12–128 个字符。")
    login = args.login.strip().lower()
    with identity.db() as db:
        if db.execute("SELECT 1 FROM account WHERE login=?", (login,)).fetchone():
            raise ValueError("该平台账号已存在。")
        if "ai" in modules and db.execute("SELECT 1 FROM grant_module WHERE module='ai'").fetchone():
            raise ValueError("这台电脑已经绑定一位 AI 网关所有者。")
    experience = None
    if "experience" in modules:
        if not args.experience_login and not args.new_experience:
            raise ValueError("请用 --experience-login 绑定原版账号，或用 --new-experience 创建账号。")
        settings.prepare()
        settings.prepare_experience()
        experience = settings.experience_account(args.experience_login or login, args.name, args.new_experience)
    account = identity.add(login, args.name, password, modules, experience)
    print(f"已创建平台账号 {login}（{account}）")
    return account


def setup_first_account(settings, identity):
    with identity.db() as db:
        if db.execute("SELECT 1 FROM account LIMIT 1").fetchone():
            return
    try:
        experience = settings.experience_account(DEFAULT_LOGIN, DEFAULT_NAME, create=False)
    except ValueError:
        experience = settings.experience_account(DEFAULT_LOGIN, DEFAULT_NAME, create=True)
    account = secrets.token_hex(16)
    with identity.db() as db:
        db.execute("INSERT INTO account VALUES (?, ?, ?, ?, ?, 1, ?)",
                   (account, DEFAULT_LOGIN, DEFAULT_NAME, DEFAULT_SALT, DEFAULT_HASH, experience))
        db.executemany("INSERT INTO grant_module VALUES (?, ?)", [(account, module) for module in MODULES])
    print(f"默认账号 {DEFAULT_NAME} 已就绪。", flush=True)


def reopen_running(settings):
    if not settings.control.is_file():
        return False
    try:
        result = request_control(settings, "open")
    except (ValueError, OSError, KeyError, json.JSONDecodeError):
        return False
    webbrowser.open(result["url"])
    print("已打开正在运行的平台。", flush=True)
    return True


def launch(settings, identity, open_browser):
    if open_browser and reopen_running(settings):
        return
    with workspace_lock(settings.data / ".lock"):
        settings.prepare()
        settings.prepare_experience()
        setup_first_account(settings, identity)
        modules = Modules(settings)
        stop_key = secrets.token_urlsafe(32)
        with Server(settings, identity, modules, stop_key) as server:
            descriptor = {"port": server.server_port, "secret": stop_key, "pid": os.getpid()}
            fd = os.open(settings.control, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as stream:
                json.dump(descriptor, stream)
            try:
                with identity.db() as db:
                    grants = db.execute("""SELECT a.id, g.module FROM account a JOIN grant_module g
                        ON a.id = g.account WHERE a.active = 1 ORDER BY g.module""").fetchall()
                for row in grants:
                    try:
                        modules.get(row["module"], row["id"])
                    except Exception:
                        continue
                url = f"http://127.0.0.1:{server.server_port}/"
                print(f"企划设计BG平台已启动 · {url}\n日志目录：{settings.logs}", flush=True)
                if open_browser:
                    threading.Thread(target=webbrowser.open, args=(server.launch_url(),), daemon=True).start()
                signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
                server.serve_forever()
            except KeyboardInterrupt:
                pass
            finally:
                modules.close()
                settings.control.unlink(missing_ok=True)


def request_control(settings, command):
    if not settings.control.is_file():
        raise ValueError("该配置下没有运行中的平台。")
    current = json.loads(settings.control.read_text(encoding="utf-8"))
    opener = build_opener(ProxyHandler({}))
    request = Request(
        f"http://127.0.0.1:{int(current['port'])}/platform/control/{command}",
        headers={"X-Platform-Control": current["secret"]},
        method="GET" if command == "status" else "POST",
    )
    try:
        with opener.open(request, timeout=10) as response:
            return json.load(response)
    except URLError as error:
        raise ValueError("无法连接此项目的启动进程。请查看对应日志。") from error


def control(settings, command):
    result = request_control(settings, command)
    if command == "stop":
        deadline = time.monotonic() + 35
        while settings.control.exists() and time.monotonic() < deadline:
            time.sleep(.15)
        if settings.control.exists():
            raise ValueError("平台仍在停止，请查看日志。")
        print("平台与本次启动的服务已停止。")
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))


def import_bg(settings, identity, login, source):
    with identity.db() as db:
        account = db.execute("SELECT id FROM account WHERE login=?", (login.strip().lower(),)).fetchone()
    if not account:
        raise ValueError("请先创建接收历史项目的平台账号。")
    source = source.resolve(strict=True)
    dest = settings.data / "bg" / account["id"]
    dest.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = dest / "platform.sqlite3"
    if target.exists():
        raise ValueError("该账号已有 BG 数据。为避免覆盖，请先备份并另选空白账号。")
    temporary = dest / (".import-" + secrets.token_hex(8) + ".sqlite3")
    try:
        with contextlib.closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as original, \
             contextlib.closing(sqlite3.connect(temporary)) as copy:
            original.backup(copy)
            if copy.execute("PRAGMA integrity_check").fetchone()[0] != "ok" or not copy.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_state'"
            ).fetchone():
                raise ValueError("备份不是有效的 BG 数据库。")
        temporary.chmod(0o600)
        temporary.rename(target)
    finally:
        temporary.unlink(missing_ok=True)
    print("BG 数据库已复制至选定账号，原数据库保留。")


def parser():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--config", type=Path, default=ROOT / "config/local.json")
    commands = cli.add_subparsers(dest="action", required=True)
    for name in ("prepare", "check", "stop"):
        commands.add_parser(name)
    start = commands.add_parser("start")
    start.add_argument("--open", action="store_true")
    add = commands.add_parser("account-add")
    add.add_argument("login")
    add.add_argument("--name", required=True)
    add.add_argument("--modules", default="bg,ai,experience")
    experience = add.add_mutually_exclusive_group()
    experience.add_argument("--new-experience", action="store_true")
    experience.add_argument("--experience-login")
    disable = commands.add_parser("account-disable")
    disable.add_argument("login")
    enable = commands.add_parser("account-enable")
    enable.add_argument("login")
    grant = commands.add_parser("account-grant")
    grant.add_argument("login")
    grant.add_argument("--modules", required=True)
    bg = commands.add_parser("bg-import")
    bg.add_argument("login")
    bg.add_argument("database", type=Path)
    return cli


def main():
    cli = parser()
    args = cli.parse_args()
    try:
        settings = Settings(args.config)
        if args.action in {"stop", "check"}:
            control(settings, "status" if args.action == "check" else "stop")
            return
        identity = Identity(settings.data / "identity.sqlite3")
        if args.action == "start":
            launch(settings, identity, args.open)
        elif args.action in {"account-disable", "account-enable"}:
            active = args.action == "account-enable"
            if not identity.set_active(args.login, active):
                raise ValueError("未找到平台账号。")
            print("平台账号已启用。" if active else "平台账号已停用，现有会话已失效。")
        elif args.action == "account-grant":
            identity.set_modules(args.login, module_set(args.modules))
            print("模块权限已更新。")
        else:
            with workspace_lock(settings.data / ".lock"):
                if args.action == "prepare":
                    settings.prepare()
                    settings.prepare_experience()
                elif args.action == "bg-import":
                    import_bg(settings, identity, args.login, args.database)
                else:
                    account_add(settings, identity, args)
    except (OSError, ValueError, KeyError, sqlite3.Error, subprocess.SubprocessError) as error:
        cli.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
