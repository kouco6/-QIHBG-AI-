"""协作空间与 AI 会话服务（T13 / PRD §13）。

v1.1 重建版（原文件因编辑事故丢失，依据 integration 路由、模型与测试契约重建）：

- 讨论串：项目内协作，可关联产物 / 问题；关闭后仅可读；外部意见走代录（必须填实际提供人）；
- AI 会话：按项目持久化，scope 实体必须属于项目；消息提交 Mock AI 作业并渲染
  确定性助手摘要（数据来自真实问题集合，不编造）。
"""

from __future__ import annotations

import json
from collections import Counter
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import RequestContext
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.core.security import new_id
from app.core.timeutil import iso_z, utcnow
from app.models.account import Account
from app.models.collab import (
    AI_SCOPES,
    AI_SCOPE_ISSUES,
    AI_SCOPE_LABELS,
    ROLE_ASSISTANT,
    ROLE_USER,
    THREAD_CLOSED,
    THREAD_OPEN,
    AiConversation,
    AiMessage,
    CollaborationMessage,
    CollaborationThread,
)
from app.models.flow import Project
from app.models.issue import Issue
from app.services.common import audit_business, get_or_404
from app.services.provider import resolve_mode, serialize_job, submit_job

DEFAULT_PAGE_SIZE = 50

MAX_BODY_LENGTH = 4000

MOCK_MODE = "mock"


# --------------------------------------------------------------------------- 序列化


def serialize_message(message: CollaborationMessage) -> dict[str, Any]:
    return {
        "id": message.id,
        "thread_id": message.thread_id,
        "body": message.body,
        "ref_type": message.ref_type,
        "ref_id": message.ref_id,
        "ref_label": message.ref_label,
        "is_proxy": message.is_proxy,
        "actual_provider": message.actual_provider,
        "author_id": message.author_id,
        "author_name": message.author_name,
        "created_at": iso_z(message.created_at),
    }


def _thread_summary(thread: CollaborationThread) -> dict[str, Any]:
    return {
        "id": thread.id,
        "project_id": thread.project_id,
        "title": thread.title,
        "status": thread.status,
        "node_code": thread.node_code,
        "ref_type": thread.ref_type,
        "ref_id": thread.ref_id,
        "started_by": thread.started_by,
        "started_by_name": thread.started_by_name,
        "reply_count": thread.reply_count,
        "last_reply_at": iso_z(thread.last_reply_at),
        "members_text": thread.members_text,
        "created_at": iso_z(thread.created_at),
        "updated_at": iso_z(thread.updated_at),
    }


def thread_detail(db: Session, thread: CollaborationThread) -> dict[str, Any]:
    payload = _thread_summary(thread)
    payload["messages"] = [serialize_message(m) for m in thread.messages]
    return payload


def _conversation_summary(conv: AiConversation) -> dict[str, Any]:
    return {
        "id": conv.id,
        "project_id": conv.project_id,
        "title": conv.title,
        "scope_type": conv.scope_type,
        "scope_type_label": AI_SCOPE_LABELS.get(conv.scope_type, conv.scope_type),
        "scope": _load_json(conv.scope_json, {}),
        "template_key": conv.template_key,
        "provider_kind": conv.provider_kind,
        "mode": conv.mode,
        "is_mock": conv.mode == MOCK_MODE,
        "status": conv.status,
        "message_count": conv.message_count,
        "last_message_at": iso_z(conv.last_message_at),
        "created_at": iso_z(conv.created_at),
        "updated_at": iso_z(conv.updated_at),
    }


def conversation_detail(db: Session, conv: AiConversation) -> dict[str, Any]:
    payload = _conversation_summary(conv)
    payload["messages"] = [_serialize_ai_message(m) for m in conv.messages]
    return payload


def _serialize_ai_message(message: AiMessage) -> dict[str, Any]:
    return {
        "id": message.id,
        "conversation_id": message.conversation_id,
        "role": message.role,
        "content": message.content,
        "refs": _load_json(message.refs_json, []),
        "job_id": message.job_id,
        "is_mock": message.is_mock,
        "author_name": message.author_name,
        "created_at": iso_z(message.created_at),
    }


def _load_json(raw: str | None, fallback: Any) -> Any:
    if not raw:
        return fallback
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return fallback


