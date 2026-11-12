"""Provider 作业服务（T13 / PRD §12.2、DESIGN §6.6 Provider 作业状态机）。

职责：

- **统一作业生命周期**：``queued → running → succeeded / failed / cancelled``，
  迁移一律经 :mod:`app.domain.states` 的 ``JOB_TRANSITIONS`` 校验（未声明迁移 → 409）；
- **幂等**：``idempotency_key`` 唯一，重复提交直接复用既有作业（``deduplicated``），
  **不重复执行**；Mock 回执 ID 使用 ``mock_`` 前缀且对同一幂等键确定性稳定；
- **重试**：仅 ``failed`` 可重试，使用**新作业 ID** 并关联 ``retry_of``；超过
  ``max_retries`` → 409 ``retry_limit``；
- **取消**：``queued`` / ``running`` 可取消，``succeeded`` / ``failed`` → 409；
- **不泄露凭证**：Provider 状态只报告「是否配置」，失败原因经 ``redact`` 脱敏。
"""

from __future__ import annotations

import json
from typing import Any, Iterable, Mapping

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import RequestContext
from app.core.audit import redact
from app.core.config import settings
from app.core.errors import BlockedError, ConflictError, ValidationError
from app.core.security import new_id
from app.core.timeutil import iso_z, utcnow
from app.domain import states as st
from app.models.account import Account
from app.models.issue import Issue
from app.models.provider import (
    JOB_TYPE_AI_ANALYSIS,
    JOB_TYPE_ISSUE_SYNC,
    JOB_TYPE_LABELS,
    JOB_TYPES,
    MODE_MOCK,
    PROVIDER_AI,
    PROVIDER_FEISHU,
    PROVIDER_KINDS,
    PROVIDER_LABELS,
    ProviderConfig,
    ProviderJob,
    ProviderReceipt,
)
from app.providers import get_adapter, resolve_mode
from app.providers.base import ProviderReceipt as AdapterReceipt
from app.services.common import (
    audit_business,
    check_transition,
    get_or_404,
    page_payload,
    paginate,
)

PAGE_SIZES: tuple[int, ...] = (20, 50, 100)
DEFAULT_PAGE_SIZE = 50
DEFAULT_MAX_RETRIES = 3

# 类型级凭证是否配置（只报告布尔，不回显值）
_CONFIGURED: dict[str, Any] = {
    PROVIDER_FEISHU: lambda: settings.feishu_configured,
    PROVIDER_AI: lambda: settings.ai_configured,
}


def _load_json(raw: str | None, fallback: Any) -> Any:
    if not raw:
        return fallback
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return fallback


def kind_configured(kind: str) -> bool:
    """该 Provider 是否配置了外部凭证（**只返回布尔**）。"""
    checker = _CONFIGURED.get(kind)
    return bool(checker()) if checker else False


# --------------------------------------------------------------------------- 序列化


def serialize_receipt(receipt: ProviderReceipt | None, mode: str) -> dict[str, Any] | None:
    """回执序列化；**body 中带 ``is_mock`` / ``mode``**（界面「模拟」标识来源）。"""
    if receipt is None:
        return None
    return {
        "id": receipt.id,
        "job_id": receipt.job_id,
        "external_id": receipt.external_id,
        "code": receipt.code,
        "message": receipt.message,
        "is_mock": bool(receipt.is_mock),
        "mode": mode,
        "body": _load_json(receipt.body_json, {}),
        "received_at": iso_z(receipt.received_at),
    }


