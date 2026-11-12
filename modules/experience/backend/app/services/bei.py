"""BEI 事业部体验重视度指数（L3）服务：阈值版本、指标取数、归一化与季度评价（T11）。

契约来源：``DESIGN.md`` §6.2.2（事业部评价 / 事业部评价详情）、``REQUIREMENTS.md`` §5.4、
PRD V1.2 §8.8 全节，阈值逐项对照 ``docs/BEI_THRESHOLD_SOURCE.md``。

硬性口径（不得违反）：

1. **阈值必须版本化且来自数据库**：归一化只读 ``bei_threshold_item`` 的
   ``full_line/pass_line/zero_line/direction``，禁止使用内置默认值；缺失即 ``BlockedError``
   （409 / code=``blocked``，附解除条件），但**数据采集（原始值）与下钻仍然可用**。
2. **维度分 = 该维度下有数据的二级指标分的算术平均**（保留 2 位小数展示口径）。
3. **某维度全部无数据 → 该维度整体剔除**，其余维度权重**等比放大**至 100%。
4. **参评问题 < 5 → 样本不足**（``insufficient_sample``）：不给分、不排名；
   **同期无在研产品/无参评问题 → ``no_participating_data``**：不得用 0 分代替。
5. **自动分与人工分分栏**：人工占比 ≤ 0.20；人工分只写 ``bei_manual_score``，
   绝不改写 ``bei_metric_value`` 的自动取数值。
6. **说明备注**留录入人与时间，写入 ``calc_trace_json.notes``，不影响任何数值与得分。
7. **季度定榜不可变**：``status=finalized`` 后再次定榜 / 改人工分 / 加备注一律 409；
   定榜同时向分值库写入 ``level="L3"`` 记录，可回溯 ``source_snapshot_id``。
"""

from __future__ import annotations

import datetime as _dt
import json
import re
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.api.deps import RequestContext
from app.core.errors import BlockedError, ConflictError, NotFoundError, ValidationError
from app.core.security import new_id
from app.core.timeutil import iso_z, utcnow
from app.domain import bei as bd
from app.domain import scoring as sc
from app.domain import states as st
from app.domain.scoring import SEVERITY_FATAL, SEVERITY_MAJOR
from app.models.account import Account
from app.models.bei import (
    EVAL_ESTIMATE,
    EVAL_FINALIZED,
    EVAL_INSUFFICIENT,
    EVAL_NO_DATA,
    EVAL_STATUS_LABELS,
    THRESHOLD_ACTIVE,
    THRESHOLD_RETIRED,
    BeiManualScore,
    BeiMetricValue,
    BeiThresholdItem,
    BeiThresholdVersion,
    DivisionEvaluation,
)
from app.models.flow import DIVISION_ACTIVE, Division, Project
from app.models.issue import Issue, IssueAcceptance
from app.models.review import Review, ReviewSignature
from app.models.scoring import SNAPSHOT_SCOPE_PROJECT, ProjectScoreSnapshot, SnapshotIssue
from app.services.common import audit_business

# --------------------------------------------------------------------------- 常量

#: 季度格式：``2026Q4``（与自然季度对齐，Q1=1–3 月）
PERIOD_PATTERN = re.compile(r"^(\d{4})Q([1-4])$")

#: 超期未回复判定阈值（PRD §8.8.6：平均首次响应零分线 120 小时）
OVERDUE_UNREPLIED_HOURS = Decimal("120")

#: 阈值来源引用：必须可追溯到 PRD §8.8.6 的经验阈值表（ACCEPTANCE「L3」第 1 条）
THRESHOLD_SOURCE_REF = "docs/BEI_THRESHOLD_SOURCE.md §2 ← PRD V1.2 §8.8.6（经验阈值表，Q9 确认）"
THRESHOLD_SOURCE_NOTE = (
    "阈值取自 PRD V1.2 §8.8.6 经验阈值表并冻结为版本；状态为「经验阈值 · 待校准」，"
    "调整必须新建版本、不得原地覆盖。"
)

#: 阻断时的解除条件（响应必须包含，便于前端直接展示）
UNBLOCK_CONDITION = (
    "请由首账号在「系统设置 → BEI 阈值版本」创建或启用一个包含 14 个打分指标完整断点"
    "（满分线 / 及格线 / 零分线）与五维权重的阈值版本；解除后重新计算即可。"
)

#: 自动分公式（对外展示，明确可拆解）
FORMULA_AUTO = "BEI_auto = Σ(维度分 × 重标后权重)"
FORMULA_COMBINED = "combined_score = auto_score × auto_weight + manual_score × manual_weight"

PASS_LINE_SCORE = Decimal("60")
FULL_LINE_SCORE = Decimal("100")

#: 自动取数占比（15 个二级指标中 14 个自动取数、1 个（产品线 UEI 贡献度）为说明性）
AUTO_DATA_NOTE = "15 个二级指标中 14 个自动取数，人工仅体现在 ≤20% 的印象分栏"


# --------------------------------------------------------------------------- 工具


def _dec(value: Any) -> Decimal | None:
    if value is None or value == "":
        return None
    return Decimal(str(value))


def _q(value: Decimal, places: str) -> Decimal:
    return value.quantize(Decimal(places))


def _q2(value: Decimal | None) -> Decimal | None:
    return None if value is None else _q(value, "0.01")


def _q1(value: Decimal | None) -> Decimal | None:
    return None if value is None else sc.quantize(value)


def _s(value: Decimal | None) -> str | None:
    """分值/原始值统一字符串化（``None`` → ``None``）。"""
    if value is None:
        return None
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


def _pct(numerator: int, denominator: int) -> Decimal | None:
    if denominator <= 0:
        return None
    return Decimal(numerator) / Decimal(denominator) * Decimal("100")


def _mean(values: list[Decimal]) -> Decimal | None:
    if not values:
        return None
    return sum(values, Decimal("0")) / Decimal(len(values))


def parse_period(period: str) -> tuple[_dt.datetime, _dt.datetime]:
    """``2026Q4`` → (2026-10-01 00:00, 2027-01-01 00:00)；非法格式 422。"""
    match = PERIOD_PATTERN.match((period or "").strip())
    if match is None:
        raise ValidationError(
            "评价周期格式不正确，应为形如 2026Q4 的自然季度",
            field_errors=[
                {"field": "period", "message": "请使用 YYYYQn 格式（如 2026Q4）", "type": "value_error"}
            ],
        )
    year, quarter = int(match.group(1)), int(match.group(2))
    start = _dt.datetime(year, (quarter - 1) * 3 + 1, 1)
    end = _dt.datetime(year + (1 if quarter == 4 else 0), 1 if quarter == 4 else quarter * 3 + 1, 1)
    return start, end


def period_label(period: str) -> str:
    match = PERIOD_PATTERN.match((period or "").strip())
    if match is None:
        return period
    return f"{match.group(1)} 年第 {match.group(2)} 季度"


# --------------------------------------------------------------------------- 阈值版本


@dataclass
class ThresholdContext:
    """一次计算所用的阈值上下文（全部来自数据库）。"""

    version: BeiThresholdVersion
    items: dict[str, BeiThresholdItem]

    def spec(self, metric: bd.MetricSpec) -> bd.MetricSpec:
        """用数据库断点覆盖领域定义中的满分/及格/零分线与方向。"""
        item = self.items.get(metric.key)
        if item is None:
            return metric
        return metric._replace(
            direction=item.direction or metric.direction,
            full=item.full_line,
            passing=item.pass_line,
            zero=item.zero_line,
            scoring=item.is_scoring,
        )

    def weights(self) -> dict[str, Decimal]:
        raw = json.loads(self.version.weights_json or "{}")
        return {d.code: Decimal(str(raw.get(d.code, d.weight))) for d in bd.DIMENSIONS}


def active_threshold_version(db: Session) -> BeiThresholdVersion | None:
    """当前生效阈值版本（``is_active`` 且 ``status=active``，取最新）。"""
    return (
        db.execute(
            select(BeiThresholdVersion)
            .where(
                BeiThresholdVersion.is_active.is_(True),
                BeiThresholdVersion.status == THRESHOLD_ACTIVE,
            )
            .order_by(BeiThresholdVersion.created_at.desc(), BeiThresholdVersion.version_label.desc())
        )
        .scalars()
        .first()
    )


