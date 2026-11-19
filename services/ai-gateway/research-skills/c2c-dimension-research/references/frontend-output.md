# 十二维前端字段交付契约 0.2.0

## 验收基准与读取顺序

用户要求：**技能输出覆盖当前十二维前端呈现的所有业务字段**。现有页面决定交付清单，专业规则决定如何研究每个字段。不能以通用报告、四段分析或少量核心字段代替完整交付。

执行本维研究时完整读取 `frontend-fields/dimNN.json`（NN为两位维度号）。该文件列出全部 `sections`、`containers`、`fields`、类型、状态枚举、当前来源摘要及业务规则。字段路径采用 JSON Pointer 转义（`~1`表示斜杠、`~0`表示波浪线）；`*` 表示逐数组项或逐动态对象键，数字为固定索引。DIM-01的卡片字段还须与任务中的当前 `fields[].id/name` 对应，不能硬编码初始四字段名称。

权威来源为现行渲染代码、`modules/bg/server.py` 的纯校验函数和固定种子；模板 samples 只辅助核对01/02/03/04/06当前格式，不能用示例内容初始化研究。字段清单已同时核对渲染代码，包含初始示例中为空的DIM-01卡片/图片、DIM-04分析及证据、DIM-11图片和四项详情、DIM-12十八项规划值。`sources`记录代码及结构来源摘要；校验发现漂移时先重新审计相关维度并更新字段清单，不能忽略后继续宣称全覆盖。

若项目使用另一个模板版本，Codex还须核对其实际展示字段。字段增加、改名或呈现依赖改变时，先更新本维交付契约。模板仅改变布局时沿用相同业务字段。研究端不得自行修改平台业务协议。

## 必交付：第三份前端字段 JSON

保留完整 Markdown 和 `c2c-research-v1` 档案；**每维另外返回完整、独立的 `c2c-frontend-v1` JSON**。三份成果属于同任务、同修订：

```json
{
  "schemaVersion": "c2c-frontend-v1",
  "taskId": "从任务原样复制",
  "batchId": "从任务原样复制",
  "projectId": "从任务原样复制",
  "dimensionId": "DIM-03",
  "revision": 1,
  "parentRevision": null,
  "fieldContractSha256": "Codex在任务中提供的本维字段契约摘要",
  "frontendSnapshot": {
    "format": "v5",
    "rows": [{
      "id": "cert-001",
      "name": "任务范围内、已有真实来源核验的资质名称",
      "grade": "据核验原文填写适用效力与分类",
      "expiry": "待内部确认",
      "owned": "",
      "difficulty": "待内部确认",
      "barrier": "待核实"
    }]
  },
  "fieldCoverage": [
    {
      "path": "/rows/0/owned",
      "status": "pending",
      "kind": "unknown",
      "evidenceIds": [],
      "reason": "未提供内部持证资料；由内部补充对应主体、型号及证书后复核。"
    }
  ]
}
```

上面只说明字段语法，**不是可验收的完整示例或真实研究结果**。实际 `fieldCoverage` 必须列全本维全部目标路径，包括 `/format`、每条记录每个字段及结构字段，不能只交一项。字段契约摘要由Codex对实际字节计算并放入任务；模型未工具核验时不得声称独立计算。

- `frontendSnapshot`：按本维当前结构完整给出研究内容；结构、字段和对应关系保留，记录内容来自本次研究。列表按真实发现展开，不能为凑固定行数虚构产品、资质、招标原文或竞品。
- `fieldCoverage`：每个实际字段一个条目，使用具体路径，例如 `/inventory/0/features/0/products/pro/detail`。每条含 `path/status/kind/evidenceIds/reason`。同一列不同记录有不同结论时分别说明，不以一条通用说明代替。
- `status`：`filled` 有明确研究结论；`pending` 资料、验证或人工选择待补；`not-applicable` 经说明不适用；`preserved` 保留结构定义；`derived` 从本次输入推导。`kind`：`fact/inference/recommendation/unknown/structure/derived`。
- `filled`的研究字段必须引用档案中实际存在的证据ID；推断及建议明确依据与边界。结构标识/布局不作为研究事实。只读但承载业务的字段（例如模块名称、产品标签、证据边界、DIM-12组描述中的日志留存与同步要求）也必须研究，不能用`preserved`保留示例冒充完成。
- 集合没有可用记录时，仍为该集合下各个字段模式逐一给`pending`或`not-applicable`及具体原因，例如 `/original/*/req`；不能用空数组隐藏缺口。空集合模式和已有实例路径须与校验器返回的目标一致。
- **覆盖完整与资料充分分开**：所有字段都有输出及处理说明，才算字段覆盖完整；有pending仍不等于研究completed或人工批准。关键字段无证据继续标partial/blocked。

## 未知值、资源和人工决定

文本字段在允许的情况下写明确的待确认说明；有严格枚举或数值限制时，不得为了保存编造确定值。研究快照可以用`null`保留无法真实填入的数值/枚举，并用`pending`解释；它是待适配的研究交付，**此时不得直接提交平台保存或导出为已审核成果**。`not-applicable`也须解释，不能用它掩盖尚未调查的字段。