def serialize_job(job: ProviderJob) -> dict[str, Any]:
    """作业序列化；**行内带 ``is_mock`` / ``mode``**（列表与详情共用）。"""
    mode = job.mode or MODE_MOCK
    return {
        "id": job.id,
        "provider_kind": job.provider_kind,
        "provider_kind_label": PROVIDER_LABELS.get(job.provider_kind, job.provider_kind),
        "job_type": job.job_type,
        "job_type_label": JOB_TYPE_LABELS.get(job.job_type, job.job_type),
        "mode": mode,
        "is_mock": mode == MODE_MOCK,
        "idempotency_key": job.idempotency_key,
        "status": job.status,
        "status_label": st.JOB_STATUS_LABELS.get(job.status, job.status),
        "progress": int(job.progress or 0),
        "target_type": job.target_type,
        "target_id": job.target_id,
        "project_id": job.project_id,
        "payload": _load_json(job.payload_json, {}),
        "retry_count": int(job.retry_count or 0),
        "max_retries": int(job.max_retries or 0),
        "retry_of": job.retry_of,
        "failure_reason": job.failure_reason,
        "allowed_actions": [dict(a) for a in st.allowed_actions("job", job.status)],
        "receipt": serialize_receipt(job.receipt, mode),
        "started_at": iso_z(job.started_at),
        "finished_at": iso_z(job.finished_at),
        "created_at": iso_z(job.created_at),
        "updated_at": iso_z(job.updated_at),
        "created_by": job.created_by,
        "created_by_name": job.created_by_name,
    }


# --------------------------------------------------------------------------- 提交 / 执行