def _missing_report(version: BeiThresholdVersion | None) -> dict[str, Any]:
    """阈值完整性报告：缺少的指标断点 / 权重 / 版本。"""
    if version is None:
        return {
            "version": "数据库中无任何生效（active）的阈值版本",
            "metrics": [m.key for m in bd.SCORING_METRICS],
            "weights": [d.code for d in bd.DIMENSIONS],
        }
    items = {item.metric_key: item for item in version.items}
    missing_metrics = [
        m.key
        for m in bd.SCORING_METRICS
        if m.key not in items
        or not (items[m.key].full_line or "").strip()
        or not (items[m.key].pass_line or "").strip()
        or not (items[m.key].zero_line or "").strip()
    ]
    weights = json.loads(version.weights_json or "{}")
    missing_weights = [d.code for d in bd.DIMENSIONS if not str(weights.get(d.code) or "").strip()]
    return {
        "version": None if not missing_metrics and not missing_weights else version.version_label,
        "metrics": missing_metrics,
        "weights": missing_weights,
    }


def threshold_state(db: Session) -> tuple[ThresholdContext | None, dict[str, Any]]:
    """返回 ``(可用阈值上下文, 缺失报告)``；不可用时上下文为 ``None``。"""
    version = active_threshold_version(db)
    report = _missing_report(version)
    if version is None or report["metrics"] or report["weights"]:
        return None, report
    return ThresholdContext(version=version, items={i.metric_key: i for i in version.items}), report


def require_threshold(db: Session) -> ThresholdContext:
    """归一化 / 得分 / 定榜的前置条件；缺失时抛 ``BlockedError``（409 / blocked）。"""
    context, report = threshold_state(db)
    if context is None:
        raise BlockedError(
            "BEI 经验阈值缺失或版本项不完整，已阻断归一化 / 得分 / 定榜（禁止猜测阈值）",
            extra={
                "blocked_reason": report,
                "unblock_condition": UNBLOCK_CONDITION,
                "blocked_scope": ["normalize", "score", "finalize"],
                "data_collection_available": True,
            },
        )
    return context


def threshold_brief(db: Session) -> dict[str, Any] | None:
    """页面顶部展示的阈值版本摘要（含状态标注与来源）。"""
    version = active_threshold_version(db)
    if version is None:
        return None
    return {
        "id": version.id,
        "version_label": version.version_label,
        "status": version.status,
        "is_active": version.is_active,
        "status_label": version.status_label,
        "source_ref": version.source_ref,
    }


def serialize_threshold_version(version: BeiThresholdVersion, *, with_items: bool = True) -> dict[str, Any]:
    weights = json.loads(version.weights_json or "{}")
    payload: dict[str, Any] = {
        "id": version.id,
        "version_label": version.version_label,
        "status": version.status,
        "status_label": version.status_label,
        "is_active": version.is_active,
        "source_ref": version.source_ref,
        "source_note": version.source_note,
        "weights": weights,
        "dimensions": [
            {
                "code": d.code,
                "name": d.name,
                "weight": str(weights.get(d.code, d.weight)),
                "frozen_weight": d.weight,
            }
            for d in bd.DIMENSIONS
        ],
        "item_count": len(version.items),
        "created_by_name": version.created_by_name,
        "created_at": iso_z(version.created_at),
    }
    if with_items:
        payload["items"] = [serialize_threshold_item(item) for item in version.items]
    return payload


def serialize_threshold_item(item: BeiThresholdItem) -> dict[str, Any]:
    return {
        "metric_key": item.metric_key,
        "dimension": item.dimension,
        "name": item.name,
        "unit": item.unit,
        "direction": item.direction,
        "direction_label": bd.DIRECTION_LABELS.get(item.direction, item.direction),
        "full_line": item.full_line,
        "pass_line": item.pass_line,
        "zero_line": item.zero_line,
        "is_scoring": item.is_scoring,
        "source_field": item.source_field,
        "drill_down": item.drill_down,
    }


def list_threshold_versions(db: Session) -> dict[str, Any]:
    rows = (
        db.execute(select(BeiThresholdVersion).order_by(BeiThresholdVersion.created_at.desc()))
        .scalars()
        .all()
    )
    return {
        "items": [serialize_threshold_version(row, with_items=False) for row in rows],
        "total": len(rows),
        "status_label": bd.THRESHOLD_VERSION_STATUS,
        "source_ref": THRESHOLD_SOURCE_REF,
        "note": "阈值版本不可原地覆盖：调整必须新增版本，旧版本自动置 retired。",
    }


def get_threshold_version(db: Session, version_id: str) -> dict[str, Any]:
    version = db.get(BeiThresholdVersion, version_id)
    if version is None:
        raise NotFoundError("阈值版本不存在")
    return serialize_threshold_version(version, with_items=True)


def _normalize_weights(raw: dict[str, str] | None, fallback: dict[str, Decimal]) -> dict[str, str]:
    """校验并规范化五维权重：键必须是 D1..D5，合计必须为 1.00。"""
    if not raw:
        return {code: str(value) for code, value in fallback.items()}
    unknown = [key for key in raw if key not in bd.DIMENSION_BY_CODE]
    if unknown:
        raise ValidationError(
            "权重维度非法",
            field_errors=[
                {"field": "weights", "message": f"未知维度：{', '.join(unknown)}", "type": "value_error"}
            ],
        )
    resolved: dict[str, Decimal] = {}
    for code in bd.DIMENSION_BY_CODE:
        item = raw.get(code)
        if item is None:
            resolved[code] = fallback[code]
            continue
        try:
            resolved[code] = Decimal(str(item))
        except Exception as exc:  # noqa: BLE001
            raise ValidationError(
                "权重取值必须为十进制数字",
                field_errors=[{"field": "weights", "message": f"{code} 取值非法", "type": "value_error"}],
            ) from exc
        if resolved[code] < 0:
            raise ValidationError(
                "权重不得为负",
                field_errors=[{"field": "weights", "message": f"{code} 不得为负", "type": "value_error"}],
            )
    total = sum(resolved.values(), Decimal("0"))
    if total != Decimal("1.00"):
        raise ValidationError(
            "五维权重合计必须为 1.00",
            field_errors=[
                {
                    "field": "weights",
                    "message": f"当前合计 {total}，请调整为 1.00",
                    "type": "value_error",
                }
            ],
        )
    return {code: _s(value) or "0" for code, value in resolved.items()}


def create_threshold_version(
    db: Session,
    *,
    payload: Any,
    account: Account,
    ctx: RequestContext | None,
) -> dict[str, Any]:
    """新建阈值版本：不覆盖旧版本；同一时刻仅一个 active；权重变更留审计前后值。"""
    label = (payload.version_label or "").strip()
    if db.execute(
        select(BeiThresholdVersion.id).where(BeiThresholdVersion.version_label == label)
    ).first():
        raise ConflictError(
            f"阈值版本标签「{label}」已存在，请使用新标签",
            code="duplicate_version_label",
            extra={"hint": "阈值版本不可原地覆盖，必须新增版本"},
        )

    previous = active_threshold_version(db)
    frozen = {d.code: Decimal(d.weight) for d in bd.DIMENSIONS}
    weights_before = (
        {code: str(value) for code, value in ThresholdContext(previous, {}).weights().items()}
        if previous is not None
        else {code: str(value) for code, value in frozen.items()}
    )
    weights_after = _normalize_weights(payload.weights, frozen)

    previous_items = {item.metric_key: item for item in previous.items} if previous is not None else {}
    overrides = {item.metric_key: item for item in (payload.items or [])}
    unknown_metrics = [key for key in overrides if key not in bd.METRIC_BY_KEY]
    if unknown_metrics:
        raise ValidationError(
            "阈值指标键非法",
            field_errors=[
                {
                    "field": "items",
                    "message": f"未知二级指标：{', '.join(unknown_metrics)}",
                    "type": "value_error",
                }
            ],
        )

    now = utcnow()
    version_id = new_id()
    if previous is not None:  # 旧版本保留（不覆盖），仅退出 active
        previous.is_active = False
        previous.status = THRESHOLD_RETIRED
        previous.updated_at = now
    version = BeiThresholdVersion(
        id=version_id,
        version_label=label,
        source_ref=(payload.source_ref or THRESHOLD_SOURCE_REF),
        source_note=(payload.source_note or THRESHOLD_SOURCE_NOTE),
        status_label=bd.THRESHOLD_VERSION_STATUS,
        status=THRESHOLD_ACTIVE,
        is_active=True,
        weights_json=json.dumps(weights_after, ensure_ascii=False),
        created_by_name=account.name,
        created_at=now,
        updated_at=now,
    )
    db.add(version)

    for order, metric in enumerate(bd.METRICS):
        override = overrides.get(metric.key)
        base = previous_items.get(metric.key)
        db.add(
            BeiThresholdItem(
                id=new_id(),
                version_id=version_id,
                metric_key=metric.key,
                item_order=order,
                dimension=metric.dimension,
                name=metric.name,
                unit=metric.unit,
                direction=metric.direction,  # 方向固化自领域冻结定义，不可通过接口改写
                full_line=(override.full_line if override and override.full_line is not None
                           else (base.full_line if base is not None else metric.full)),
                pass_line=(override.pass_line if override and override.pass_line is not None
                           else (base.pass_line if base is not None else metric.passing)),
                zero_line=(override.zero_line if override and override.zero_line is not None
                           else (base.zero_line if base is not None else metric.zero)),
                is_scoring=metric.scoring,
                source_field=metric.source_field,
                drill_down=metric.drill_down,
                created_at=now,
                updated_at=now,
            )
        )

    changed = weights_before != weights_after
    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="create_bei_threshold_version",
        target_type="bei_threshold_version",
        target_id=version_id,
        summary=f"新建 BEI 阈值版本 {label}（权重变更：{'是' if changed else '否'}）",
        detail={
            "version_label": label,
            "weights_before": weights_before,
            "weights_after": weights_after,
            "weights_changed": changed,
            "retired_version_label": previous.version_label if previous is not None else None,
            "source_ref": version.source_ref,
        },
        commit=False,
    )
    db.commit()
    db.refresh(version)
    return serialize_threshold_version(version, with_items=True)


