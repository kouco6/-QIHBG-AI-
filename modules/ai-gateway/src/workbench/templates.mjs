/**
 * Workbench template catalog.
 *
 * Four domains, three templates each. Every template produces a layered prompt:
 * a domain-specific skeleton plus a shared output contract, so the front end can
 * parse "conclusions / risks / next steps / produced files" out of any result
 * without a second model call.
 */

export const DOMAINS = [
  { id: "research", name: "调研", hint: "招标、竞品、行业、技术扫描" },
  { id: "planning", name: "企划", hint: "立项、跑分、路标、商业分析" },
  { id: "design", name: "产品设计", hint: "需求、方案、标书、汇报" },
  { id: "flow", name: "流程任务", hint: "流程编排里的每一个步骤" },
  { id: "adhoc", name: "临时任务", hint: "脚本、审阅、整理、查询" },
];

/**
 * The output contract is appended to every prompt. It is what makes P0-05
 * possible: the result page reads these headings instead of guessing.
 */
export const OUTPUT_CONTRACT = `

## 输出要求（必须遵守）
用中文回答，严格按以下四节输出，标题原样保留：

### 结论
3-7 条，每条一句话，先给判断再给依据。不要复述过程。

### 风险与不确定
没有就写「无」。有就逐条写清不确定点、影响和验证方式。

### 建议下一步
2-4 条可执行动作。

### 产出文件
如果本次生成了文件，每行一条，格式严格为：\`- 绝对路径 | 类型 | 一句话说明\`
没有生成文件就写「无」。`;

const field = (key, label, type, placeholder, required = false) => ({
  key,
  label,
  type,
  placeholder,
  required,
});

const template = ({ id, name, domain, summary, fields, promptTemplate, outputTypes }) => ({
  id,
  name,
  domain,
  summary,
  fields,
  promptTemplate,
  outputTypes,
  version: 1,
  isSystem: true,
});

