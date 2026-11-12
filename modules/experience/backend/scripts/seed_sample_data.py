#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v1.1 示例数据：事业部 → 系统 → 产品项目（带权重）端到端演示数据落库。

运行方式（仓库根 ``E:\\AI work\\tiyanwork``，Git Bash: ``/e/AI work/tiyanwork``）：

    cd '/e/AI work/tiyanwork/backend'
    ./.venv/Scripts/python.exe ./scripts/seed_sample_data.py

也可（在 backend 目录下）以模块方式运行：

    ./.venv/Scripts/python.exe -m scripts.seed_sample_data

v1.1 层级合并后的演示结构（产品层已取消，项目直挂系统）：

- 事业部 1 个：音视频事业部（ITC-AV）。
- 系统 3 个（绑定默认方案 ``8-2__7-5-3-1``）：
  会议协作系统（SYS-MEETING）/ 专业扩声系统（SYS-SOUND）/ LED 显示系统（SYS-LED）。
- 产品项目 6 个（每系统 2 个，带权重，13 节点 + 问题 + L1 快照）：

  ================  ============  ======  ==================================
  项目              系统          权重    问题构成（全部 severity=normal）
  ================  ============  ======  ==================================
  会议一体机 V7.32  会议协作      2       23 核心-一般 + 9 非核心-一般 → 39.4
  会议摄像机 V1.0   会议协作      1       核心 2严重+3一般；非核心 1严重+19一般+3轻微 → 71.8
  数字功放 V2.0     专业扩声      3       10 核心-一般 + 10 非核心-一般 → 70.0
  数字调音台 V1.5   专业扩声      1       核心 1严重+5一般；非核心 5一般 → 81.0
  小间距LED V3.0    LED 显示      2       8 核心-一般 + 12 非核心-一般 → 73.6
  LED处理器 V1.0    LED 显示      1       6 核心-一般 + 4 非核心-一般 → 83.2
  ================  ============  ======  ==================================

系统合并 UEI（权重加权平均 = Σ(项目UEI×权重)/Σ权重，新默认展示口径）：

- 会议协作系统：(39.4×2 + 71.8×1) / 3 = **50.2**
- 专业扩声系统：(70.0×3 + 81.0×1) / 4 = **72.75 → 72.8**
- LED 显示系统：(73.6×2 + 83.2×1) / 3 = **76.8**

每个系统同时落一条 L2 快照（权威去重重算为权威口径，权重加权/木桶分为辅助口径）。

- 默认方案 ``8-2__7-5-3-1`` 单元扣分：core_fatal 5.6 / core_major 4 / core_normal 2.4 /
  core_minor 0.8；non_core_fatal 1.4 / non_core_major 1 / non_core_normal 0.6 / non_core_minor 0.2。
- BEI 季度评估（2026Q4）走 ``estimate``（不触发不可变定榜），问题创建时间落在评价周期内。
- 全量构造采用稳定 code 做 upsert；``--reset`` 仅清理本脚本写入的演示数据。

本脚本为独立进程，直接用 SQLAlchemy session 操作，不依赖 pytest 夹具。
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys
from pathlib import Path

# --------------------------------------------------------------------------- 路径自举
# 脚本位于 backend/scripts，需将 backend 加入 sys.path 以便 import app。
BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import create_engine, delete, event, func, select  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

from app.api.deps import RequestContext  # noqa: E402
from app.core.security import hash_password, new_id  # noqa: E402
from app.core.timeutil import utcnow  # noqa: E402
from app.domain import states as st  # noqa: E402
from app.domain.nodes import NODE_SPECS, PROJECT_TYPE_NEW, node_applicable  # noqa: E402
from app.domain.templates import TEMPLATE_BY_KIND  # noqa: E402
from app.models.account import Account  # noqa: E402
from app.models.artifact import Artifact, ArtifactVersion  # noqa: E402
from app.models.flow import (  # noqa: E402
    DIVISION_ACTIVE,
    PROJECT_ACTIVE,
    Division,
    Project,
    WorkflowNode,
    WorkflowNodeEvent,
)
from app.models.issue import (  # noqa: E402
    PROXY_TARGET_ISSUE_REPLY,
    Issue,
    ProxyRecord,
)
from app.models.review import (  # noqa: E402
    DECISION_STATUS_DECIDED,
    DECISION_STATUS_OPEN,
    Review,
    ReviewDecision,
    ReviewSignature,
)
from app.models.scoring import ProjectScoreSnapshot, SnapshotIssue  # noqa: E402
from app.models.score_library import ScoreLibraryEntry  # noqa: E402
from app.models.systems import (  # noqa: E402
    SELECTION_LATEST,
    SYSTEM_ACTIVE,
    System,
    SystemSnapshot,
    SystemSnapshotSource,
)
from app.models.usability import (  # noqa: E402
    PARTICIPANT_NOVICE,
    RUN_COMPLETED,
    STUDY_COMPLETED,
    STUDY_USABILITY,
    SusAnswer,
    StudyParticipant,
    StudyTask,
    TaskRun,
    UsabilityStudy,
)
from app.seeds import seed_all  # noqa: E402
from app.services.scoring import create_l1_snapshot, latest_effective_snapshot  # noqa: E402
from app.services.systems import create_l2_snapshot, create_system  # noqa: E402
from app.services.usability import compute_sus  # noqa: E402

# 评价周期固定为 2026Q4（与自然季度对齐：2026-10-01 ~ 2027-01-01）
BEI_PERIOD = "2026Q4"
# 演示数据统一落入评价周期内的固定时刻，保证 BEI 采集稳定（不受真实运行日期影响）
FIXED_NOW = _dt.datetime(2026, 11, 15, 10, 0, 0)

# 稳定编码（用于幂等 upsert 与 --reset 定位）
DIV_CODE = "ITC-AV"
SYS_MEETING_CODE = "SYS-MEETING"
SYS_SOUND_CODE = "SYS-SOUND"
SYS_LED_CODE = "SYS-LED"
SEED_ACCOUNT = "seed_script"
# 演示用首账号：仅在库中没有任何首账号时创建，便于「登录 → 多层分值」全流程演示。
# 口令可用环境变量 UEI_SEED_DEMO_PASSWORD 覆盖，默认值为示例口令（非生产凭证）。
DEMO_ACCOUNT = "demo"
DEMO_NAME = "示例体验人员"
DEMO_PASSWORD_ENV = "UEI_SEED_DEMO_PASSWORD"
DEMO_PASSWORD_DEFAULT = "UeiDemo2026!"