# --------------------------------------------------------------------------- 原始取数


@dataclass
class MetricRaw:
    """一个二级指标的原始取数与下钻依据。"""

    key: str
    dimension: str
    name: str
    unit: str
    direction: str
    is_scoring: bool
    raw: Decimal | None
    blocks: dict[str, Any] = field(default_factory=dict)
    drill: list[dict[str, Any]] = field(default_factory=list)
    normalized: Decimal | None = None

    @property
    def has_data(self) -> bool:
        return self.raw is not None


def _issue_drill(issue: Issue, **extra: Any) -> dict[str, Any]:
    """下钻条目统一形状：谁、何时、什么问题、什么状态（PRD §8.8.5）。"""
    payload: dict[str, Any] = {
        "issue_code": issue.code,
        "description": issue.description,
        "status": issue.status,
        "status_label": st.ISSUE_STATUS_LABELS.get(issue.status, issue.status),
        "owner_text": issue.owner_text,
        "division_id": issue.division_id,
        "module": issue.module,
        "metric_l2": issue.metric_l2,
        "severity": issue.severity,
        "business_level": issue.business_level,
        "created_at": iso_z(issue.created_at),
    }
    payload.update(extra)
    return payload


def _is_replied(issue: Issue) -> bool:
    """有事业部回复：以代录回复文本为准（无文本时回退到首次回复时间戳）。"""
    return bool((issue.division_reply or "").strip()) or issue.first_replied_at is not None


def _is_closed(issue: Issue) -> bool:
    return issue.status == st.ISSUE_CLOSED


def _age_hours(issue: Issue, reference: _dt.datetime) -> Decimal | None:
    if issue.created_at is None:
        return None
    return Decimal(str((reference - issue.created_at).total_seconds())) / Decimal("3600")


def _committed(issues: list[Issue]) -> list[Issue]:
    return [issue for issue in issues if (issue.committed_version or "").strip()]


def _severity_fatal_major(counts: dict[str, Any]) -> tuple[int, int]:
    total = 0
    fatal_major = 0
    for key, value in counts.items():
        try:
            number = int(value)
        except Exception:  # noqa: BLE001
            continue
        total += number
        if key.endswith(SEVERITY_FATAL) or key.endswith(SEVERITY_MAJOR):
            fatal_major += number
    return fatal_major, total


