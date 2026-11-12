"""13 个固定工作节点与 4 个阶段（REQUIREMENTS §5.1 / PRD §5.1 / DESIGN §6.1.1）。

节点的 **名称、顺序、适用范围、工期、输出** 必须与合同一致，逐字冻结；
顺序不可调整，任何"合并 / 省略"都是验收失败项。

同时给出：
- ``NODE_TRANSITIONS`` 使用的上游依赖（``upstream_deps``）；
- 节点是否允许标记"不适用"（``allow_not_applicable``）；
- 是否仅迭代产品适用（``iteration_only``）——新产品主线在实例化时自动标为不适用；
- 每个节点的必需产物类型（``artifact_kinds``），用于「进行中 → 已完成」的完成判定。
"""

from __future__ import annotations

from typing import NamedTuple


class StageSpec(NamedTuple):
    """阶段（泳道）。"""

    code: str
    name: str
    order: int


class NodeSpec(NamedTuple):
    """单个工作节点的冻结定义。"""

    code: str
    order: int
    stage_code: str
    name: str
    scope: str
    owner: str
    collaborators: str
    duration_days: int
    outputs: str
    artifact_kinds: tuple[str, ...]
    upstream_deps: tuple[str, ...]
    allow_not_applicable: bool
    iteration_only: bool


STAGES: tuple[StageSpec, ...] = (
    StageSpec("S1", "一、产品企划", 1),
    StageSpec("S2", "二、需求分析", 2),
    StageSpec("S3", "三、产品设计", 3),
    StageSpec("S4", "四、产品发布", 4),
)

STAGE_BY_CODE: dict[str, StageSpec] = {s.code: s for s in STAGES}

# 适用范围常量
SCOPE_NEW = "新产品/新领域"
SCOPE_NEW_AND_ITER = "新产品/新领域/迭代产品"
SCOPE_ITER_ONLY = "仅迭代产品"

NODE_SPECS: tuple[NodeSpec, ...] = (
    NodeSpec("N01", 1, "S1", "场景调研", SCOPE_NEW, "体验人员", "项目经理、企划人员", 3, "场景调研报告",
             ("scene_research",), (), True, False),
    NodeSpec("N02", 2, "S1", "体验方案设计", SCOPE_NEW, "体验人员", "项目经理、企划人员", 3, "体验方案",
             ("experience_plan", "user_journey"), ("N01",), True, False),
    NodeSpec("N03", 3, "S2", "业务场景分析", SCOPE_NEW_AND_ITER, "体验人员", "体验人员", 3, "业务场景分析",
             ("business_scenario_analysis",), ("N02",), False, False),
    NodeSpec("N04", 4, "S2", "内部业务场景评审", SCOPE_NEW_AND_ITER, "体验人员", "项目经理、体验人员、产品人员", 2, "业务场景评审表",
             ("internal_scenario_review",), ("N03",), False, False),
    NodeSpec("N05", 5, "S2", "外部业务场景评审", SCOPE_NEW_AND_ITER, "体验人员", "市场服务部、设计部、品管部", 2, "业务场景评审表",
             ("external_scenario_review",), ("N04",), True, False),
    NodeSpec("N06", 6, "S2", "交互点设计", SCOPE_NEW_AND_ITER, "体验人员", "产品人员、体验人员", 3, "交互设计点报告",
             ("interaction_point_report",), ("N04", "N05"), False, False),
    NodeSpec("N07", 7, "S3", "原型体验", SCOPE_NEW_AND_ITER, "体验人员", "产品人员、体验人员", 3, "原型体验报告",
             ("prototype_report",), ("N06",), False, False),
    NodeSpec("N08", 8, "S3", "脚本设计", SCOPE_NEW_AND_ITER, "体验人员", "体验人员", 3, "脚本设计",
             ("script_design",), ("N06",), False, False),
    NodeSpec("N09", 9, "S3", "UI体验", SCOPE_NEW_AND_ITER, "体验人员", "体验人员、UI人员", 2, "UI体验报告",
             ("ui_report",), ("N06",), False, False),
    NodeSpec("N10", 10, "S4", "体验优化迭代验收", SCOPE_ITER_ONLY, "体验人员", "体验人员", 2, "体验验收准入报告",
             ("acceptance_admission_report",), ("N07", "N09"), True, True),
    NodeSpec("N11", 11, "S4", "体验走查", SCOPE_NEW_AND_ITER, "体验人员", "体验人员", 7, "产品自查表、发布体验报告",
             ("self_check_table", "release_experience_report"), ("N07", "N09", "N10"), False, False),
    NodeSpec("N12", 12, "S4", "可用性测试/小组走查", SCOPE_NEW_AND_ITER, "体验人员", "体验人员、可用性测试用户", 7, "可用性测试报告/小组走查报告",
             ("usability_report",), ("N08",), True, False),
    NodeSpec("N13", 13, "S4", "发布体验评审", SCOPE_NEW_AND_ITER, "体验人员", "项目经理、产品人员、开发人员、市场部、品管部、设计部、事业部", 2, "体验问题回复终版、UEI分数测评表",
             ("issue_final_reply", "uei_score_sheet"), ("N11", "N12"), False, False),
)

