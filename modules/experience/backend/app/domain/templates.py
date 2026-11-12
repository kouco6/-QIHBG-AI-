"""结构化产物模板定义（T05 / PRD §7.3）。

模板是**数据**：运行期以 ``artifact_template`` 形式经迁移播种，可版本化；
本模块为单一数据源，同时供「首次必填 ≤ 8 项」的机器自检使用。

字段类型：``text`` / ``textarea`` / ``number`` / ``date`` / ``select`` /
``multiselect`` / ``table``（含列定义）/ ``checklist``（勾选式）。
"""

from __future__ import annotations

from typing import NamedTuple

# --- 字段类型 ---
F_TEXT = "text"
F_TEXTAREA = "textarea"
F_NUMBER = "number"
F_DATE = "date"
F_SELECT = "select"
F_MULTISELECT = "multiselect"
F_TABLE = "table"
F_CHECKLIST = "checklist"

# --- 表单分组 ---
G_BASIC = "基础信息"
G_CONTENT = "内容"
G_RELATION = "协作与来源"
G_AUDIT = "审计信息"

# 所有模板共有的分组（由服务端补齐，不占用户必填配额）
COMMON_GROUPS: tuple[str, ...] = (G_RELATION, G_AUDIT)


class Field(NamedTuple):
    key: str
    label: str
    type: str = F_TEXT
    required: bool = False
    group: str = G_CONTENT
    help: str = ""
    options: tuple[str, ...] = ()
    columns: tuple[str, ...] = ()   # 仅 table / checklist 使用
    max_length: int = 2000


class TemplateSpec(NamedTuple):
    kind: str
    name: str
    node_code: str
    allow_not_applicable: bool
    description: str
    fields: tuple[Field, ...]