def collect_metrics(
    db: Session,
    *,
    division: Division,
    issues: list[Issue],
    acceptances: list[IssueAcceptance],
    reviews: list[Review],
    snapshots: list[ProjectScoreSnapshot],
    reference: _dt.datetime,
) -> list[MetricRaw]:
    """按 PRD §8.8.6 口径自动取数 15 个二级指标（14 个打分 + 1 个说明性）。

    每个指标的口径（公式）同时写入代码注释与 ``blocks_json``，保证可复核。
    """
    rows: list[MetricRaw] = []

    def add(metric: bd.MetricSpec, raw: Decimal | None, blocks: dict[str, Any],
            drill: list[dict[str, Any]]) -> None:
        rows.append(
            MetricRaw(
                key=metric.key,
                dimension=metric.dimension,
                name=metric.name,
                unit=metric.unit,
                direction=metric.direction,
                is_scoring=metric.scoring,
                raw=raw,
                blocks=blocks,
                drill=drill,
            )
        )

    total = len(issues)

    # ---------------- D1 响应及时性 ----------------

    # 口径：问题回复率 = 有 division_reply 的问题数 / 全部参评问题数 × 100%
    replied = [issue for issue in issues if _is_replied(issue)]
    add(
        bd.METRIC_BY_KEY["response_rate"],
        _pct(len(replied), total),
        {
            "formula": "有事业部回复的问题数 / 参评问题总数 × 100%",
            "replied": len(replied),
            "total": total,
            "source": "issue.division_reply / issue.first_replied_at",
        },
        [_issue_drill(issue, responded=_is_replied(issue)) for issue in issues],
    )

    # 口径：平均首次响应时长 = mean(first_replied_at − created_at)，单位小时
    durations = [
        Decimal(str((issue.first_replied_at - issue.created_at).total_seconds())) / Decimal("3600")
        for issue in issues
        if issue.first_replied_at is not None and issue.created_at is not None
    ]
    add(
        bd.METRIC_BY_KEY["first_response_hours"],
        _q2(_mean(durations)),
        {
            "formula": "mean(first_replied_at − created_at)，单位：小时",
            "samples": len(durations),
            "hours": [float(item) for item in durations],
            "source": "issue.first_replied_at − issue.created_at",
        },
        [
            _issue_drill(
                issue,
                hours=float((issue.first_replied_at - issue.created_at).total_seconds() / 3600),
                first_replied_at=iso_z(issue.first_replied_at),
            )
            for issue in issues
            if issue.first_replied_at is not None
        ],
    )

    # 口径：超期未回复数 = 登记超过 120 小时仍无事业部回复的问题数
    overdue_unreplied = [
        issue
        for issue in issues
        if not _is_replied(issue)
        and (_age_hours(issue, reference) or Decimal("0")) > OVERDUE_UNREPLIED_HOURS
    ]
    add(
        bd.METRIC_BY_KEY["overdue_unreplied"],
        Decimal(len(overdue_unreplied)) if total else None,
        {
            "formula": "登记超过 120 小时且无事业部回复的问题数（条）",
            "threshold_hours": str(OVERDUE_UNREPLIED_HOURS),
            "overdue": len(overdue_unreplied),
            "reference_at": iso_z(reference),
        },
        [
            _issue_drill(
                issue,
                responded=_is_replied(issue),
                age_hours=float(_age_hours(issue, reference) or 0),
                overdue=issue in overdue_unreplied,
            )
            for issue in issues
        ],
    )

    # ---------------- D2 问题闭环率 ----------------

    # 口径：问题关闭率 = status=closed 的问题数 / 全部参评问题数 × 100%
    closed = [issue for issue in issues if _is_closed(issue)]
    add(
        bd.METRIC_BY_KEY["issue_close_rate"],
        _pct(len(closed), total),
        {"formula": "status=closed 的问题数 / 参评问题总数 × 100%", "closed": len(closed), "total": total},
        [_issue_drill(issue, closed=_is_closed(issue)) for issue in issues],
    )

    # 口径：承诺版本内按期关闭率 = (已关闭 且 actual_version == committed_version) / 有承诺版本的问题数 × 100%
    committed = _committed(issues)
    on_time = [
        issue
        for issue in committed
        if _is_closed(issue)
        and (issue.actual_version or "").strip() == (issue.committed_version or "").strip()
    ]
    add(
        bd.METRIC_BY_KEY["on_time_close_rate"],
        _pct(len(on_time), len(committed)),
        {
            "formula": "(已关闭 且 实际版本 == 承诺版本) / 有承诺版本的问题数 × 100%",
            "on_time": len(on_time),
            "committed": len(committed),
        },
        [
            _issue_drill(
                issue,
                committed_version=issue.committed_version,
                actual_version=issue.actual_version,
                on_time=issue in on_time,
                closed=_is_closed(issue),
            )
            for issue in committed
        ],
    )

    # 口径：超期遗留数 = 有承诺版本但未关闭的问题数（条）
    backlog = [issue for issue in committed if not _is_closed(issue)]
    add(
        bd.METRIC_BY_KEY["overdue_backlog"],
        Decimal(len(backlog)) if committed else None,
        {
            "formula": "有承诺版本但未关闭的问题数（条）",
            "committed": len(committed),
            "backlog": len(backlog),
        },
        [
            _issue_drill(
                issue,
                committed_version=issue.committed_version,
                actual_version=issue.actual_version,
                closed=_is_closed(issue),
                backlog=issue in backlog,
            )
            for issue in committed
        ],
    )

    # ---------------- D3 整改质量 ----------------

    # 口径：复测验收通过率 = result=accepted 的验收记录数 / 全部验收记录数 × 100%
    accepted = [item for item in acceptances if item.result == st.ISSUE_ACCEPTED]
    add(
        bd.METRIC_BY_KEY["retest_pass_rate"],
        _pct(len(accepted), len(acceptances)),
        {
            "formula": "issue_acceptance.result=accepted 的记录数 / 全部验收记录数 × 100%",
            "accepted": len(accepted),
            "total": len(acceptances),
        },
        [
            {
                "issue_code": item.issue_code if hasattr(item, "issue_code") else "",
                "acceptance_id": item.id,
                "result": item.result,
                "tested_version": item.tested_version,
                "reason": item.reason,
            }
            for item in acceptances
        ],
    )

    # 口径：驳回后平均重试次数 = 全部驳回次数 / 参评问题数（每问题被驳回次数均值）
    reject_counts = {issue.id: 0 for issue in issues}
    for item in acceptances:
        if item.result == st.ISSUE_REJECTED and item.issue_id in reject_counts:
            reject_counts[item.issue_id] += 1
    total_rejects = sum(reject_counts.values())
    add(
        bd.METRIC_BY_KEY["avg_retry_after_reject"],
        (Decimal(total_rejects) / Decimal(total)) if total else None,
        {
            "formula": "全部验收驳回次数 / 参评问题总数（每问题被驳回次数均值）",
            "rejects": total_rejects,
            "total": total,
        },
        [
            _issue_drill(issue, rejected_count=reject_counts.get(issue.id, 0))
            for issue in issues
        ],
    )

    # 口径：同类问题重复发生率 = Σ(同 (module, metric_l2) 分组内 问题数−1) / 参评问题总数 × 100%
    groups: dict[tuple[str, str], list[Issue]] = {}
    for issue in issues:
        groups.setdefault(((issue.module or "").strip(), (issue.metric_l2 or "").strip()), []).append(issue)
    duplicate_issues: list[Issue] = []
    group_detail: list[dict[str, Any]] = []
    for (module, metric_l2), members in groups.items():
        if len(members) > 1:
            duplicate_issues.extend(members[1:])
            group_detail.append(
                {
                    "module": module,
                    "metric_l2": metric_l2,
                    "count": len(members),
                    "issue_codes": [member.code for member in members],
                }
            )
    add(
        bd.METRIC_BY_KEY["repeat_issue_rate"],
        _pct(len(duplicate_issues), total),
        {
            "formula": "Σ(同 (module, metric_l2) 分组内问题数−1) / 参评问题总数 × 100%",
            "repeat_issues": len(duplicate_issues),
            "total": total,
            "groups": group_detail,
        },
        [_issue_drill(issue, duplicate=True) for issue in duplicate_issues],
    )

    # ---------------- D4 体验投入度 ----------------

    # 口径：承诺版本兑现率 = (实际版本 == 承诺版本) / 有承诺版本的问题数 × 100%
    fulfilled = [
        issue
        for issue in committed
        if (issue.actual_version or "").strip()
        and (issue.actual_version or "").strip() == (issue.committed_version or "").strip()
    ]
    add(
        bd.METRIC_BY_KEY["commitment_fulfill_rate"],
        _pct(len(fulfilled), len(committed)),
        {
            "formula": "(实际版本 == 承诺版本) / 有承诺版本的问题数 × 100%",
            "fulfilled": len(fulfilled),
            "committed": len(committed),
        },
        [
            _issue_drill(
                issue,
                committed_version=issue.committed_version,
                actual_version=issue.actual_version,
                fulfilled=issue in fulfilled,
            )
            for issue in committed
        ],
    )

    # 口径：体验需求采纳率 = solution 非空的问题数 / 全部参评问题数 × 100%
    adopted = [issue for issue in issues if (issue.solution or "").strip()]
    add(
        bd.METRIC_BY_KEY["experience_adoption_rate"],
        _pct(len(adopted), total),
        {
            "formula": "issue.solution 非空的问题数 / 参评问题总数 × 100%",
            "adopted": len(adopted),
            "total": total,
        },
        [_issue_drill(issue, adopted=issue in adopted) for issue in issues],
    )

    # 口径：评审参与记录 = 本季度该事业部在评审部门签署中缺席的评审次数（次）
    signatures_by_review: dict[str, list[ReviewSignature]] = {}
    for review in reviews:
        signatures_by_review[review.id] = list(review.signatures)
    division_keys = {division.name.strip(), (division.code or "").strip(), division.id}
    absent_reviews: list[Review] = []
    review_drill: list[dict[str, Any]] = []
    for review in reviews:
        departments = [sig.department.strip() for sig in signatures_by_review.get(review.id, [])]
        signed = any(
            any(key and (key in department or department in key) for key in division_keys)
            for department in departments
        )
        if not signed:
            absent_reviews.append(review)
        review_drill.append(
            {
                "review_code": review.code,
                "review_id": review.id,
                "title": review.title,
                "stage": review.stage,
                "signed_departments": departments,
                "division_signed": signed,
                "created_at": iso_z(review.created_at),
                # 下钻关联问题（评审决策绑定的问题）
                "issue_code": next(
                    (d.issue_code for d in review.decisions if (d.issue_code or "").strip()), ""
                ),
                "issue_codes": [d.issue_code for d in review.decisions if (d.issue_code or "").strip()],
            }
        )
    add(
        bd.METRIC_BY_KEY["review_participation"],
        Decimal(len(absent_reviews)) if reviews else None,
        {
            "formula": "该事业部未在评审部门签署中出现的评审次数（次，缺省视为无数据）",
            "reviews": len(reviews),
            "absent": len(absent_reviews),
            "matched_keys": sorted(key for key in division_keys if key),
        },
        review_drill,
    )

    # ---------------- D5 体验成效 ----------------

    # 口径：版本 UEI 提升幅度 = 同一产品相邻两次 L1 快照 display_uei 之差，跨产品取平均
    by_project: dict[str, list[ProjectScoreSnapshot]] = {}
    for snapshot in snapshots:
        by_project.setdefault(snapshot.project_id, []).append(snapshot)
    gains: list[Decimal] = []
    uei_drill: list[dict[str, Any]] = []
    for project_id, items in by_project.items():
        items = sorted(items, key=lambda item: item.snapshot_at or _dt.datetime.min)
        if len(items) < 2:
            continue
        previous, latest = items[-2], items[-1]
        gain = Decimal(str(latest.display_uei or "0")) - Decimal(str(previous.display_uei or "0"))
        gains.append(gain)
        uei_drill.append(
            {
                "project_id": project_id,
                "project_name": latest.project_name,
                "prev_snapshot_id": previous.id,
                "prev_uei": previous.display_uei,
                "latest_snapshot_id": latest.id,
                "latest_uei": latest.display_uei,
                "gain": float(gain),
                "issue_code": next((i.issue_code for i in latest.issues), ""),
                "issue_codes": [i.issue_code for i in latest.issues],
            }
        )
    add(
        bd.METRIC_BY_KEY["uei_gain"],
        _q2(_mean(gains)),
        {
            "formula": "同一项目相邻两次 L1 快照 display_uei 之差，跨项目取算术平均（分）",
            "projects": len(gains),
            "gains": [float(item) for item in gains],
        },
        uei_drill,
    )

    # 口径：致命+严重问题下降率 = (上一期占比 − 本期占比) × 100%，跨产品取平均
    drops: list[Decimal] = []
    drop_drill: list[dict[str, Any]] = []
    for project_id, items in by_project.items():
        items = sorted(items, key=lambda item: item.snapshot_at or _dt.datetime.min)
        if len(items) < 2:
            continue
        previous, latest = items[-2], items[-1]
        prev_counts = json.loads(previous.severity_counts_json or "{}")
        latest_counts = json.loads(latest.severity_counts_json or "{}")
        prev_cm, prev_total = _severity_fatal_major(prev_counts)
        latest_cm, latest_total = _severity_fatal_major(latest_counts)
        prev_ratio = (Decimal(prev_cm) / Decimal(prev_total)) if prev_total else Decimal("0")
        latest_ratio = (Decimal(latest_cm) / Decimal(latest_total)) if latest_total else Decimal("0")
        drop = (prev_ratio - latest_ratio) * Decimal("100")
        drops.append(drop)
        drop_drill.append(
            {
                "project_id": project_id,
                "project_name": latest.project_name,
                "prev_snapshot_id": previous.id,
                "latest_snapshot_id": latest.id,
                "prev_fatal_major": prev_cm,
                "prev_total": prev_total,
                "latest_fatal_major": latest_cm,
                "latest_total": latest_total,
                "drop": float(drop),
                "issue_code": next(
                    (
                        i.issue_code
                        for i in latest.issues
                        if i.severity in (SEVERITY_FATAL, SEVERITY_MAJOR)
                    ),
                    "",
                ),
                "issue_codes": [
                    i.issue_code
                    for i in latest.issues
                    if i.severity in (SEVERITY_FATAL, SEVERITY_MAJOR)
                ],
            }
        )
    add(
        bd.METRIC_BY_KEY["critical_major_drop_rate"],
        _q2(_mean(drops)),
        {
            "formula": "(上一期致命+严重占比 − 本期致命+严重占比) × 100%，跨项目取算术平均",
            "projects": len(drops),
            "drops": [float(item) for item in drops],
        },
        drop_drill,
    )

    # 说明性指标：系统 UEI 贡献度（源表无断点 → 不参与单点归一化打分）
    add(
        bd.METRIC_BY_KEY["product_line_uei_contribution"],
        None,
        {
            "formula": "该部门系统 UEI 占其全域比重（%）",
            "note": "源阈值表以「—」标注，无满分/及格/零分断点，故不参与单点打分，仅作说明",
            "scoring": False,
        },
        [],
    )

    return rows


