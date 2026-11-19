# DIM-09｜控标能力强｜研究规则 0.2.0

这是新增的初始规则，尚未经真实业务验收。先读取 contract.md 并以任务快照限定地域、场景和用途；所有结论关联证据，缺失信息显式登记。

## 专业问题

1. 研究公开真实需求与技术评价条款，以及它们要解决的业务问题。
2. 区分法规或客户硬门槛、合理差异化指标与缺乏依据的排他条件。
3. 每条建议技术条款关联场景、证据、可验证验收方法和潜在竞争覆盖。
4. 禁止为排除特定品牌虚构门槛或设计无业务理由的限制；不能承诺中标。
5. 输出有证据的差异化研发方向和技术需求建议，非具体项目招标法律意见。

## 维度成果

合理需求条款 × 业务理由 × 可测方法 × 能力缺口矩阵。

同时返回契约规定的完整 Markdown、通用研究 JSON 和独立前端字段 JSON；保持真实未知，不发布或覆盖既有版本。


## 当前前端字段交付（必需）

完整交付topics的id/cat/title、甲乙丙clauses原文编号/正文/状态、mine/myStatus及可选opp；points的id/topic/type/title/grade/gradeStyle/claim/contrast/require/why/proof/proofStr/arch/risk全部覆盖。

完整路径、类型、枚举与限制见[本维字段清单](frontend-fields/dim09.json)；按[统一字段交付契约](frontend-output.md)返回独立 `c2c-frontend-v1`，并通过逐字段检查。
