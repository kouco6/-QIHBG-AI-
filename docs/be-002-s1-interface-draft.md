# BE-002｜S1 AI 网关承接企划12大维度：接口盘点与最小草案

本文件在报告契约之后交付。状态：**源码盘点 PASS；S1 接口为提案；真实执行 POC BLOCKED / 未执行**。依据 GD 全局唯一基线 V1.0 第三、四、六、七节。没有运行网关入口、创建任务、请求模型、发送 WorkBuddy 消息或改造研究流程。

## 现有接口与边界（代码事实，不代表 S1 已具备）

| 能力 | 现有源码/接口 | 可复用点与缺口 |
|---|---|---|
| 任务创建与查询 | `src/server.mjs:438` 起 POST /v1/tasks、GET /v1/tasks、GET /v1/tasks/:id；`src/workbench/api.mjs:896` 起 /api/tasks | /v1 为较低层执行入口；/api 包含草稿、模板、skills 和执行器选择。接收任务不代表研究完成 |
| 任务状态与事件 | /v1/tasks/:id/events.json、/v1/tasks/:id/events；/api/tasks/:id/events；`task-manager.mjs:6`—`:35` | 已有 draft/queued/running/waiting_approval/completed/failed/interrupted/cancelled/archived、序号和 SSE 补读；没有按 DIM/cycle 编排两轮 Skill、N 份研究与一轮 N 份补研的专用合同 |
| 控制与审批 | /api/tasks/:id/dispatch、cancel、rerun、archive、read；POST /v1/tasks/:id/approvals/:approvalId | 执行器审批与业务权限不同；不得把“允许工具执行”当作“用户已应用 P”。取消/进度是否由对应执行器真正支持仍需分执行器 POC |
| 幂等 | x-idempotency-key → TaskManager.idempotency | 当前按键命中可返回已有任务；S1 还需主体/模块/项目/维度/周期/阶段/请求摘要绑定和冲突规则，不能让不同员工共用任意字符串键 |
| 结果 | `task-manager.mjs:574` 起 parseResult→summary/conclusions/risks/nextActions/structured/finalResponse | structured 表示解析过执行器答案，不表示通过 12 维 schema 或业务应用校验。completed 不等于研究双文件完整交付，也不等于 P |
| 产物 | GET /api/tasks/:id/artifacts；GET /api/artifacts/:taskId/content/:artifactId（由路由 segment 实际顺序确认）；`workbench/api.mjs:1009` 起 | 当前注册 path/type/exists 等，能预览/读取文件；还缺 S1 MD+JSON 配对、schema、hash、业务归属与不可变交付清单 |
| 产物安全 | `workbench/artifacts.mjs:108` 起接受模型声明的绝对/相对路径；内容接口按记录的 artifact.path 读文件 | allowedRoots 对 cwd 的检查不等于已完成产物 realpath/符号链接/逐对象权限检查。需审查并 POC；本轮未构造读取任意真实文件的攻击 |
| 网关鉴权 | `server.mjs:290` bearer 服务令牌，`:379` collab 独立 Token 路由先处理，`:385` 保护 /api 与 /v1 | 服务令牌不是员工身份；collab 成员 Token 不是自动可用于全部研究任务的 ACL |
| 平台代理 | `scripts/platform_http.py:151` 起，按账号/module grant 选择模块进程并由服务端附加 Token；runtime 中 AI 数据按账号目录分离 | 当前开通/实例隔离有帮助，但不证明 S1 多员工 task/artifact 对象级授权完成。TaskManager 公共字段/创建路径没有建立所需的业务 owner/context 校验 |

注意：内容接口路径是代码按 segment 解析的 `/api/artifacts/<taskId>/content/<artifactId>`；不能误写成任务 artifacts 列表下的 content 子路径。此表是只读代码定位，不是对外发布的稳定 API 承诺。

## 原12维研究流程 → 目标网关职责

| 原实现 | 当前事实/证据 | S1 最小承接关系 |
|---|---|---|
| 开研究周期 | `modules/bg/index.html:270`，cycles 按 projectId/DIM/cycleId 存储 | 企划12大维度保留业务周期与范围；网关任务关联该周期，不能统一业务项目库 |
| WorkBuddy 第一轮规划 | `round1_service.py:52` 限 DIM-01；两个示例 Skill 在 workbuddy_sample_skills | 网关管理专业 Skill＋公共 Skill①执行；12+2 Skill 注册、版本、授权路径先盘点，不把两个样例当成 12 维完整部署 |
| 投递/收件 | `round1_service.py:221` send；`round1_poc.py:212` 起外部 Open API 调用 | 原外部 token/接口仅是旧适配假设；新网关受控承接执行器。发送消息或拿到 messageId 只是交接证据，不能标研究完成 |
| 打开 GPT / 初研 MD 上传 | `index.html:165`—`:225`、`:678`，files 含归属/hash/confirmed | 目标由网关登记 N 个初研任务/人工交接及 MD 档案；浏览器打开不证明自动研究或完成，不能退回企划模块独立队列 |
| 第二轮整合与质检 | `index.html:667` enqueueRun；当前 enqueueRun/tick 及文案明确未接入真实整合 | 网关按同维度聚合 N 份 MD，公共 Skill②做检查与整合；必须有实际执行证据，不能用模板拼接冒充质检 |
| 补研 | 旧 UI supplementUsed/“唯一任务包”；`:668` 明确不可执行 | 基线覆盖旧“一份任务包”表述：**最多一轮补研，轮内可 N 份任务包**；需业务确认计数归属、重试不消耗新轮数，不能沿用一个包＝一轮的限制 |
| 最终结果/导入 | 旧 resultMD、integrations、bodies 以 MD 为主 | 网关交付同维度 MD 档案＋JSON 正文（可 ZIP）与清单；用户授权校验后导入 W，不直接发布 P。报告继续按 BE-002 报告契约读取 P |