# --------------------------------------------------------------------------- 讨论串


def get_thread(db: Session, thread_id: str) -> CollaborationThread:
    return get_or_404(db, CollaborationThread, thread_id, "讨论串")


def list_threads(
    db: Session,
    *,
    project_id: str | None = None,
    status: str | None = None,
    page: int = 1,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> dict[str, Any]:
    stmt = select(CollaborationThread)
    if project_id:
        stmt = stmt.where(CollaborationThread.project_id == project_id)
    if status:
        stmt = stmt.where(CollaborationThread.status == status)
    total = int(db.execute(select(func.count()).select_from(stmt.subquery())).scalar() or 0)
    rows = (
        db.execute(
            stmt.order_by(CollaborationThread.updated_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
        .scalars()
        .all()
    )
    return {
        "page": max(1, page),
        "page_size": page_size,
        "total": total,
        "items": [_thread_summary(row) for row in rows],
    }


def create_thread(
    db: Session,
    *,
    account: Account,
    payload: Any,
    ctx: RequestContext | None,
) -> CollaborationThread:
    project = get_or_404(db, Project, payload.project_id, "项目")
    title = (payload.title or "").strip()
    if not title:
        raise ValidationError(
            "讨论标题必填",
            field_errors=[{"field": "title", "message": "标题不能为空", "type": "value_error"}],
        )
    now = utcnow()
    thread = CollaborationThread(
        id=new_id(),
        project_id=project.id,
        title=title,
        status=THREAD_OPEN,
        node_code=(payload.node_code or "").strip(),
        ref_type=(payload.ref_type or "").strip(),
        ref_id=(payload.ref_id or "").strip(),
        started_by=account.id,
        started_by_name=account.name,
        reply_count=0,
        last_reply_at=None,
        members_text=(payload.members_text or "").strip(),
        created_at=now,
        updated_at=now,
    )
    db.add(thread)
    db.commit()
    db.refresh(thread)
    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="thread_created",
        target_type="collaboration_thread",
        target_id=thread.id,
        summary=f"发起讨论「{thread.title}」",
        detail={"project_id": thread.project_id, "node_code": thread.node_code},
    )
    return thread


def post_message(
    db: Session,
    thread: CollaborationThread,
    *,
    account: Account,
    payload: Any,
    ctx: RequestContext | None,
) -> CollaborationMessage:
    if thread.status == THREAD_CLOSED:
        raise ConflictError("讨论已关闭，仅可读", code="thread_closed")

    problems: list[dict[str, str]] = []
    body = (payload.body or "").strip()
    if not body:
        problems.append({"field": "body", "message": "回复内容不能为空白", "type": "value_error"})
    elif len(body) > MAX_BODY_LENGTH:
        problems.append(
            {"field": "body", "message": f"回复内容不能超过 {MAX_BODY_LENGTH} 字", "type": "value_error"}
        )
    is_proxy = bool(payload.is_proxy)
    actual_provider = (payload.actual_provider or "").strip()
    if is_proxy and not actual_provider:
        problems.append(
            {"field": "actual_provider", "message": "代录发言必须填写实际提供人", "type": "value_error"}
        )
    if problems:
        raise ValidationError("回复内容校验失败", field_errors=problems)

    ref_type = (payload.ref_type or "").strip()
    ref_id = (payload.ref_id or "").strip()
    ref_label = (payload.ref_label or "").strip()
    if ref_id and not ref_label and ref_type == "issue":
        issue = db.get(Issue, ref_id)
        if issue is not None:
            ref_label = issue.code

    now = utcnow()
    message = CollaborationMessage(
        id=new_id(),
        thread_id=thread.id,
        body=body,
        ref_type=ref_type,
        ref_id=ref_id,
        ref_label=ref_label,
        is_proxy=is_proxy,
        actual_provider=actual_provider,
        author_id=account.id,
        author_name=account.name,
        created_at=now,
        updated_at=now,
    )
    db.add(message)
    thread.reply_count = int(thread.reply_count or 0) + 1
    thread.last_reply_at = now
    thread.updated_at = now
    db.commit()
    db.refresh(message)
    db.refresh(thread)
    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="thread_message_created",
        target_type="collaboration_thread",
        target_id=thread.id,
        summary=f"回复讨论「{thread.title}」",
        detail={"thread_id": thread.id, "message_id": message.id, "is_proxy": is_proxy},
    )
    return message


def close_thread(
    db: Session,
    thread: CollaborationThread,
    *,
    account: Account,
    ctx: RequestContext | None,
) -> CollaborationThread:
    if thread.status == THREAD_CLOSED:
        return thread
    thread.status = THREAD_CLOSED
    thread.updated_at = utcnow()
    db.commit()
    db.refresh(thread)
    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="thread_closed",
        target_type="collaboration_thread",
        target_id=thread.id,
        summary=f"关闭讨论「{thread.title}」",
        detail={"thread_id": thread.id},
    )
    return thread


