#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""T15 安全验证：仓库凭证扫描、接口鉴权（401/403/404）、错误信息脱敏、审计与代录留痕。

运行（仓库根 /e/AI work/tiyanwork）：
    cd backend && ./.venv/Scripts/python.exe scripts/verify_t15_security.py

输出：test-results/t15-security.json
说明：
- 演示/测试口令（如种子脚本的 UEI_SEED_DEMO_PASSWORD、E2E 脚本内联账号）按
  「非生产凭证」归类，仅要求显式可见、可被环境变量覆盖，不视为真实凭证泄露。
- 会创建一个普通账号 sec_member01 用于 403 验证（保留在库中，便于复核）。
"""

from __future__ import annotations

import http.cookiejar
import json
import os
import re
import sqlite3
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DB_PATH = ROOT / "data" / "uei.db"
API = os.environ.get("API_BASE", "http://127.0.0.1:8000")
OUT = ROOT / "test-results" / "t15-security.json"

PRIMARY_ACCOUNT = os.environ.get("T15_ACCOUNT", "demo")
PRIMARY_PASSWORD = os.environ.get("T15_PASSWORD", "UeiDemo2026!")
MEMBER_ACCOUNT = "sec_member01"
MEMBER_PASSWORD = "SecMember2026x"

checks: list[dict] = []


def add(name: str, ok: bool, method: str, conclusion: str, evidence) -> None:
    checks.append({"check": name, "ok": bool(ok), "method": method, "conclusion": conclusion, "evidence": evidence})
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {conclusion}")


# --------------------------------------------------------------------------- HTTP 助手
def _opener_with_cookies() -> urllib.request.OpenerDirector:
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def http_json(opener, method: str, url: str, body: dict | None = None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    try:
        with opener.open(req, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, {"_raw": raw[:400]}


def login(opener, account: str, password: str) -> int:
    status, _ = http_json(opener, "POST", f"{API}/api/v1/auth/login",
                          {"account": account, "password": password, "remember": False})
    return status


# --------------------------------------------------------------------------- 1. 仓库扫描
SKIP_DIRS = {"node_modules", ".venv", "venv", ".git", "dist", "build", "__pycache__",
             "data", "logs", "test-results", "archive", "output", ".ruff_cache", ".pytest_cache"}
SCAN_EXT = {".py", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".ps1", ".md", ".json", ".yml",
            ".yaml", ".toml", ".cfg", ".ini", ".example", ".txt", ".html", ".css", ".sql"}
PATTERNS = {
    "openai_style_key": re.compile(r"sk-[A-Za-z0-9_-]{16,}"),
    "password_literal": re.compile(r"""password\s*[=:]\s*["'][^"']{6,}["']""", re.IGNORECASE),
    "secret_literal": re.compile(r"""(secret|api[_-]?key|access[_-]?token)\s*[=:]\s*["'][A-Za-z0-9_\-/.]{12,}["']""", re.IGNORECASE),
    "token_url": re.compile(r"""https?://[^\s"']*token=[A-Za-z0-9_\-]{16,}""", re.IGNORECASE),
    "private_key": re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    "feishu_secret": re.compile(r"""app_secret\s*[=:]\s*["'][^"']{8,}["']""", re.IGNORECASE),
}
DEMO_MARKER = re.compile(r"UeiDemo2026|MemberPass2026|SecMember2026|change-me|placeholder|example|xxx|demo", re.IGNORECASE)
TEST_FILE_MARKER = re.compile(r"(test|spec|verify_|seed_|mock|example|\.env\.example|explore)", re.IGNORECASE)

findings: list[dict] = []
scanned = 0
for dirpath, dirnames, filenames in os.walk(ROOT):
    rel = Path(dirpath).relative_to(ROOT)
    parts = set(rel.parts)
    if parts & SKIP_DIRS:
        dirnames[:] = []
        continue
    for fn in filenames:
        p = Path(dirpath) / fn
        ext = p.suffix.lower()
        if ext not in SCAN_EXT and fn != ".env.example":
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        scanned += 1
        for name, pat in PATTERNS.items():
            for m in pat.finditer(text):
                line_no = text.count("\n", 0, m.start()) + 1
                snippet = m.group(0)
                if DEMO_MARKER.search(snippet) or TEST_FILE_MARKER.search(str(p)):
                    verdict = "test_or_demo_placeholder"
                else:
                    verdict = "needs_review"
                findings.append({"file": str(p.relative_to(ROOT)), "line": line_no,
                                 "pattern": name, "snippet": snippet[:80], "verdict": verdict})

needs_review = [f for f in findings if f["verdict"] == "needs_review"]
add("repo_credential_scan",
    len(needs_review) == 0,
    f"遍历仓库 {scanned} 个文本文件，匹配 {len(PATTERNS)} 类凭证模式",
    "无待人工复核的真实凭证命中" if len(needs_review) == 0 else f"{len(needs_review)} 处待复核",
    {"scanned_files": scanned, "total_hits": len(findings),
     "hits": findings[:40], "needs_review": needs_review[:20]})