TEMPLATES: tuple[TemplateSpec, ...] = (
    # ① 场景调研报告
    TemplateSpec("scene_research", "场景调研报告", "N01", True,
                 "沉淀行业事实、真实场景与用户角色，为后续体验方案提供依据。",
                 (
                     Field("keywords_scene", "调研关键词·应用场景", F_TEXTAREA, True, G_BASIC, "每行一个",
                           max_length=1000),
                     Field("keywords_role", "调研关键词·用户角色", F_TEXTAREA, True, G_BASIC, "每行一个",
                           max_length=1000),
                     Field("keywords_competitor", "调研关键词·竞争对手", F_TEXTAREA, False, G_BASIC, "每行一个",
                           max_length=1000),
                     Field("table_a", "表 A·地点与场景特征", F_TABLE, True, G_CONTENT,
                           "记录地点、场景特征（场景大小、室内外、其他设备、联动方式）",
                           columns=("地点", "场景", "场景大小", "室内/室外", "其他设备", "联动方式")),
                     Field("table_b", "表 B·功能场景", F_TABLE, True, G_CONTENT,
                           "记录功能场景、解释与信息来源",
                           columns=("功能场景", "解释", "信息来源")),
                     Field("table_c", "表 C·角色与关注点", F_TABLE, True, G_CONTENT,
                           "记录角色、关注点与需求/可能行为",
                           columns=("角色", "关注点", "需求/可能行为")),
                     Field("table_d", "表 D·性能与参数", F_TABLE, False, G_CONTENT,
                           "记录性能、参数及解释、联动设备",
                           columns=("性能", "参数及解释", "联动设备")),
                     Field("conclusion", "调研结论", F_TEXTAREA, True, G_CONTENT,
                           "至少覆盖一个应用场景与一个用户角色的结论", max_length=4000),
                 )),

    # ② 用户体验地图
    TemplateSpec("user_journey", "用户体验地图", "N02", False,
                 "按「阶段 × 行」矩阵呈现目标、行为触点、异常、功能需求与体验点。",
                 (
                     Field("stage_names", "阶段名称", F_MULTISELECT, True, G_BASIC,
                           "默认为会前/会中/会后，可自定义",
                           options=("一、会前", "二、会中", "三、会后")),
                     Field("rows", "用户地图矩阵", F_TABLE, True, G_CONTENT,
                           "每行一个条目：行类型 × 阶段 × 内容",
                           columns=("行（目标/行为触点/异常情况/功能需求/体验点）", "阶段", "内容")),
                     Field("key_abnormal", "关键异常情况", F_TEXTAREA, True, G_CONTENT,
                           "例如：预约时间地点人员与实际不符；网络不佳；签到人数统计不准", max_length=2000),
                 )),

    # 体验方案
    TemplateSpec("experience_plan", "体验方案", "N02", True,
                 "确定体验要素与体验方法，一条要素至少对应一种方法。",
                 (
                     Field("elements", "体验要素与方法", F_TABLE, True, G_CONTENT,
                           "一条要素至少对应一种方法",
                           columns=("体验要素", "对应体验方法", "目标角色", "备注")),
                     Field("source_version", "关联 N01 调研版本", F_TEXT, True, G_RELATION,
                           "填写场景调研报告的版本号，上游变更时需重新确认", max_length=64),
                     Field("goal", "体验目标", F_TEXTAREA, True, G_CONTENT, max_length=3000),
                 )),

    # 客户地图
    TemplateSpec("customer_map", "客户地图", "N02", True,
                 "梳理客户决策链与角色诉求。",
                 (
                     Field("roles", "客户角色与决策链", F_TABLE, True, G_CONTENT,
                           columns=("角色", "决策影响", "核心诉求")),
                     Field("note", "补充说明", F_TEXTAREA, False, G_CONTENT),
                 )),

    # ③ 业务场景分析
    TemplateSpec("business_scenario_analysis", "业务场景分析", "N03", False,
                 "树表方式录入角色 / 场景 / 场景行为 / 业务等级 / 指标。",
                 (
                     Field("product_nature", "产品性质", F_SELECT, True, G_BASIC,
                           options=("新产品", "迭代产品")),
                     Field("core_business_involved", "是否涉及核心业务", F_SELECT, True, G_BASIC,
                           "迭代产品必填；选择「否」时必须填写理由", options=("是", "否")),
                     Field("core_business_reason", "核心业务判定理由", F_TEXTAREA, True, G_CONTENT,
                           max_length=2000),
                     Field("scenario_rows", "角色 / 场景 / 行为", F_TABLE, True, G_CONTENT,
                           "每条行为必须给定业务等级",
                           columns=("角色", "场景", "场景行为", "业务等级（核心/非核心）", "备注/指标")),
                     Field("metric_outline", "指标大纲", F_TABLE, False, G_CONTENT,
                           columns=("一级指标", "二级指标", "指标说明")),
                 )),

    # 内部评审表
    TemplateSpec("internal_scenario_review", "内部业务场景评审表", "N04", False,
                 "固定评审目的文案 + 正文表 + 补充说明 + 部门签名表。",
                 (
                     Field("review_purpose", "评审目的（固定文案，不可编辑）", F_TEXTAREA, True, G_BASIC,
                           "确认列举的角色、场景、场景行为，核心场景及非核心场景的定义是否符合预期，"
                           "体验指标是否核心，并对场景进行相应调整及补充；"
                           "划分核心及非核心场景、核心及非核心指标涉及后续问题的分类及 UEI 分值的计算。",
                           max_length=1000),
                     Field("header", "评审头部信息", F_TABLE, True, G_BASIC,
                           columns=("产品名称", "版本", "项目负责人", "产品设计", "评审时间", "评审结果")),
                     Field("body", "评审正文表", F_TABLE, True, G_CONTENT,
                           "评审前的分类与评审后最终分类分别保存",
                           columns=("角色", "场景", "场景行为", "业务等级定义", "备注")),
                     Field("supplement", "补充说明", F_TEXTAREA, False, G_CONTENT, max_length=3000),
                     Field("signatures", "评审签名表", F_TABLE, True, G_CONTENT,
                           "部门 × 负责人 × 成员；意见由体验人员代录，须记录实际提供人",
                           columns=("部门", "负责人", "成员", "实际提供人", "意见", "是否通过")),
                 )),

    # 外部评审表
    TemplateSpec("external_scenario_review", "外部业务场景评审表", "N05", True,
                 "市场服务部 / 设计部 / 品管部外部视角的评审与补充。",
                 (
                     Field("review_purpose", "评审目的（固定文案，不可编辑）", F_TEXTAREA, True, G_BASIC,
                           "确认列举的角色、场景、场景行为，核心场景及非核心场景的定义是否符合预期，"
                           "体验指标是否核心，并对场景进行相应调整及补充；"
                           "划分核心及非核心场景、核心及非核心指标涉及后续问题的分类及 UEI 分值的计算。",
                           max_length=1000),
                     Field("body", "外部评审正文表", F_TABLE, True, G_CONTENT,
                           "冲突意见进入争议清单",
                           columns=("场景", "角色", "部门意见", "实际提供人", "是否通过")),
                     Field("conflicts", "争议清单", F_TEXTAREA, False, G_CONTENT, max_length=2000),
                     Field("signatures", "评审签名表", F_TABLE, True, G_CONTENT,
                           columns=("部门", "负责人", "成员", "实际提供人", "意见", "是否通过")),
                 )),

    # ④ 交互设计点报告
    TemplateSpec("interaction_point_report", "交互设计点报告", "N06", False,
                 "按核心场景逐步定义关键交互点，序号连续。",
                 (
                     Field("rows", "交互点清单", F_TABLE, True, G_CONTENT,
                           "序号连续；每个核心场景至少一个交互点",
                           columns=("序号", "所属场景", "涉及角色", "行为/步骤", "交互点")),
                     Field("coverage_note", "覆盖范围说明", F_TEXTAREA, True, G_CONTENT,
                           "说明本次覆盖的核心场景范围", max_length=2000),
                 )),

    # ⑤ 脚本设计
    TemplateSpec("script_design", "脚本设计", "N08", False,
                 "按业务场景为核心功能路径设计可执行测试脚本。",
                 (
                     Field("flow", "主流程", F_SELECT, True, G_BASIC,
                           options=("一、会前", "二、会中", "三、会后", "自定义")),
                     Field("rows", "任务清单", F_TABLE, True, G_CONTENT,
                           "每个任务须有功能模块、任务内容与完成标准",
                           columns=("序号", "流程", "功能模块", "任务内容", "预期完成结果")),
                     Field("coverage_note", "覆盖范围说明", F_TEXTAREA, False, G_CONTENT),
                 )),

    # ⑧-1 原型体验报告
    TemplateSpec("prototype_report", "原型体验报告", "N07", False,
                 "功能模块与业务逻辑走查，问题统一登记并引用。",
                 (
                     Field("prototype_version", "原型版本", F_TEXT, True, G_BASIC, max_length=64),
                     Field("prototype_link", "原型链接/附件", F_TEXT, False, G_BASIC, max_length=500),
                     Field("scope", "走查范围", F_TEXTAREA, True, G_CONTENT,
                           "声明本次覆盖的模块与场景", max_length=2000),
                     Field("issue_refs", "关联问题", F_TABLE, False, G_RELATION,
                           "统一问题 ID 引用，不重复登记",
                           columns=("问题编号", "问题描述", "问题等级", "问题类型", "所属模块", "责任人")),
                 )),

    # ⑧-2 UI 体验报告
    TemplateSpec("ui_report", "UI体验报告", "N09", False,
                 "视觉交互、操作流程与防呆规范走查。",
                 (
                     Field("ui_version", "UI 版本", F_TEXT, True, G_BASIC, max_length=64),
                     Field("ui_link", "UI 链接/附件", F_TEXT, False, G_BASIC, max_length=500),
                     Field("scope", "走查范围", F_TEXTAREA, True, G_CONTENT, max_length=2000),
                     Field("issue_refs", "关联问题", F_TABLE, False, G_RELATION,
                           columns=("问题编号", "问题描述", "问题等级", "问题类型", "所属模块", "责任人")),
                 )),

    # 体验验收准入报告
    TemplateSpec("acceptance_admission_report", "体验验收准入报告", "N10", True,
                 "迭代产品发布准入验收（新产品自动不适用）。",
                 (
                     Field("target_version", "待验版本", F_TEXT, True, G_BASIC, max_length=64),
                     Field("environment", "环境检查结果", F_SELECT, True, G_CONTENT,
                           options=("符合预期", "部分不符合", "不可用")),
                     Field("rows", "待验收项", F_TABLE, True, G_CONTENT,
                           "逐项给出通过/驳回与证据",
                           columns=("问题编号", "问题描述", "验收结论", "证据说明")),
                     Field("conclusion", "准入结论", F_TEXTAREA, True, G_CONTENT, max_length=2000),
                 )),

    # ⑥ 产品自查表
    TemplateSpec("self_check_table", "产品自查表", "N11", False,
                 "勾选式自查：体验维度 / 子维度 / 注释 / 体验方法参考 / 是否体验 / 体验结果。",
                 (
                     Field("items", "自查项", F_CHECKLIST, True, G_CONTENT,
                           "适用检查项必须全部有「已体验 / 不适用」结论",
                           columns=("体验维度", "子维度", "注释", "体验方法参考", "是否体验", "体验结果")),
                     Field("coverage", "覆盖情况说明", F_TEXTAREA, True, G_CONTENT,
                           "已检查 / 适用总数与未检查定位", max_length=2000),
                 )),

    # 发布体验报告
    TemplateSpec("release_experience_report", "发布体验报告", "N11", False,
                 "结合业务等级与产品性质的综合走查结论与初步 UEI。",
                 (
                     Field("candidate_version", "发布候选版本", F_TEXT, True, G_BASIC, max_length=64),
                     Field("summary", "走查结论", F_TEXTAREA, True, G_CONTENT, max_length=4000),
                     Field("preliminary_uei", "初步 UEI", F_NUMBER, False, G_CONTENT,
                           "由评分预览生成，可留空后补"),
                     Field("issue_refs", "关联问题", F_TABLE, False, G_RELATION,
                           columns=("问题编号", "问题描述", "业务等级", "问题等级", "验收状态")),
                 )),

    # ⑨ 可用性测试报告
    TemplateSpec("usability_report", "可用性测试报告/小组走查报告", "N12", True,
                 "汇总 SUS、满意度、任务完成度与模块 Top N。",
                 (
                     Field("study_id", "关联可用性研究", F_TEXT, True, G_BASIC,
                           "由 N12 研究详情生成，填写研究编号", max_length=64),
                     Field("summary", "测试结果总结", F_TEXTAREA, True, G_CONTENT,
                           "SUS 分值与行业均值对比、问题统计（按模块 Top N）、任务完成度、任务时间、满意度",
                           max_length=4000),
                     Field("improvement", "改进方案", F_TEXTAREA, True, G_CONTENT, max_length=4000),
                     Field("details", "明细表", F_TABLE, False, G_CONTENT,
                           columns=("功能页面", "问题描述", "问题等级", "问题类型", "解决方案与价值提升")),
                 )),

    # ⑪ 体验问题回复终版
    TemplateSpec("issue_final_reply", "体验问题回复终版", "N13", False,
                 "问题 + 事业部回复（代录）+ 解决方案 + 承诺修改版本（代录）+ 最终分类 + 最终 UEI。",
                 (
                     Field("version", "产品版本", F_TEXT, True, G_BASIC, max_length=64),
                     Field("rows", "问题回复明细", F_TABLE, True, G_CONTENT,
                           "事业部回复与承诺版本为代录内容，须记录实际提供人",
                           columns=("问题编号", "问题描述", "事业部回复", "解决方案", "承诺修改版本",
                                    "实际提供人", "最终分类")),
                     Field("final_uei", "最终 UEI", F_NUMBER, False, G_CONTENT,
                           "来自最新 L1 快照"),
                 )),

    # ⑩ UEI 分数测评表
    TemplateSpec("uei_score_sheet", "UEI分数测评表", "N13", False,
                 "由 L1 快照生成的测评表（基础信息 / 扣分值 / 问题类型分布）。",
                 (
                     Field("snapshot_id", "关联 L1 快照", F_TEXT, True, G_BASIC, max_length=64),
                     Field("deduction_breakdown", "扣分值明细", F_TABLE, True, G_CONTENT,
                           columns=("维度", "权重", "致命", "严重", "一般", "轻微", "扣分值")),
                     Field("type_distribution", "产品问题类型分布", F_TABLE, False, G_CONTENT,
                           columns=("一级指标", "二级指标", "问题数量")),
                 )),

    # ⑫ 其他产物
    TemplateSpec("industry_analysis", "行业及产品分析报告", "N01", True, "行业与产品专业分析。",
                 (
                     Field("industry", "行业情况", F_TEXTAREA, True, G_CONTENT, max_length=4000),
                     Field("product", "产品专业知识", F_TEXTAREA, True, G_CONTENT, max_length=4000),
                     Field("source", "信息来源", F_TEXTAREA, True, G_CONTENT, max_length=2000),
                 )),
    TemplateSpec("competitor_report", "竞品体验报告", "N01", True, "竞品横向并列对比。",
                 (
                     Field("rows", "竞品对比", F_TABLE, True, G_CONTENT,
                           columns=("竞品", "对比维度", "表现", "体验较好做法", "差距")),
                     Field("conclusion", "结论", F_TEXTAREA, True, G_CONTENT, max_length=2000),
                 )),
    TemplateSpec("persona_draft", "初版用户画像", "N01", True, "角色、关注点、需求/可能行为。",
                 (
                     Field("rows", "画像条目", F_TABLE, True, G_CONTENT,
                           columns=("角色", "关注点", "需求/可能行为")),
                 )),
    TemplateSpec("scene_metric", "场景体验指标", "N03", True, "用户旅程完善后的体验指标。",
                 (
                     Field("rows", "指标条目", F_TABLE, True, G_CONTENT,
                           columns=("场景", "用户旅程阶段", "一级指标", "二级指标", "指标说明")),
                 )),
)