# --------------------------------------------------------------------------- AI 会话


def get_conversation(db: Session, conversation_id: str) -> AiConversation:
    return get_or_404(db, AiConversation, conversation_id, "AI 会话")


def list_conversations(
    db: Session,
    *,
    project_id: str | None = None,
    page: int = 1,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> dict[str, Any]:
    stmt = select(AiConversation)
    if project_id:
        stmt = stmt.where(AiConversation.project_id == project_id)
    total = int(db.execute(select(func.count()).select_from(stmt.subquery())).scalar() or 0)
    rows = (
        db.execute(
            stmt.order_by(AiConversation.updated_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
        .scalars()
        .all()
    )
    return {
        "page": max(1, page),
        "page_size": page_size,
        "total": total,
        "items": [_conversation_summary(row) for row in rows],
    }


def _validate_scope(db: Session, project: Project, scope_type: str, scope: dict[str, Any]) -> dict[str, Any]:
    """scope 实体必须属于项目；返回规范化后的 scope 字典。"""
    if scope_type not in AI_SCOPES:
        raise ValidationError(
            "AI 会话范围类型非法",
            field_errors=[
                {"field": "scope_type", "message": f"可选值：{' / '.join(AI_SCOPES)}", "type": "value_error"}
            ],
        )
    normalized: dict[str, Any] = {}
    if scope_type == AI_SCOPE_ISSUES:
        issue_ids = [str(v) for v in (scope or {}).get("issue_ids", []) if str(v).strip()]
        if issue_ids:
            rows = (
                db.execute(select(Issue).where(Issue.id.in_(issue_ids), Issue.project_id == project.id))
                .scalars()
                .all()
            )
            found = {row.id for row in rows}
            missing = [iid for iid in issue_ids if iid not in found]
            if missing:
                raise ValidationError(
                    "范围包含不属于该项目的实体",
                    field_errors=[
                        {"field": "scope", "message": f"问题 {missing[0]} 不属于项目，禁止引用", "type": "value_error"}
                    ],
                )
        normalized["issue_ids"] = issue_ids
    elif scope_type == "snapshot":
        snapshot_id = str((scope or {}).get("snapshot_id", "") or "").strip()
        normalized["snapshot_id"] = snapshot_id
    return normalized


def create_conversation(
    db: Session,
    *,
    account: Account,
    payload: Any,
    ctx: RequestContext | None,
) -> AiConversation:
    project = get_or_404(db, Project, payload.project_id, "项目")
    scope_type = (payload.scope_type or "project").strip()
    scope = _validate_scope(db, project, scope_type, payload.scope or {})
    mode = resolve_mode("ai")
    now = utcnow()
    conv = AiConversation(
        id=new_id(),
        project_id=project.id,
        title=(payload.title or "").strip() or "AI 分析会话",
        scope_type=scope_type,
        scope_json=json.dumps(scope, ensure_ascii=False, sort_keys=True),
        template_key=(payload.template_key or "summary").strip() or "summary",
        provider_kind="ai",
        mode=mode,
        status="active",
        message_count=0,
        last_message_at=None,
        created_at=now,
        updated_at=now,
    )
    db.add(conv)
    db.commit()
    db.refresh(conv)
    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="ai_conversation_created",
        target_type="ai_conversation",
        target_id=conv.id,
        summary=f"新建 AI 会话「{conv.title}」（{AI_SCOPE_LABELS.get(conv.scope_type, conv.scope_type)}）",
        detail={"project_id": conv.project_id, "scope_type": conv.scope_type, "mode": conv.mode},
    )
    return conv


def _scope_issues(db: Session, conv: AiConversation) -> list[Issue]:
    """按会话范围取出问题集合（数据必须来自真实库）。"""
    scope = _load_json(conv.scope_json, {})
    stmt = select(Issue).where(Issue.project_id == conv.project_id)
    if conv.scope_type == AI_SCOPE_ISSUES:
        issue_ids = [str(v) for v in scope.get("issue_ids", [])]
        if issue_ids:
            stmt = stmt.where(Issue.id.in_(issue_ids))
    return list(db.execute(stmt.order_by(Issue.code)).scalars().all())


def _mock_summary_content(conv: AiConversation, issues: list[Issue]) -> str:
    """确定性 Mock 摘要：只陈述真实库中的统计，不编造结论。"""
    by_module = Counter((issue.module or "未设置") for issue in issues)
    by_severity = Counter((issue.severity or "未设置") for issue in issues)
    module_txt = "、".join(f"{k} {v} 条" for k, v in by_module.most_common()) or "无"
    severity_txt = "、".join(f"{k} {v} 条" for k, v in by_severity.most_common()) or "无"
    return (
        f"本地模拟分析（Mock）：会话「{conv.title}」范围内共 {len(issues)} 条问题。"
        f"按模块：{module_txt}；按严重度：{severity_txt}。"
        "以上为确定性本地统计，非模型生成；接入真实 AI Provider 后将替换为模型分析。"
    )


def _persist_and_run(
    db: Session,
    conv: AiConversation,
    *,
    account: Account,
    content: str,
    ctx: RequestContext | None,
    idempotency_key: str,
) -> tuple[AiMessage, AiMessage, Any, bool]:
    """写入用户消息 → 提交并执行 Mock AI 作业 → 写入助手消息。返回 (user, assistant, job, dedup)。"""
    now = utcnow()
    user_message = AiMessage(
        id=new_id(),
        conversation_id=conv.id,
        role=ROLE_USER,
        content=content,
        refs_json="[]",
        job_id=None,
        is_mock=conv.mode == MOCK_MODE,
        author_name=account.name,
        created_at=now,
        updated_at=now,
    )
    db.add(user_message)
    db.commit()
    db.refresh(user_message)

    issues = _scope_issues(db, conv)
    job, deduplicated = submit_job(
        db,
        account=account,
        kind="ai",
        job_type="ai_analysis",
        target_type="ai_conversation",
        target_id=conv.id,
        payload={
            "conversation_id": conv.id,
            "prompt": content,
            "scope_type": conv.scope_type,
            "issue_count": len(issues),
        },
        idempotency_key=idempotency_key,
        project_id=conv.project_id,
        ctx=ctx,
    )

    assistant_message = AiMessage(
        id=new_id(),
        conversation_id=conv.id,
        role=ROLE_ASSISTANT,
        content=_mock_summary_content(conv, issues),
        refs_json=json.dumps(
            [{"ref_type": "provider_job", "ref_id": job.id}], ensure_ascii=False
        ),
        job_id=job.id,
        is_mock=True,
        author_name="AI 助手（Mock）",
        created_at=utcnow(),
        updated_at=utcnow(),
    )
    db.add(assistant_message)
    conv.message_count = int(conv.message_count or 0) + 2
    conv.last_message_at = assistant_message.created_at
    conv.updated_at = utcnow()
    db.commit()
    db.refresh(assistant_message)
    db.refresh(conv)
    db.refresh(job)
    return user_message, assistant_message, job, deduplicated


def post_ai_message(
    db: Session,
    conv: AiConversation,
    *,
    account: Account,
    payload: Any,
    ctx: RequestContext | None,
) -> dict[str, Any]:
    content = (payload.content or "").strip()
    if not content:
        raise ValidationError(
            "消息内容不能为空白",
            field_errors=[{"field": "content", "message": "消息内容不能为空白", "type": "value_error"}],
        )
    user_message, assistant_message, job, _dedup = _persist_and_run(
        db, conv, account=account, content=content, ctx=ctx,
        idempotency_key=f"ai_conv:{conv.id}:{user_message.id}",
    )
    return {
        "user_message": _serialize_ai_message(user_message),
        "assistant_message": _serialize_ai_message(assistant_message),
        "job": serialize_job(job),
        "conversation": conversation_detail(db, conv),
    }


def retry_ai_conversation(
    db: Session,
    conv: AiConversation,
    *,
    account: Account,
    ctx: RequestContext | None,
) -> dict[str, Any]:
    last_assistant = next(
        (m for m in reversed(conv.messages) if m.role == ROLE_ASSISTANT), None
    )
    if last_assistant is None:
        raise ConflictError("会话内没有可重试的助手消息", code="nothing_to_retry")

    issues = _scope_issues(db, conv)
    job, deduplicated = submit_job(
        db,
        account=account,
        kind="ai",
        job_type="ai_analysis",
        target_type="ai_conversation",
        target_id=conv.id,
        payload={
            "conversation_id": conv.id,
            "prompt": f"重试：{last_assistant.id}",
            "scope_type": conv.scope_type,
            "issue_count": len(issues),
        },
        idempotency_key=f"ai_conv:{conv.id}:retry:{new_id()}",
        project_id=conv.project_id,
        ctx=ctx,
    )
    now = utcnow()
    assistant_message = AiMessage(
        id=new_id(),
        conversation_id=conv.id,
        role=ROLE_ASSISTANT,
        content=_mock_summary_content(conv, issues),
        refs_json=json.dumps(
            [{"ref_type": "provider_job", "ref_id": job.id}], ensure_ascii=False
        ),
        job_id=job.id,
        is_mock=True,
        author_name="AI 助手（Mock）",
        created_at=now,
        updated_at=now,
    )
    db.add(assistant_message)
    conv.message_count = int(conv.message_count or 0) + 1
    conv.last_message_at = now
    conv.updated_at = now
    db.commit()
    db.refresh(assistant_message)
    db.refresh(conv)
    db.refresh(job)
    return {
        "job": serialize_job(job),
        "assistant_message": _serialize_ai_message(assistant_message),
        "retried_from": last_assistant.id,
        "deduplicated": deduplicated,
    }


def context_summary(db: Session, conv: AiConversation) -> dict[str, Any]:
    """上下文范围与统计（按模块 / 等级 / 指标 / 版本 / 系统 / 事业部聚合）。"""
    issues = _scope_issues(db, conv)
    system_ids = {i.system_id for i in issues if i.system_id}

    system_map: dict[str, str] = {}
    if system_ids:
        from app.models.systems import System

        for system in db.execute(select(System).where(System.id.in_(system_ids))).scalars().all():
            system_map[system.id] = system.name or system.code

    def _counter(attr: str) -> dict[str, int]:
        c: Counter[str] = Counter()
        for issue in issues:
            value = getattr(issue, attr, None) or "未设置"
            c[str(value)] += 1
        return dict(c.most_common())

    by_system: Counter[str] = Counter()
    for issue in issues:
        by_system[system_map.get(issue.system_id or "", "未归系统")] += 1

    project = db.get(Project, conv.project_id)
    return {
        "conversation_id": conv.id,
        "project_id": conv.project_id,
        "project_name": project.name if project else "",
        "scope_type": conv.scope_type,
        "scope_type_label": AI_SCOPE_LABELS.get(conv.scope_type, conv.scope_type),
        "scope": _load_json(conv.scope_json, {}),
        "mode": conv.mode,
        "is_mock": conv.mode == MOCK_MODE,
        "issue_total": len(issues),
        "by_module": _counter("module"),
        "by_business_level": _counter("business_level"),
        "by_severity": _counter("severity"),
        "by_metric_l1": _counter("metric_l1"),
        "by_version": _counter("version_code"),
        "by_system": dict(by_system),
        "by_division": _counter("division_id"),
        "generated_from": "本地统计（Mock，数据来自项目真实问题集合）",
    }


__all__ = [
    "DEFAULT_PAGE_SIZE",
    "close_thread",
    "context_summary",
    "conversation_detail",
    "create_conversation",
    "create_thread",
    "get_conversation",
    "get_thread",
    "list_conversations",
    "list_threads",
    "post_ai_message",
    "post_message",
    "retry_ai_conversation",
    "serialize_message",
    "thread_detail",
]