export const TEMPLATES = [
  // ---------------------------------------------------------------- 调研
  template({
    id: "research-tender",
    name: "型号中标查询",
    domain: "research",
    summary: "按型号查历史中标记录，出六维表格",
    fields: [
      field("model", "型号", "text", "如 DS-65PL0010", true),
      field("scope", "范围", "text", "项目/品牌/地区限定，可留空"),
      field("years", "时间范围", "text", "如 近三年"),
    ],
    promptTemplate: `调研任务：查「{model}」的历史招投标与中标记录。

范围限制：{scope}
时间范围：{years}

按以下六个维度整理每一条记录：
1. 项目名称与采购单位
2. 公告时间与项目地区
3. 中标金额与预算
4. 中标供应商（含是否为代理商）
5. 同包竞品型号与报价
6. 参数门槛与倾向性条款

产出一张 Markdown 表格，表头就是上面六个维度。表格之后单独说明：
- 该型号的主要出没市场（行业、区域）
- 价格带区间与走势
- 是否存在明显的参数控标特征`,
    outputTypes: ["markdown", "excel"],
  }),
  template({
    id: "research-competitor",
    name: "竞品对比",
    domain: "research",
    summary: "参数/价格/中标价三线对比，出差异判断",
    fields: [
      field("ours", "我方产品", "text", "如 itc 数字会议系统", true),
      field("rivals", "竞品", "text", "多个用逗号分隔，如 海康、大华、音王", true),
      field("dimensions", "对比维度", "textarea", "留空则用默认：功能、参数、价格、中标价、服务、生态"),
    ],
    promptTemplate: `竞品对比任务：我方产品「{ours}」，对比对象「{rivals}」。

对比维度：{dimensions}

按维度逐项对比，每项给三个值：我方、竞品、差距（领先/持平/落后 + 一句话说明）。
最后必须回答三个问题：
1. 我方最容易被攻破的一个点是什么，为什么
2. 我方最值得放大的一个点是什么，需要什么佐证材料
3. 如果客户只比价格，我们的应对话术是什么

数据来源不确定的地方要标出来，不要编造具体数字。`,
    outputTypes: ["markdown", "excel"],
  }),
  template({
    id: "research-brief",
    name: "行业动态简报",
    domain: "research",
    summary: "声光电视讯行业动态，按影响度排序",
    fields: [
      field("topic", "主题/领域", "text", "如 数字会议系统、LED 一体机", true),
      field("window", "时间窗口", "text", "如 最近两周"),
      field("competitors", "关注厂商", "text", "留空则默认 海康、大华、音王、洲明、利亚德"),
    ],
    promptTemplate: `行业简报任务：主题「{topic}」，时间窗口「{window}」，关注厂商「{competitors}」。

收集这段时间内值得注意的动态：新品发布、中标大单、价格调整、渠道政策、技术路线变化、政策文件。

每条动态写清：发生了什么、对我们有什么影响、建议谁跟进。
按影响度从高到低排序，最多 8 条，不要凑数。
拿不到确切信息就写「未检索到」，不要推测。`,
    outputTypes: ["markdown"],
  }),

  // ---------------------------------------------------------------- 企划
  template({
    id: "planning-feasibility",
    name: "立项可行性",
    domain: "planning",
    summary: "市场/技术/竞品/风险四维评估",
    fields: [
      field("direction", "产品方向", "textarea", "要做什么，解决什么问题", true),
      field("target", "目标市场", "text", "客户类型、行业、区域"),
      field("threshold", "决策阈值", "text", "如 首年营收 2000 万、毛利 35%"),
    ],
    promptTemplate: `立项可行性分析：产品方向「{direction}」。
目标市场：{target}
决策阈值：{threshold}

按四维展开，每一维都要给出「支持立项 / 不支持 / 有条件支持」的判断和理由：

一、市场维度：需求是否真实存在、规模、增长性、客户采购动机、现有替代方案
二、技术维度：核心技术是否可得、自研与外购的比例、研发周期、卡点
三、竞品维度：已有哪些玩家、他们的定价与打法、我们的切入缝隙
四、风险维度：技术风险、市场风险、供应链风险、合规风险，各自的概率与影响

最后给一句明确结论：立 / 不立 / 有条件立（条件是什么）。
不要用「需要进一步调研」代替结论。`,
    outputTypes: ["markdown", "ppt"],
  }),
  template({
    id: "planning-scorecard",
    name: "竞品跑分表",
    domain: "planning",
    summary: "维护竞品评分矩阵，出总分与短板",
    fields: [
      field("category", "品类", "text", "如 数字会议系统", true),
      field("players", "参与评分的产品", "textarea", "每行一个：品牌 型号", true),
      field("criteria", "评分维度", "textarea", "留空则用默认：功能完整度、性能指标、易用性、稳定性、价格竞争力、服务响应、生态兼容"),
    ],
    promptTemplate: `竞品跑分任务：品类「{category}」。

参与评分：
{players}

评分维度：{criteria}

规则：
- 每个维度 1-10 分，必须给分，不给区间
- 每一分都要有依据（参数、实测、公开资料、中标参数），没依据的标注「缺依据」
- 输出一张矩阵表：行是产品，列是维度，最后一列是加权总分
- 权重默认等权，如果某维度明显更重要请说明并给出调整后的总分

表格之后给出：
1. 我方排名与主要失分项
2. 每个失分项对应的改进动作和大致投入`,
    outputTypes: ["markdown", "excel"],
  }),
  template({
    id: "planning-roadmap",
    name: "产品路标规划",
    domain: "planning",
    summary: "按季度拆版本，出依赖与取舍",
    fields: [
      field("product", "产品线", "text", "如 智能工牌", true),
      field("horizon", "规划周期", "text", "如 未来 12 个月"),
      field("constraints", "约束", "textarea", "人力、预算、客户承诺、认证要求"),
    ],
    promptTemplate: `路标规划任务：产品线「{product}」，周期「{horizon}」。
约束条件：{constraints}

按季度拆成版本，每季度最多三个主线目标。每个版本写清：
- 目标（一句话，可验收）
- 关键功能（不超过 5 条）
- 依赖（外部 SDK、认证、供应链、其他团队）
- 交付物形式
- 放弃或延后的东西，以及为什么

最后给出一张依赖关系表，标出哪些依赖一旦延期会连带拖垮后续版本。`,
    outputTypes: ["markdown", "ppt"],
  }),

  // ---------------------------------------------------------------- 产品设计
  template({
    id: "design-spec",
    name: "需求文档",
    domain: "design",
    summary: "出结构化 PRD，含边界与验收",
    fields: [
      field("feature", "功能/产品", "text", "要设计什么", true),
      field("users", "目标用户", "text", "谁用，什么场景"),
      field("boundary", "边界与不做", "textarea", "明确不做什么，避免范围蔓延"),
    ],
    promptTemplate: `需求文档任务：为「{feature}」写 PRD。
目标用户与场景：{users}
边界：{boundary}

结构固定为：
1. 背景与问题（现在怎么解决的，痛点在哪）
2. 目标与非目标
3. 用户与场景（角色、触发条件、主流程）
4. 功能需求（按优先级分批，每条给验收标准）
5. 交互与状态（含空态、加载、异常、无权限）
6. 数据与埋点
7. 依赖与风险
8. 不做的部分及理由

验收标准必须可判定，不要写「体验流畅」这类无法验收的描述。`,
    outputTypes: ["markdown", "word"],
  }),
  template({
    id: "design-proposal",
    name: "方案 / 标书撰写",
    domain: "design",
    summary: "按招标要求出应答骨架与要点",
    fields: [
      field("project", "项目名称", "text", "招标项目全称", true),
      field("requirements", "招标要求", "textarea", "评分办法、技术参数、资质要求、否决项"),
      field("advantages", "我方优势", "textarea", "可用的案例、资质、参数优势"),
    ],
    promptTemplate: `方案撰写任务：项目「{project}」。

招标要求：
{requirements}

我方可用优势：
{advantages}

产出一份应答骨架：
1. 逐条对应评分办法，列出每个评分点的应答位置和得分策略
2. 技术参数响应表：招标要求 / 我方响应 / 偏离说明，偏离项必须标出
3. 方案主体章节结构与每章要写什么
4. 否决项自查清单（逐项确认是否满足）
5. 需要补充的证明材料清单，标明由谁提供

凡是无法确认的资质或参数，标记为「待确认」，不要假设满足。`,
    outputTypes: ["markdown", "word"],
  }),
  template({
    id: "design-ppt",
    name: "汇报 PPT 逻辑",
    domain: "design",
    summary: "先出论证框架，再谈视觉",
    fields: [
      field("subject", "汇报主题", "text", "讲什么", true),
      field("audience", "听众", "text", "决策层/技术/客户，决定论证方式"),
      field("goal", "期望结果", "text", "听完之后希望对方做什么决定", true),
    ],
    promptTemplate: `汇报 PPT 逻辑梳理任务：主题「{subject}」。
听众：{audience}
期望结果：{goal}

第一步只做逻辑，不谈配色和排版。输出：
1. 一句话主张（整场汇报要对方记住的那句话）
2. 论证链：从现状到结论的推理步骤，每一步的支撑证据
3. 页面清单：每页的标题（必须是结论句，不是名词短语）、核心图表、要传达的一个信息
4. 预判三个可能的质疑，以及回应方式
5. 建议删除的内容（哪些常见内容对这个听众是噪音）

页面数量控制在 12-18 页。`,
    outputTypes: ["markdown"],
  }),

  // ---------------------------------------------------------------- 临时任务
  template({
    id: "adhoc-script",
    name: "代码 / 脚本",
    domain: "adhoc",
    summary: "写或改脚本，跑通并说明用法",
    fields: [
      field("goal", "要做什么", "textarea", "功能描述或要修的 bug", true),
      field("stack", "技术栈/环境", "text", "如 Node 22、PowerShell、Python 3.12"),
      field("acceptance", "怎么算完成", "text", "可运行的验证方式"),
    ],
    promptTemplate: `代码任务：{goal}

环境：{stack}
完成标准：{acceptance}

要求：
- 先说明你会改哪些文件、为什么，再动手
- 改完必须实际运行验证，不要只说「应该可以」
- 依赖尽量少，能零依赖就零依赖
- 最后说明怎么用、怎么回滚`,
    outputTypes: ["markdown"],
  }),
  template({
    id: "adhoc-review",
    name: "文档审阅",
    domain: "adhoc",
    summary: "挑错、挑空话、挑逻辑断点",
    fields: [
      field("target", "审阅对象", "text", "文件路径或粘贴内容", true),
      field("standard", "审阅标准", "text", "如 对内评审、对外投标、给老板看"),
    ],
    promptTemplate: `文档审阅任务：审阅「{target}」，用途是「{standard}」。

按三类问题分别列：
1. 事实与数据问题：数字对不对、来源有没有、时间是否过期
2. 逻辑问题：论证缺口、前后矛盾、结论没有支撑
3. 表达问题：空话套话、术语不一致、读者看不懂的地方

每条给出：位置（章节或原句）、问题、改法。
不要重写整篇，只给可执行的修改点。按严重程度排序。`,
    outputTypes: ["markdown"],
  }),
  template({
    id: "adhoc-data",
    name: "数据整理",
    domain: "adhoc",
    summary: "清洗、透视、出结论",
    fields: [
      field("source", "数据来源", "text", "文件路径或说明", true),
      field("question", "要回答的问题", "textarea", "整理完想看到什么结论", true),
      field("format", "期望形式", "text", "表格 / 图表 / 文字结论"),
    ],
    promptTemplate: `数据整理任务：来源「{source}」。
要回答：{question}
期望形式：{format}

要求：
- 先说清数据有多少行、有哪些字段、缺多少值
- 清洗规则要写明（去重、单位统一、异常值怎么处理），不要静默改数
- 结论必须能从数据里算出来，给出计算方式
- 样本太少或口径不一致时，直接说明不可用，不要硬下结论`,
    outputTypes: ["markdown", "excel"],
  }),
];

export const findTemplate = (id) => TEMPLATES.find((item) => item.id === id) ?? null;

export const domainName = (id) => DOMAINS.find((item) => item.id === id)?.name ?? id;

/** Fill {placeholders} and append the shared output contract. */
export const buildPrompt = (templateDef, values = {}) => {
  const body = templateDef.promptTemplate.replace(/\{(\w+)\}/g, (_, key) => {
    const value = values[key];
    return typeof value === "string" && value.trim() ? value.trim() : "（未提供）";
  });
  return `${body}${OUTPUT_CONTRACT}`;
};