# --------------------------------------------------------------------------- 归一化与合成


def _rescaled_weights(context: ThresholdContext, active: list[str]) -> dict[str, Decimal]:
    """剔除无数据维度后，剩余维度权重等比放大至 100%。

    默认（v1 冻结阈值）与 :func:`app.domain.bei.rescale_weights` 完全一致；
    若版本自定义了权重，则按同一公式对**版本权重**等比放大。
    """
    version_weights = context.weights()
    frozen = {d.code: Decimal(d.weight) for d in bd.DIMENSIONS}
    if version_weights == frozen:
        return bd.rescale_weights(active)
    total = sum((version_weights.get(code, Decimal("0")) for code in active), Decimal("0"))
    if total == 0:
        return {}
    return {code: version_weights.get(code, Decimal("0")) / total for code in active}


@dataclass
class EvaluationResult:
    """一次计算的全部中间结果（用于响应组装与落库）。"""

    division: Division
    period: str
    rows: list[MetricRaw]
    dim_scores: dict[str, Decimal]
    active_dimensions: list[str]
    rescaled_weights: dict[str, Decimal]
    auto_score: Decimal | None
    issue_count: int
    participating_project_count: int
    sample_sufficient: bool
    status: str
    threshold: ThresholdContext | None
    blocked: dict[str, Any] | None
    reference_at: _dt.datetime


def evaluate_division(
    db: Session,
    *,
    division: Division,
    period: str,
    reference: _dt.datetime | None = None,
) -> EvaluationResult:
    """实时计算（明细层实时刷新）：取数 → 归一化 → 维度分 → 自动分。

    阈值缺失时不做归一化与得分（``blocked``），但**原始取数与下钻照常返回**。
    """
    start, end = parse_period(period)
    reference = reference or utcnow()

    issues = list(
        db.execute(
            select(Issue).where(
                Issue.division_id == division.id,
                Issue.created_at >= start,
                Issue.created_at < end,
            )
        )
        .scalars()
        .all()
    )
    issue_ids = [issue.id for issue in issues]
    acceptances = (
        list(
            db.execute(select(IssueAcceptance).where(IssueAcceptance.issue_id.in_(issue_ids)))
            .scalars()
            .all()
        )
        if issue_ids
        else []
    )

    projects = list(
        db.execute(select(Project).where(Project.division_id == division.id)).scalars().all()
    )
    project_ids = [project.id for project in projects]
    reviews = (
        list(
            db.execute(
                select(Review).where(
                    Review.project_id.in_(project_ids),
                    Review.created_at >= start,
                    Review.created_at < end,
                )
            )
            .scalars()
            .all()
        )
        if project_ids
        else []
    )

    snapshots = list(
        db.execute(
            select(ProjectScoreSnapshot).where(
                ProjectScoreSnapshot.division_id == division.id,
                ProjectScoreSnapshot.scope == SNAPSHOT_SCOPE_PROJECT,
                ProjectScoreSnapshot.is_effective.is_(True),
            )
        )
        .scalars()
        .all()
    )

    rows = collect_metrics(
        db,
        division=division,
        issues=issues,
        acceptances=acceptances,
        reviews=reviews,
        snapshots=snapshots,
        reference=reference,
    )

    context, report = threshold_state(db)
    if context is not None:
        for row in rows:
            metric = bd.METRIC_BY_KEY[row.key]
            if not metric.scoring:
                continue
            row.normalized = _q2(bd.normalize(context.spec(metric), row.raw))
    else:
        for row in rows:
            row.normalized = None

    dim_scores: dict[str, Decimal] = {}
    for dimension in bd.DIMENSIONS:
        values = [
            row.normalized
            for row in rows
            if row.dimension == dimension.code
            and row.is_scoring
            and row.normalized is not None
        ]
        mean = _mean([value for value in values if value is not None])
        if mean is not None:
            dim_scores[dimension.code] = mean

    active_dimensions = [dimension.code for dimension in bd.DIMENSIONS if dimension.code in dim_scores]
    rescaled = _rescaled_weights(context, active_dimensions) if context is not None else {}
    auto_score = (
        sum((dim_scores[code] * rescaled.get(code, Decimal("0")) for code in active_dimensions), Decimal("0"))
        if active_dimensions and context is not None
        else None
    )

    issue_count = len(issues)
    sample_sufficient = issue_count >= bd.MIN_ISSUES_FOR_SCORE
    if not projects or issue_count == 0:
        status = EVAL_NO_DATA
        sample_sufficient = False
    elif not sample_sufficient:
        status = EVAL_INSUFFICIENT
    else:
        status = EVAL_ESTIMATE

    blocked = None
    if context is None:
        blocked = {
            "reason": report,
            "unblock_condition": UNBLOCK_CONDITION,
            "scope": ["normalize", "score", "finalize"],
        }
        auto_score = None
        status = EVAL_ESTIMATE  # 数据采集仍可用，得分缺失单独由 has_score 表达

    if status in (EVAL_INSUFFICIENT, EVAL_NO_DATA):
        auto_score = None  # 不给分

    return EvaluationResult(
        division=division,
        period=period,
        rows=rows,
        dim_scores=dim_scores,
        active_dimensions=active_dimensions,
        rescaled_weights=rescaled,
        auto_score=auto_score,
        issue_count=issue_count,
        participating_project_count=len({project.system_id for project in projects}),
        sample_sufficient=sample_sufficient,
        status=status,
        threshold=context,
        blocked=blocked,
        reference_at=reference,
    )


# --------------------------------------------------------------------------- 落库与组装


def _load_manual(db: Session, evaluation_id: str) -> BeiManualScore | None:
    return (
        db.execute(
            select(BeiManualScore)
            .where(BeiManualScore.evaluation_id == evaluation_id)
            .order_by(BeiManualScore.entered_at.desc())
        )
        .scalars()
        .first()
    )


def _combined(auto_score: Decimal | None, manual: BeiManualScore | None) -> tuple[Decimal | None, Decimal, Decimal]:
    """自动分与人工分**分栏**合成：``combined = auto × auto_weight + manual × manual_weight``。"""
    if manual is None:
        return auto_score, Decimal("1.00"), Decimal("0.00")
    manual_weight = Decimal(str(manual.weight))
    auto_weight = Decimal("1") - manual_weight
    if auto_score is None:
        return None, auto_weight, manual_weight
    combined = auto_score * auto_weight + Decimal(str(manual.score)) * manual_weight
    return combined, auto_weight, manual_weight


