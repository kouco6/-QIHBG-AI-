"""BEI 事业部体验重视度指数（L3）REST API（T11）。

路径说明：
- 季度榜单 ``GET /bei`` 使用根路径（而非 ``/divisions/bei``），因为 ``projects`` 路由已注册
  ``GET /divisions/{division_id}``，后者会优先匹配 ``/divisions/bei`` 导致被吞；根路径 ``/bei``
  与前端 ``endpoints.ts`` 的 ``beiApi.list``（``/bei``）一致，且无冲突。
- 其余端点严格按任务描述与 ``DESIGN.md §6.2.2`` 实现。
- 全部端点需要登录（未登录 401）；阈值版本创建与定榜仅首账号（403）。
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import RequestContext, get_current_account, get_db, get_request_context, require_primary_account
from app.models.account import Account
from app.services import bei as bei_service

router = APIRouter(tags=["bei"])


# --------------------------------------------------------------------------- 请求模型
class ThresholdItemIn(BaseModel):
    metric_key: str
    full_line: str | None = None
    pass_line: str | None = None
    zero_line: str | None = None


class ThresholdVersionIn(BaseModel):
    version_label: str
    weights: dict[str, str] | None = None
    items: list[ThresholdItemIn] | None = None
    source_ref: str | None = None
    source_note: str | None = None


class PreviewIn(BaseModel):
    division_id: str
    period: str


class FinalizeIn(BaseModel):
    division_id: str
    period: str


class ManualScoreIn(BaseModel):
    score: float
    reason: str | None = None
    basis: str | None = None
    weight: float | None = None


class NoteIn(BaseModel):
    content: str


# --------------------------------------------------------------------------- 阈值版本
@router.get("/bei-threshold-versions")
def list_threshold_versions(
    db: Session = Depends(get_db),
    account: Account = Depends(get_current_account),
) -> dict[str, Any]:
    """阈值版本列表（含状态标注与来源）。"""
    return bei_service.list_threshold_versions(db)


@router.get("/bei-threshold-versions/{version_id}")
def get_threshold_version(
    version_id: str,
    db: Session = Depends(get_db),
    account: Account = Depends(get_current_account),
) -> dict[str, Any]:
    """版本详情（15 个二级指标断点 + 五维权重）。"""
    return bei_service.get_threshold_version(db, version_id)


@router.post("/bei-threshold-versions", status_code=201)
def create_threshold_version(
    payload: ThresholdVersionIn,
    db: Session = Depends(get_db),
    primary: Account = Depends(require_primary_account),
    ctx: RequestContext = Depends(get_request_context),
) -> dict[str, Any]:
    """新建阈值版本（仅首账号；标签唯一 409；权重变更留审计）。"""
    return bei_service.create_threshold_version(db, payload=payload, account=primary, ctx=ctx)


# --------------------------------------------------------------------------- 季度榜单 / 预估 / 明细 / 定榜
@router.get("/bei")
def division_ranking(
    period: str = Query(..., description="评价周期，形如 2026Q4"),
    db: Session = Depends(get_db),
    account: Account = Depends(get_current_account),
) -> dict[str, Any]:
    """季度榜单（每事业部样本状态 / 五维分 / 自动分 / 人工分 / 档位 / 定榜状态）。"""
    return bei_service.division_ranking(db, period=period, account=account)


@router.post("/divisions/bei/preview")
def preview_division(
    payload: PreviewIn,
    db: Session = Depends(get_db),
    account: Account = Depends(get_current_account),
) -> dict[str, Any]:
    """实时预估（status=estimate，标注未定榜）；含五维分、自动/人工分与分栏、下钻。"""
    return bei_service.preview_division(
        db, division_id=payload.division_id, period=payload.period, account=account
    )


@router.post("/bei/quarterly-snapshots/finalize", status_code=200)
def finalize_quarterly_snapshot(
    payload: FinalizeIn,
    db: Session = Depends(get_db),
    primary: Account = Depends(require_primary_account),
    ctx: RequestContext = Depends(get_request_context),
) -> dict[str, Any]:
    """季度定榜（仅首账号；不可变，再定榜 409；写入分值库 L3）。"""
    return bei_service.finalize_division(
        db, division_id=payload.division_id, period=payload.period, account=primary, ctx=ctx
    )


@router.get("/divisions/{division_id}/bei/{period}")
def division_detail(
    division_id: str,
    period: str,
    db: Session = Depends(get_db),
    account: Account = Depends(get_current_account),
) -> dict[str, Any]:
    """事业部评价详情 + 下钻（每二级指标 → 原始问题清单 issue_code 等）。"""
    return bei_service.division_detail(db, division_id=division_id, period=period, account=account)


# --------------------------------------------------------------------------- 人工分 / 备注
@router.post("/divisions/bei/{evaluation_id}/manual-score")
def set_manual_score(
    evaluation_id: str,
    payload: ManualScoreIn,
    db: Session = Depends(get_db),
    account: Account = Depends(get_current_account),
    ctx: RequestContext = Depends(get_request_context),
) -> dict[str, Any]:
    """人工印象分：必填 score/reason/basis；weight ≤ 0.20；只写 BeiManualScore，不改 BeiMetricValue。"""
    evaluation = bei_service.get_evaluation(db, evaluation_id)
    return bei_service.set_manual_score(
        db,
        evaluation=evaluation,
        score=Decimal(str(payload.score)),
        reason=payload.reason or "",
        basis=payload.basis or "",
        weight=None if payload.weight is None else Decimal(str(payload.weight)),
        account=account,
        ctx=ctx,
    )


@router.post("/divisions/bei/{evaluation_id}/note")
def add_note(
    evaluation_id: str,
    payload: NoteIn,
    db: Session = Depends(get_db),
    account: Account = Depends(get_current_account),
    ctx: RequestContext = Depends(get_request_context),
) -> dict[str, Any]:
    """说明备注（留录入人+时间），不影响数值。"""
    evaluation = bei_service.get_evaluation(db, evaluation_id)
    return bei_service.add_note(
        db, evaluation=evaluation, content=payload.content, account=account, ctx=ctx
    )
