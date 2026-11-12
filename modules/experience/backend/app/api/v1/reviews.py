"""发布体验评审工作区 API（T07）。

- 评审列表 / 详情（三阶段 Tab）/ 阶段迁移 / 争议决策 / 部门签署（代录）；
- 全部端点要求登录（401）；不存在 404；非法迁移 409；校验失败 422；
- 写操作统一写 ``audit_business`` 审计。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.api.deps import RequestContext, get_current_account, get_request_context
from app.core.db import get_db
from app.models.account import Account
from app.models.review import Review, ReviewDecision
from app.schemas.reviews import (
    ReviewCreateRequest,
    ReviewDecisionCreateRequest,
    ReviewDecisionUpdateRequest,
    ReviewSignatureRequest,
    ReviewTransitionRequest,
)
from app.services import reviews as reviews_service
from app.services.common import get_or_404

router = APIRouter(prefix="/reviews", tags=["reviews"])


@router.get("", summary="评审列表（项目 / 阶段 / 类型过滤）")
async def list_reviews(
    project_id: str | None = None,
    stage: str | None = None,
    review_kind: str | None = None,
    page: int = 1,
    page_size: int = reviews_service.DEFAULT_PAGE_SIZE,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    return reviews_service.list_reviews(
        db,
        project_id=project_id,
        stage=stage,
        review_kind=review_kind,
        page=page,
        page_size=page_size,
    )


@router.post("", status_code=status.HTTP_201_CREATED, summary="新建评审（预置 6 部门签署行）")
async def create_review(
    payload: ReviewCreateRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    review = reviews_service.create_review(db, account=account, payload=payload, ctx=ctx)
    return reviews_service.review_detail(db, review)


@router.get("/{review_id}", summary="评审详情（前 / 中 / 后三阶段 Tab）")
async def get_review(
    review_id: str,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    review = get_or_404(db, Review, review_id, "评审")
    return reviews_service.review_detail(db, review)


@router.post("/{review_id}/transition", summary="评审阶段迁移（含归档确认文本校验）")
async def transition_review(
    review_id: str,
    payload: ReviewTransitionRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    review = get_or_404(db, Review, review_id, "评审")
    return reviews_service.transition_review(db, review=review, payload=payload, account=account, ctx=ctx)


@router.post("/{review_id}/decisions", status_code=status.HTTP_201_CREATED, summary="新增争议项")
async def create_decision(
    review_id: str,
    payload: ReviewDecisionCreateRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    review = get_or_404(db, Review, review_id, "评审")
    decision = reviews_service.create_decision(db, review=review, payload=payload, account=account, ctx=ctx)
    return reviews_service.review_detail(db, review) | {
        "decision": {
            "id": decision.id,
            "status": decision.status,
            "issue_code": decision.issue_code,
        }
    }


@router.patch("/{review_id}/decisions/{decision_id}", summary="更新争议项（open→decided/deferred 需决策内容）")
async def update_decision(
    review_id: str,
    decision_id: str,
    payload: ReviewDecisionUpdateRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    review = get_or_404(db, Review, review_id, "评审")
    decision = get_or_404(db, ReviewDecision, decision_id, "争议项")
    reviews_service.update_decision(
        db, review=review, decision=decision, payload=payload, account=account, ctx=ctx
    )
    return reviews_service.review_detail(db, review)


@router.put("/{review_id}/signatures", summary="逐部门提交签署（代录：actual_provider 必填）")
async def upsert_signature(
    review_id: str,
    payload: ReviewSignatureRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    review = get_or_404(db, Review, review_id, "评审")
    return reviews_service.upsert_signature(db, review=review, payload=payload, account=account, ctx=ctx)