def submit_job(
    db: Session,
    *,
    account: Account,
    kind: str,
    job_type: str,
    target_type: str = "",
    target_id: str = "",
    payload: Mapping[str, Any] | None = None,
    idempotency_key: str,
    project_id: str | None = None,
    ctx: RequestContext | None = None,
    max_retries: int = DEFAULT_MAX_RETRIES,
    run: bool = True,
) -> tuple[ProviderJob, bool]:
    """提交作业：**先查幂等键**，重复请求复用既有作业，不重复执行。

    返回 ``(job, deduplicated)``。
    """
    if kind not in PROVIDER_KINDS:
        raise ValidationError(
            "Provider 类型非法",
            field_errors=[{"field": "kind", "message": "必须是 feishu / ai / workbuddy", "type": "value_error"}],
        )
    if job_type not in JOB_TYPES:
        raise ValidationError(
            "作业类型非法",
            field_errors=[{"field": "job_type", "message": "必须是 issue_sync / ai_analysis / workbuddy_submit", "type": "value_error"}],
        )
    key = (idempotency_key or "").strip()
    if not key:
        raise ValidationError(
            "幂等键不能为空",
            field_errors=[{"field": "idempotency_key", "message": "幂等键不能为空", "type": "value_error"}],
        )

    existing = (
        db.execute(select(ProviderJob).where(ProviderJob.idempotency_key == key)).scalars().first()
    )
    if existing is not None:
        # 幂等命中：直接返回既有作业，**不重复执行**
        return existing, True

    now = utcnow()
    job = ProviderJob(
        id=new_id(),
        provider_kind=kind,
        job_type=job_type,
        mode=resolve_mode(kind),
        idempotency_key=key,
        status=st.JOB_QUEUED,
        target_type=target_type or "",
        target_id=target_id or "",
        project_id=project_id,
        payload_json=json.dumps(dict(payload or {}), ensure_ascii=False, sort_keys=True),
        progress=0,
        retry_count=0,
        max_retries=max(0, int(max_retries)),
        retry_of=None,
        failure_reason="",
        created_by=account.id,
        created_by_name=account.name,
        created_at=now,
        updated_at=now,
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    if run:
        run_job(db, job, ctx=ctx)
    return job, False


def _transition_job(db: Session, job: ProviderJob, target: str, *, label: str = "作业") -> None:
    """经 ``JOB_TRANSITIONS`` 校验后迁移（未声明迁移 → 409）。"""
    check_transition("job", current=job.status, target=target, reason=None, label=label)
    job.status = target
    job.updated_at = utcnow()


def run_job(db: Session, job: ProviderJob, *, ctx: RequestContext | None = None) -> ProviderJob:
    """同步执行一次作业（Mock 即时成功）。

    ``queued → running → succeeded``（写回执）或 ``running → failed``（写脱敏失败原因）。
    """
    if job.status == st.JOB_QUEUED:
        _transition_job(db, job, st.JOB_RUNNING)
        job.started_at = utcnow()
        db.commit()
        db.refresh(job)

    if job.status != st.JOB_RUNNING:
        raise ConflictError(
            "作业当前状态不可执行",
            code="illegal_transition",
            extra={
                "machine": "job",
                "current": job.status,
                "target": st.JOB_RUNNING,
                "reason": "仅 queued 作业可进入执行",
            },
        )

    adapter = get_adapter(job.provider_kind, job.mode)
    request = _build_request(job)

    try:
        result = adapter.submit(request, job.idempotency_key)
    except BlockedError as exc:
        return _fail(db, job, str(exc.message))
    except Exception as exc:  # noqa: BLE001 - 兜底：最终失败原因也必须脱敏
        return _fail(db, job, f"{type(exc).__name__}: {exc}")

    _transition_job(db, job, st.JOB_SUCCEEDED)
    job.progress = 100
    job.finished_at = utcnow()

    receipt = ProviderReceipt(
        id=new_id(),
        job_id=job.id,
        external_id=result.external_id,
        is_mock=bool(result.is_mock),
        code=result.code,
        message=result.message,
        body_json=json.dumps(dict(result.body or {}), ensure_ascii=False, sort_keys=True),
        received_at=result.received_at or utcnow(),
    )
    # 同一作业只保留一条回执
    if job.receipt is not None:
        db.delete(job.receipt)
        db.flush()
    db.add(receipt)
    db.commit()
    db.refresh(job)

    audit_business(
        db,
        account=_system_account(job),
        ctx=ctx,
        action="provider_job.succeeded",
        target_type="provider_job",
        target_id=job.id,
        summary=f"{JOB_TYPE_LABELS.get(job.job_type, job.job_type)} 执行成功（{'模拟' if receipt.is_mock else '真实'}）",
        detail={
            "provider_kind": job.provider_kind,
            "mode": job.mode,
            "external_id": receipt.external_id,
            "is_mock": receipt.is_mock,
        },
    )
    return job


def _fail(db: Session, job: ProviderJob, reason: str) -> ProviderJob:
    _transition_job(db, job, st.JOB_FAILED)
    job.failure_reason = str(redact(reason))[:1000]
    job.finished_at = utcnow()
    db.commit()
    db.refresh(job)
    return job


def _build_request(job: ProviderJob) -> dict[str, Any]:
    return {
        "job_id": job.id,
        "job_type": job.job_type,
        "provider_kind": job.provider_kind,
        "target_type": job.target_type,
        "target_id": job.target_id,
        "project_id": job.project_id,
        "payload": _load_json(job.payload_json, {}),
    }


def _system_account(job: ProviderJob) -> Account:
    """构造仅用于审计展示的"执行器"虚拟账号（不落账号表）。"""
    return Account(
        id=job.created_by or "system",
        account="system",
        name=job.created_by_name or "系统执行器",
        role="experience_member",
        password_hash="",
        is_primary=False,
        is_active=True,
    )


# --------------------------------------------------------------------------- 查询


def list_jobs(
    db: Session,
    *,
    kind: str | None = None,
    job_type: str | None = None,
    status: str | None = None,
    target_id: str | None = None,
    project_id: str | None = None,
    page: int = 1,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> dict[str, Any]:
    stmt = select(ProviderJob).order_by(ProviderJob.created_at.desc(), ProviderJob.id.desc())
    if kind:
        stmt = stmt.where(ProviderJob.provider_kind == kind)
    if job_type:
        stmt = stmt.where(ProviderJob.job_type == job_type)
    if status:
        stmt = stmt.where(ProviderJob.status == status)
    if target_id:
        stmt = stmt.where(ProviderJob.target_id == target_id)
    if project_id:
        stmt = stmt.where(ProviderJob.project_id == project_id)
    rows, total = paginate(db, stmt, page=page, page_size=page_size)
    return page_payload(rows, total, page, page_size, serialize_job)


def get_job(db: Session, job_id: str) -> ProviderJob:
    return get_or_404(db, ProviderJob, job_id, "作业")


# --------------------------------------------------------------------------- 重试 / 取消


def retry_job(
    db: Session,
    job: ProviderJob,
    *,
    account: Account,
    ctx: RequestContext | None = None,
) -> ProviderJob:
    """重试失败作业：**新作业 ID** + ``retry_of``；超过上限 → 409 ``retry_limit``。"""
    transition = st.find_transition("job", job.status, st.JOB_QUEUED)
    if transition is None:
        raise ConflictError(
            "仅失败作业可重试",
            code="illegal_transition",
            extra={
                "machine": "job",
                "current": job.status,
                "target": st.JOB_QUEUED,
                "allowed_targets": list(st.allowed_targets("job", job.status)),
                "reason": "仅 failed 可重试（PRD §12.2）",
            },
        )
    if int(job.retry_count or 0) >= int(job.max_retries or 0):
        raise ConflictError(
            "已达到最大重试次数，无法继续重试",
            code="retry_limit",
            extra={
                "machine": "job",
                "current": job.status,
                "target": st.JOB_QUEUED,
                "retry_count": int(job.retry_count or 0),
                "max_retries": int(job.max_retries or 0),
                "guard": "retry_limit",
            },
        )

    now = utcnow()
    new_job = ProviderJob(
        id=new_id(),
        provider_kind=job.provider_kind,
        job_type=job.job_type,
        mode=resolve_mode(job.provider_kind),
        idempotency_key=f"{job.idempotency_key}#retry:{int(job.retry_count or 0) + 1}",
        status=st.JOB_QUEUED,
        target_type=job.target_type,
        target_id=job.target_id,
        project_id=job.project_id,
        payload_json=job.payload_json,
        progress=0,
        retry_count=int(job.retry_count or 0) + 1,
        max_retries=int(job.max_retries or 0),
        retry_of=job.id,
        failure_reason="",
        created_by=account.id,
        created_by_name=account.name,
        created_at=now,
        updated_at=now,
    )
    db.add(new_job)
    db.commit()
    db.refresh(new_job)
    run_job(db, new_job, ctx=ctx)

    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="provider_job.retry",
        target_type="provider_job",
        target_id=new_job.id,
        summary=f"重试作业（原作业 {job.id}）",
        detail={"retry_of": job.id, "retry_count": new_job.retry_count},
    )
    return new_job


def cancel_job(
    db: Session,
    job: ProviderJob,
    *,
    account: Account,
    ctx: RequestContext | None = None,
) -> ProviderJob:
    """取消作业：``queued`` / ``running`` 可取消；``succeeded`` / ``failed`` → 409。"""
    check_transition("job", current=job.status, target=st.JOB_CANCELLED, reason=None, label="作业")

    # 尽力通知适配器（Mock 立即生效；真实骨架不执行外部调用）
    if job.receipt is not None:
        try:
            adapter_receipt = AdapterReceipt(
                external_id=job.receipt.external_id,
                is_mock=bool(job.receipt.is_mock),
                code=job.receipt.code,
                message=job.receipt.message,
            )
            get_adapter(job.provider_kind, job.mode).cancel(adapter_receipt)
        except Exception:  # noqa: BLE001 - 取消失败不影响本地状态收敛
            pass

    job.status = st.JOB_CANCELLED
    job.finished_at = utcnow()
    job.updated_at = utcnow()
    if not job.failure_reason:
        job.failure_reason = "已取消"
    db.commit()
    db.refresh(job)

    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="provider_job.cancel",
        target_type="provider_job",
        target_id=job.id,
        summary="取消作业",
        detail={"job_type": job.job_type, "provider_kind": job.provider_kind},
    )
    return job


