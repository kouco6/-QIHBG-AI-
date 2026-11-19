# 调研任务与成果契约 0.2.0

## 任务快照

Codex 建立不可覆盖的任务文件，至少包含：taskId、batchId、projectId、dimensionId、revision、parentRevision（首版为 null）、skillVersion、技能文件 SHA-256、product、market、scenario、purpose、exclusions、inputRefs、可公开研究的问题、前置结果引用、用户修订意见、fieldContractRef、fieldContractSha256、当前前端字段定义/必要快照引用及验收条件。已有项目输入足够时直接建立任务执行，不额外等待启动确认；缺口如实记录，逐维交付人工审核。模型读取的内部材料须已经授权向 ChatGPT 提供；不要把整仓库或真实凭证当作任务材料。

本项目已确认的首版范围：PAGA 公共广播与报警系统；主市场沙特阿拉伯；主场景陆上油气设施；其他中东市场、海上及常规工业为比较范围；用途是产品立项与研发规划。本机内部试用，完整十二维，人工审核与修订后导出离线 HTML。主市场与主场景是用户选定范围，不是经调研证明的最佳商业选择。

仅使用公开资料和已授权材料，不依赖付费数据库，不自行购买或切换付费接口。自有产品型号、持证状态、实测性能、BOM 和成本尚未提供时，写“待内部确认”，不能推断为不具备，也不能填竞品或示例数据冒充本公司信息。

## 研究质量

每条关键事实关联稳定的证据编号。证据记录标题、发布主体、可访问 URL 或已授权文件定位、发布日期/版本（未知明确标注）、查询日期、原文位置、相关型号及适用地域/条件、实际支持的命题。发现线索未核验原文不能当已证实事实；内部确认须有真实材料或确认记录。复用证据时沿用编号，过期或范围不匹配时重新核查。

优先监管机构、标准组织、制造商手册、原始项目文件及招标原文。市场法规、强制认证等须核验原文、当前适用版本和适用边界；技术标准被引用不等于获得认证。不得编造链接、日期、编号、价格、市场份额或本公司能力。明确区分事实、推断、建议、待确认；冲突保留双方来源并解释或登记未解决。不能访问全文时说明可见范围，不宣称已经核验全文。

全文至少包含：范围及输入缺口、结论摘要、逐问题专业分析、证据清单、对比/适用矩阵、对产品立项与研发规划的影响、反证及不确定性、内部待确认与下一步。每维规则列出的专业问题均须回答或注明无法回答的具体原因和已尝试路径。结论不能超出证据确定性。

## 通用研究 JSON（不是平台快照）

输出合法 JSON，字段为：

- schemaVersion：固定 c2c-research-v1。
- taskId、batchId、projectId、dimensionId、revision、parentRevision：原任务值。
- skillVersion、skillSha256：实际读取的规则版本与任务提供的摘要；未由工具核验的摘要不得宣称模型已独立计算。
- status：completed / partial / blocked；completed 表示本维研究问题已充分处理，不等于公司已有所需能力或业务审核通过。
- scope：product、market、scenario、purpose。
- findings：数组，每项 id、question、statement、kind（fact/inference/recommendation/unknown）、evidenceIds 字符串数组、limitations 字符串（无额外限制可为空字符串）。
- evidence：数组，含 id、title、publisher、urlOrFile、publishedAt、accessedAt、locator、applicability、verification（lead/verified-public/confirmed-internal）；其余字段为说明字符串，日期或版本未知时明确写“未知”。
- gaps：数组，每项 question、reason、attemptedPaths 字符串数组、nextAction 字符串。
- conflicts：数组，每项 topic、evidenceIds、resolution（未解决则明确写明）。
- planningImplications：数组，每项 recommendation、rationale、evidenceIds 字符串数组、dependencies 字符串数组、priorityReason 字符串。

无检索能力且无足够资料应 blocked，不输出“全部完成”的空数组。真实待内部确认事项可以存在于完整研究中，但影响核心判断的关键证据缺失必须标 partial。Markdown 与 JSON 同任务同修订，JSON 每个事实引用必须可在档案中找到，证据编号无悬空，差异须修正后再交付。

## 前端字段交付（必需）

读取[前端字段交付契约](frontend-output.md)和本维 `frontend-fields/dimNN.json`，额外交付独立的 `c2c-frontend-v1` JSON。其任务标识与本档案一致，完整覆盖本维前端全部字段及每条记录，逐字段关联本档案证据或解释未知。通用研究JSON不能替代它；它也不改变本档案的证据结构。字段完整、研究充分、平台结构兼容和人工通过分别判断。

## 保存、审核与修订

Codex 收集完整原始回复、Markdown、研究JSON、前端字段JSON、覆盖检查报告和所用技能/输入/字段契约摘要，记录实际执行通道为 chatgpt-web-c2c，验证任务标识与证据引用。网页实际检索能力必须现场确认；不能伪造其他执行器的原生调用证明、签名或成功标志。当前平台的 DIM-03 原生研究接口另有校验，本契约未自动接通它。

人工反馈形成新 revision，指定 parentRevision，保留修改前后的原始成果；仅对受影响结论与证据重研，注明变化理由。失败任务可重试，但重试有新的 attempt 标识，不能重复导入覆盖历史。业务审核与导出状态单独记录，HTML 必须来自审核确认的同一修订。全维汇总消除或显式列出跨维矛盾，不借汇总隐藏未完成维度。