TEMPLATE_BY_KIND: dict[str, TemplateSpec] = {t.kind: t for t in TEMPLATES}
TEMPLATE_KINDS: tuple[str, ...] = tuple(t.kind for t in TEMPLATES)

# 固定评审目的文案（不可编辑，PRD §7.3-③）
FIXED_REVIEW_PURPOSE = (
    "确认列举的角色、场景、场景行为，核心场景及非核心场景的定义是否符合预期，体验指标是否核心，"
    "并对场景进行相应调整及补充；划分核心及非核心场景、核心及非核心指标涉及后续问题的分类及 "
    "UEI 分值的计算。"
)

# 评审签名表固定部门结构（PRD §7.3-③ / F3）
REVIEW_SIGN_DEPARTMENTS: tuple[str, ...] = (
    "研发部门", "产品企划部", "产品设计部", "设计部", "市场服务部", "品管部",
)

FIRST_SUBMIT_REQUIRED_MAX = 8


def required_fields(kind: str) -> tuple[Field, ...]:
    return tuple(f for f in TEMPLATE_BY_KIND[kind].fields if f.required)


def templates_for_node(node_code: str) -> tuple[TemplateSpec, ...]:
    return tuple(t for t in TEMPLATES if t.node_code == node_code)


def assert_templates_frozen() -> None:
    """自检：模板键唯一；首次必填 ≤ 8；节点引用的产物类型均已定义。"""
    from app.domain import nodes as nodes_mod

    assert len(TEMPLATE_KINDS) == len(set(TEMPLATE_KINDS)), "模板类型键重复"
    for spec in TEMPLATES:
        required = required_fields(spec.kind)
        assert len(required) <= FIRST_SUBMIT_REQUIRED_MAX, (
            f"{spec.kind} 首次必填 {len(required)} 项，超过 {FIRST_SUBMIT_REQUIRED_MAX} 项上限"
        )
        keys = [f.key for f in spec.fields]
        assert len(keys) == len(set(keys)), f"{spec.kind} 字段键重复"
        assert spec.node_code in nodes_mod.NODE_BY_CODE, f"{spec.kind} 节点 {spec.node_code} 不存在"
    for node in nodes_mod.NODE_SPECS:
        for kind in node.artifact_kinds:
            assert kind in TEMPLATE_BY_KIND, f"节点 {node.code} 引用了未定义模板 {kind}"


assert_templates_frozen()