def persist_evaluation(
    db: Session,
    *,
    division: Division,
    period: str,
    result: EvaluationResult,
    status: str,
    account: Account | None = None,
    threshold_version: BeiThresholdVersion | None = None,
    commit: bool = True,
) -> DivisionEvaluation:
    """把计算结果落库（``division_evaluation`` + ``bei_metric_value``）。

    备注保存在 ``calc_trace_json.notes``，重算时**原样保留**（备注不影响任何数值）。
    """
    version = threshold_version or (result.threshold.version if result.threshold else None)
    if version is None:
        raise BlockedError(
            "阈值缺失时不落库季度评价（禁止猜测阈值）",
            extra={"blocked_reason": (result.blocked or {}).get("reason"), "unblock_condition": UNBLOCK_CONDITION},
        )

    evaluation = (
        db.execute(
            select(DivisionEvaluation).where(
                DivisionEvaluation.division_id == division.id,
                DivisionEvaluation.period == period,
                DivisionEvaluation.threshold_version_id == version.id,
            )
        )
        .scalars()
        .first()
    )
    now = utcnow()
    if evaluation is None:
        evaluation = DivisionEvaluation(
            id=new_id(),
            division_id=division.id,
            division_name=division.name,
            period=period,
            threshold_version_id=version.id,
            threshold_version_label=version.version_label,
            created_by=(account.id if account else ""),
            created_by_name=(account.name if account else ""),
            created_at=now,
            updated_at=now,
        )
        db.add(evaluation)

    manual = _load_manual(db, evaluation.id) if evaluation.id else None
    combined, auto_weight, manual_weight = _combined(result.auto_score, manual)

    evaluation.division_name = division.name
    evaluation.threshold_version_label = version.version_label
    evaluation.status = status
    evaluation.issue_count = result.issue_count
    evaluation.sample_sufficient = result.sample_sufficient
    evaluation.participating_project_count = result.participating_project_count
    evaluation.d1_score = _s(_q2(result.dim_scores.get("D1")))
    evaluation.d2_score = _s(_q2(result.dim_scores.get("D2")))
    evaluation.d3_score = _s(_q2(result.dim_scores.get("D3")))
    evaluation.d4_score = _s(_q2(result.dim_scores.get("D4")))
    evaluation.d5_score = _s(_q2(result.dim_scores.get("D5")))
    evaluation.active_dimensions_json = json.dumps(result.active_dimensions, ensure_ascii=False)
    evaluation.rescaled_weights_json = json.dumps(
        {code: _s(value) for code, value in result.rescaled_weights.items()}, ensure_ascii=False
    )
    evaluation.auto_score = _s(_q1(result.auto_score))
    evaluation.auto_weight = f"{auto_weight:.2f}"
    evaluation.manual_weight = f"{manual_weight:.2f}"
    evaluation.combined_score = _s(_q1(combined))
    evaluation.grade = bd.grade_of(combined)
    evaluation.disclaimer = bd.DISCLAIMER
    evaluation.updated_at = now
    evaluation.updated_by_name = account.name if account else evaluation.updated_by_name

    # 备注保留：只更新计算轨迹，不触碰 notes
    trace = _load_trace(evaluation)
    trace.update(
        {
            "formula_auto": FORMULA_AUTO,
            "formula_combined": FORMULA_COMBINED,
            "active_dimensions": result.active_dimensions,
            "rescaled_weights": {code: _s(value) for code, value in result.rescaled_weights.items()},
            "dimension_scores": {code: _s(_q2(value)) for code, value in result.dim_scores.items()},
            "issue_count": result.issue_count,
            "sample_sufficient": result.sample_sufficient,
            "threshold_version_label": version.version_label,
            "status": status,
        }
    )
    evaluation.calc_trace_json = json.dumps(trace, ensure_ascii=False)

    db.execute(delete(BeiMetricValue).where(BeiMetricValue.evaluation_id == evaluation.id))
    for row in result.rows:
        spec = bd.METRIC_BY_KEY[row.key]
        breakpoints = {
            "full_line": None,
            "pass_line": None,
            "zero_line": None,
        }
        if result.threshold is not None:
            item = result.threshold.items.get(row.key)
            if item is not None:
                breakpoints = {
                    "full_line": item.full_line,
                    "pass_line": item.pass_line,
                    "zero_line": item.zero_line,
                }
        db.add(
            BeiMetricValue(
                id=new_id(),
                evaluation_id=evaluation.id,
                metric_key=row.key,
                dimension=row.dimension,
                name=row.name,
                unit=row.unit,
                direction=row.direction,
                is_scoring=row.is_scoring,
                raw_value=_s(row.raw),
                normalized=_s(row.normalized),
                has_data=row.has_data and row.is_scoring,
                blocks_json=json.dumps(
                    {
                        **row.blocks,
                        "breakpoints": breakpoints,
                        "direction": row.direction,
                        "direction_label": bd.DIRECTION_LABELS.get(row.direction, row.direction),
                        "source_field": spec.source_field,
                        "drill_down": spec.drill_down,
                    },
                    ensure_ascii=False,
                ),
                drill_json=json.dumps(row.drill, ensure_ascii=False),
                created_at=now,
                updated_at=now,
            )
        )

    if commit:
        db.commit()
        db.refresh(evaluation)
    else:
        db.flush()
    return evaluation


def _load_trace(evaluation: DivisionEvaluation) -> dict[str, Any]:
    try:
        trace = json.loads(evaluation.calc_trace_json or "{}")
    except Exception:  # noqa: BLE001
        trace = {}
    if not isinstance(trace, dict):
        trace = {}
    trace.setdefault("notes", [])
    return trace


