"""服务层公共工具：审计、分页、404/409/422 统一口径、乐观锁、状态迁移。

所有业务服务共用这一层，保证：

- **审计必写**：业务写操作统一走 :func:`audit_business`，明细经 ``redact`` 脱敏；
- **错误语义统一**：不存在 404 / 非法状态迁移 409（附 current、target、reason）/
  校验失败 422（附 ``field_errors``）；
- **乐观锁**：``row_version`` 不匹配返回 409 并提示刷新。
"""

from __future__ import annotations

from typing import Any, Sequence, TypeVar

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import RequestContext
from app.core.audit import write_audit
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.domain import states as st
from app.models.account import AUDIT_CATEGORY_BUSINESS, Account
from app.models import Base

T = TypeVar("T")


# ----------------------------------------------------------------------------- 分页


def paginate(
    db: Session,
    stmt: Any,
    *,
    page: int = 1,
    page_size: int = 50,
    count_column: Any = None,
) -> tuple[Sequence[Any], int]:
    """统一分页：返回 ``(rows, total)``。"""
    page = max(1, page)
    page_size = min(max(1, page_size), 200)
    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = int(db.execute(count_stmt).scalar() or 0)
    rows = db.execute(stmt.offset((page - 1) * page_size).limit(page_size)).scalars().all()
    return rows, total


def page_payload(rows: Sequence[Any], total: int, page: int, page_size: int, serializer: Any) -> dict[str, Any]:
    return {
        "page": page,
        "page_size": page_size,
        "total": total,
        "items": [serializer(row) for row in rows],
    }


# ----------------------------------------------------------------------------- 存在性


def get_or_404(db: Session, model: type[T], entity_id: str | None, label: str = "实体") -> T:
    if not entity_id:
        raise NotFoundError(f"{label}不存在")
    obj = db.get(model, entity_id)
    if obj is None:
        raise NotFoundError(f"{label}不存在：{entity_id}")
    return obj


def find_by(db: Session, model: type[Base], **filters: Any) -> Any:
    stmt = select(model)
    for key, value in filters.items():
        stmt = stmt.where(getattr(model, key) == value)
    return db.execute(stmt).scalars().first()


# ----------------------------------------------------------------------------- 校验


def require_reason(reason: str | None, *, field: str = "reason", label: str = "原因") -> str:
    text = (reason or "").strip()
    if not text:
        raise ValidationError(
            f"{label}不能为空",
            field_errors=[{"field": field, "message": f"请填写{label}", "type": "value_error"}],
        )
    return text


def require_fields(problems: list[dict[str, str]], message: str = "请求参数校验失败") -> None:
    if problems:
        raise ValidationError(message, field_errors=problems)


# ----------------------------------------------------------------------------- 状态迁移


def check_transition(
    machine: str,
    *,
    current: str,
    target: str,
    reason: str | None,
    label: str,
    guard_failures: list[str] | None = None,
) -> st.Transition:
    """校验一次状态迁移；非法迁移抛 409，缺理由抛 422。"""
    transition = st.find_transition(machine, current, target)
    if transition is None:
        allowed = st.allowed_targets(machine, current)
        raise ConflictError(
            f"{label}不允许从「{_status_label(machine, current)}」迁移到「{_status_label(machine, target)}」",
            code="illegal_transition",
            extra={
                "machine": machine,
                "current": current,
                "target": target,
                "allowed_targets": list(allowed),
                "reason": "未在状态机中声明的迁移一律拒绝（DESIGN §6.6）",
            },
        )
    if transition.requires_reason:
        require_reason(reason, label="操作原因")
    if guard_failures:
        raise ConflictError(
            f"{label}当前不满足迁移前置条件",
            code="precondition_failed",
            extra={
                "machine": machine,
                "current": current,
                "target": target,
                "reason": "；".join(guard_failures),
                "failed_guards": guard_failures,
            },
        )
    return transition


def _status_label(machine: str, status: str) -> str:
    maps = {
        "node": st.NODE_STATUS_LABELS,
        "artifact": st.ARTIFACT_STATUS_LABELS,
        "issue": st.ISSUE_STATUS_LABELS,
        "review": st.REVIEW_STATUS_LABELS,
        "job": st.JOB_STATUS_LABELS,
    }
    return maps.get(machine, {}).get(status, status)


# ----------------------------------------------------------------------------- 乐观锁


def check_row_version(entity: Any, expected: int | None, label: str = "记录") -> None:
    """并发更新校验：``row_version`` 不匹配返回 409。"""
    if expected is None:
        return
    current = getattr(entity, "row_version", None)
    if current is None:
        return
    if int(expected) != int(current):
        raise ConflictError(
            f"{label}已被其他操作更新，请刷新后重试",
            code="version_conflict",
            extra={"expected_version": int(expected), "current_version": int(current)},
        )


def touch(entity: Any, account: Account, *, bump: bool = True) -> None:
    """写入修改人并递增乐观锁版本。"""
    entity.updated_by = account.id
    entity.updated_by_name = account.name
    if bump and hasattr(entity, "row_version"):
        entity.row_version = int(getattr(entity, "row_version") or 0) + 1


def mark_created(entity: Any, account: Account) -> None:
    entity.created_by = account.id
    entity.created_by_name = account.name
    entity.updated_by = account.id
    entity.updated_by_name = account.name


# ----------------------------------------------------------------------------- 审计


def audit_business(
    db: Session,
    *,
    account: Account,
    ctx: RequestContext | None,
    action: str,
    target_type: str,
    target_id: str = "",
    summary: str = "",
    detail: dict[str, Any] | None = None,
    commit: bool = True,
) -> None:
    """业务审计统一入口。"""
    write_audit(
        db,
        category=AUDIT_CATEGORY_BUSINESS,
        action=action,
        actor_account_id=account.id,
        actor_name=account.name,
        actor_role=account.role,
        target_type=target_type,
        target_id=target_id,
        summary=summary,
        detail=detail or {},
        request_id=ctx.request_id if ctx else "",
        ip_address=ctx.ip_address if ctx else "",
        commit=commit,
    )


def table_counts(db: Session) -> dict[str, int]:
    """若干关键表的计数（健康检查与自检用）。"""
    from app.models.flow import Project, WorkflowNode
    from app.models.issue import Issue

    out: dict[str, int] = {}
    for name, model in (("projects", Project), ("nodes", WorkflowNode), ("issues", Issue)):
        out[name] = int(db.execute(select(func.count()).select_from(model)).scalar() or 0)
    return out