NODE_CODES: tuple[str, ...] = tuple(n.code for n in NODE_SPECS)
NODE_BY_CODE: dict[str, NodeSpec] = {n.code: n for n in NODE_SPECS}
NODE_COUNT = len(NODE_SPECS)

# 需要「需求评审通过」才能开始（N06 特别校验，DESIGN §6.6 / PRD 节点业务规则）
REVIEW_GATED_NODES: tuple[str, ...] = ("N06",)

# --- 项目类型 ---
PROJECT_TYPE_NEW = "new_product"          # 新产品
PROJECT_TYPE_ITERATION = "iteration"      # 迭代产品
PROJECT_TYPES: tuple[str, ...] = (PROJECT_TYPE_NEW, PROJECT_TYPE_ITERATION)
PROJECT_TYPE_LABELS: dict[str, str] = {
    PROJECT_TYPE_NEW: "新产品",
    PROJECT_TYPE_ITERATION: "迭代产品",
}


def stage_nodes(stage_code: str) -> tuple[NodeSpec, ...]:
    return tuple(n for n in NODE_SPECS if n.stage_code == stage_code)


def node_applicable(code: str, project_type: str) -> bool:
    """节点是否适用于该项目类型（仅做类型级判断，不含用户手动标记）。

    以 :data:`NodeSpec.scope` 为唯一依据：

    - ``SCOPE_NEW``（N01/N02）：仅新产品主线，迭代产品自动不适用；
    - ``SCOPE_ITER_ONLY``（N10）：仅迭代产品主线；
    - ``SCOPE_NEW_AND_ITER``：两条主线均适用。
    """
    spec = NODE_BY_CODE[code]
    if spec.scope == SCOPE_ITER_ONLY:
        return project_type == PROJECT_TYPE_ITERATION
    if spec.scope == SCOPE_NEW:
        return project_type == PROJECT_TYPE_NEW
    return True


def resolved_upstream(code: str, project_type: str) -> tuple[str, ...]:
    """该节点在当前项目类型下的真实上游依赖（剔除按类型不适用的节点）。"""
    return tuple(
        dep for dep in NODE_BY_CODE[code].upstream_deps if node_applicable(dep, project_type)
    )


def assert_specs_frozen() -> None:
    """自检：13 个节点、顺序连续、阶段齐全、依赖只引用前序节点。"""
    assert len(NODE_SPECS) == 13, f"节点数必须为 13，实际 {len(NODE_SPECS)}"
    assert [n.order for n in NODE_SPECS] == list(range(1, 14)), "节点顺序必须为 1–13 连续"
    assert len(STAGES) == 4
    for spec in NODE_SPECS:
        assert spec.stage_code in STAGE_BY_CODE, f"{spec.code} 阶段非法"
        for dep in spec.upstream_deps:
            assert dep in NODE_BY_CODE, f"{spec.code} 上游 {dep} 不存在"
            assert NODE_BY_CODE[dep].order < spec.order, f"{spec.code} 上游 {dep} 必须在前序"
        assert spec.artifact_kinds, f"{spec.code} 必须定义至少一个产物类型"


assert_specs_frozen()