def evaluation_payload(
    db: Session,
    evaluation: DivisionEvaluation,
    *,
    rows: list[MetricRaw] | None = None,
    blocked: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """组装对外响应：五维分、自动/人工分栏、四档、下钻、阈值与免责声明。"""
    manual = _load_manual(db, evaluation.id)
    auto_score = _dec(evaluation.auto_score)
    combined = _dec(evaluation.combined_score)
    auto_weight, manual_weight = _dec(evaluation.auto_weight), _dec(evaluation.manual_weight)
    trace = _load_trace(evaluation)

    metric_values = {item.metric_key: item for item in evaluation.metrics}
    metric_rows: list[dict[str, Any]] = []
    for metric in bd.METRICS:
        item = metric_values.get(metric.key)
        if item is None:
            continue
        blocks: dict[str, Any] = {}
        drill: list[dict[str, Any]] = []
        try:
            blocks = json.loads(item.blocks_json or "{}")
        except Exception:  # noqa: BLE001
            blocks = {}
        try:
            drill = json.loads(item.drill_json or "[]")
        except Exception:  # noqa: BLE001
            drill = []
        metric_rows.append(
            {
                "metric_key": item.metric_key,
                "dimension": item.dimension,
                "dimension_name": bd.DIMENSION_BY_CODE[item.dimension].name,
                "name": item.name,
                "unit": item.unit,
                "direction": item.direction,
                "direction_label": bd.DIRECTION_LABELS.get(item.direction, item.direction),
                "is_scoring": item.is_scoring,
                "raw_value": item.raw_value,
                "normalized": item.normalized,
                "has_data": item.has_data,
                "breakpoints": blocks.get("breakpoints", {}),
                "formula": blocks.get("formula", ""),
                "blocks": blocks,
                "drill": drill,
                "drill_count": len(drill),
            }
        )

    rescaled = {}
    try:
        rescaled = json.loads(evaluation.rescaled_weights_json or "{}")
    except Exception:  # noqa: BLE001
        rescaled = {}
    active = []
    try:
        active = json.loads(evaluation.active_dimensions_json or "[]")
    except Exception:  # noqa: BLE001
        active = []

    version = db.get(BeiThresholdVersion, evaluation.threshold_version_id)
    return {
        "evaluation_id": evaluation.id,
        "division_id": evaluation.division_id,
        "division_name": evaluation.division_name,
        "period": evaluation.period,
        "period_label": period_label(evaluation.period),
        "status": evaluation.status,
        "status_label": EVAL_STATUS_LABELS.get(evaluation.status, evaluation.status),
        "finalized": evaluation.status == EVAL_FINALIZED,
        "finalized_at": iso_z(evaluation.finalized_at),
        "finalized_by_name": evaluation.finalized_by_name,
        "issue_count": evaluation.issue_count,
        "participating_project_count": evaluation.participating_project_count,
        "sample_sufficient": evaluation.sample_sufficient,
        "min_issues_for_score": bd.MIN_ISSUES_FOR_SCORE,
        "has_score": auto_score is not None,
        "d1": evaluation.d1_score,
        "d2": evaluation.d2_score,
        "d3": evaluation.d3_score,
        "d4": evaluation.d4_score,
        "d5": evaluation.d5_score,
        "d1_score": evaluation.d1_score,
        "d2_score": evaluation.d2_score,
        "d3_score": evaluation.d3_score,
        "d4_score": evaluation.d4_score,
        "d5_score": evaluation.d5_score,
        "dimensions": [
            {
                "code": dimension.code,
                "name": dimension.name,
                "weight": (json.loads(version.weights_json or "{}").get(dimension.code) if version else dimension.weight)
                or dimension.weight,
                "frozen_weight": dimension.weight,
                "rescaled_weight": rescaled.get(dimension.code),
                "score": getattr(evaluation, f"{dimension.code.lower()}_score"),
                "active": dimension.code in active,
            }
            for dimension in bd.DIMENSIONS
        ],
        "active_dimensions": active,
        "rescaled_weights": rescaled,
        "auto_score": evaluation.auto_score,
        "auto_weight": evaluation.auto_weight,
        "manual_score": (manual.score if manual else None),
        "manual_weight": evaluation.manual_weight,
        "manual_entries": [
            {
                "id": item.id,
                "score": item.score,
                "weight": item.weight,
                "reason": item.reason,
                "basis": item.basis,
                "entered_by": item.entered_by,
                "entered_at": iso_z(item.entered_at),
            }
            for item in sorted(evaluation.manual, key=lambda row: row.entered_at or _dt.datetime.min)
        ],
        "combined_score": evaluation.combined_score,
        "formula": FORMULA_COMBINED,
        "formula_auto": FORMULA_AUTO,
        "grade": evaluation.grade,
        "grade_label": bd.GRADE_LABELS.get(evaluation.grade or "", None),
        "grade_semantics": bd.GRADE_SEMANTICS.get(evaluation.grade or "", None),
        "metrics": metric_rows,
        "notes": trace.get("notes", []),
        "threshold": (
            {
                "id": version.id,
                "version_label": version.version_label,
                "status": version.status,
                "status_label": version.status_label,
                "source_ref": version.source_ref,
                "is_active": version.is_active,
            }
            if version is not None
            else None
        ),
        "blocked": blocked,
        "auto_data_note": AUTO_DATA_NOTE,
        "auto_data_ratio": f"{len(bd.SCORING_METRICS)}/{len(bd.METRICS)}",
        "disclaimer": evaluation.disclaimer or bd.DISCLAIMER,
    }


def evaluate_and_persist(
    db: Session,
    *,
    division: Division,
    period: str,
    account: Account | None = None,
    reference: _dt.datetime | None = None,
    commit: bool = True,
) -> tuple[DivisionEvaluation | None, EvaluationResult, dict[str, Any] | None]:
    """取数 + 落库；阈值缺失时返回内存结果（``evaluation`` 为 ``None``）。"""
    result = evaluate_division(db, division=division, period=period, reference=reference)
    if result.threshold is None:
        return None, result, result.blocked
    evaluation = persist_evaluation(
        db, division=division, period=period, result=result, status=result.status,
        account=account, commit=commit,
    )
    return evaluation, result, None


def existing_finalized(db: Session, division_id: str, period: str) -> DivisionEvaluation | None:
    return (
        db.execute(
            select(DivisionEvaluation)
            .where(
                DivisionEvaluation.division_id == division_id,
                DivisionEvaluation.period == period,
                DivisionEvaluation.status == EVAL_FINALIZED,
            )
            .order_by(DivisionEvaluation.finalized_at.desc())
        )
        .scalars()
        .first()
    )


# --------------------------------------------------------------------------- 对外用例


def _division_or_404(db: Session, division_id: str) -> Division:
    division = db.get(Division, division_id)
    if division is None:
        raise NotFoundError(f"事业部不存在：{division_id}")
    return division


def division_ranking(db: Session, *, period: str, account: Account | None = None) -> dict[str, Any]:
    """季度榜单：同层内按 ``combined_score`` 排名；样本不足/无数据单独分组不参与排名。"""
    parse_period(period)  # 格式校验（非法 422）
    require_threshold(db)  # 榜单即得分 → 阈值缺失 409 blocked

    divisions = (
        db.execute(select(Division).where(Division.status == DIVISION_ACTIVE).order_by(Division.code))
        .scalars()
        .all()
    )
    ranked: list[dict[str, Any]] = []
    insufficient: list[dict[str, Any]] = []
    no_data: list[dict[str, Any]] = []

    for division in divisions:
        finalized = existing_finalized(db, division.id, period)
        if finalized is not None:
            payload = evaluation_payload(db, finalized)
            result_status = finalized.status
            score = _dec(finalized.combined_score)
        else:
            evaluation, _result, _blocked = evaluate_and_persist(
                db, division=division, period=period, account=account
            )
            if evaluation is None:  # pragma: no cover - require_threshold 已提前拦截
                continue
            payload = evaluation_payload(db, evaluation)
            result_status = evaluation.status
            score = _dec(evaluation.combined_score)

        row = {
            "division_id": payload["division_id"],
            "division_name": payload["division_name"],
            "evaluation_id": payload["evaluation_id"],
            "status": payload["status"],
            "status_label": payload["status_label"],
            "issue_count": payload["issue_count"],
            "sample_sufficient": payload["sample_sufficient"],
            "has_score": payload["has_score"],
            "auto_score": payload["auto_score"],
            "manual_score": payload["manual_score"],
            "manual_weight": payload["manual_weight"],
            "combined_score": payload["combined_score"],
            "grade": payload["grade"],
            "grade_label": payload["grade_label"],
            "d1": payload["d1"],
            "d2": payload["d2"],
            "d3": payload["d3"],
            "d4": payload["d4"],
            "d5": payload["d5"],
            "disclaimer": payload["disclaimer"],
            "finalized": payload["finalized"],
            "rank": None,
            "_score": score,
        }
        if result_status == EVAL_NO_DATA:
            no_data.append(row)
        elif result_status == EVAL_INSUFFICIENT or not payload["has_score"]:
            insufficient.append(row)
        else:
            ranked.append(row)

    ranked.sort(key=lambda item: (-(item["_score"] or Decimal("0")), item["division_name"]))
    for index, row in enumerate(ranked):
        if index > 0 and row["_score"] == ranked[index - 1]["_score"]:
            row["rank"] = ranked[index - 1]["rank"]
        else:
            row["rank"] = index + 1

    items = ranked + insufficient + no_data
    for row in items:
        row.pop("_score", None)

    return {
        "period": period,
        "period_label": period_label(period),
        "groups": {
            "ranked": ranked,
            "insufficient_sample": insufficient,
            "no_participating_data": no_data,
        },
        "items": items,
        "ranked_count": len(ranked),
        "threshold_version": threshold_brief(db),
        "min_issues_for_score": bd.MIN_ISSUES_FOR_SCORE,
        "disclaimer": bd.DISCLAIMER,
        "note": "季度内为未定榜预估；样本不足与本期无参评数据单列分组，不参与排名。",
    }


def preview_division(db: Session, *, division_id: str, period: str, account: Account | None = None) -> dict[str, Any]:
    """实时预估：返回五维分、自动分、人工分与分栏、四档、逐指标原始值/归一化/断点/下钻。"""
    division = _division_or_404(db, division_id)
    parse_period(period)

    finalized = existing_finalized(db, division.id, period)
    if finalized is not None:
        payload = evaluation_payload(db, finalized)
        payload["estimate"] = False
        payload["estimate_label"] = "已定榜（不可修改）"
        return payload

    evaluation, result, blocked = evaluate_and_persist(db, division=division, period=period, account=account)
    if evaluation is None:
        payload = _blocked_preview_payload(division, period, result)
        payload["estimate"] = True
        payload["estimate_label"] = "未定榜"
        return payload
    payload = evaluation_payload(db, evaluation, blocked=blocked)
    payload["estimate"] = True
    payload["estimate_label"] = "未定榜"
    return payload


def _blocked_preview_payload(division: Division, period: str, result: EvaluationResult) -> dict[str, Any]:
    """阈值缺失时的预估响应：只给数据采集与下钻，不给归一化分与得分。"""
    return {
        "evaluation_id": None,
        "division_id": division.id,
        "division_name": division.name,
        "period": period,
        "period_label": period_label(period),
        "status": EVAL_ESTIMATE,
        "status_label": EVAL_STATUS_LABELS[EVAL_ESTIMATE],
        "finalized": False,
        "issue_count": result.issue_count,
        "participating_project_count": result.participating_project_count,
        "sample_sufficient": result.sample_sufficient,
        "min_issues_for_score": bd.MIN_ISSUES_FOR_SCORE,
        "has_score": False,
        "d1": None, "d2": None, "d3": None, "d4": None, "d5": None,
        "dimensions": [],
        "active_dimensions": [],
        "rescaled_weights": {},
        "auto_score": None,
        "auto_weight": "1.00",
        "manual_score": None,
        "manual_weight": "0.00",
        "manual_entries": [],
        "combined_score": None,
        "formula": FORMULA_COMBINED,
        "formula_auto": FORMULA_AUTO,
        "grade": None,
        "grade_label": None,
        "grade_semantics": None,
        "metrics": [
            {
                "metric_key": row.key,
                "dimension": row.dimension,
                "dimension_name": bd.DIMENSION_BY_CODE[row.dimension].name,
                "name": row.name,
                "unit": row.unit,
                "direction": row.direction,
                "direction_label": bd.DIRECTION_LABELS.get(row.direction, row.direction),
                "is_scoring": row.is_scoring,
                "raw_value": _s(row.raw),
                "normalized": None,
                "has_data": row.has_data and row.is_scoring,
                "breakpoints": {},
                "formula": row.blocks.get("formula", ""),
                "blocks": row.blocks,
                "drill": row.drill,
                "drill_count": len(row.drill),
            }
            for row in result.rows
        ],
        "notes": [],
        "threshold": None,
        "blocked": result.blocked,
        "auto_data_note": AUTO_DATA_NOTE,
        "auto_data_ratio": f"{len(bd.SCORING_METRICS)}/{len(bd.METRICS)}",
        "disclaimer": bd.DISCLAIMER,
    }


def division_detail(db: Session, *, division_id: str, period: str, account: Account | None = None) -> dict[str, Any]:
    """明细 + 下钻：实时刷新；阈值缺失时仍返回原始取数与下钻（得分留空并标注 blocked）。"""
    division = _division_or_404(db, division_id)
    parse_period(period)

    finalized = existing_finalized(db, division.id, period)
    if finalized is not None:
        return evaluation_payload(db, finalized)

    evaluation, result, blocked = evaluate_and_persist(db, division=division, period=period, account=account)
    if evaluation is None:
        return _blocked_preview_payload(division, period, result)
    return evaluation_payload(db, evaluation, blocked=blocked)


def finalize_division(
    db: Session,
    *,
    division_id: str,
    period: str,
    account: Account,
    ctx: RequestContext | None,
) -> dict[str, Any]:
    """季度定榜：写入 ``finalized`` 且**不可变**；同时写入分值库 L3 记录。"""
    from app.services import score_library as score_library_service  # 避免顶层循环依赖

    division = _division_or_404(db, division_id)
    parse_period(period)

    if existing_finalized(db, division.id, period) is not None:
        raise ConflictError(
            "已定榜快照不可修改",
            code="snapshot_immutable",
            extra={"hint": "季度榜一经定榜即固化；如需修正请新建下一季度或调整阈值后重新评估"},
        )

    context = require_threshold(db)
    result = evaluate_division(db, division=division, period=period)
    evaluation = persist_evaluation(
        db,
        division=division,
        period=period,
        result=result,
        status=EVAL_FINALIZED,
        account=account,
        threshold_version=context.version,
        commit=False,
    )
    evaluation.status = EVAL_FINALIZED
    evaluation.finalized_at = utcnow()
    evaluation.finalized_by_name = account.name

    score_library_service.record_entry(
        db,
        level="L3",
        object_type="division",
        object_id=division.id,
        object_name=division.name,
        source_type="division_evaluation",
        source_snapshot_id=evaluation.id,
        score=evaluation.combined_score,
        display_score=evaluation.combined_score,
        grade=evaluation.grade,
        period=period,
        division_id=division.id,
        threshold_ref=context.version.version_label,
        issue_count=evaluation.issue_count,
        has_score=evaluation.combined_score is not None,
        sample_sufficient=evaluation.sample_sufficient,
        status_note=EVAL_STATUS_LABELS.get(EVAL_FINALIZED, "已定榜"),
        extra={
            "auto_score": evaluation.auto_score,
            "manual_score": evaluation.manual_score if hasattr(evaluation, "manual_score") else None,
            "auto_weight": evaluation.auto_weight,
            "manual_weight": evaluation.manual_weight,
            "grade_label": bd.GRADE_LABELS.get(evaluation.grade or "", None),
            "blocked": False,
        },
        created_by_name=account.name,
        commit=False,
    )

    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="finalize_bei_quarterly_snapshot",
        target_type="division_evaluation",
        target_id=evaluation.id,
        summary=f"事业部 {division.name} {period} 季度 BEI 定榜",
        detail={
            "period": period,
            "division_id": division.id,
            "combined_score": evaluation.combined_score,
            "auto_score": evaluation.auto_score,
            # 人工印象分不落在 DivisionEvaluation 上（独立表），用 getattr 兜底避免定榜 500
            "manual_score": getattr(evaluation, "manual_score", None),
            "manual_weight": getattr(evaluation, "manual_weight", None),
            "grade": evaluation.grade,
            "threshold_version": context.version.version_label,
            "issue_count": evaluation.issue_count,
            "sample_sufficient": evaluation.sample_sufficient,
        },
        commit=False,
    )
    db.commit()
    db.refresh(evaluation)
    return evaluation_payload(db, evaluation)