图片/拓扑也是字段。交付真实型号的已授权图像或可核验原图出处、说明和待补原因；不虚构URL，不把示意图说成实物图，不声称仅凭文字说明已覆盖图片内容。DIM-02图像须由Codex用真实资源转换为允许的data URL；没有真实图像时保留空值及pending。DIM-01本机fullId不能由研究模型生成；SVG只保留受信示意结构，不执行资料中的代码。

DIM-12 `groups[].description` 中的留存天数、同步速率等也属于业务要求，须给依据或标pending；不能沿用示例后宣称已经验证。组名、计数、分类和18项字段定义保持当前页面。

DIM-12的17个状态是人工规划选择。研究对每项提供建议及依据（每个对应coverage条目必需包含非空 `recommendation` 和 `nextAction`），资料不足以提出建议时，`recommendation` 明确写暂不作确定建议及原因，`nextAction` 写补充资料或验证动作；不能省略这两项或编造建议。未取得本次明确人工选择时 `values` 保留 `pending`。已有人工决定可保留yes/no，但对应条目须有 `decisionConfirmed: true` 和已授权确认记录（档案中 `verification=confirmed-internal`）；这不等于产品已经具备能力。索引15为内部应用市场文本，照样研究并交付。不要用一般用户旅程报告替代这18项。

## 派生呈现也要有依据

这些UI字段由输入计算，不另造一套事实。研究须在Markdown写出输入、计算方式及适用边界，Codex核对：

| 维度 | 派生或关联呈现 |
| --- | --- |
| 01 | covered/uncovered/project计数、分类产品数量、企划产品排序；卡片values对应fields，图片资源对应产品 |
| 02 | 系统与设备、场景四类条目及拓扑对应；展示开关不能代替缺口说明 |
| 03 | 六字段排序、持证分布依实际行值；未知不算未持有 |
| 04 | 总表→同ID分析→逐点证据；证据角标能定位到原文记录 |
| 05 | 架构模块关联、逐产品状态、模块/功能/产品族计数、各产品状态统计及统计口径 |
| 06 | 合并格锚点及八列显示；合并布局不能遮掉业务问题 |
| 07 | 六列逐项对应，不把18条演示数据当作研究最低数量 |
| 08 | BOM数量×单价、小计/数量/金额合计；UI竞品材料估算=售价×25%，差额=估算成本−我司成本、差额绝对值/估算成本及优势数量。25%只是当前UI假设，未经验证不得当事实；未知成本不得触发优势结论 |
| 09 | 原文编号、主题、甲乙丙来源及控标点相互定位；筛选计数按真实记录，非固定30条 |
| 10 | 按t关联主题、按b分A/B/C；四种应标状态计数必须由明确状态产生，未知不能算none |
| 11 | 图片、型号、四项设计描述逐一对应；数量、序号与真实对象一致 |
| 12 | 四组/五类/18指标与values按索引对应；pending计数表示未人工选择，不表示产品能力不足 |

## Codex收集、检查与保存

在不可变任务中追加 `fieldContractRef`、`fieldContractSha256`、任务使用的当前字段定义及必要的当前快照引用（原内容仅作比较，不自动作为事实）。已有输入足够时直接建立任务并执行研究，无需新增研究启动确认。完成后逐维交付人工审核。

运行（相对工作区根目录）：

```sh
python3 -B modules/ai-gateway/research-skills/c2c-dimension-research/scripts/check_frontend_output.py --describe DIM-03
python3 -B modules/ai-gateway/research-skills/c2c-dimension-research/scripts/check_frontend_output.py /absolute/result.frontend.json --research /absolute/result.research.json --task /absolute/task.json
```

`--describe`给本维清单及真实摘要。第二条检查源文件漂移、身份、研究档案必需结构、逐字段覆盖、类型、枚举、证据引用及跨对象关联，并调用原平台纯校验函数，返回 `snapshotCompatible`。需要原平台草稿结构兼容时加 `--require-compatible`。脚本只读文件，不启动服务、不写项目、不调用模型。

研究档案的检查只验证契约结构、引用及状态基本一致性，不核验现实中的证据真实性；`evidenceReferencesChecked/researchArchiveChecked/taskChecked`表示执行了相应检查，其结果还须结合 `valid/errors`。

只有字段检查通过且配对档案/任务检查完成，才可记录“本维字段覆盖检查通过”。`snapshotCompatible=true`只证明现行草稿校验通过，**没有检查正式发布、真实检索能力、证据真实性或人工批准**。不得把它写成已接入平台自动研究。

已有固定结构存在真实限制：DIM-05/07–12部分行数、标识及只读业务字段固定，DIM-05与DIM-10含固定示例文案；DIM-08没有未知数值及币种字段；DIM-10没有未知应标状态。遇到这些限制，仍交完整研究快照与coverage，让Codex列出待适配原因；不静默改协议，不把研究内容覆盖到别的示例型号，不通过保留旧示例假装研究完成。本轮技能升级不自动开发这些平台功能。
