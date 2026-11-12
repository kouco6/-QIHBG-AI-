---
name: bg-research-plan-validator
display_name: 企划BG-研究规划核验
display_name_en: BG Research Plan Validator
description: WorkBuddy第一轮公共核验Skill，检查维度研究任务包的目标、范围、深度、证据、批次与成果结构，并要求修正不合格草稿。
description_zh: 仅负责规划问题质量核验，不负责GPT实际研究、WorkBuddy第二轮成果整合或人工审批。
description_en: Validate first-round GPT research plan, scope, depth, evidence and chapter mapping.
version: 0.1.0
author: 企划设计BG-内部POC
---
# 企划BG公共Skill｜研究规划核验（样例0.1.0）

本Skill须与“当前正式维度专业Skill”同时使用，不得与第二轮公共“研究成果处理Skill”混用。

## 必须执行的核验

| 类别 | PASS要求 | 不符合时 |
|---|---|---|
| 维度定位 | 任务都属于当前dimensionId，越界部分有明确理由 | REVISE，删掉其它维度任务 |
| 研究目标 | 能支撑企划决策，不是仅搜集名词清单 | REVISE，补决策输出 |
| 任务深度 | 每个任务能指导GPT具体搜索、验证、比较和分析 | REVISE，补可执行问题 |
| 证据要求 | 规定来源分级、URL/文档标识、查询日期、事实限制 | REVISE，补验证办法 |
| 结构映射 | 每个Task都映射至少1个GPT成果章节 | REVISE，修订对应 |
| 前置依赖 | 可以并行/有依赖的批次明确，不矛盾不循环 | REVISE，拆分依赖 |
| 适用与边界 | 对单品/系统做适用裁剪，不造额外必选项目 | REVISE，说明排除条件 |
| 真实性 | 不提前填入想象数据、品牌/项目结果 | REVISE，删除不实内容 |

检查遇到无法根据输入判断的边界应标 `UNRESOLVED`，并在任务包里声明待GPT核实的具体资料类型，不得把无法判断写作PASS。

## 执行顺序

1. 读取第一轮专业Skill产生的规划草案。
2. 逐项输出内部核验结果：PASS、REVISE、UNRESOLVED；REVISE时修正草稿并再查。
3. 校验成功后写出**唯一候选研究任务包Markdown文件**，路径和前置元数据必须与工作台指令完全一致。
4. 在真实WorkBuddy执行记录中保留两个Skill实际运行的证据，便于工作台/操作员确认；本样例不能证明平台具备获取该回执的能力。

## 最终MD必须包含

开头 frontmatter：project_id、dimension_id、research_cycle_id、run_id、document_type=research_task_package。主标题及七个必需章节：研究目标、研究边界、GPT研究任务、GPT成果章节结构、任务与章节映射、前置依赖、证据与检索要求。

**禁令：** 不生成虚构的GPT研究结果，不擅自发起下游GPT执行、不做第二轮成果合并，不因已写出MD就声称平台已自动接通双Skill。