def get_evaluation(db: Session, evaluation_id: str) -> DivisionEvaluation:
    evaluation = db.get(DivisionEvaluation, evaluation_id)
    if evaluation is None:
        raise NotFoundError("事业部评价记录不存在")
    return evaluation


def set_manual_score(
    db: Session,
    *,
    evaluation: DivisionEvaluation,
    score: Decimal,
    reason: str,
    basis: str,
    weight: Decimal | None,
    account: Account,
    ctx: RequestContext | None,
) -> dict[str, Any]:
    """人工印象分：只写 ``bei_manual_score``，**不改写** ``bei_metric_value``。"""
    if evaluation.status == EVAL_FINALIZED:
        raise ConflictError(
            "已定榜快照不可修改",
            code="snapshot_immutable",
            extra={"hint": "定榜后不可再录人工印象分"},
        )
    manual_weight = Decimal(str(weight)) if weight is not None else bd.MANUAL_WEIGHT_DEFAULT
    if manual_weight > bd.MANUAL_WEIGHT_MAX:
        raise ValidationError(
            "人工印象分占比不得超过 20%",
            field_errors=[
                {
                    "field": "weight",
                    "message": f"人工占比上限 {bd.MANUAL_WEIGHT_MAX}，当前 {manual_weight}",
                    "type": "value_error",
                }
            ],
        )
    if not (reason or "").strip():
        raise ValidationError(
            "必须填写事由",
            field_errors=[{"field": "reason", "message": "请填写人工印象分的事由", "type": "value_error"}],
        )
    if not (basis or "").strip():
        raise ValidationError(
            "必须填写依据",
            field_errors=[{"field": "basis", "message": "请填写人工印象分的依据", "type": "value_error"}],
        )
    if score < 0 or score > 100:
        raise ValidationError(
            "人工印象分必须在 0–100 之间",
            field_errors=[{"field": "score", "message": "取值范围 0–100", "type": "value_error"}],
        )

    now = utcnow()
    manual = BeiManualScore(
        id=new_id(),
        evaluation_id=evaluation.id,
        score=_s(score) or "0",
        weight=_s(manual_weight) or "0",
        reason=reason.strip(),
        basis=basis.strip(),
        entered_by=account.name,
        entered_at=now,
        created_at=now,
        updated_at=now,
    )
    db.add(manual)

    auto_score = _dec(evaluation.auto_score)
    combined, auto_weight, _mw = _combined(auto_score, manual)
    evaluation.auto_weight = f"{auto_weight:.2f}"
    evaluation.manual_weight = f"{manual_weight:.2f}"
    evaluation.combined_score = _s(_q1(combined))
    evaluation.grade = bd.grade_of(combined)
    evaluation.updated_at = now
    evaluation.updated_by_name = account.name

    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="set_bei_manual_score",
        target_type="division_evaluation",
        target_id=evaluation.id,
        summary=f"录入人工印象分 {_s(score)}（占比 {_s(manual_weight)}）",
        detail={
            "score": _s(score),
            "weight": _s(manual_weight),
            "reason": reason.strip(),
            "basis": basis.strip(),
            "auto_score_unchanged": evaluation.auto_score,
            "combined_score": evaluation.combined_score,
        },
        commit=False,
    )
    db.commit()
    db.refresh(evaluation)
    return evaluation_payload(db, evaluation)


def add_note(
    db: Session,
    *,
    evaluation: DivisionEvaluation,
    content: str,
    account: Account,
    ctx: RequestContext | None,
) -> dict[str, Any]:
    """说明备注：留录入人与时间，**不影响任何指标数值与得分**。"""
    if evaluation.status == EVAL_FINALIZED:
        raise ConflictError(
            "已定榜快照不可修改",
            code="snapshot_immutable",
            extra={"hint": "定榜后不可再添加说明备注"},
        )
    text = (content or "").strip()
    if not text:
        raise ValidationError(
            "备注内容不能为空",
            field_errors=[{"field": "content", "message": "请填写备注内容", "type": "value_error"}],
        )

    now = utcnow()
    trace = _load_trace(evaluation)
    trace.setdefault("notes", []).append(
        {"content": text, "entered_by": account.name, "entered_at": iso_z(now)}
    )
    evaluation.calc_trace_json = json.dumps(trace, ensure_ascii=False)
    evaluation.updated_at = now
    evaluation.updated_by_name = account.name

    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="add_bei_note",
        target_type="division_evaluation",
        target_id=evaluation.id,
        summary="添加 BEI 说明备注（不影响得分）",
        detail={
            "content": text,
            "note_count": len(trace["notes"]),
            "auto_score": evaluation.auto_score,
            "combined_score": evaluation.combined_score,
        },
        commit=False,
    )
    db.commit()
    db.refresh(evaluation)
    return evaluation_payload(db, evaluation)