# 演示项目定义：(项目code, 名称, 版本号, 系统code, 权重, core分布, non_core分布, 期望UEI)
PROJECT_SPECS: list[dict] = [
    {
        "code": "P-MEETING-V732",
        "name": "会议一体机 V7.32 体验项目",
        "version_code": "V7.32",
        "system": SYS_MEETING_CODE,
        "weight": "2",
        "core": (0, 0, 23, 0),
        "non_core": (0, 0, 9, 0),
        "expected_uei": "39.4",
        "description": "会议协作系统主线项目：覆盖 13 个固定工作节点，落地会议一体机 V7.32 的完整体验度量。",
        "owner_text": "龙斌",
        "members_text": "体验团队：张三、李四；协作：产品、开发",
        "issue_prefix": "ISS-M-V732",
        "with_proxy": True,
    },
    {
        "code": "P-CAM-V10",
        "name": "会议摄像机 V1.0 体验项目",
        "version_code": "V1.0",
        "system": SYS_MEETING_CODE,
        "weight": "1",
        "core": (0, 2, 3, 0),
        "non_core": (0, 1, 19, 3),
        "expected_uei": "71.8",
        "description": "会议协作系统第二项目：让系统合并 UEI 样本充足（有效项目 ≥ 2 且去重问题 ≥ 5）。",
        "owner_text": "龙斌",
        "members_text": "体验团队：王五；协作：硬件、固件",
        "issue_prefix": "ISS-C-V10",
        "with_proxy": False,
    },
    {
        "code": "P-AMP-V20",
        "name": "数字功放 V2.0 体验项目",
        "version_code": "V2.0",
        "system": SYS_SOUND_CODE,
        "weight": "3",
        "core": (0, 0, 10, 0),
        "non_core": (0, 0, 10, 0),
        "expected_uei": "70.0",
        "description": "专业扩声系统主线项目：高权重（3），示范权重对系统合并 UEI 的放大作用。",
        "owner_text": "龙斌",
        "members_text": "体验团队：赵六；协作：声学、电子",
        "issue_prefix": "ISS-A-V20",
        "with_proxy": False,
    },
    {
        "code": "P-MIX-V15",
        "name": "数字调音台 V1.5 体验项目",
        "version_code": "V1.5",
        "system": SYS_SOUND_CODE,
        "weight": "1",
        "core": (0, 1, 5, 0),
        "non_core": (0, 0, 5, 0),
        "expected_uei": "81.0",
        "description": "专业扩声系统第二项目：低权重（1），示范权重加权平均口径。",
        "owner_text": "龙斌",
        "members_text": "体验团队：钱七；协作：DSP、固件",
        "issue_prefix": "ISS-X-V15",
        "with_proxy": False,
    },
    {
        "code": "P-LED-V30",
        "name": "小间距LED显示屏 V3.0 体验项目",
        "version_code": "V3.0",
        "system": SYS_LED_CODE,
        "weight": "2",
        "core": (0, 0, 8, 0),
        "non_core": (0, 0, 12, 0),
        "expected_uei": "73.6",
        "description": "LED 显示系统主线项目：小间距显示屏的完整体验度量。",
        "owner_text": "龙斌",
        "members_text": "体验团队：孙八；协作：光学、结构",
        "issue_prefix": "ISS-L-V30",
        "with_proxy": False,
    },
    {
        "code": "P-LEDC-V10",
        "name": "LED视频处理器 V1.0 体验项目",
        "version_code": "V1.0",
        "system": SYS_LED_CODE,
        "weight": "1",
        "core": (0, 0, 6, 0),
        "non_core": (0, 0, 4, 0),
        "expected_uei": "83.2",
        "description": "LED 显示系统第二项目：视频处理器的完整体验度量。",
        "owner_text": "龙斌",
        "members_text": "体验团队：周九；协作：算法、固件",
        "issue_prefix": "ISS-D-V10",
        "with_proxy": False,
    },
]

# 系统定义：(系统code, 名称, 备注)
SYSTEM_SPECS: list[tuple[str, str, str]] = [
    (SYS_MEETING_CODE, "会议协作系统", "示例系统：会议一体机 + 会议摄像机"),
    (SYS_SOUND_CODE, "专业扩声系统", "示例系统：数字功放 + 数字调音台"),
    (SYS_LED_CODE, "LED显示系统", "示例系统：小间距LED显示屏 + LED视频处理器"),
]

SEVERITIES = ("fatal", "major", "normal", "minor")

MODULES = [
    "会议预约", "无线投屏", "画中画布局", "遥控器交互", "白板批注",
    "声控唤醒", "多屏协作", "签名纪要", "网络自适应", "UI 信息密度",
]
METRIC_L1 = ["易学性", "效率", "易忆性", "容错性", "主观满意度"]


# --------------------------------------------------------------------------- 审计字段填充
def _audit(entity, account, *, when: _dt.datetime | None = None) -> None:
    """填充审计 / 时间戳字段（AuditMixin + TimestampMixin）。"""
    now = when or utcnow()
    if hasattr(entity, "created_by"):
        entity.created_by = account.id
        entity.created_by_name = account.name
        entity.updated_by = account.id
        entity.updated_by_name = account.name
        entity.row_version = 1
    entity.created_at = now
    entity.updated_at = now


def _get_by_code(db, model, code: str):
    return db.execute(select(model).where(model.code == code)).scalars().first()


def _ensure_seed_account(db) -> Account:
    existing = db.execute(select(Account).where(Account.account == SEED_ACCOUNT)).scalars().first()
    if existing is not None:
        # 早期版本写入的是占位串；统一改为「随机口令的 bcrypt 哈希」，保证该账号不可登录且格式合规。
        if not (existing.password_hash or "").startswith("bcrypt_sha256$"):
            existing.password_hash = hash_password(os.urandom(24).hex())
            existing.updated_at = utcnow()
            db.flush()
        return existing
    now = utcnow()
    account = Account(
        id=new_id(),
        account=SEED_ACCOUNT,
        name="种子脚本",
        role="experience_member",
        password_hash=hash_password(os.urandom(24).hex()),
        is_primary=False,
        is_active=True,
        last_login_at=None,
    )
    account.created_at = now
    account.updated_at = now
    db.add(account)
    db.flush()
    return account


