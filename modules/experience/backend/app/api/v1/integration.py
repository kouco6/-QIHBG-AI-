"""集成 API：Provider 作业、协作空间与 AI 会话（T13 / PRD §12、§13）。

端点族：

| 路径 | 说明 |
|---|---|
| ``/provider-jobs`` | 作业列表 / 详情 / 重试 / 取消 / 问题一键同步 |
| ``/providers`` | 三类 Provider 配置状态（不回显密钥）/ 自检 |
| ``/collaboration/*`` | 讨论串、消息、关闭讨论 |
| ``/ai-conversations/*`` | AI 会话、消息、重试、上下文汇总 |

统一约束：所有端点要求登录（401）；不存在 404；非法状态迁移 / 关闭后发帖 409；
校验失败 422；写操作写业务审计。**真实外部调用在本轮范围外，一律使用 Mock。**
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query, status

from app.api.deps import RequestContext, get_current_account, get_request_context
from app.core.db import get_db
from app.models.account import Account
from app.schemas.integration import (
    AiMessageCreateRequest,
    ConversationCreateRequest,
    IssueSyncRequest,
    MessageCreateRequest,
    ThreadCreateRequest,
)
from app.services import collaboration as collab_service
from app.services import provider as provider_service
from sqlalchemy.orm import Session

router = APIRouter(tags=["integration"])


# --------------------------------------------------------------------------- Provider 作业


@router.post(
    "/provider-jobs/issue-sync",
    status_code=status.HTTP_201_CREATED,
    summary="问题一键同步（Mock，幂等键 issue_sync:{issue_id}）",
)
async def issue_sync(
    payload: IssueSyncRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    items = provider_service.sync_issues(db, payload.issue_ids, account=account, ctx=ctx)
    return {"mode": "mock", "is_mock": True, "items": items, "total": len(items)}


@router.get("/provider-jobs", summary="Provider 作业列表（过滤 + 分页，含 Mock 标识）")
async def list_provider_jobs(
    kind: str | None = Query(default=None, description="feishu / ai / workbuddy"),
    job_type: str | None = Query(default=None),
    job_status: str | None = Query(default=None, alias="status"),
    target_id: str | None = Query(default=None),
    project_id: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=provider_service.DEFAULT_PAGE_SIZE, ge=1, le=200),
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    return provider_service.list_jobs(
        db,
        kind=kind,
        job_type=job_type,
        status=job_status,
        target_id=target_id,
        project_id=project_id,
        page=page,
        page_size=page_size,
    )


@router.get("/provider-jobs/{job_id}", summary="作业详情（含回执与允许动作）")
async def get_provider_job(
    job_id: str,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    job = provider_service.get_job(db, job_id)
    return provider_service.serialize_job(job)


@router.post("/provider-jobs/{job_id}/retry", summary="重试失败作业（仅 failed；新作业 ID + retry_of）")
async def retry_provider_job(
    job_id: str,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    job = provider_service.get_job(db, job_id)
    new_job = provider_service.retry_job(db, job, account=account, ctx=ctx)
    return provider_service.serialize_job(new_job)


@router.post("/provider-jobs/{job_id}/cancel", summary="取消作业（queued / running 可取消）")
async def cancel_provider_job(
    job_id: str,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    job = provider_service.get_job(db, job_id)
    job = provider_service.cancel_job(db, job, account=account, ctx=ctx)
    return provider_service.serialize_job(job)


# --------------------------------------------------------------------------- Provider 配置


@router.get("/providers", summary="三类 Provider 状态（只显示是否配置，不回显密钥）")
async def list_providers(
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    items = provider_service.list_providers(db)
    return {
        "items": items,
        "mode_policy": "未配置外部凭证时自动降级为本地 Mock；真实外部调用在本轮范围外。",
    }


@router.post("/providers/{kind}/test", summary="Provider 自检（本地 Mock，不发起外部调用）")
async def test_provider(
    kind: str,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    return provider_service.test_provider(db, kind, account=account, ctx=ctx)


# --------------------------------------------------------------------------- 协作空间


@router.get("/collaboration/threads", summary="讨论串列表（项目过滤 + 分页）")
async def list_threads(
    project_id: str | None = Query(default=None),
    thread_status: str | None = Query(default=None, alias="status"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=collab_service.DEFAULT_PAGE_SIZE, ge=1, le=200),
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    return collab_service.list_threads(
        db, project_id=project_id, status=thread_status, page=page, page_size=page_size
    )


@router.post(
    "/collaboration/threads",
    status_code=status.HTTP_201_CREATED,
    summary="发起讨论（title 必填）",
)
async def create_thread(
    payload: ThreadCreateRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    thread = collab_service.create_thread(db, account=account, payload=payload, ctx=ctx)
    return collab_service.thread_detail(db, thread)


@router.get("/collaboration/threads/{thread_id}", summary="讨论串详情（串 + 消息 + 引用标签）")
async def get_thread(
    thread_id: str,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    thread = collab_service.get_thread(db, thread_id)
    return collab_service.thread_detail(db, thread)


@router.post(
    "/collaboration/threads/{thread_id}/messages",
    status_code=status.HTTP_201_CREATED,
    summary="回复讨论（空白 / 超长 / 代录缺实际提供人 → 422；已关闭 → 409）",
)
async def create_thread_message(
    thread_id: str,
    payload: MessageCreateRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    thread = collab_service.get_thread(db, thread_id)
    message = collab_service.post_message(db, thread, account=account, payload=payload, ctx=ctx)
    return {
        "message": collab_service.serialize_message(message),
        "thread": collab_service.thread_detail(db, thread),
    }


@router.post("/collaboration/threads/{thread_id}/close", summary="关闭讨论（关闭后仅可读）")
async def close_thread(
    thread_id: str,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    thread = collab_service.get_thread(db, thread_id)
    thread = collab_service.close_thread(db, thread, account=account, ctx=ctx)
    return collab_service.thread_detail(db, thread)


# --------------------------------------------------------------------------- AI 会话


@router.get("/ai-conversations", summary="AI 会话列表（项目过滤 + 分页）")
async def list_conversations(
    project_id: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=collab_service.DEFAULT_PAGE_SIZE, ge=1, le=200),
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    return collab_service.list_conversations(db, project_id=project_id, page=page, page_size=page_size)


@router.post(
    "/ai-conversations",
    status_code=status.HTTP_201_CREATED,
    summary="新建 AI 会话（scope 实体 ID 必须属于该项目，否则 422）",
)
async def create_conversation(
    payload: ConversationCreateRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    conv = collab_service.create_conversation(db, account=account, payload=payload, ctx=ctx)
    return collab_service.conversation_detail(db, conv)


@router.get("/ai-conversations/{conversation_id}", summary="AI 会话详情（会话 + 全部消息，持久化）")
async def get_conversation(
    conversation_id: str,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    conv = collab_service.get_conversation(db, conversation_id)
    return collab_service.conversation_detail(db, conv)


@router.post(
    "/ai-conversations/{conversation_id}/messages",
    status_code=status.HTTP_201_CREATED,
    summary="发送消息（提交 Mock AI 作业并渲染确定性助手摘要）",
)
async def create_ai_message(
    conversation_id: str,
    payload: AiMessageCreateRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    conv = collab_service.get_conversation(db, conversation_id)
    return collab_service.post_ai_message(db, conv, account=account, payload=payload, ctx=ctx)


@router.post("/ai-conversations/{conversation_id}/retry", summary="重试最后一条助手消息（新作业 ID）")
async def retry_ai_conversation(
    conversation_id: str,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    conv = collab_service.get_conversation(db, conversation_id)
    return collab_service.retry_ai_conversation(db, conv, account=account, ctx=ctx)


@router.get(
    "/ai-conversations/{conversation_id}/context-summary",
    summary="上下文范围与统计（模块 / 等级 / 指标 / 版本 / 产品线 / 事业部聚合）",
)
async def conversation_context_summary(
    conversation_id: str,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    conv = collab_service.get_conversation(db, conversation_id)
    return collab_service.context_summary(db, conv)
