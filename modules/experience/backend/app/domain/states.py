"""五个状态机（DESIGN §6.6）。

统一约束（服务端为唯一权威）：

- 任何**未列出的迁移**都必须返回 **409**，并在响应中给出 ``current``、``target``
  与不允许原因（``reason``）。
- 需要理由的迁移（重新打开 / 不适用 / 退回）必须提供非空 ``reason``，否则 422。
- 迁移的**前置条件**（guard）由各服务的 ``_guard_*`` 函数实现；本模块只声明
  「哪些迁移存在」以及「需要什么 guard 键」，避免把业务查询写进常量层。
"""

from __future__ import annotations

from typing import NamedTuple

# --- 节点状态 ---
NODE_NOT_STARTED = "not_started"
NODE_IN_PROGRESS = "in_progress"
NODE_COMPLETED = "completed"
NODE_NOT_APPLICABLE = "not_applicable"

NODE_STATUSES: tuple[str, ...] = (
    NODE_NOT_STARTED,
    NODE_IN_PROGRESS,
    NODE_COMPLETED,
    NODE_NOT_APPLICABLE,
)
NODE_STATUS_LABELS: dict[str, str] = {
    NODE_NOT_STARTED: "未开始",
    NODE_IN_PROGRESS: "进行中",
    NODE_COMPLETED: "已完成",
    NODE_NOT_APPLICABLE: "不适用",
}

# --- 产物状态 ---
ARTIFACT_DRAFT = "draft"
ARTIFACT_SUBMITTED = "submitted"
ARTIFACT_RETURNED = "returned"
ARTIFACT_CONFIRMED = "confirmed"
ARTIFACT_NOT_APPLICABLE = "not_applicable"

ARTIFACT_STATUSES: tuple[str, ...] = (
    ARTIFACT_DRAFT,
    ARTIFACT_SUBMITTED,
    ARTIFACT_RETURNED,
    ARTIFACT_CONFIRMED,
    ARTIFACT_NOT_APPLICABLE,
)
ARTIFACT_STATUS_LABELS: dict[str, str] = {
    ARTIFACT_DRAFT: "草稿",
    ARTIFACT_SUBMITTED: "已提交",
    ARTIFACT_RETURNED: "已退回",
    ARTIFACT_CONFIRMED: "已确认",
    ARTIFACT_NOT_APPLICABLE: "不适用",
}

# --- 问题状态 ---
ISSUE_DRAFT = "draft"
ISSUE_PENDING_CONFIRM = "pending_confirm"
ISSUE_PENDING_REPLY = "pending_reply"
ISSUE_IN_PROGRESS = "in_progress"
ISSUE_PENDING_ACCEPTANCE = "pending_acceptance"
ISSUE_ACCEPTED = "accepted"
ISSUE_REJECTED = "rejected"
ISSUE_CLOSED = "closed"

ISSUE_STATUSES: tuple[str, ...] = (
    ISSUE_DRAFT,
    ISSUE_PENDING_CONFIRM,
    ISSUE_PENDING_REPLY,
    ISSUE_IN_PROGRESS,
    ISSUE_PENDING_ACCEPTANCE,
    ISSUE_ACCEPTED,
    ISSUE_REJECTED,
    ISSUE_CLOSED,
)
ISSUE_STATUS_LABELS: dict[str, str] = {
    ISSUE_DRAFT: "草稿",
    ISSUE_PENDING_CONFIRM: "待确认",
    ISSUE_PENDING_REPLY: "待回复",
    ISSUE_IN_PROGRESS: "处理中",
    ISSUE_PENDING_ACCEPTANCE: "待验收",
    ISSUE_ACCEPTED: "已通过",
    ISSUE_REJECTED: "已驳回",
    ISSUE_CLOSED: "已关闭",
}

# --- 评审状态 ---
REVIEW_BEFORE = "before"
REVIEW_DURING = "during"
REVIEW_AFTER = "after"
REVIEW_ARCHIVED = "archived"

REVIEW_STATUSES: tuple[str, ...] = (REVIEW_BEFORE, REVIEW_DURING, REVIEW_AFTER, REVIEW_ARCHIVED)
REVIEW_STATUS_LABELS: dict[str, str] = {
    REVIEW_BEFORE: "评审前",
    REVIEW_DURING: "评审中",
    REVIEW_AFTER: "评审后",
    REVIEW_ARCHIVED: "已归档",
}

# --- Provider 作业状态 ---
JOB_QUEUED = "queued"
JOB_RUNNING = "running"
JOB_SUCCEEDED = "succeeded"
JOB_FAILED = "failed"
JOB_CANCELLED = "cancelled"