def _ensure_demo_primary(db) -> tuple[Account | None, bool]:
    """确保示例库存在可登录的首账号。

    仅当库中没有任何首账号时创建（``demo``）；已有首账号则完全不改动，
    避免覆盖使用者自建账号的口令。返回 ``(账号, 是否新建)``。
    """
    primary = db.execute(select(Account).where(Account.is_primary.is_(True))).scalars().first()
    if primary is not None:
        return primary, False

    password = os.environ.get(DEMO_PASSWORD_ENV) or DEMO_PASSWORD_DEFAULT
    now = utcnow()
    account = db.execute(select(Account).where(Account.account == DEMO_ACCOUNT)).scalars().first()
    if account is None:
        account = Account(
            id=new_id(),
            account=DEMO_ACCOUNT,
            name=DEMO_NAME,
            role="experience_member",
            password_hash=hash_password(password),
            is_primary=True,
            is_active=True,
            last_login_at=None,
        )
        account.created_at = now
        account.updated_at = now
        db.add(account)
    else:
        account.is_primary = True
        account.is_active = True
        account.password_hash = hash_password(password)
        account.updated_at = now
    db.flush()
    return account, True


# --------------------------------------------------------------------------- 节点实例化
def _instantiate_nodes(db, project: Project, account: Account) -> list[WorkflowNode]:
    """按 NODE_SPECS 串行实例化 13 个节点；N10（iteration_only）在新产品上自动不适用。"""
    nodes: list[WorkflowNode] = []
    cursor = utcnow()
    for spec in NODE_SPECS:
        planned_start = cursor
        cursor = cursor + _dt.timedelta(days=spec.duration_days)
        node = WorkflowNode(
            id=new_id(),
            project_id=project.id,
            code=spec.code,
            node_order=spec.order,
            stage_code=spec.stage_code,
            name=spec.name,
            scope=spec.scope,
            duration_days=spec.duration_days,
            outputs_text=spec.outputs,
            allow_not_applicable=spec.allow_not_applicable,
            iteration_only=spec.iteration_only,
            status=st.NODE_NOT_STARTED,
            planned_start_at=planned_start,
            planned_end_at=cursor,
        )
        _audit(node, account)
        if not node_applicable(spec.code, project.project_type):
            node.status = st.NODE_NOT_APPLICABLE
            node.not_applicable_reason = f"新产品不适用{spec.name}"
            node.actual_end_at = utcnow()
        db.add(node)
        nodes.append(node)
    db.flush()

    for node in nodes:
        if node.status == st.NODE_NOT_APPLICABLE:
            db.add(
                WorkflowNodeEvent(
                    id=new_id(),
                    node_id=node.id,
                    project_id=project.id,
                    action="mark_na",
                    from_status="",
                    to_status=st.NODE_NOT_APPLICABLE,
                    reason=node.not_applicable_reason,
                    actor_account_id=account.id,
                    actor_name=account.name,
                    request_id="",
                    created_at=utcnow(),
                    updated_at=utcnow(),
                )
            )
    db.flush()
    return nodes


# --------------------------------------------------------------------------- 问题构造
def _add_issue_batch(
    db,
    *,
    project: Project,
    division: Division,
    spec: dict,
    account: Account,
) -> list[Issue]:
    issues: list[Issue] = []
    counter = 0
    for business_level, dist in (("core", spec["core"]), ("non_core", spec["non_core"])):
        for sev_idx, count in enumerate(dist):
            sev = SEVERITIES[sev_idx]
            for _ in range(count):
                counter += 1
                code = f"{spec['issue_prefix']}-{counter:04d}"
                module = MODULES[counter % len(MODULES)]
                metric_l1 = METRIC_L1[counter % len(METRIC_L1)]
                issue = Issue(
                    id=new_id(),
                    code=code,
                    project_id=project.id,
                    system_id=project.system_id,
                    division_id=division.id,
                    module=module,
                    description=f"{project.name}体验问题（{code}）：{module}模块在{metric_l1}维度存在可优化点。",
                    business_level=business_level,
                    severity=sev,
                    metric_l1=metric_l1,
                    metric_l2=f"{module}交互",
                    metric_l3=f"{sev}级",
                    issue_type="体验问题",
                    owner_text="体验团队",
                    status=st.ISSUE_CLOSED,
                    pre_business_level=business_level,
                    pre_severity=sev,
                    final_business_level=business_level,
                    final_severity=sev,
                    final_classified_at=utcnow(),
                    final_classified_by=account.name,
                    division_reply=f"事业部已确认并在 {project.version_code} 中修复：{module} 交互路径已优化。",
                    solution=f"优化 {module} 交互流程，补充引导与容错。",
                    committed_version=project.version_code,
                    actual_version=project.version_code,
                    first_replied_at=FIXED_NOW,
                    closed_at=FIXED_NOW,
                    source_refs_json=json.dumps([{"node_code": "N13", "module": module}]),
                    note="",
                    reference_count=0,
                    is_proxy=False,
                )
                _audit(issue, account)
                # 固定到评价周期内，保证 BEI 采集稳定
                issue.created_at = FIXED_NOW
                issue.updated_at = FIXED_NOW
                db.add(issue)
                issues.append(issue)

                if spec.get("with_proxy"):
                    db.add(
                        ProxyRecord(
                            id=new_id(),
                            target_type=PROXY_TARGET_ISSUE_REPLY,
                            target_id=issue.id,
                            field_key="division_reply",
                            issue_id=issue.id,
                            actual_provider="龙斌（音视频事业部）",
                            provider_department="音视频事业部",
                            proxy_by=account.id,
                            proxy_by_name=account.name,
                            proxy_at=FIXED_NOW,
                            source_note="种子脚本代录事业部回复",
                            content_digest=(issue.division_reply or "")[:200],
                            created_at=FIXED_NOW,
                            updated_at=FIXED_NOW,
                        )
                    )
    db.flush()
    return issues


