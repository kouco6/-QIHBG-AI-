"""T03 端到端验收脚本：真实 HTTP 走通账号、权限与审计。

对应契约验收步骤：
  「以未登录、普通账号、首账号分别调用接口核对 401/403/200」

用法（后端需已启动；脚本不修改任何契约文件）：
  python scripts/verify_t03_e2e.py --base http://127.0.0.1:8010

输出：控制台断言表 + test-results/t03-e2e-report.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "test-results" / "t03-e2e-report.json"

PRIMARY = {"name": "龙斌", "account": "longbin", "password": "UeiWorkbench2026"}
MEMBER = {"name": "体验同事", "account": "member01", "password": "MemberPass2026"}

results: list[dict[str, object]] = []


def check(name: str, ok: bool, detail: str) -> None:
    results.append({"step": name, "ok": bool(ok), "detail": detail})
    print(f"{'PASS' if ok else 'FAIL'}  {name}  —  {detail}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8010")
    args = parser.parse_args()
    v1 = args.base.rstrip("/") + "/api/v1"

    anon = httpx.Client(base_url=v1, timeout=10.0)
    primary = httpx.Client(base_url=v1, timeout=10.0)
    member = httpx.Client(base_url=v1, timeout=10.0)

    # 1) 健康与初始化状态
    health = httpx.get(args.base.rstrip("/") + "/api/health", timeout=10.0).json()
    check("后端健康", health.get("status") == "ok", f"db={health['database']['detail']} provider={health['provider']['effective_mode']}")

    boot = anon.get("/auth/bootstrap").json()
    check("空库 needs_setup", boot.get("needs_setup") is True, json.dumps(boot, ensure_ascii=False))

    # 2) 未登录：业务接口 401
    codes = {}
    for path in ("/auth/me", "/accounts", "/settings", "/audit-logs"):
        codes[path] = anon.get(path).status_code
    check("未登录业务接口 401", all(c == 401 for c in codes.values()), json.dumps(codes))
    check(
        "未登录写设置 401",
        anon.patch("/settings/uei.clamp_zero", json={"value": "true"}).status_code == 401,
        "PATCH /settings -> 401",
    )

    # 3) 首账号初始化
    resp = primary.post("/auth/setup", json={**PRIMARY, "confirm_password": PRIMARY["password"]})
    check("创建首账号 201", resp.status_code == 201, f"HTTP {resp.status_code}")
    me = primary.get("/auth/me").json()
    check("首账号自动登录且 is_primary", me.get("is_primary") is True, f"{me.get('name')}/{me.get('account')}")
    check("响应不含密码字段", "password" not in json.dumps(me) and "hash" not in json.dumps(me), "字段白名单校验")

    dup = anon.post(
        "/auth/setup",
        json={"name": "冒名者", "account": "hacker", "password": "Hacker12345", "confirm_password": "Hacker12345"},
    )
    check("重复 setup 被拒 409", dup.status_code == 409 and dup.json().get("code") == "setup_closed", dup.json().get("message", ""))
    check("初始化入口已关闭", anon.get("/auth/bootstrap").json()["needs_setup"] is False, "needs_setup=false")

    # 4) 首账号创建普通账号
    created = primary.post("/accounts", json={"name": MEMBER["name"], "account": MEMBER["account"], "password": MEMBER["password"]})
    check("首账号新增体验人员 201", created.status_code == 201, f"HTTP {created.status_code}")
    member_id = created.json().get("id")

    # 5) 普通账号登录
    login = member.post("/auth/login", json={"account": MEMBER["account"], "password": MEMBER["password"]})
    check("普通账号登录 200", login.status_code == 200, f"HTTP {login.status_code}")
    member_me = member.get("/auth/me").json()
    check(
        "普通账号业务权限相同（非首账号）",
        member_me.get("is_primary") is False and member_me.get("role") == "experience_member",
        f"role={member_me.get('role')} is_primary={member_me.get('is_primary')}",
    )

    # 6) 写设置：普通 403 / 首账号 200
    denied = member.patch("/settings/uei.clamp_zero", json={"value": "true"})
    check("普通账号写设置 403", denied.status_code == 403, f"code={denied.json().get('code')} msg={denied.json().get('message')}")

    allowed = primary.patch("/settings/uei.clamp_zero", json={"value": "true"})
    check("首账号写设置 200", allowed.status_code == 200, f"value={allowed.json().get('value')} by={allowed.json().get('updated_by')}")
    primary.patch("/settings/uei.clamp_zero", json={"value": "false"})

    # 7) 可见范围一致
    same = primary.get("/settings").json() == member.get("/settings").json()
    check("普通账号与首账号业务可见范围一致", same, "GET /settings 响应逐字相等")

    # 8) 不存在实体 404
    check(
        "不存在的配置项 404",
        primary.patch("/settings/no.such.key", json={"value": "x"}).status_code == 404,
        "PATCH /settings/no.such.key",
    )
    check(
        "不存在的账号 404",
        primary.patch("/accounts/not-a-real-id/status", json={"is_active": False}).status_code == 404,
        "PATCH /accounts/{unknown}/status",
    )
    check(
        "普通账号新增账号 403",
        member.post("/accounts", json={"name": "偷偷建号", "account": "sneaky", "password": "Sneaky2026x"}).status_code
        == 403,
        "POST /accounts -> 403",
    )
    self_off = primary.patch(f"/accounts/{me['id']}/status", json={"is_active": False})
    check("首账号不可停用自己 409", self_off.status_code == 409, f"code={self_off.json().get('code')}")

    # 9) 账号启停
    off = primary.patch(f"/accounts/{member_id}/status", json={"is_active": False})
    check("首账号停用普通账号 200", off.status_code == 200, f"is_active={off.json().get('is_active')}")
    check("停用后既有会话立即失效", member.get("/auth/me").status_code == 401, "GET /auth/me -> 401")
    relogin = member.post("/auth/login", json={"account": MEMBER["account"], "password": MEMBER["password"]})
    check("停用账号不可登录", relogin.status_code == 401 and relogin.json().get("code") == "account_disabled", "code=account_disabled")

    # 10) 审计留痕与脱敏
    logs = primary.get("/audit-logs", params={"page_size": 50}).json()
    blob = json.dumps(logs, ensure_ascii=False)
    actions = {item["action"] for item in logs["items"]}
    check("设置变更留痕", "setting_updated" in actions, f"actions={sorted(actions)}")
    check("账号启停留痕", "account_status_changed" in actions, "account_status_changed")
    leaked = [s for s in (PRIMARY["password"], MEMBER["password"]) if s in blob]
    check("审计不含明文密码", not leaked, f"审计 {logs['total']} 条，0 泄漏")
    check("审计带请求编号", all(item["request_id"] for item in logs["items"]), "每条含 request_id")

    # 11) 退出
    primary.post("/auth/logout")
    check("退出后 401", primary.get("/auth/me").status_code == 401, "GET /auth/me -> 401")

    anon.close()
    primary.close()
    member.close()

    passed = sum(1 for r in results if r["ok"])
    summary = {"total": len(results), "passed": passed, "failed": len(results) - passed, "results": results}
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n合计 {passed}/{len(results)} 通过；报告写入 {REPORT}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
