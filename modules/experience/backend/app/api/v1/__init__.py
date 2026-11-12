"""v1 路由汇总。

各业务模块在此挂载；统一前缀 /api/v1（由 main.py 注入）。

路由模块与任务的对应关系（便于审查时定位）：

| 模块 | 任务 | 覆盖接口族 |
|---|---|---|
| ``auth`` / ``accounts`` / ``settings`` | T03 | 首账号、登录、会话、账号、设置、审计 |
| ``projects`` | T04 | ``/projects``、``/divisions``、``/workflow-nodes``（v1.1 产品层已并入系统） |
| ``artifacts`` | T05 | ``/artifacts/*``（草稿、提交、退回、确认、版本、差异） |
| ``dictionaries`` | T06 | ``/dictionaries/*``（导入预检、提交、版本、停用、引用检查） |
| ``issues`` | T07 | ``/issues/*``（查询、批量、同步、验收、流转、代录） |
| ``reviews`` | T07 | ``/reviews/*``（阶段迁移、决策、签署、归档） |
| ``scoring`` | T08 | ``/scoring-schemes/*``、``/scores/preview``、``/project-score-snapshots/*`` |
| ``usability`` | T09 | ``/usability-studies/*`` |
| ``systems`` | T10 | ``/systems/*``、``/system-snapshots/*``、``/system-comparisons``（v1.1 由产品线升级） |
| ``bei`` | T11 | ``/bei/*``、``/divisions/*``、``/bei-threshold-versions/*`` |
| ``score_library`` | T12 | ``/score-library``（必须带 ``level``） |
| ``integration`` | T13 | ``/provider-jobs/*``、``/collaboration/*``、``/ai-conversations/*``、``/providers/*`` |
"""

from __future__ import annotations

from fastapi import APIRouter

from app.api.v1 import (
    accounts,
    artifacts,
    auth,
    bei,
    dictionaries,
    integration,
    issues,
    projects,
    reviews,
    score_library,
    scoring,
    settings,
    systems,
    usability,
)

api_router = APIRouter(prefix="/api/v1")


@api_router.get("/ping", tags=["system"])
async def ping() -> dict[str, str]:
    return {"pong": "ok", "api_prefix": "/api/v1"}


api_router.include_router(auth.router)
api_router.include_router(accounts.router)
api_router.include_router(settings.router)
api_router.include_router(projects.router)
api_router.include_router(artifacts.router)
api_router.include_router(dictionaries.router)
api_router.include_router(issues.router)
api_router.include_router(reviews.router)
api_router.include_router(scoring.router)
api_router.include_router(usability.router)
api_router.include_router(systems.router)
api_router.include_router(bei.router)
api_router.include_router(score_library.router)
api_router.include_router(integration.router)