# --------------------------------------------------------------------------- 产物构造
def _seed_artifacts(db, *, project: Project, nodes: list[WorkflowNode], account: Account) -> None:
    # 幂等：该项目已有产物则跳过
    existing = db.execute(select(Artifact).where(Artifact.project_id == project.id)).scalars().first()
    if existing is not None:
        return
    for node in nodes:
        spec = next(s for s in NODE_SPECS if s.code == node.code)
        if not node_applicable(node.code, project.project_type):
            continue  # 不适用节点（N10）不生成产物
        kind = spec.artifact_kinds[0]
        now = utcnow()
        template_title = TEMPLATE_BY_KIND[kind].name if kind in TEMPLATE_BY_KIND else kind
        artifact = Artifact(
            id=new_id(),
            project_id=project.id,
            node_id=node.id,
            node_code=node.code,
            kind=kind,
            title=f"{node.name} · {template_title}",
            status=st.ARTIFACT_CONFIRMED,
            current_version_no=1,
            collaborators_text="体验人员",
            not_applicable_reason="",
            last_saved_at=now,
            submitted_at=now,
            confirmed_at=now,
        )
        _audit(artifact, account)
        db.add(artifact)
        db.flush()
        db.add(
            ArtifactVersion(
                id=new_id(),
                artifact_id=artifact.id,
                version_no=1,
                status=st.ARTIFACT_CONFIRMED,
                payload_json=json.dumps(
                    {"title": artifact.title, "node_code": node.code, "content": f"{node.name} 产出内容（示例）"},
                    ensure_ascii=False,
                ),
                is_frozen=True,
                change_note="初始确认版本",
                source_version_no=None,
                issue_ids_json="[]",
                created_by=account.id,
                created_by_name=account.name,
                request_id="",
                created_at=now,
                updated_at=now,
            )
        )
    db.flush()


def _sync_nodes_with_artifacts(db, *, project: Project, nodes: list[WorkflowNode], account: Account) -> int:
    """演示数据一致性回填（幂等，可对已初始化的库重复执行）：

    1. 产物标题规范化：``{节点名} · {kind} 产物`` → ``{节点名} · {模板标题}``。
    2. 节点状态回填：交付物全部已确认且节点仍为"未开始"时置为"已完成"，
       并写入 auto_sync 节点事件留痕（与 N10 自动不适用同一处理方式；
       正常业务路径仍应走状态机迁移接口）。

    返回本次回填的节点数。
    """
    changed = 0
    # 1) 标题规范化
    artifacts = db.execute(select(Artifact).where(Artifact.project_id == project.id)).scalars().all()
    for a in artifacts:
        node = next((n for n in nodes if n.id == a.node_id), None)
        if node is None:
            continue
        spec = next((s for s in NODE_SPECS if s.code == node.code), None)
        kind_title = TEMPLATE_BY_KIND[a.kind].name if a.kind in TEMPLATE_BY_KIND else a.kind
        expected = f"{node.name} · {kind_title}"
        legacy = f"{node.name} · {a.kind} 产物"
        if a.title in ("", legacy) and expected != a.title:
            a.title = expected
            _audit(a, account)
    db.flush()

    # 2) 节点状态回填
    by_node: dict[str, list[Artifact]] = {}
    for a in artifacts:
        if a.node_id:
            by_node.setdefault(a.node_id, []).append(a)
    for node in nodes:
        if node.status != st.NODE_NOT_STARTED:
            continue
        arts = by_node.get(node.id, [])
        if not arts or not all(a.status == st.ARTIFACT_CONFIRMED for a in arts):
            continue
        now = utcnow()
        node.status = st.NODE_COMPLETED
        if node.actual_end_at is None:
            node.actual_end_at = now
        _audit(node, account)
        db.add(
            WorkflowNodeEvent(
                id=new_id(),
                node_id=node.id,
                project_id=project.id,
                action="auto_sync",
                from_status=st.NODE_NOT_STARTED,
                to_status=st.NODE_COMPLETED,
                reason="种子回填：交付物已全部确认，节点同步为已完成",
                actor_account_id=account.id,
                actor_name=account.name,
                request_id="",
                created_at=now,
                updated_at=now,
            )
        )
        changed += 1
    db.flush()
    return changed


# --------------------------------------------------------------------------- 可用性研究构造
def _seed_study(db, *, project: Project, account: Account) -> None:
    code = f"US-{project.code}-0001"
    # 幂等：该 code 已存在则跳过
    if db.execute(select(UsabilityStudy).where(UsabilityStudy.code == code)).scalars().first() is not None:
        return
    now = utcnow()
    study = UsabilityStudy(
        id=new_id(),
        code=code,
        project_id=project.id,
        version_code=project.version_code,
        name=f"{project.name}可用性测试",
        study_kind=STUDY_USABILITY,
        status=STUDY_COMPLETED,
        not_applicable_reason="",
        report_artifact_id=None,
        note="示例可用性测试",
        created_by=account.id,
        created_by_name=account.name,
        updated_by=account.id,
        updated_by_name=account.name,
        row_version=1,
        created_at=now,
        updated_at=now,
    )
    db.add(study)
    db.flush()

    participants = [("用户A", 8), ("用户B", 7)]
    participant_rows: list[StudyParticipant] = []
    for order_no, (alias, satisfaction) in enumerate(participants, start=1):
        p = StudyParticipant(
            id=new_id(),
            study_id=study.id,
            order_no=order_no,
            alias=alias,
            group_type=PARTICIPANT_NOVICE,
            is_valid=True,
            exclusion_reason="",
            satisfaction=satisfaction,
            note="",
            created_at=now,
            updated_at=now,
        )
        db.add(p)
        participant_rows.append(p)
    db.flush()

    tasks = [
        ("预约会议", "会议预约", "从首页发起一次预约会议并邀请成员", "预约成功且成员收到通知"),
        ("无线投屏", "无线投屏", "将笔记本通过无线方式投屏至一体机", "投屏成功且画面清晰"),
        ("白板批注", "白板批注", "在白板中手写批注并保存", "批注保存成功可回看"),
    ]
    task_rows: list[StudyTask] = []
    for task_no, (flow, module, content, expected) in enumerate(tasks, start=1):
        t = StudyTask(
            id=new_id(),
            study_id=study.id,
            task_no=task_no,
            flow=flow,
            module=module,
            content=content,
            expected=expected,
            created_at=now,
            updated_at=now,
        )
        db.add(t)
        task_rows.append(t)
    db.flush()

    # 运行矩阵：每位参与者 × 每个任务
    for p in participant_rows:
        for t in task_rows:
            db.add(
                TaskRun(
                    id=new_id(),
                    study_id=study.id,
                    task_id=t.id,
                    participant_id=p.id,
                    status=RUN_COMPLETED,
                    duration_seconds=120 + (t.task_no * 15) + (p.order_no * 7),
                    error_steps="",
                    error_count=0,
                    note="",
                    created_at=now,
                    updated_at=now,
                )
            )
    db.flush()

    # SUS 十题（每人完整作答，便于产出有效 SUS 分）
    sus_answers = {
        "用户A": [4, 4, 4, 4, 4, 4, 4, 4, 4, 4],  # → 50.0
        "用户B": [5, 4, 5, 4, 5, 4, 5, 4, 5, 4],  # → 62.5
    }
    for p in participant_rows:
        answers = {f"q{i}": sus_answers[p.alias][i - 1] for i in range(1, 11)}
        computed = compute_sus(answers)
        db.add(
            SusAnswer(
                id=new_id(),
                study_id=study.id,
                participant_id=p.id,
                q1=answers["q1"], q2=answers["q2"], q3=answers["q3"], q4=answers["q4"],
                q5=answers["q5"], q6=answers["q6"], q7=answers["q7"], q8=answers["q8"],
                q9=answers["q9"], q10=answers["q10"],
                sus_score=computed["sus_score"],
                satisfaction=p.satisfaction,
                entered_at=now,
                created_at=now,
                updated_at=now,
            )
        )
    db.flush()