JOB_STATUSES: tuple[str, ...] = (JOB_QUEUED, JOB_RUNNING, JOB_SUCCEEDED, JOB_FAILED, JOB_CANCELLED)
JOB_STATUS_LABELS: dict[str, str] = {
    JOB_QUEUED: "排队中",
    JOB_RUNNING: "执行中",
    JOB_SUCCEEDED: "成功",
    JOB_FAILED: "失败",
    JOB_CANCELLED: "已取消",
}


class Transition(NamedTuple):
    """一条合法迁移。"""

    source: str
    target: str
    action: str
    label: str
    requires_reason: bool = False
    guards: tuple[str, ...] = ()
    actors: tuple[str, ...] = ("experience_member",)


def _index(transitions: tuple[Transition, ...]) -> dict[tuple[str, str], Transition]:
    out: dict[tuple[str, str], Transition] = {}
    for t in transitions:
        key = (t.source, t.target)
        assert key not in out, f"重复迁移定义：{key}"
        out[key] = t
    return out


# --------------------------------------------------------------------------------------
# 节点状态机
# --------------------------------------------------------------------------------------
NODE_TRANSITIONS: tuple[Transition, ...] = (
    Transition(NODE_NOT_STARTED, NODE_IN_PROGRESS, "start", "开始节点", guards=("upstream_done", "review_gate")),
    Transition(NODE_NOT_STARTED, NODE_NOT_APPLICABLE, "mark_na", "标记不适用", requires_reason=True, guards=("allow_na",)),
    Transition(NODE_IN_PROGRESS, NODE_COMPLETED, "complete", "完成节点", guards=("required_artifacts_confirmed",)),
    Transition(NODE_IN_PROGRESS, NODE_NOT_APPLICABLE, "mark_na", "标记不适用", requires_reason=True, guards=("allow_na", "no_confirmed_artifact")),
    Transition(NODE_COMPLETED, NODE_IN_PROGRESS, "reopen", "重新打开", requires_reason=True, guards=("downstream_check",)),
    Transition(NODE_NOT_APPLICABLE, NODE_NOT_STARTED, "restore", "恢复为未开始", requires_reason=True),
)
NODE_TRANSITION_INDEX = _index(NODE_TRANSITIONS)

# --------------------------------------------------------------------------------------
# 产物状态机
# --------------------------------------------------------------------------------------
ARTIFACT_TRANSITIONS: tuple[Transition, ...] = (
    Transition(ARTIFACT_DRAFT, ARTIFACT_SUBMITTED, "submit", "提交产物", guards=("required_fields",)),
    Transition(ARTIFACT_DRAFT, ARTIFACT_NOT_APPLICABLE, "mark_na", "标记不适用", requires_reason=True, guards=("template_allows_na",)),
    Transition(ARTIFACT_SUBMITTED, ARTIFACT_RETURNED, "return", "退回产物", requires_reason=True),
    Transition(ARTIFACT_SUBMITTED, ARTIFACT_CONFIRMED, "confirm", "确认产物", guards=("proxy_complete",)),
    Transition(ARTIFACT_RETURNED, ARTIFACT_DRAFT, "resume", "恢复为草稿", guards=("new_edit_version",)),
    Transition(ARTIFACT_CONFIRMED, ARTIFACT_DRAFT, "reopen", "复制为新编辑版本", requires_reason=True, guards=("new_edit_version",)),
    Transition(ARTIFACT_NOT_APPLICABLE, ARTIFACT_DRAFT, "restore", "恢复为草稿", requires_reason=True),
)
ARTIFACT_TRANSITION_INDEX = _index(ARTIFACT_TRANSITIONS)

