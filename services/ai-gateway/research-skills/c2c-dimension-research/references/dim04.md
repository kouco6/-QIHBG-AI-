# DIM-04｜技术先进｜研究规则 0.2.0

这是新增的初始规则，尚未经真实业务验收。先读取 contract.md 并以任务快照限定地域、场景和用途；所有结论关联证据，缺失信息显式登记。

## 专业问题

1. 比较有资料支持的系统架构、音频传输、分区控制、冗余、故障监测与接口方案。
2. 说明技术方案对可用性、故障隔离、时延、维护及扩展性的影响与取舍。
3. 把厂商宣传与经文档支持或实测验证的能力分开。
4. 结合主场景明确推荐架构、可替代方案、技术依赖和需要原型验证的问题。
5. 不能仅凭使用新技术就认定先进，也不能把竞品参数写成我司已具备能力。

## 维度成果

架构方案比较及原型验证清单。

同时返回契约规定的完整 Markdown、通用研究 JSON 和独立前端字段 JSON；保持真实未知，不发布或覆盖既有版本。


## 当前前端字段交付（必需）

覆盖format=v1.1及rows八列name/source/maturity/leading/barrier/value/company/industry、aiInitial/companyTouched；完整交付analysis的类别/来源/摘要/边界和每点title/summary/performance/benchmark/difference/reason/value/supplement/evidence；evidence的publisher/title/url/where/excerpt/support/note也逐项覆盖。

完整路径、类型、枚举与限制见[本维字段清单](frontend-fields/dim04.json)；按[统一字段交付契约](frontend-output.md)返回独立 `c2c-frontend-v1`，并通过逐字段检查。