# --------------------------------------------------------------------------- 评审构造
def _seed_reviews(db, *, project: Project, meeting_l1: ProjectScoreSnapshot, account: Account) -> None:
    stages = [
        (st.REVIEW_BEFORE, meeting_l1.id, "", "初评：范围已锁定，初算 UEI 39.4，待发布前评审确认。"),
        (st.REVIEW_DURING, "", "", "评审进行中：对若干争议问题讨论决策，部分需明确待办。"),
        (st.REVIEW_AFTER, "", meeting_l1.id, "终评：问题已闭环，最终 UEI 维持 39.4，准予发布。"),
    ]
    # 取两条问题作为评审决策对象
    issues = (
        db.execute(select(Issue).where(Issue.project_id == project.id).order_by(Issue.code).limit(2))
        .scalars()
        .all()
    )
    for index, (stage, prelim, final, conclusion) in enumerate(stages, start=1):
        now = utcnow()
        review = Review(
            id=new_id(),
            code=f"REV-{project.code}-{index:02d}",
            project_id=project.id,
            node_code="N13",
            review_kind="release",
            title=f"{project.name}发布体验评审（{stage}）",
            stage=stage,
            scope_locked_at=now if stage == st.REVIEW_BEFORE else None,
            preliminary_snapshot_id=prelim or None,
            preliminary_uei="39.4" if prelim else "",
            final_snapshot_id=final or None,
            final_uei="39.4" if final else "",
            archived_at=None,
            archive_confirm_text="",
            conclusion=conclusion,
        )
        _audit(review, account)
        review.created_at = now
        review.updated_at = now
        db.add(review)
        db.flush()

        # 争议决策（before 仅记录，during/after 给出决策与承诺版本）
        for issue in issues:
            dispute = "" if stage == st.REVIEW_BEFORE else "该问题是否计入核心业务扣分存在争议，经讨论维持原分类。"
            decision = "" if stage == st.REVIEW_BEFORE else f"维持「{issue.business_level}/{issue.severity}」分类，承诺在 {issue.committed_version} 修复。"
            db.add(
                ReviewDecision(
                    id=new_id(),
                    review_id=review.id,
                    issue_id=issue.id,
                    issue_code=issue.code,
                    status=DECISION_STATUS_DECIDED if stage != st.REVIEW_BEFORE else DECISION_STATUS_OPEN,
                    dispute=dispute,
                    discussion=f"围绕 {issue.module} 体验问题展开讨论。",
                    decision=decision,
                    solution=issue.solution,
                    committed_version=issue.committed_version,
                    owner_text="体验团队",
                    business_level_after=issue.final_business_level,
                    severity_after=issue.final_severity,
                    created_by_name=account.name,
                    created_at=now,
                    updated_at=now,
                )
            )

        # 部门签署（代录，必须挂载实际提供人）
        db.add(
            ReviewSignature(
                id=new_id(),
                review_id=review.id,
                department="音视频事业部",
                principal="龙斌",
                members="体验团队、产品团队、开发团队",
                opinion="同意发布体验评审结论。",
                is_approved=True,
                is_proxy=True,
                actual_provider="龙斌（音视频事业部）",
                proxy_by=account.id,
                proxy_by_name=account.name,
                proxy_at=now,
                created_at=now,
                updated_at=now,
            )
        )
        db.flush()


# --------------------------------------------------------------------------- 基础实体（幂等）
def _seed_base(db, account: Account) -> dict:
    """创建事业部 / 系统 / 项目 / 13 节点（缺失则创建，存在则复用）。返回上下文字典。"""
    division = _get_by_code(db, Division, DIV_CODE)
    if division is None:
        division = Division(
            id=new_id(),
            code=DIV_CODE,
            name="音视频事业部",
            owner_text="龙斌",
            note="v1.1 示例数据：音视频事业部",
            status=DIVISION_ACTIVE,
        )
        _audit(division, account)
        db.add(division)
        db.flush()

    # 系统（绑定默认方案）
    from app.seeds.scoring_schemes import default_scheme

    scheme = default_scheme(db)
    if scheme is None:
        raise RuntimeError("默认评分方案缺失：请先运行 seed_all（本脚本已内置调用）。")
    systems: dict[str, System] = {}
    for sys_code, sys_name, note in SYSTEM_SPECS:
        system = _get_by_code(db, System, sys_code)
        if system is None:
            system = create_system(
                db,
                code=sys_code,
                name=sys_name,
                scheme_id=scheme.id,
                owner_text="龙斌",
                division_id=division.id,
                note=note,
                account=account,
                ctx=None,
            )
        systems[sys_code] = system
    db.flush()

    # 项目（直挂系统，带权重与版本号）
    projects: dict[str, Project] = {}
    for spec in PROJECT_SPECS:
        proj = _get_by_code(db, Project, spec["code"])
        if proj is None:
            proj = Project(
                id=new_id(),
                code=spec["code"],
                name=spec["name"],
                system_id=systems[spec["system"]].id,
                division_id=division.id,
                version_code=spec["version_code"],
                weight=spec["weight"],
                project_type=PROJECT_TYPE_NEW,
                owner_text=spec["owner_text"],
                members_text=spec["members_text"],
                description=spec["description"],
                status=PROJECT_ACTIVE,
                started_at=utcnow(),
            )
            _audit(proj, account)
            db.add(proj)
            db.flush()
            _instantiate_nodes(db, proj, account)
        projects[spec["code"]] = proj

    return {
        "division": division,
        "systems": systems,
        "projects": projects,
        "scheme": scheme,
    }


