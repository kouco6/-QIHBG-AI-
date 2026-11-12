"""领域常量与规则（业务数据，不作为界面硬编码的替代）。

本包集中承载合同要求的「落在代码里的口径」：
- ``nodes``：13 个固定工作节点与 4 个阶段（REQUIREMENTS §5.1 / PRD §5.1）；
- ``states``：节点 / 产物 / 问题 / 评审 / Provider 作业五个状态机（DESIGN §6.6）；
- ``scoring``：20 套评分方案 × 8 个矩阵单元 = 160 单元（PRD §8.3）；
- ``bei``：BEI 五维权重、15 个二级指标经验阈值与四档边界（PRD §8.8）。

注意：**阈值、矩阵、字典都是"数据"**——它们在运行期以数据库实体形式存在并
可版本化 / 停用；本包只是"种子数据源 + 服务端规则断言"，业务计算一律读取数据库。
"""

from app.domain import bei, nodes, scoring, states, templates  # noqa: F401

__all__ = ["bei", "nodes", "scoring", "states", "templates"]