# --------------------------------------------------------------------------- Provider 配置


def _sync_config(db: Session, kind: str) -> ProviderConfig:
    cfg = db.get(ProviderConfig, kind)
    if cfg is None:
        cfg = ProviderConfig(
            kind=kind,
            configured=False,
            configured_mode=MODE_MOCK,
            effective_mode=MODE_MOCK,
            endpoint_label="",
            last_test_result="",
            capability_note="",
            created_at=utcnow(),
            updated_at=utcnow(),
        )
        db.add(cfg)
    status = get_adapter(kind, MODE_MOCK).validate_configuration()
    cfg.configured = kind_configured(kind)
    cfg.configured_mode = settings.provider_mode
    cfg.effective_mode = resolve_mode(kind)
    cfg.endpoint_label = status.endpoint_label
    cfg.capability_note = status.capability_note
    cfg.updated_at = utcnow()
    db.commit()
    db.refresh(cfg)
    return cfg


def list_providers(db: Session) -> list[dict[str, Any]]:
    """三类 Provider 状态：**只显示变量是否存在，不回显任何密钥**。"""
    out: list[dict[str, Any]] = []
    for kind in PROVIDER_KINDS:
        cfg = db.get(ProviderConfig, kind)
        status = get_adapter(kind, MODE_MOCK).validate_configuration()
        out.append(
            {
                "kind": kind,
                "label": PROVIDER_LABELS.get(kind, kind),
                "configured": kind_configured(kind),
                "configured_mode": settings.provider_mode,
                "effective_mode": resolve_mode(kind),
                "endpoint_label": status.endpoint_label,
                "capability_note": status.capability_note,
                "last_tested_at": iso_z(cfg.last_tested_at) if cfg else None,
                "last_test_result": cfg.last_test_result if cfg else "",
            }
        )
    return out