def _seed_issues(db, account: Account, ctx: dict) -> None:
    """为各项目写入问题（缺失则创建）。分布见 PROJECT_SPECS。"""
    for spec in PROJECT_SPECS:
        proj = ctx["projects"][spec["code"]]
        existing = int(
            db.execute(
                select(func.count()).select_from(Issue).where(Issue.project_id == proj.id)
            ).scalar()
            or 0
        )
        if existing == 0:
            _add_issue_batch(db, project=proj, division=ctx["division"], spec=spec, account=account)


# --------------------------------------------------------------------------- L1 / 评审 / 系统快照 / BEI
def _ensure_l1(db, account: Account, project: Project) -> ProjectScoreSnapshot | None:
    existing = latest_effective_snapshot(db, project.id)
    if existing is not None:
        return existing
    # create_l1_snapshot 内部自行提交并返回 dict 载荷；这里重新取回快照对象供评审等后续使用
    create_l1_snapshot(
        db, project_id=project.id, scheme_id=None, version_id=None, account=account, ctx=None
    )
    return latest_effective_snapshot(db, project.id)


def _ensure_system_l2(db, account: Account, ctx: dict) -> dict[str, SystemSnapshot | None]:
    """每个系统生成一条 L2 快照（幂等：已有快照则跳过）。"""
    from app.services.systems import list_l2_snapshots

    l2_map: dict[str, SystemSnapshot | None] = {}
    for sys_code, system in ctx["systems"].items():
        rows, _total = list_l2_snapshots(db, system_id=system.id, page=1, page_size=1)
        if rows:
            l2_map[sys_code] = rows[0]
            continue
        create_l2_snapshot(
            db,
            system=system,
            selection_mode=SELECTION_LATEST,
            from_value=None,
            to_value=None,
            version_prefix=None,
            note="v1.1 示例系统快照：截至最新有效 L1 快照的并集重算 + 权重加权平均",
            account=account,
            ctx=None,
        )
        rows, _total = list_l2_snapshots(db, system_id=system.id, page=1, page_size=1)
        l2_map[sys_code] = rows[0] if rows else None
    return l2_map


def _ensure_bei(db, account: Account, division) -> bool:
    """执行季度 BEI 评价（estimate）。失败时优雅跳过。返回是否成功执行。"""
    try:
        from app.services.bei import evaluate_and_persist
    except Exception as exc:  # noqa: BLE001
        print(
            "  ! BEI 评价跳过：无法导入 evaluate_and_persist"
            f"（{type(exc).__name__}: {exc}）。"
        )
        return False
    try:
        evaluate_and_persist(
            db, division=division, period=BEI_PERIOD, account=account, reference=None, commit=True
        )
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"  ! BEI 评价执行失败（{type(exc).__name__}: {exc}）。")
        return False


def _ensure_reviews(db, account: Account, ctx: dict, meeting_l1: ProjectScoreSnapshot) -> None:
    proj = ctx["projects"]["P-MEETING-V732"]
    existing = int(
        db.execute(
            select(func.count()).select_from(Review).where(Review.project_id == proj.id)
        ).scalar()
        or 0
    )
    if existing == 0:
        _seed_reviews(db, project=proj, meeting_l1=meeting_l1, account=account)


# --------------------------------------------------------------------------- 验证
def _verify(db) -> tuple[bool, list[str]]:
    lines: list[str] = []
    ok = True

    # 1) 系统 + 项目
    lines.append(f"系统：{db.execute(select(func.count()).select_from(System)).scalar()} 个；"
                 f"项目：{db.execute(select(func.count()).select_from(Project)).scalar()} 个")

    # 2) 每项目 L1 快照
    for spec in PROJECT_SPECS:
        proj = _get_by_code(db, Project, spec["code"])
        if proj is None:
            ok = False
            lines.append(f"FAIL: 项目 {spec['code']} 不存在")
            continue
        nodes = db.execute(select(WorkflowNode).where(WorkflowNode.project_id == proj.id)).scalars().all()
        if len(nodes) != 13:
            ok = False
            lines.append(f"  ✗ {spec['code']} 节点数应为 13，实际 {len(nodes)}")
        snapshot = latest_effective_snapshot(db, proj.id)
        if snapshot is None:
            ok = False
            lines.append(f"FAIL: {spec['code']} 缺少 L1 快照")
            continue
        match = abs(float(snapshot.display_uei) - float(spec["expected_uei"])) < 0.05
        lines.append(
            f"L1 {spec['code']}：UEI={snapshot.display_uei}（期望 {spec['expected_uei']}）"
            f" issues={snapshot.issue_count} weight={proj.weight} {'✓' if match else '✗'}"
        )
        if not match or snapshot.issue_count != sum(spec["core"]) + sum(spec["non_core"]):
            ok = False
            lines.append(f"  ✗ {spec['code']} L1 UEI 或问题数不符")

    # 3) 系统合并 UEI（权重加权）
    expected_weighted = {
        SYS_MEETING_CODE: (39.4 * 2 + 71.8 * 1) / 3,      # 50.2
        SYS_SOUND_CODE: (70.0 * 3 + 81.0 * 1) / 4,        # 72.75
        SYS_LED_CODE: (73.6 * 2 + 83.2 * 1) / 3,          # 76.8
    }
    for sys_code, expected in expected_weighted.items():
        system = _get_by_code(db, System, sys_code)
        if system is None:
            ok = False
            lines.append(f"FAIL: 系统 {sys_code} 不存在")
            continue
        l2 = (
            db.execute(
                select(SystemSnapshot)
                .where(SystemSnapshot.system_id == system.id)
                .order_by(SystemSnapshot.snapshot_at.desc())
            )
            .scalars()
            .first()
        )
        if l2 is None:
            ok = False
            lines.append(f"FAIL: 系统 {sys_code} 缺少 L2 快照")
            continue
        weighted = float(l2.weighted_average_uei) if l2.weighted_average_uei else None
        match = weighted is not None and abs(weighted - expected) < 0.05
        lines.append(
            f"L2 {system.name}：权威={l2.authoritative_uei} 加权={l2.weighted_average_uei}"
            f"（期望 {round(expected, 2)}） 木桶={l2.bucket_uei}"
            f" 项目数={l2.effective_project_count} 去重问题={l2.deduped_issue_count}"
            f" 样本充足={l2.sample_sufficient} {'✓' if match else '✗'}"
        )
        if not match:
            ok = False
            lines.append(f"  ✗ 系统 {sys_code} 权重加权 UEI 不符")

    return ok, lines