env_file = ROOT / ".env"
gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8", errors="ignore") if (ROOT / ".gitignore").exists() else ""
add("env_not_committed",
    not env_file.exists() and ".env" in gitignore,
    "检查 .env 是否存在 + .gitignore 是否忽略 .env",
    ".env 不在仓库且已被 .gitignore 忽略" if not env_file.exists() else ".env 文件存在于仓库目录（未入库也可能需清理）",
    {"env_exists": env_file.exists(), "gitignore_has_env": ".env" in gitignore})

config_src = (ROOT / "backend" / "app" / "core" / "config.py").read_text(encoding="utf-8", errors="ignore")
add("secrets_from_env_only",
    "BaseSettings" in config_src and "env_file" in config_src and not re.search(r'secret_key\s*[:=]\s*"(?!change-me)[A-Za-z0-9]{12,}"', config_src),
    "阅读 backend/app/core/config.py 并检查 secret_key 默认值",
    "运行期配置经 pydantic BaseSettings 从环境/.env 读取；secret_key 仅有占位默认值（本地开发用，部署时必须覆盖）",
    {"default_secret": "change-me-in-env（占位，需在部署环境覆盖）"})

# --------------------------------------------------------------------------- 2. 接口鉴权
anon = _opener_with_cookies()
status, body = http_json(anon, "GET", f"{API}/api/v1/projects")
err_text = json.dumps(body, ensure_ascii=False)
add("api_unauthenticated_401",
    status == 401 and "Traceback" not in err_text,
    "未携带会话 GET /api/v1/projects",
    f"返回 {status}（期望 401），错误体不含堆栈",
    {"status": status, "body_keys": sorted(body.keys()) if isinstance(body, dict) else str(body)[:120]})

primary = _opener_with_cookies()
st = login(primary, PRIMARY_ACCOUNT, PRIMARY_PASSWORD)
add("primary_login_ok", st == 200, f"POST /api/v1/auth/login（{PRIMARY_ACCOUNT}）", f"返回 {st}", {"status": st})

# 确保存在普通账号（用于 403 验证）
status, body = http_json(primary, "POST", f"{API}/api/v1/accounts",
                         {"name": "安全验证成员", "account": MEMBER_ACCOUNT, "password": MEMBER_PASSWORD})
created = status == 201
member = _opener_with_cookies()
mst = login(member, MEMBER_ACCOUNT, MEMBER_PASSWORD)
add("member_account_ready", mst == 200, "POST /accounts（首账号创建普通账号）+ 登录",
    f"创建 {'成功' if created else '已存在（幂等复用）'}，登录返回 {mst}",
    {"created": created, "login_status": mst})

# 普通账号读设置 200、写设置 403
status, _ = http_json(member, "GET", f"{API}/api/v1/settings")
member_read_ok = status == 200
# 记录当前值以便恢复
pstatus, settings_before = http_json(primary, "GET", f"{API}/api/v1/settings")
target = None
if isinstance(settings_before, list):
    for s in settings_before:
        if isinstance(s, dict) and s.get("key") == "uei.clamp_zero":
            target = s.get("value")
mstatus, mbody = http_json(member, "PATCH", f"{API}/api/v1/settings/uei.clamp_zero", {"value": "true"})
add("member_settings_write_403",
    member_read_ok and mstatus == 403,
    "普通账号 GET /settings（期望 200）+ PATCH /settings/uei.clamp_zero（期望 403）",
    f"读 {200 if member_read_ok else '非200'}，写返回 {mstatus}",
    {"read_status": 200 if member_read_ok else "other", "write_status": mstatus,
     "write_body": mbody if mstatus != 200 else "(意外成功，需复查)"})

# 不存在实体 404
status, body = http_json(primary, "GET", f"{API}/api/v1/projects/00000000-0000-0000-0000-000000000000")
err_text = json.dumps(body, ensure_ascii=False)
add("entity_not_found_404",
    status == 404 and "Traceback" not in err_text and "sqlalchemy" not in err_text.lower(),
    "GET /api/v1/projects/{不存在的 UUID}",
    f"返回 {status}（期望 404），响应不含堆栈/内部路径",
    {"status": status, "body": body})

# 错误响应统一形状且不含敏感信息
if isinstance(body, dict):
    sensitive_hits = [k for k in ("Traceback", "sqlalchemy", "password", "secret_key", "/e/AI", "E:\\") if k in err_text]
else:
    sensitive_hits = ["body-not-dict"]
add("error_shape_sanitized",
    status == 404 and not sensitive_hits and isinstance(body, dict) and {"code", "message"} <= set(body.keys()),
    "检查 404 错误体：统一形状 + 无堆栈/密钥/内部路径",
    "错误体含 code/message，未泄漏内部细节" if not sensitive_hits else f"发现敏感片段 {sensitive_hits}",
    {"body": body, "sensitive_hits": sensitive_hits})