def test_provider(
    db: Session,
    kind: str,
    *,
    account: Account,
    ctx: RequestContext | None = None,
) -> dict[str, Any]:
    """执行一次 **Mock 自检** 并记录结果（真实模式不可用时返回明确说明）。"""
    if kind not in PROVIDER_KINDS:
        raise ValidationError(
            "Provider 类型非法",
            field_errors=[{"field": "kind", "message": "必须是 feishu / ai / workbuddy", "type": "value_error"}],
        )
    adapter = get_adapter(kind, MODE_MOCK)
    status = adapter.validate_configuration()
    receipt = adapter.submit({"self_test": True}, f"provider_test:{kind}")
    effective = resolve_mode(kind)

    message = f"模拟自检通过（回执 {receipt.external_id}）"
    if effective != MODE_MOCK:
        message = (
            f"已完成本地 Mock 自检（回执 {receipt.external_id}）；"
            "真实外部调用在本轮范围外，未发起任何网络请求。"
        )

    cfg = _sync_config(db, kind)
    cfg.last_tested_at = utcnow()
    cfg.last_test_result = message
    cfg.updated_at = utcnow()
    db.commit()
    db.refresh(cfg)

    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="provider.test",
        target_type="provider",
        target_id=kind,
        summary=message,
        detail={"kind": kind, "effective_mode": effective, "is_mock": True},
    )
    return {
        "kind": kind,
        "label": PROVIDER_LABELS.get(kind, kind),
        "configured": kind_configured(kind),
        "configured_mode": settings.provider_mode,
        "effective_mode": effective,
        "endpoint_label": status.endpoint_label,
        "capability_note": status.capability_note,
        "last_tested_at": iso_z(cfg.last_tested_at),
        "last_test_result": cfg.last_test_result,
        "is_mock": True,
        "real_call_executed": False,
        "message": message,
        "receipt": {
            "external_id": receipt.external_id,
            "is_mock": True,
            "mode": MODE_MOCK,
            "code": receipt.code,
            "message": receipt.message,
        },
    }


# --------------------------------------------------------------------------- 便捷同步


def sync_issues(
    db: Session,
    issue_ids: Iterable[str],
    *,
    account: Account,
    ctx: RequestContext | None = None,
) -> list[dict[str, Any]]:
    """问题一键同步（Mock）：为每个问题以 ``issue_sync:{issue_id}`` 提交幂等作业。"""
    ids = [str(i).strip() for i in issue_ids if str(i).strip()]
    if not ids:
        raise ValidationError(
            "请至少选择一个问题",
            field_errors=[{"field": "issue_ids", "message": "请至少选择一个问题", "type": "value_error"}],
        )
    results: list[dict[str, Any]] = []
    for issue_id in ids:
        issue = get_or_404(db, Issue, issue_id, "问题")
        job, deduplicated = submit_job(
            db,
            account=account,
            kind=PROVIDER_FEISHU,
            job_type=JOB_TYPE_ISSUE_SYNC,
            target_type="issue",
            target_id=issue_id,
            payload={"issue_code": issue.code, "project_id": issue.project_id},
            idempotency_key=f"issue_sync:{issue_id}",
            project_id=issue.project_id,
            ctx=ctx,
        )
        results.append(
            {
                "issue_id": issue_id,
                "job_id": job.id,
                "deduplicated": deduplicated,
                "receipt": serialize_receipt(job.receipt, job.mode),
            }
        )
    return results


# 供其它模块（AI 会话）复用的作业类型常量
JOB_AI_ANALYSIS = JOB_TYPE_AI_ANALYSIS