# --------------------------------------------------------------------------- reset
def _reset(db) -> None:
    division = _get_by_code(db, Division, DIV_CODE)
    project_codes = [spec["code"] for spec in PROJECT_SPECS]
    system_codes = [s[0] for s in SYSTEM_SPECS]

    project_rows = db.execute(select(Project).where(Project.code.in_(project_codes))).scalars().all() if project_codes else []
    project_ids = [p.id for p in project_rows]
    system_rows = db.execute(select(System).where(System.code.in_(system_codes))).scalars().all() if system_codes else []
    system_ids = [s.id for s in system_rows]

    def _ids(model, col, values):
        if not values:
            return []
        rows = db.execute(select(model.id).where(col.in_(values))).scalars().all()
        return list(rows)

    issue_ids = _ids(Issue, Issue.project_id, project_ids) if project_ids else []
    node_ids = _ids(WorkflowNode, WorkflowNode.project_id, project_ids) if project_ids else []
    artifact_ids = _ids(Artifact, Artifact.project_id, project_ids) if project_ids else []
    review_ids = _ids(Review, Review.project_id, project_ids) if project_ids else []
    study_ids = _ids(UsabilityStudy, UsabilityStudy.project_id, project_ids) if project_ids else []
    snapshot_ids = _ids(ProjectScoreSnapshot, ProjectScoreSnapshot.project_id, project_ids) if project_ids else []

    # 分值库（L1/L2/L3，本事业部）
    if division is not None:
        db.execute(delete(ScoreLibraryEntry).where(ScoreLibraryEntry.division_id == division.id))
    # 系统快照及来源
    if system_ids:
        db.execute(delete(SystemSnapshotSource).where(SystemSnapshotSource.snapshot_id.in_(
            _ids(SystemSnapshot, SystemSnapshot.system_id, system_ids)
        )))
        db.execute(delete(SystemSnapshot).where(SystemSnapshot.system_id.in_(system_ids)))
    # BEI 评价
    if division is not None:
        from app.models.bei import DivisionEvaluation

        db.execute(delete(DivisionEvaluation).where(DivisionEvaluation.division_id == division.id))
    # 评审
    if review_ids:
        db.execute(delete(ReviewSignature).where(ReviewSignature.review_id.in_(review_ids)))
        db.execute(delete(ReviewDecision).where(ReviewDecision.review_id.in_(review_ids)))
        db.execute(delete(Review).where(Review.id.in_(review_ids)))
    # 可用性研究
    if study_ids:
        db.execute(delete(SusAnswer).where(SusAnswer.study_id.in_(study_ids)))
        db.execute(delete(TaskRun).where(TaskRun.study_id.in_(study_ids)))
        db.execute(delete(StudyTask).where(StudyTask.study_id.in_(study_ids)))
        db.execute(delete(StudyParticipant).where(StudyParticipant.study_id.in_(study_ids)))
        db.execute(delete(UsabilityStudy).where(UsabilityStudy.id.in_(study_ids)))
    # 产物
    if artifact_ids:
        db.execute(delete(ArtifactVersion).where(ArtifactVersion.artifact_id.in_(artifact_ids)))
        db.execute(delete(Artifact).where(Artifact.id.in_(artifact_ids)))
    # 节点事件 + 节点
    if node_ids:
        db.execute(delete(WorkflowNodeEvent).where(WorkflowNodeEvent.node_id.in_(node_ids)))
        db.execute(delete(WorkflowNode).where(WorkflowNode.id.in_(node_ids)))
    # 问题相关
    if issue_ids:
        db.execute(delete(ProxyRecord).where(ProxyRecord.issue_id.in_(issue_ids)))
        from app.models.issue import IssueAcceptance, IssueEvidence, IssueTransition

        db.execute(delete(IssueAcceptance).where(IssueAcceptance.issue_id.in_(issue_ids)))
        db.execute(delete(IssueEvidence).where(IssueEvidence.issue_id.in_(issue_ids)))
        db.execute(delete(IssueTransition).where(IssueTransition.issue_id.in_(issue_ids)))
        db.execute(delete(Issue).where(Issue.id.in_(issue_ids)))
    # L1 快照明细 + 快照
    if snapshot_ids:
        db.execute(delete(SnapshotIssue).where(SnapshotIssue.snapshot_id.in_(snapshot_ids)))
        db.execute(delete(ProjectScoreSnapshot).where(ProjectScoreSnapshot.id.in_(snapshot_ids)))
    # 项目 / 系统 / 事业部
    if project_ids:
        db.execute(delete(Project).where(Project.id.in_(project_ids)))
    if system_ids:
        db.execute(delete(System).where(System.id.in_(system_ids)))
    if division is not None:
        db.execute(delete(Division).where(Division.id == division.id))
    db.commit()