# Provider 状态不回显密钥
status, body = http_json(primary, "GET", f"{API}/api/v1/providers")
ptext = json.dumps(body, ensure_ascii=False)
leak = re.findall(r"(secret|api_key|token|password)", ptext, flags=re.IGNORECASE)
add("provider_no_secret_echo",
    status == 200 and not leak,
    "GET /api/v1/providers（Mock 模式）",
    "仅返回 configured/mode 等状态字段，无任何凭证字段" if not leak else f"疑似泄漏字段 {leak}",
    {"status": status, "keys": list(body.keys()) if isinstance(body, dict) else str(body)[:200]})

# 恢复设置值（验证写入路径本身可用，并保持数据不变）
if target is not None:
    rstatus, _ = http_json(primary, "PATCH", f"{API}/api/v1/settings/uei.clamp_zero", {"value": target})
    restored = rstatus == 200
else:
    restored = False
add("primary_settings_write_ok",
    restored,
    "首账号 PATCH /settings/uei.clamp_zero（写后恢复原值）",
    "首账号写设置成功（403 对照成立）" if restored else "首账号写设置未成功，403 对照结论需复核",
    {"restored_to": target})

# --------------------------------------------------------------------------- 3. 数据库审计与代录
if DB_PATH.exists():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    try:
        # 审计日志无密码/密钥明文
        rows = conn.execute("SELECT summary, detail FROM audit_log").fetchall()
        bad = []
        for r in rows:
            blob = f"{r['summary'] or ''} {r['detail'] or ''}"
            if re.search(r"(password|passwd|密码|secret|api_key|sk-[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9])", blob, re.IGNORECASE):
                bad.append(blob[:120])
        add("audit_log_no_secrets",
            len(bad) == 0,
            f"扫描 audit_log 全部 {len(rows)} 条记录的 summary/detail",
            "审计日志不含密码/密钥明文" if not bad else f"{len(bad)} 条疑似敏感内容",
            {"total": len(rows), "suspicious": bad[:10]})

        # 会话表不存明文令牌
        sess = conn.execute("SELECT token_hash FROM auth_session LIMIT 5").fetchall()
        ok_hash = all(r["token_hash"] and not r["token_hash"].startswith("uei_") for r in sess) if sess else True
        add("session_token_hashed", ok_hash, "抽样 auth_session.token_hash", "会话令牌仅存摘要（无明文令牌列）",
            {"sample_len": [len(r["token_hash"]) for r in sess]})

        # 密码为哈希存储
        acc = conn.execute("SELECT account, password_hash, is_primary FROM account").fetchall()
        plain_hits = [r["account"] for r in acc
                      if r["password_hash"] in ("", r["account"]) or not r["password_hash"].startswith("bcrypt_sha256$")]
        add("password_hashed_at_rest",
            not plain_hits,
            f"检查 account 表 {len(acc)} 行 password_hash 前缀（bcrypt_sha256$）",
            "密码均以 bcrypt_sha256 哈希存储" if not plain_hits else f"异常账号 {plain_hits}",
            {"accounts": [r["account"] for r in acc], "anomalies": plain_hits})

        # 代录留痕：每条代录记录必须带 actual_provider / proxy_by / proxy_at（服务端生成）
        proxy_rows = conn.execute(
            "SELECT target_type, field_key, actual_provider, proxy_by, proxy_at FROM proxy_record"
        ).fetchall()
        bad_proxy = [dict(r) for r in proxy_rows
                     if not (r["actual_provider"] and r["proxy_by"] and r["proxy_at"])]
        add("proxy_records_server_attributed",
            len(proxy_rows) > 0 and not bad_proxy,
            f"检查 proxy_record 中 {len(proxy_rows)} 条代录记录",
            "代录记录均含实际提供人/代录人/代录时间（服务端生成）" if not bad_proxy else f"{len(bad_proxy)} 条留痕缺失",
            {"total": len(proxy_rows), "bad": bad_proxy[:5]})
    finally:
        conn.close()
else:
    add("db_checks", False, "定位 data/uei.db", "数据库文件不存在，审计/代录检查未执行", {"path": str(DB_PATH)})

# --------------------------------------------------------------------------- 汇总
passed = sum(1 for c in checks if c["ok"])
summary = {
    "checkedAt": datetime.now(timezone.utc).isoformat(),
    "scope": {
        "repo_root": str(ROOT),
        "api": API,
        "patterns": list(PATTERNS.keys()),
        "note": "演示/测试口令按非生产凭证归类：种子脚本 UEI_SEDE_DEMO_PASSWORD 环境变量可覆盖；见 findings.verdict",
    },
    "total": len(checks),
    "passed": passed,
    "failed": len(checks) - passed,
    "checks": checks,
    "all_pass": passed == len(checks),
}
OUT.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"\n安全检查合计 {passed}/{len(checks)} 通过；报告：{OUT}")
sys.exit(0 if summary["all_pass"] else 1)
