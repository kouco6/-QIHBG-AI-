"""统一问题中心 / 问题详情 API（T07）。

- 全部端点要求登录（未登录 401）；实体不存在 404；非法迁移 409；校验失败 422；
- 所有写操作写 ``audit_business`` 审计；
- ``DELETE`` 一律禁止（返回 409 并提示改为关闭）。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.api.deps import RequestContext, get_current_account, get_request_context
from app.core.db import get_db
from app.core.errors import ConflictError
from app.models.account import Account
from app.models.issue import Issue
from app.schemas.issues import (
    IssueBatchRequest,
    IssueCreateRequest,
    IssueRefRequest,
    IssueTransitionRequest,
    IssueUpdateRequest,
)
from app.services import issues as issues_service
from app.services.common import get_or_404

router = APIRouter(prefix="/issues", tags=["issues"])


@router.get("", summary="问题列表（过滤 + 状态优先 + 更新时间倒序 + 分页）")
async def list_issues(
    project_id: str | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
    business_level: str | None = None,
    severity: str | None = None,
    division_id: str | None = None,
    module: str | None = None,
    keyword: str | None = None,
    metric_l1: str | None = None,
    updated_from: str | None = None,
    page: int = 1,
    page_size: int = issues_service.DEFAULT_PAGE_SIZE,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    filters = {
        "project_id": project_id,
        "status": status_filter,
        "business_level": business_level,
        "severity": severity,
        "division_id": division_id,
        "module": module,
        "keyword": keyword,
        "metric_l1": metric_l1,
        "updated_from": updated_from,
    }
    return issues_service.list_issues(db, filters=filters, page=page, page_size=page_size)


@router.post("", status_code=status.HTTP_201_CREATED, summary="新建问题（服务端生成编号）")
async def create_issue(
    payload: IssueCreateRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    issue = issues_service.create_issue(db, account=account, payload=payload, ctx=ctx)
    return issues_service.issue_detail(db, issue)


@router.post("/batch", summary="批量改等级 / Mock 同步 / 批量验收（先回显范围）")
async def batch_issues(
    payload: IssueBatchRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    return issues_service.batch_issues(db, payload=payload, account=account, ctx=ctx)


@router.get("/{issue_id}", summary="问题详情（来源引用 + 时间线 + 代录 + 验收 + 分类对比 + 矩阵预览）")
async def get_issue(
    issue_id: str,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    issue = get_or_404(db, Issue, issue_id, "问题")
    return issues_service.issue_detail(db, issue)


@router.patch("/{issue_id}", summary="更新问题（支持 expected_version 乐观锁）")
async def update_issue(
    issue_id: str,
    payload: IssueUpdateRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    issue = get_or_404(db, Issue, issue_id, "问题")
    issues_service.update_issue(db, issue=issue, payload=payload, account=account, ctx=ctx)
    return issues_service.issue_detail(db, issue)


@router.post("/{issue_id}/transition", summary="问题状态迁移（按状态机 + guard 校验）")
async def transition_issue(
    issue_id: str,
    payload: IssueTransitionRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    issue = get_or_404(db, Issue, issue_id, "问题")
    return issues_service.transition_issue(
        db,
        issue=issue,
        action=payload.action,
        reason=payload.reason,
        expected_version=payload.expected_version,
        extra=payload.extra or {},
        account=account,
        ctx=ctx,
    )


@router.post("/{issue_id}/refs", summary="追加来源引用（一次录入多视图呈现）")
async def add_issue_ref(
    issue_id: str,
    payload: IssueRefRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    issue = get_or_404(db, Issue, issue_id, "问题")
    result = issues_service.add_ref(
        db,
        issue=issue,
        ref_type=payload.ref_type,
        ref_id=payload.ref_id,
        label=payload.label,
        account=account,
        ctx=ctx,
    )
    result["issue_id"] = issue.id
    result["issue_code"] = issue.code
    return result


@router.delete(
    "/{issue_id}",
    summary="物理删除被禁止（只能关闭）",
)
async def delete_issue(
    issue_id: str,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    get_or_404(db, Issue, issue_id, "问题")
    raise ConflictError(
        "已被引用的问题不能物理删除，请关闭",
        code="delete_forbidden",
        extra={"hint": "请使用关闭 / 驳回动作，历史与审计将保留"},
    )