# --------------------------------------------------------------------------- 主流程
def _build_engine(db_url: str):
    engine = create_engine(db_url, future=True, pool_pre_ping=True, connect_args={"timeout": 30})
    if db_url.startswith("sqlite"):
        @event.listens_for(engine, "connect")
        def _pragmas(dbapi_connection, _record):  # noqa: ANN001
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA busy_timeout=30000")
            cursor.close()

    return engine


def main() -> int:
    parser = argparse.ArgumentParser(description="v1.1 示例数据：事业部 → 系统 → 产品项目（带权重）端到端演示")
    parser.add_argument(
        "--db-url",
        default=None,
        help="SQLite 数据库 URL（默认使用 app 配置：sqlite:///<repo>/data/uei.db）",
    )
    parser.add_argument("--reset", action="store_true", help="清空本脚本写入的演示数据后退出")
    parser.add_argument("--verify", action="store_true", help="仅执行验证并打印结果后退出")
    parser.add_argument("--no-verify", action="store_true", help="跳过结尾的断言验证（仍会打印统计）")
    args = parser.parse_args()

    db_url = args.db_url or "sqlite:///E:/AI work/tiyanwork/data/uei.db"

    engine = _build_engine(db_url)
    # 确保表存在（对全新数据库安全；对已迁移库为幂等 no-op）
    from app.models import Base

    Base.metadata.create_all(engine)

    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True, expire_on_commit=False)
    db = SessionLocal()
    try:
        # 基础系统数据（系统设置 / 20 套方案 / 模板 / BEI 阈值 v1），幂等
        seed_all(db)

        demo, demo_created = _ensure_demo_primary(db)
        account = _ensure_seed_account(db)
        if demo_created and demo is not None:
            print(
                f"演示首账号：{demo.account} / "
                f"{os.environ.get(DEMO_PASSWORD_ENV) or DEMO_PASSWORD_DEFAULT}"
                f"（可用环境变量 {DEMO_PASSWORD_ENV} 覆盖）"
            )

        if args.reset:
            _reset(db)
            print("RESET OK：已清空 v1.1 演示数据。")
            return 0

        if args.verify:
            ok, lines = _verify(db)
            print("\n".join(lines))
            print("SEED " + ("OK" if ok else "FAIL"))
            return 0 if ok else 1

        # 构造顺序：基础实体 → 问题 → 产物/研究 → L1（逐项目）→ 评审 → 系统 L2 快照 → BEI
        ctx = _seed_base(db, account)
        _seed_issues(db, account, ctx)

        meeting_proj = ctx["projects"]["P-MEETING-V732"]
        _seed_artifacts(db, project=meeting_proj, nodes=_nodes_of(db, meeting_proj.id), account=account)
        synced = _sync_nodes_with_artifacts(
            db,
            project=meeting_proj,
            nodes=_nodes_of(db, meeting_proj.id),
            account=account,
        )
        _seed_study(db, project=meeting_proj, account=account)

        l1_map: dict[str, ProjectScoreSnapshot | None] = {}
        for spec in PROJECT_SPECS:
            l1_map[spec["code"]] = _ensure_l1(db, account, ctx["projects"][spec["code"]])
        _ensure_reviews(db, account, ctx, l1_map["P-MEETING-V732"])
        l2_map = _ensure_system_l2(db, account, ctx)
        bei_ok = _ensure_bei(db, account, ctx["division"])
        db.commit()

        # 统计
        meeting_l1 = l1_map["P-MEETING-V732"]
        node_count = int(db.execute(select(func.count()).select_from(WorkflowNode).where(WorkflowNode.project_id == meeting_proj.id)).scalar() or 0)
        issue_total = int(db.execute(select(func.count()).select_from(Issue).where(Issue.project_id == meeting_proj.id)).scalar() or 0)
        issue_core = int(db.execute(select(func.count()).select_from(Issue).where(Issue.project_id == meeting_proj.id, Issue.business_level == "core")).scalar() or 0)
        issue_non = int(db.execute(select(func.count()).select_from(Issue).where(Issue.project_id == meeting_proj.id, Issue.business_level == "non_core")).scalar() or 0)
        l1_count = int(db.execute(select(func.count()).select_from(ScoreLibraryEntry).where(ScoreLibraryEntry.level == "L1")).scalar() or 0)
        l2_count = int(db.execute(select(func.count()).select_from(ScoreLibraryEntry).where(ScoreLibraryEntry.level == "L2")).scalar() or 0)

        print("=" * 60)
        print("SEED 统计")
        print(f"  事业部        : {ctx['division'].name} ({ctx['division'].code})")
        print(f"  系统          : {' / '.join(s.name for s in ctx['systems'].values())}")
        print(f"  项目          : {len(ctx['projects'])} 个（含权重与版本号）")
        print(f"  节点数        : {node_count}（会议一体机项目）")
        print(f"  节点状态回填   : 本次 {synced} 个（未开始→已完成，依据已确认交付物）")
        print(f"  问题数        : 总计 {issue_total}（核心 {issue_core} / 非核心 {issue_non}，会议一体机项目）")
        if meeting_l1 is not None:
            print(f"  L1 快照 UEI   : {meeting_l1.display_uei}（raw {meeting_l1.raw_uei}）")
        for sys_code, l2 in l2_map.items():
            if l2 is not None:
                print(
                    f"  L2 {ctx['systems'][sys_code].name}: 权威 {l2.authoritative_uei}"
                    f" / 加权 {l2.weighted_average_uei} / 木桶 {l2.bucket_uei}"
                )
        print(f"  分值库 L1 记录 : {l1_count}")
        print(f"  分值库 L2 记录 : {l2_count}")
        print(f"  BEI 季度评价   : {'已生成(2026Q4)' if bei_ok else '跳过（见上方 ! 提示）'}")
        print("=" * 60)

        if not args.no_verify:
            ok, lines = _verify(db)
            print("\n".join(lines))
            if ok:
                print("SEED OK")
                return 0
            print("SEED FAIL")
            return 1
        print("SEED OK（已跳过断言验证）")
        return 0
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        print("SEED FAIL")
        print(f"  原因：{type(exc).__name__}: {exc}")
        raise
    finally:
        db.close()


def _nodes_of(db, project_id: str) -> list[WorkflowNode]:
    return list(db.execute(select(WorkflowNode).where(WorkflowNode.project_id == project_id)).scalars().all())


if __name__ == "__main__":
    sys.exit(main())