`OFFICIAL_READY` 在旧 Round1Service 中指“可用的第一轮研究任务包”，不是该维度正式业务成果 P；`STRUCTURE_VALID` 也不等于完成专业内容核验。不得因为名称含 official 就计入项目完成数。

## 最小接口草案（待批准，不是现有接口）

建议在可信平台/网关适配层增加以下合同，由后端映射到现有网关能力；具体路径及持久化归属待评审：

| 提议接口 | 责任/关键约束 |
|---|---|
| POST /platform/research/tasks | 验证平台 session、发起模块与业务上下文；建立业务研究任务与网关 task 的关联，幂等返回；不接受浏览器传入服务令牌或任意执行目录 |
| GET /platform/research/tasks/:researchTaskId | 对当前主体逐对象授权后返回真实阶段、执行器任务关联、错误和可支持的进度，不伪造百分比 |
| GET /platform/research/tasks/:researchTaskId/deliverables | 返回授权的 MD/JSON/可选 ZIP 引用、schemaVersion、hash 与来源清单；不返回服务器绝对文件路径 |
| POST /platform/research/tasks/:researchTaskId/cancel | 先确认执行器支持；不支持时返回不可取消/仅停止后续调度，不能假报已停止远端任务 |
| POST /bg/api/research/imports | 企划12大维度在用户确认后校验同用户/项目/维度/周期、结构、来源和重复导入；CAS 写入 W；导入失败不改 W/P；本轮仅提案 |

建议请求合同（身份由会话解析，不信任客户端 ownerId）：

```json
{
  "sourceModule": "planning12",
  "projectId": "synthetic-project",
  "dimensionId": "DIM-03",
  "researchCycleId": "synthetic-cycle",
  "requestType": "plan | research | integrate | supplement | deliver",
  "professionalSkill": {"id": "dimension-skill", "version": "approved-version"},
  "commonSkillVersion": "approved-version",
  "structureVersion": "dimension-specific",
  "authorizedInputRefs": [],
  "parentResearchTaskId": null,
  "supplementRound": 0,
  "idempotencyKey": "opaque-client-request-id",
  "expectedBusinessRevision": 1
}
```

请求含用户确认过的研究范围/业务输入或不可变输入引用及其摘要。适配层派发前检验权限、档案目录、执行模式与模型选择，不让前端绕过检查设置 workspace-write 或任意 cwd。
响应区分 researchTaskId（业务研究聚合）与 gatewayTaskIds（N 个实际执行任务），包含 correlationId、真实 stage/status、executorAuthorizationState、createdAt/updatedAt、errorCode/retryable、resultRefs/schemaVersion。失败重试保留尝试记录，终态按真实执行结果；完成传输、结构合格、内容质检、用户导入和应用是不同状态。

交付 manifest 至少含业务三元组/主体作用域、Skill/schema 版本、阶段与任务关联、MD/JSON 的 artifactRef、SHA-256、字节数/媒体类型及校验结果；MD/JSON 同维配对，源引用一致性限可验证范围，不把“语义完全一致”当作仅凭 hash 就已证明。

安全策略：任务/事件/产物/重试/取消/导入均做对象级授权；拒绝跨账号、错维度、错周期及越界文件引用；realpath 防目录穿越/符号链接逃逸；撤销权限后停止事件和下载访问；服务令牌、个人模型授权与平台 session 分离；原始路径、个人 Key 不到浏览器或日志。当前接口没有自动满足这些条件。

## 真实执行 POC 前置条件与关闭证据

当前 **BLOCKED：本轮未获真实模型/外部发送任务授权，也未检查或处理现用凭证**。不能从 DEV-001 的 CLI --version/health=200 推导已经可以真实执行。

真实 POC 前先确认：

1. S1 请求/状态/产物/导入合同、分工与验收任务获批准；两种不同结构维度选 DIM-03 和 DIM-04，范围、输入、专业 Skill 与公共①②版本固定。
2. 明确执行器、模型/接口、费用与调用上限、只读或最小写目录权限及用户授权。所需供应商接口、外部 GPT 自动交接可达性和 WorkBuddy 官方授权 scope 按实际服务另行核实，不使用旧代码假设替代供应商证明。
3. 使用全新合成项目、研究目录、业务库与专用授权；A/B 两个测试主体验证 task、事件、原文件和导入隔离。真实秘密另行批准后配置，不从现用账号复制。
4. 先验证单个真实任务及失败/超时/不确定发送、幂等和可支持取消，再验证同维 N 份研究＋公共②整合＋最多一轮 N 份补研。没有输出/质量证据时不标完成。
5. 取得真实 task/runId、时间/阶段、脱敏日志、实际 MD/JSON 内容和摘要、专业/公共 Skill 校验；无权访问/错误 schema/错维度/重复/中断重试均附反向证据。
6. 用户确认导入 W → 保存 D → 校验并应用 P → 正式预览/完成数/报告章节/HTML 同值，且 W/D、旧 MD、失败场景不污染 P。BE-002 当前报告链缺陷未修复前，不能宣布整条端到端 POC PASS。

未完成项按 BLOCKED 或真实失败记录；手工登记产物可作为已批准的交接降级，但不能冒充自动执行或脱离网关任务体系。体验工作台 Provider 属 S2，跨模块项目/数据共享不在本草案中。