# --------------------------------------------------------------------------------------
# 问题状态机
# --------------------------------------------------------------------------------------
ISSUE_TRANSITIONS: tuple[Transition, ...] = (
    Transition(ISSUE_DRAFT, ISSUE_PENDING_CONFIRM, "submit", "提交待确认", guards=("issue_required_fields",)),
    Transition(ISSUE_PENDING_CONFIRM, ISSUE_PENDING_REPLY, "confirm_classification", "人工确认分类", guards=("classification_confirmed",)),
    Transition(ISSUE_PENDING_CONFIRM, ISSUE_DRAFT, "return", "退回草稿", requires_reason=True),
    Transition(ISSUE_PENDING_REPLY, ISSUE_IN_PROGRESS, "record_reply", "代录事业部回复", guards=("proxy_required", "reply_complete")),
    Transition(ISSUE_IN_PROGRESS, ISSUE_PENDING_ACCEPTANCE, "record_solution", "登记解决方案", guards=("proxy_required", "solution_and_version")),
    Transition(ISSUE_PENDING_ACCEPTANCE, ISSUE_ACCEPTED, "accept", "验收通过", guards=("acceptance_evidence",)),
    Transition(ISSUE_PENDING_ACCEPTANCE, ISSUE_REJECTED, "reject", "验收驳回", requires_reason=True, guards=("acceptance_evidence",)),
    Transition(ISSUE_REJECTED, ISSUE_IN_PROGRESS, "record_rework", "登记新整改记录", guards=("rework_record",)),
    Transition(ISSUE_ACCEPTED, ISSUE_CLOSED, "close", "关闭问题", guards=("final_classification", "no_open_dispute")),
    Transition(ISSUE_CLOSED, ISSUE_IN_PROGRESS, "reopen", "重新打开", requires_reason=True),
)
ISSUE_TRANSITION_INDEX = _index(ISSUE_TRANSITIONS)

# --------------------------------------------------------------------------------------
# 评审状态机
# --------------------------------------------------------------------------------------
REVIEW_TRANSITIONS: tuple[Transition, ...] = (
    Transition(REVIEW_BEFORE, REVIEW_DURING, "start", "进入评审中", guards=("summary_ready",)),
    Transition(REVIEW_DURING, REVIEW_BEFORE, "return", "退回评审前", requires_reason=True),
    Transition(REVIEW_DURING, REVIEW_AFTER, "finish", "进入评审后", guards=("disputes_decided",)),
    Transition(REVIEW_AFTER, REVIEW_DURING, "reopen", "重新讨论", requires_reason=True),
    Transition(REVIEW_AFTER, REVIEW_ARCHIVED, "archive", "归档评审", guards=("no_open_dispute", "proxy_complete", "final_classification", "l1_snapshot_ready")),
)
REVIEW_TRANSITION_INDEX = _index(REVIEW_TRANSITIONS)

# --------------------------------------------------------------------------------------
# Provider 作业状态机
# --------------------------------------------------------------------------------------
JOB_TRANSITIONS: tuple[Transition, ...] = (
    Transition(JOB_QUEUED, JOB_RUNNING, "run", "开始执行", actors=("executor",)),
    Transition(JOB_QUEUED, JOB_CANCELLED, "cancel", "取消作业"),
    Transition(JOB_RUNNING, JOB_SUCCEEDED, "succeed", "执行成功", actors=("executor",)),
    Transition(JOB_RUNNING, JOB_FAILED, "fail", "执行失败", actors=("executor",)),
    Transition(JOB_RUNNING, JOB_CANCELLED, "cancel", "取消作业", actors=("executor", "experience_member")),
    Transition(JOB_FAILED, JOB_QUEUED, "retry", "重试作业", guards=("retry_limit",)),
)
JOB_TRANSITION_INDEX = _index(JOB_TRANSITIONS)


TRANSITION_TABLES: dict[str, tuple[Transition, ...]] = {
    "node": NODE_TRANSITIONS,
    "artifact": ARTIFACT_TRANSITIONS,
    "issue": ISSUE_TRANSITIONS,
    "review": REVIEW_TRANSITIONS,
    "job": JOB_TRANSITIONS,
}

TRANSITION_INDEXES: dict[str, dict[tuple[str, str], Transition]] = {
    "node": NODE_TRANSITION_INDEX,
    "artifact": ARTIFACT_TRANSITION_INDEX,
    "issue": ISSUE_TRANSITION_INDEX,
    "review": REVIEW_TRANSITION_INDEX,
    "job": JOB_TRANSITION_INDEX,
}


class IllegalTransition(Exception):
    """内部信号：非法迁移。由服务层转换为 409 ``ConflictError``。"""

    def __init__(self, machine: str, source: str, target: str, reason: str) -> None:
        super().__init__(reason)
        self.machine = machine
        self.source = source
        self.target = target
        self.reason = reason


def find_transition(machine: str, source: str, target: str) -> Transition | None:
    return TRANSITION_INDEXES[machine].get((source, target))


def allowed_targets(machine: str, source: str) -> tuple[str, ...]:
    return tuple(t.target for t in TRANSITION_TABLES[machine] if t.source == source)


def allowed_actions(machine: str, source: str) -> tuple[dict[str, object], ...]:
    return tuple(
        {
            "action": t.action,
            "label": t.label,
            "target": t.target,
            "requires_reason": t.requires_reason,
        }
        for t in TRANSITION_TABLES[machine]
        if t.source == source
    )
