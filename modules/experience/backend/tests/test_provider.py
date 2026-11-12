"""T13 验收：Provider 适配层、作业状态机、幂等、重试 / 取消与密钥不回显。"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings
from app.core.errors import BlockedError
from app.core.security import new_id
from app.core.timeutil import utcnow
from app.models.account import Account
from app.models.flow import Division, Project
from app.models.issue import Issue
from app.models.systems import System
from app.models.provider import MODE_MOCK, ProviderJob
from app.providers import get_adapter, resolve_mode
from app.providers.mock import MockAdapter


# --------------------------------------------------------------------------- 夹具


@pytest.fixture()
def project(session_factory: sessionmaker[Session]) -> dict[str, object]:
    ids: dict[str, object] = {
        "division_id": new_id(),
        "system_id": new_id(),
        "project_id": new_id(),
        "issue_ids": [new_id(), new_id()],
    }
    with session_factory() as db:
        db.add(Division(id=ids["division_id"], code="DIV-PRV-001", name="会议事业部"))
        db.add(
            System(
                id=ids["system_id"],
                code="SYS-PRV-001",
                name="会议协作系统",
                division_id=ids["division_id"],
                scheme_id="scheme-default",
            )
        )
        db.add(
            Project(
                id=ids["project_id"],
                code="PRJ-PRV-001",
                name="会议一体机体验项目",
                system_id=ids["system_id"],
                version_code="V7.32",
                division_id=ids["division_id"],
                project_type="new_product",
            )
        )
        for idx, issue_id in enumerate(ids["issue_ids"], start=1):
            db.add(
                Issue(
                    id=issue_id,
                    code=f"ISS-PRV-001-{idx:04d}",
                    project_id=ids["project_id"],
                    system_id=ids["system_id"],
                    division_id=ids["division_id"],
                    module="会议预约",
                    description=f"同步用问题 {idx}",
                )
            )
        db.commit()
    return ids


def _first_issue(project: dict[str, object]) -> str:
    return str(project["issue_ids"][0])  # type: ignore[index]


def _sync(client: TestClient, issue_ids: list[str]) -> tuple[int, dict]:
    resp = client.post("/api/v1/provider-jobs/issue-sync", json={"issue_ids": issue_ids})
    return resp.status_code, resp.json()


# --------------------------------------------------------------------------- 适配层单元


def test_mock_adapter_is_deterministic_and_poll_progresses() -> None:
    adapter = get_adapter("feishu", MODE_MOCK)
    assert isinstance(adapter, MockAdapter)
    first = adapter.submit({"x": 1}, "idem-1")
    second = adapter.submit({"x": 2}, "idem-1")
    assert first.external_id == second.external_id
    assert first.external_id.startswith("mock_feishu_")
    assert len(first.external_id) == len("mock_feishu_") + 8
    assert first.is_mock is True
    assert [adapter.poll(first).progress for _ in range(4)] == [0, 40, 80, 100]


def test_resolve_mode_falls_back_to_mock_without_credentials() -> None:
    assert settings.effective_provider_mode == "mock"
    for kind in ("feishu", "ai", "workbuddy"):
        assert resolve_mode(kind) == MODE_MOCK
        assert get_adapter(kind).mode == MODE_MOCK


def test_real_skeleton_blocks_external_calls() -> None:
    adapter = get_adapter("feishu", "real")
    status = adapter.validate_configuration()
    assert status.mode == "real"
    with pytest.raises(BlockedError):
        adapter.submit({}, "idem")
    with pytest.raises(BlockedError):
        adapter.poll(None)  # type: ignore[arg-type]


# --------------------------------------------------------------------------- 作业 API


def test_issue_sync_is_idempotent(client: TestClient, setup_primary: dict, project: dict[str, object]) -> None:
    issue_id = _first_issue(project)
    code, first = _sync(client, [issue_id])
    assert code == 201, first
    assert first["is_mock"] is True
    item = first["items"][0]
    assert item["deduplicated"] is False
    assert item["receipt"]["external_id"].startswith("mock_feishu_")
    assert item["receipt"]["is_mock"] is True

    code2, second = _sync(client, [issue_id])
    assert code2 == 201, second
    assert second["items"][0]["deduplicated"] is True
    assert second["items"][0]["job_id"] == item["job_id"]

    listing = client.get("/api/v1/provider-jobs", params={"target_id": issue_id}).json()
    assert listing["total"] == 1


def test_job_detail_shows_state_machine_and_mock_flags(
    client: TestClient, setup_primary: dict, project: dict[str, object]
) -> None:
    _code, payload = _sync(client, [_first_issue(project)])
    job_id = payload["items"][0]["job_id"]
    job = client.get(f"/api/v1/provider-jobs/{job_id}").json()
    assert job["status"] == "succeeded"
    assert job["is_mock"] is True
    assert job["mode"] == "mock"
    assert job["progress"] == 100
    assert job["receipt"]["mode"] == "mock"
    assert job["receipt"]["is_mock"] is True
    # 合法迁移：queued -> running -> succeeded 之后没有可选动作
    assert job["allowed_actions"] == []
    assert job["started_at"] and job["finished_at"]


def test_run_job_legal_transition_queue_to_running_to_succeeded(
    client: TestClient, setup_primary: dict, session_factory: sessionmaker[Session], project: dict[str, object]
) -> None:
    from app.services import provider as provider_service

    with session_factory() as db:
        account = db.execute(select(Account)).scalars().first()
        assert account is not None
        job, dedup = provider_service.submit_job(
            db,
            account=account,
            kind="feishu",
            job_type="issue_sync",
            target_type="issue",
            target_id=_first_issue(project),
            payload={},
            idempotency_key="manual:queued",
            project_id=str(project["project_id"]),
            run=False,
        )
        assert dedup is False
        assert job.status == "queued"
        assert job.progress == 0
        provider_service.run_job(db, job)
        assert job.status == "succeeded"
        assert job.receipt is not None and job.receipt.is_mock is True


def test_retry_requires_failed(client: TestClient, setup_primary: dict, project: dict[str, object]) -> None:
    _code, payload = _sync(client, [_first_issue(project)])
    job_id = payload["items"][0]["job_id"]
    resp = client.post(f"/api/v1/provider-jobs/{job_id}/retry")
    assert resp.status_code == 409, resp.text
    assert resp.json()["code"] == "illegal_transition"


def test_failed_job_retry_creates_new_job_and_retry_limit(
    client: TestClient, setup_primary: dict, session_factory: sessionmaker[Session], project: dict[str, object]
) -> None:
    with session_factory() as db:
        account = db.execute(select(Account)).scalars().first()
        now = utcnow()
        failed = ProviderJob(
            id=new_id(),
            provider_kind="feishu",
            job_type="issue_sync",
            mode="mock",
            idempotency_key="failed:1",
            status="failed",
            target_type="issue",
            target_id=_first_issue(project),
            project_id=str(project["project_id"]),
            payload_json="{}",
            progress=0,
            retry_count=0,
            max_retries=1,
            failure_reason="模拟失败",
            created_by=account.id,
            created_by_name=account.name,
            created_at=now,
            updated_at=now,
        )
        limited = ProviderJob(
            id=new_id(),
            provider_kind="feishu",
            job_type="issue_sync",
            mode="mock",
            idempotency_key="failed:2",
            status="failed",
            target_type="issue",
            target_id=_first_issue(project),
            project_id=str(project["project_id"]),
            payload_json="{}",
            progress=0,
            retry_count=1,
            max_retries=1,
            failure_reason="模拟失败",
            created_by=account.id,
            created_by_name=account.name,
            created_at=now,
            updated_at=now,
        )
        db.add_all([failed, limited])
        db.commit()
        failed_id, limited_id = failed.id, limited.id

    resp = client.post(f"/api/v1/provider-jobs/{failed_id}/retry")
    assert resp.status_code == 200, resp.text
    new_job = resp.json()
    assert new_job["id"] != failed_id
    assert new_job["retry_of"] == failed_id
    assert new_job["retry_count"] == 1
    assert new_job["status"] == "succeeded"

    limited_resp = client.post(f"/api/v1/provider-jobs/{limited_id}/retry")
    assert limited_resp.status_code == 409, limited_resp.text
    assert limited_resp.json()["code"] == "retry_limit"


def test_cancel_semantics(
    client: TestClient, setup_primary: dict, session_factory: sessionmaker[Session], project: dict[str, object]
) -> None:
    from app.services import provider as provider_service

    with session_factory() as db:
        account = db.execute(select(Account)).scalars().first()
        queued, _ = provider_service.submit_job(
            db,
            account=account,
            kind="ai",
            job_type="ai_analysis",
            target_type="ai_conversation",
            target_id="conv-dummy",
            payload={},
            idempotency_key="cancel:queued",
            run=False,
        )
        queued_id = queued.id

    resp = client.post(f"/api/v1/provider-jobs/{queued_id}/cancel")
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "cancelled"

    # 已成功作业不可取消 → 409
    _code, payload = _sync(client, [_first_issue(project)])
    done_id = payload["items"][0]["job_id"]
    cancel_done = client.post(f"/api/v1/provider-jobs/{done_id}/cancel")
    assert cancel_done.status_code == 409, cancel_done.text
    assert cancel_done.json()["code"] == "illegal_transition"


def test_provider_status_never_echoes_secrets(client: TestClient, setup_primary: dict, monkeypatch) -> None:
    secrets = {
        "feishu_app_id": "FEISHU-APP-ID-LEAK-9f2a",
        "feishu_app_secret": "FEISHU-SECRET-LEAK-7c1b",
        "ai_api_key": "AI-KEY-LEAK-3d4e",
        "ai_endpoint": "https://ai.example.invalid/v1/LEAK-5f6a",
    }
    for key, value in secrets.items():
        monkeypatch.setattr(settings, key, value)

    resp = client.get("/api/v1/providers")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["items"]) == 3
    text = resp.text
    for value in secrets.values():
        assert value not in text
    feishu = next(item for item in body["items"] if item["kind"] == "feishu")
    assert feishu["configured"] is True
    # provider_mode 仍为 mock → 生效模式为 mock（未配置不降级，配置也不外调）
    assert feishu["effective_mode"] == MODE_MOCK

    test_resp = client.post("/api/v1/providers/feishu/test")
    assert test_resp.status_code == 200, test_resp.text
    assert test_resp.json()["real_call_executed"] is False
    assert test_resp.json()["is_mock"] is True
    for value in secrets.values():
        assert value not in test_resp.text


def test_provider_endpoints_require_login(client: TestClient) -> None:
    assert client.get("/api/v1/provider-jobs").status_code == 401
    assert client.get("/api/v1/providers").status_code == 401
    assert client.post("/api/v1/providers/feishu/test").status_code == 401


def test_unknown_job_returns_404(client: TestClient, setup_primary: dict) -> None:
    assert client.get("/api/v1/provider-jobs/does-not-exist").status_code == 404
