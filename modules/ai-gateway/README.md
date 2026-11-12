# WorkBuddy × Codex Gateway

一个可直接运行的本地联通网关：WorkBuddy 用 HTTP/MCP 异步派发任务，网关通过常驻 Codex app-server 执行，并提供任务队列、可恢复事件、审批、取消和连续对话。

可靠性设计、观测字段和压测方法见 `docs/reliability.md`（原内部参考未随附）。

## 能力

- 单例 `codex app-server` + 稳定的 stdio JSONL 传输，避免每任务冷启动 CLI
- `POST /v1/tasks` 异步派发任务，立即返回任务 ID
- `GET /v1/tasks/:id/events` 通过 SSE 输出 Codex 实时事件
- SSE 支持 `Last-Event-ID` / `?after=` 断点续传，并以原子“订阅+快照”消除漏事件窗口
- 每个任务记录排队、首输出、执行、静默、重连和退出原因；`GET /v1/metrics` 提供汇总
- 使用 `threadId` 继续上一轮 Codex 对话
- 使用 `X-Idempotency-Key` 防止 WorkBuddy 重复派发
- 命令/文件变更审批进入 `waiting_approval`，可经 HTTP 或 MCP 明确处理
- 任务快照与事件流分开持久化，重启后仍可按序号续读
- app-server 只在回合启动前失败时回退 `codex exec`；启动后绝不自动重放
- 支持只读和工作区写入两种权限，不开放 `danger-full-access`
- 工作目录白名单，可阻止任务跳出指定代码目录
- Bearer Token 鉴权，默认只监听 `127.0.0.1`
- 自带中文 Web 控制台，无前端构建步骤、无第三方运行时依赖

## 任务协作（成员智能体推送）

任务抽屉里的「任务协作」面板接收成员本机智能体推进来的内容，不需要人工上传。每个成员一个独立 Token，推送端自动声明是哪个 AI 推的，工作台只做接收与展示。

| 项 | 说明 |
|---|---|
| 推送端 | 仓库根目录 `push-agent.mjs`（零依赖单文件，拷到成员电脑）：`init <工作台地址>` → `token <成员Token>` → `use <任务ID>` → `push 文件/文本/管道`；`clip` 把剪贴板内容推成产物（网页版 AI 的兜底动作） |
| 身份 | 成员 Token 绑定成员，服务端只存 sha256 哈希（明文仅创建时返回一次），可随时「换 Token」吊销旧的 |
| AI 来源 | 推送端用 `--agent` 声明（默认 `workbuddy`），面板显示为徽标；不靠人工下拉 |
| 两档内容 | `artifact` 产物进主时间线，`note` 过程动态进折叠区；两者都参与后续汇总 |
| 实时 | `GET /api/collab/stream`（SSE）：新推送不刷新页面即时出现 |
| 归属修正 | 推错任务可在卡片上「移动」到别的任务，或「删除」 |
| 鉴权边界 | 成员 Token 只能推送、读任务列表、读附件；成员管理/流转/删除只认网关主 Token |

成员端最简流程：

```bash
node push-agent.mjs init http://<工作台IP>:4317
node push-agent.mjs token cb_xxxxxxxx        # 管理员在「成员与 Token」里生成
node push-agent.mjs use <任务ID>             # tasks 子命令可列出
node push-agent.mjs push 报告.md             # 产物
node push-agent.mjs push --kind note --agent kimi "补充结论…"   # 动态
node push-agent.mjs clip                     # 网页版 AI：复制后一键推
```

## 界面结构

六个导航位，一屏一件事：

| 导航 | 内容 |
|---|---|
| **数据看板** | 任务趋势、状态分布、运行效率、成本观测、队列积压、员工 / 流程表现、产出统计 |
| **任务** | 两个页签：**临时任务**（快速派活 + 最近任务）、**流程编排**（启动台、流程卡片、执行记录与详情） |
| **产出库** | 按文件取件，定位到来源任务 |
| **知识库** | 产品中枢：首页（搜索/待处理/空间/统计）+ 调研/企划/产品/灵感四空间 + 审核中心 + 导入中心 + 运行记录 |
| **工作方法** | 本机与云端工作方法管理 |
| **设置** | **AI 员工**（置顶、默认展开）→ 服务与开关 / 运行环境 / 快捷入口（默认折叠） |

设计取舍：工作记录模块已移除——历史任务在「任务 → 临时任务 → 最近」与产出库里按需查看；员工管理属于设置的一部分，不再单独占导航位。流程编辑页仍是整页视图，导航高亮归到「任务」。

顶部常驻条是一排**完整员工卡**：张数不设上限，按窗口宽度自动适配——能放几张放几张（卡宽固定 172px，由前端实测容器宽度计算），放不下的折成末尾的「+N 更多」虚线卡。每张卡显示头像、名字、模型名（本机 CLI 员工写「本机 CLI」）和状态点；点空闲员工直接带着它开派活面板，点在忙员工进它的任务详情，未配置的去设置。点「+N 更多」从右侧展开完整名单（含任务摘要），面板底部是「派发任务」和「管理员工」。顶部不再有指令输入框和派发按钮——派活从员工卡或面板进入，`N` 键仍可快捷开面板。

## 知识库（产品中枢）

按《产品中枢知识库工作台功能需求规格书》V1.0 的 P0 范围落地：本地优先，`E:\Obsidian\产品中枢` 是正式知识唯一事实源，`state/knowledge.db` 只是可重建缓存 + 工作流状态。

### 已实现（P0 + P1 一期）

| 能力 | 说明 |
|---|---|
| 一级导航与独立页面 | 导航顺序：数据看板 → 任务 → 产出库 → 知识库 → 工作方法 → 设置；页面标题「产品中枢」 |
| 四空间 + 双索引搜索 | 调研/企划/产品/灵感；**摘要层 + 正文层两份 FTS5 trigram 索引**（中文 ≥3 字子串、英文型号子串均可命中，1~2 字走 LIKE 回退），摘要命中权重高于正文并标注「摘要命中 / 正文命中」，可切换「摘要+正文 / 只搜摘要 / 只搜正文」；命中带来源片段；类型/状态/密级三维筛选 |
| 空间迁移 | 放错空间的主题一键迁移（详情页「迁移」或编辑页改空间/类型）：先回灌 Obsidian 最新内容 → 改 space/type → Vault 页面搬到新目录并删除旧文件 → 改写 frontmatter，避免下一轮扫描按旧目录拽回去；在 Obsidian 里手工把页面剪切到另一知识层目录，扫描时也按目录纠正空间 |
| 灵感随手记 | 灵感页不设「新建主题」表单，只有一个常驻捕获框：写一句话、**Ctrl+V 贴截图**、拖文件进去，「丢进灵感池」（或 Ctrl+Enter）一步收下。标题自动取首行（去尾标点、超 20 字截断），没文字就用附件名 / 时间；灵感直接发布进 Vault（不占草稿→审核流程，frontmatter 里 evidence_level C / confidence 40 已表明可信度）。截图与文件落 `40-灵感模型/_附件/`，正文写成 `![[文件名]]`，详情页就地渲染成图；列表按「待整理 / 全部 / 已流出」分组，卡片可直接「补一句」（进编辑）或「整理为…」（展开流转面板）。贴了图但没点收下的孤儿附件 24 小时后自动清理 |
| 灵感流转（有向） | 灵感详情页「流转为…」可选调研 / 企划 / 产品，在那里长出一个派生主题：**原件保留**（不搬家、不删文件、状态不变），派生主题是草稿并带上灵感原文与「待验证」清单；`relations` 记一条有向边，图谱画成橙色箭头；两边 Vault 页面的 `source_refs` 互相链接（「来源灵感」/「已流转为企划 · 企划项目」）。同一灵感重复流转幂等，标题被占用时要求改名。灵感空间现在也能从导入中心直接导入 |
| 摘要自动摘取 | 不再取正文前 160 字：按章节结构优先摘「产品概述 / 系统概述 / 项目概述 / 方案概述」（调研走「核心结论 / 执行摘要」，产品走「产品定位 / 功能概述」），没有概述章节时取首个实质段落，模板/目录/封面一律跳过；摘要记录来源（如「自动摘取 · 产品概述 · 第 2 页」），发布前空摘要自动补齐，「运行记录 → 重算摘要」可批量补历史数据 |
| 本地解析（零依赖） | PPTX（按页 + 备注）、DOCX（标题层级）、XLSX（工作表/单元格）、PDF（文本层尽力提取）、XMind（节点树）、**Markdown（剥 frontmatter / BOM，按 # 切章节）**、**HTML/HTM（按 h1~h6 切章节，跳过 nav/header/footer/script/style，按 charset 解码兼容 GBK）**、纯文本、网页链接（手动提交） |
| 本地 OCR（Tesseract 适配器） | 自动探测本机 tesseract（PATH / Program Files / `TESSERACT_CMD`）；可用时图片与纯图版 PPT 逐页识别成文字片段（rels→media 取页面主图，单页失败不阻断），未安装时明确提示并保持「待 OCR」，绝不假装识别过 |
| 导入与去重 | 文件多选 / **整页拖放（支持整个文件夹递归展开，按扩展名预筛并列出跳过原因）** / 粘贴文本 / 网页链接；导入队列逐文件显示等待/解析中/完成/跳过/失败，可中途停止、导入完一键「把这批候选主题提交审核」；内容哈希查完全重复、2-gram Jaccard 查高度相似与疑似新版本，给出「跳过 / 合并 / 登记新版本 / 独立导入」建议 |
| 主题与审核 | 草稿 → 待审核 → 待修订 → 已发布 → 已归档；单级审核；版本快照与回滚；质量分按 来源30/证据25/审核20/新鲜15/一致10 计算并公开分项；审核中心「全部通过并发布」 |
| 列表多选与批量操作 | 卡片左上角 / 表格首列勾选，批量条显示已选数：**批量提交审核、批量迁移空间（含 Vault 文件搬家）、导出 ZIP（每篇一个 .md）、批量废止（页面移入 90-归档，不删文件）**；支持全选当前与清空，筛选或切页签时自动清理不可见选择 |
| AI 问答（带引用） | 检索增强：问句先剥疑问词再铺中文 2-gram（「凯越有多少人」→ 凯越），并按问句意图扩出度量词（多少人 → 人数/员工/规模）；检索范围同时覆盖**主题正文**（按段落打分取摘要 + 最相关段落）和来源片段，模型逐条标 [n] 引用；零命中直接回可读提示，不空跑模型；通道自动选型（云端员工优先，本机 Claude CLI 兜底）；「机密」资料只走本机通道，云端通道命中全机密时直接拒绝 |
| 知识图谱 | 共享标签 + 共享来源生成主题关联边（权重=关联强度），Canvas 四簇环形布局可视化，点节点开主题详情 |
| 受控词表 | 全库标签底账（使用数排序）；改名即全量合并（同步更新所有主题），编辑器提供高频标签一键打标，减少随意造新词 |
| 导出 Markdown | 主题导出为交付文件：frontmatter + 正文 + 来源证据附录，带鉴权下载 |
| Vault 双向 | 发布回写带 frontmatter 的 .md（目录按空间分）；每 60s 扫描 Obsidian 外部修改回灌索引（沿用页面 id，不重复登记），工作台有未保存草稿时记冲突并给「采用 Vault / 保留草稿」二选一 |
| 证据引用 | 来源片段按「第 N 页 / 章节 / 工作表」定位，主题详情可见；搜索结果可看到命中片段与来源名 |
| 导入中心 / 运行记录 | 批次进度、失败记录、健康检查（失联来源、无引用已发布主题、冲突）、只追加审计日志 |
| 备份 | 每日增量、周日全量，写入 `H:\产品中枢备份\kb-<kind>-<时间>`（DB + Vault + 参数），盘不可用时接口明确报错且首页持续提示 |

### P2 未做（有意不做，不假装有功能）

向量语义检索（当前为词面 + bigram 拆词检索，已覆盖大多数场景）、四个只读知识角色与权限分级、客户反馈/对比矩阵/机会建议的专门表单、AI 生成候选关系（relations 表已预留）。

### 与 Vault 既有 Schema 的关系

`E:\Obsidian\产品中枢` 里已有一套 LLMWiki Schema（`AGENTS.md` + `99-模板`），工作台严格对齐它，不另造目录或字段：

| 空间 | 正式目录（按类型细分，如 `10-调研Wiki/01-行业趋势`） |
|---|---|
| 调研 | `10-调研Wiki/`（00-综合调研 / 01-行业趋势 / 02-厂商竞品 / **02-主题汇编** / 03-技术方案 / 04-政策标准 / 05-客户需求 / 06-招投标） |
| 企划 | `20-企划Wiki/`（01-企划项目 / 02-竞争力12维度 / 03-竞品跑分 / 04-市场政策 / **04-主题汇编** / 05-营销研发计划） |
| 产品 | `30-产品模型/`（01-产品档案 / 02-功能库 / 03-需求池 / 04-客户反馈 / 05-竞品反馈 / 06-对比矩阵 / 07-机会与建议） |
| 灵感 | `40-灵感模型/` |

- 发布写出的 frontmatter 含 `id / type / status / domain / source_refs / evidence_level / confidence / sensitivity / created / updated / review_due`，并保留 `space` 扩展字段；
  状态双向映射：`draft→draft`、`pending→review`、`published→approved`、`archived→archived`；密级 `secret→confidential`。
- 导入资料会按编译规则在 `03-资料索引/` 生成 source 卡片；受管原文件落在原始层 `02-待导入/`。
- 启动与每 60s 扫描四个知识层（+ `80-AI候选更新`），Obsidian 里手工新建/修改的页面会自动进工作台；模板与规范目录不参与扫描。

### 目录与类型的对齐规则

Vault 里同一空间有两种目录：**类型目录**（`00-综合调研`…）和**按主题分册的目录**（`10-调研Wiki/02-主题汇编`、`20-企划Wiki/04-主题汇编`）。分册目录里的页面 frontmatter `type` 与普通主题相同，所以落盘规则改成「目录优先」：

- **已有页面原地更新**：只要页面已经在所属知识层根目录下、且目录是认识的（类型目录 / 分册目录 / 空间根），发布与编辑都写回原目录，不会被搬进类型目录；
- 临时目录（例如手工剪贴到的 `20-企划Wiki/00-临时`）仍会规范化回收；
- 新页面按类型目录落盘；类型不属于当前空间时落空间根。

类型表新增 `产品线全景`（`product_line`）、`方法论`（`method`）、`企划索引`（`planning_index`）三种，与 AGENTS.md 的页面类型表对齐；**未登记或类型与目录打架的页面一律落「未分类」**，不再猜一个最像的类型（旧逻辑会把 `product_line` 静默改成「企划项目」）。

列表顶部多一排**目录分档**（`全部 / 04-主题汇编 / 01-企划项目 …`），按 Vault 实际目录过滤，解决「同一类型里混着 62 页主题汇编和普通主题」的问题。

同步时会顺手做**死链自愈**：DB 里有记录但文件不在 → 同 id 换了路径的直接重连；同标题同空间的活页面存在则旧记录软删（`deleted`，审计留痕）；都没有则清空 `vault_path` 并记 `vault.missing-page`。也可手动触发 `POST /api/knowledge/repair-links`。废止（软删）的主题默认不出现在列表里，需显式 `?status=deleted` 才查得到。

### 配置

```json
{
  "knowledge": {
    "vaultDir": "E:\\Obsidian\\产品中枢",
    "backupDir": "H:\\产品中枢备份"
  }
}
```

环境变量 `WORKBUDDY_KNOWLEDGE_VAULT` / `WORKBUDDY_KNOWLEDGE_BACKUP` 优先。启动时只补齐 Schema 要求的目录（四个知识层根目录 + `03-资料索引` + `80-AI候选更新`），不会新建 Schema 之外的目录。

## 版本与更新

网关可以自己从 AI 能力平台拉「程序更新包」升级：检查 → 下载 → 校验 → 备份 → 覆盖 → 重启，全程在设置页完成。

### 发布一个更新包

```bash
node scripts/build-update.mjs --version 1.1.0 --notes "修复了什么" \
  --base-url http://8.138.91.205/hub/releases
```

产出 `dist/update/` 下两个文件，一起上传：

| 文件 | 放哪里 |
|---|---|
| `gateway-1.1.0.zip` | `--base-url` 指向的目录（清单里的 `url` 指向它） |
| `gateway.json` | `<平台地址>/hub/release/gateway.json`（默认清单地址；放别处就在设置页填「更新源地址」） |

清单格式：

```json
{
  "version": "1.1.0",
  "publishedAt": "2026-11-03T08:00:00+08:00",
  "notes": "更新说明，会显示在设置页",
  "url": "http://host/hub/releases/gateway-1.1.0.zip",
  "sha256": "…",
  "size": 606849,
  "minVersion": "1.0.0"
}
```

`sha256` 建议填：填了就强校验，不填也能装，但结果里标 `verified: false`。

### 更新时会发生什么

1. 读清单，语义版本比较（`1.10.0 > 1.9.0`），有新版才允许装
2. 下载 zip，校验 `sha256`（清单给了的话）与体积上限（300MB）
3. 解压到 `updates/staging-*`，找到含 `src/server.mjs` 的包根
4. **只替换白名单里的程序条目**：`src`、`public`、`scripts`、`installer`、`mcp`、`package.json`、几个启动脚本与文档
5. 替换前把旧条目 `rename` 进 `backups/update-<旧版本>-<时间>/`，中途失败整批退回
6. 提示「重启后生效」——**不会自动重启**

**永远不动**：`state/`（任务、流程、更新记录）、`logs/`、`skills/`、`backups/`、`dist/`、`secrets.json`、`agent-secrets.json`、`hub-secrets.json`、`gateway.config.json`。包里就算带了这些也会被跳过，并在结果的 `skipped` 里列出来。

### 重启怎么回去

`POST /api/system/restart` → 写标记 → `spawn scripts/relaunch.mjs` → 进程退出 → relaunch 等端口释放（最多 60 秒）→ 多等 4 秒看 watchdog 有没有先起来 → 没人拉就自己拉起，日志追加到 `logs/gateway-<日期>.log`。

装了 `scripts/watchdog.ps1`（开机自启那套）时，watchdog 会先一步接手，relaunch 发现端口已占用就自己退出，不会双开。没装 watchdog 也能重启，不依赖外部进程。

### 自动更新

| 开关 | 默认 | 行为 |
|---|---|---|
| 启动后自动检查 | 开 | 启动 25 秒后查一次，之后每 6 小时一次，只读清单不改文件 |
| 有新版自动安装 | 关 | 打开后，**没有任务在跑/排队**时才下载安装并重启；有任务就等下一轮 |

有新版时侧栏「设置」会亮一个小圆点，设置页折叠标题也会写「可更新到 vX」。

### 排障

| 现象 | 原因 |
|---|---|
| 「暂无更新包」 | 清单地址返回 404——平台还没发过网关包，属于正常状态，不是故障 |
| 「清单不是 JSON」 | 更新源地址指到了网页（比如平台登录页），填到 `gateway.json` 上 |
| 「校验失败」 | 清单 `sha256` 与实际包不符：包传坏了或清单过期，重新打包上传 |
| 「包里找不到 src/server.mjs」 | 上传的不是网关更新包，或者包内多套了一层别的目录 |
| 更新后起不来 | 看 `logs/update-<日期>.log` 与 `logs/gateway-<日期>.log`；在设置页点「回滚到 v上一版」再重启 |

## 架构

```text
WorkBuddy / Web Console
          │  Bearer Token + JSON
          ▼
  WorkBuddy Gateway :4317
     ├─ validate / deduplicate
     ├─ concurrency queue
     ├─ SSE event stream
     ├─ durable task/event logs
     ├─ approval router
     └─ allowed-root guard
          │  JSON-RPC 2.0 / stdio JSONL
          ▼
  Persistent Codex app-server
          │  pre-turn failure only
          ├──────────────► codex exec fallback
          │
          ▼
   Approved repository roots
```

## 快速启动

前置条件：Node.js 18+、已安装且已登录的 Codex CLI。

PowerShell：

```powershell
$env:WORKBUDDY_ALLOWED_ROOTS = "C:\code\project-a;D:\repos\project-b"
$env:WORKBUDDY_GATEWAY_TOKEN = "replace-with-a-long-random-token"
npm start
```

也可以直接使用启动脚本：

```powershell
.\start.ps1 -AllowedRoots "C:\code\project-a;D:\repos\project-b" -GatewayToken "replace-with-a-long-random-token"
```

如果不设置 `WORKBUDDY_GATEWAY_TOKEN`，每次启动会自动生成临时 Token 并打印到终端。

打开 <http://127.0.0.1:4317>，输入终端中的 Token，即可从控制台派发任务。

## 交互约定

前端不再使用浏览器原生 `alert / confirm / prompt`，所有需要用户确认、输入、填表的地方统一走工作台弹窗（`public/dialog.js`，深色玻璃风格，与页面同一套视觉）。

| 场景 | 调用 | 返回 |
| --- | --- | --- |
| 二次确认 | `confirmDialog({ title, message, detail, okText, tone })` | 确认为 `true`，取消为 `false`；`tone: "danger"` 走危险色 |
| 单行 / 多行输入 | `promptDialog({ title, label, value, multiline })` | 输入内容，取消为 `null` |
| 多字段表单 | `formDialog({ title, fields, onChange })` | 字段名到值的对象，取消为 `null` |

- `formDialog` 的 `fields` 支持 `text / textarea / select`；`onChange(current, panel)` 返回 `{ key: { options, value } }` 即可联动下拉（例如「知识空间 → 类型」）。
- 键盘：`Esc` 取消、`Enter` 确认（多行输入为 `Ctrl + Enter`）、`Tab` 焦点锁在弹窗内、关闭后焦点归还触发元素。
- 样式全部靠 class（`w420 / w440 / w460 / w520 / w560` 控宽），不写内联 style —— 站点 CSP 为 `style-src 'self'`。

灵感录入同理，不走「新建主题」表单：在知识库首页的捕获台写一句话、按 `Ctrl + V` 贴截图、或直接拖文件进去，`Ctrl + Enter` 收下即入 Vault，事后再整理。

## 豆包与 Kimi AI 员工

网关已内置豆包 Ark Chat Completions 与 Kimi Moonshot Chat Completions 的流式执行器。任务可以在工作台中选择“自动匹配”，也可以手动指定员工；云端员工的输出、取消、超时、错误和用量会进入与 Codex 相同的任务时间线。

首次激活时，在网关目录运行：

```powershell
.\scripts\configure-agents.ps1 -Restart
```

脚本会用隐藏输入分别读取 `ARK_API_KEY` 和 `MOONSHOT_API_KEY`，保存到已被 `.gitignore` 排除的 `agent-secrets.json`，并收紧为当前用户、SYSTEM 和管理员可读。不要把密钥粘贴进聊天、任务提示词或 `gateway.config.json`。也可通过环境变量 `ARK_API_KEY`、`MOONSHOT_API_KEY` 临时覆盖。

默认模型在 `gateway.config.json` 的 `agents` 节点配置：豆包为 `doubao-seed-2-1-lite-260915`，Kimi 为 `kimi-k3`。网关没有凭据时仍可启动，工作台会把相应员工标为“待配置”，且不会误派任务。

## 员工名单

内置四位：两位本机 CLI、两位云端 API。都能在员工页改名、换头像、调能力标签；
自建员工（云端或本机）与内置位同等对待，只是可以删。

| 员工 | 跑在哪 | 能力标签 | 什么时候路由到它 |
|---|---|---|---|
| Codex | 本机 CLI | 代码执行 / 本地文件 / 命令行 / Office 文件 | 改代码、跑命令 |
| Claude | 本机 CLI | 上面这些 **+ 联网检索** | 需要长上下文推理、查资料再动手的活 |
| 豆包 | 云端 API | 长文写作 / 中文写作 / 文档 / 归纳摘要 | 中文长文、文档理解 |
| Kimi | 云端 API | 长文写作 / 长上下文 / 文档 / 归纳摘要 | 超长上下文、资料归纳 |

分工写在 `src/workbench/agents.mjs` 的 `capabilities` 里，改它就能改自动路由。

### 新建员工：两种类型，本机的不问 API

员工页「新增员工」顶部磁贴分两类：

| 磁贴 | 表单长什么样 | 靠什么判定可用 |
|---|---|---|
| **本机 CLI**（Claude Code） | 只有名称、概述、头像、能力标签、单价——**没有 API Key / 地址 / 模型** | 本机 `claude.exe` 在不在 |
| 云端厂商（豆包 / Kimi / OpenAI 兼容…） | 地址与默认模型预填，补 Key 即可 | Key、地址、模型三项齐 |

本机磁贴的小字会直接标出探测结果：`本机 CLI · 已安装` / `本机 CLI · 未检测到`。
没装时磁贴转琥珀色、副标题提示「装好后才能派活」，避免建完才发现派不了活。
探测在每次打开页面拉 bootstrap 时做一次（只查文件在不在，不启动 CLI，无额外开销）。

本机类型的员工落盘只有 `provider:"local"` + `cli:"claude"`，重启后仍按
「CLI 装没装」还原，不会因为没 Key 被打成「待配置」。想再加一个本机员工
（比如给不同业务起不同名字、挂不同能力标签），直接选这张磁贴就行，
不用复制配置文件、也不用重启。

除此之外还可以随时「新建员工」加任何 OpenAI 兼容的模型，不限于这几家。

### 本机 Claude Code 员工

网关不碰 Anthropic 的凭据，也不替 Claude 选模型——它 spawn 一次
`claude -p --output-format stream-json`，上游是谁由 Claude Code 自己的
`~/.claude/settings.json` 决定（官方、CC Switch 代理、中转都行）。

| 网关做的一件小事 | 为什么 |
|---|---|
| 权限：只读走 `--permission-mode plan`，可写走 `--dangerously-skip-permissions` | 非交互模式没人点「同意」，不提前定死就一步也走不了 |
| 续聊带 `--resume <session_id>` | 任务卡片的连续对话靠它，不是每次从零开 |
| 产物只认它自己报的 Write/Edit 路径 | 扫目录会把 `state/*.jsonl` 这类自更新文件当成产物 |
| token 用量照真实事件记 | 缓存命中单独记账，成本按你填的单价折算 |

三条容易踩的：

1. **它依赖本机 Claude Code 能跑**。代理没开、登录态过期，任务会失败并直接告诉你
   「连不上上游」还是「没有登录态」，不会假装成功。
2. **模型名不给它猜**。配置里不存模型，Claude 用它自己的默认；要指定就在派活时传。
3. **别指望它和 Codex 并行**：两者都是本机进程，并发上限还是 `maxConcurrency`。

补充：本机装的是 npm 包里的原生 `claude.exe`，走直接 spawn，不经过 `.cmd` 壳，
所以不会有 Windows 那套转义/注入问题。

### WorkBuddy 暂不在册（2026-11-02）

API 还没到手，卡片留着只是每次都要解释「为什么是灰的」，先拿下来。

加回来**不需要改代码**：员工页 → 新建员工 → 填 Base URL、模型名、API Key 三项即可，
和加一个 DeepSeek 没有区别。若想恢复成「内置位」（固定头像、固定能力标签、参与自动路由），
把 `src/workbench/agents.mjs` 里注释掉的那段放回 `AGENTS`，再在 `gateway.config.json`
的 `agents` 下补一个同名节点。

**历史 · 为什么当初从 CLI 换成 API**（这段留着，避免以后再走一遍）：

- 桌面端自带的那份 CLI 只打包了 headless 精简包，没有 `dist/codebuddy.js`，进不了交互界面，`/login` 在它身上不存在；
- 凭据文件 `workbuddy-desktop.info` 是加密信封，跨进程解不开；状态接口返回的 `authenticated:true` 是假阳性，真派任务仍然 401；
- 登录态会过期、换机要重来，不适合做成后台常驻服务。

API Key 这三样才是给程序用的：不过期、可分发、能写进配置。

**历史 · 当初的能力定位**（加回来时建议照这个挂，别让它通吃）：
`code / files / shell / office-files / web`，且**不挂** `longform` / `long-context` / `summarize`——
挂上它能力集最大，自动路由会把所有活都派给它，另外三位变成摆设，额度也全烧在一处。

## 成本观测（token 与花费）

每个云端员工跑完一回合都会带回 `usage`。网关只落**事实**：输入 / 输出 / 缓存命中 / 推理 token，
存进任务的 `usage` 字段，跟着 `state/tasks.jsonl` 一起活过重启。

多轮工具循环不会漏账：一次派活里模型来回几趟，每一趟的用量在 runner 里就累加好了，
`turn.completed` 上报的是这次派活的总量。

**钱是按单价算出来的估算，不是账单。** 单价按员工配，单位是「元 / 百万 tokens」：

```json
"doubao": {
  "enabled": true,
  "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
  "model": "doubao-seed-2-1-turbo-260628",
  "pricing": { "input": 0.8, "output": 2 }
}
```

- `cachedInput` 可选，不填就按 `input` 算（宁可算高不算低）。
- **不填单价就不算钱**：看板显示「未填单价」，不是 ¥0——「算不出来」和「免费」必须区分开。
- 历史金额会跟着单价变。因为库里只存 token，改价后旧单子按新价重算；
  想留一份当时的账，就把单价抄进任务备注里，别指望数据库。
- 本机 Codex 不上报 usage，它的 token 与花费一律显示「—」。

界面上的四处：

| 位置 | 看什么 |
|---|---|
| 数据看板 · 成本观测 | 总花费、输入/输出/缓存结构条、最贵的 5 单（点开看详情）、哪几家没填单价 |
| 数据看板 · 员工表现 | 每个员工的输入/输出 token 与花费，可以按花费排序 |
| 趋势图悬停 | 当天的 token 与花费（按完成时间入桶，跟「派单」不是同一批） |
| 任务抽屉 | 这一单的 `128.0k tokens（约 ¥0.112）` |

填单价的地方：员工页 → 卡片上的「填 API」→ 高级设置 → 输入 / 输出单价。
两个都留空就是清掉估算，只留 token 统计。

### AI 查价：不想手填时的按钮

单价行右侧有个 **AI 查价** 按钮：点一下，网关派一个能上网的员工（优先 Claude Code，
不可用时退 Codex）去抓厂商官方定价页，把「输入 / 输出 / 缓存」折成元/百万 tokens
填进表单——**只填不存**，还要你点「保存并生效」才落盘，查错价看得见、拦得住。

| 环节 | 做法 |
|---|---|
| 出题 | `pricing-fetcher.mjs` 的 `buildPricingPrompt`：curl 抓官方页优先，单位、汇率（1 USD ≈ 7.2 CNY）、只查该型号、只回 JSON 一次说死 |
| 执行 | 新任务模式 `mode:"web"`：bypass 权限 + 黑名单 `Write/Edit/MultiEdit/NotebookEdit`，能联网、写不了文件；封顶 8 分钟 |
| 收卷 | `parsePricingReply`：抠 JSON（容忍围栏/废话）、验收数字、超上限按「单位没换算」拒绝、查不到只要 `{"error": ...}` 就转成人话 |
| 回填 | 成功填两个输入框，提示一行结论，note 与来源挂在悬停上 |

踩过的坑记在这里，换机器/换上游时先看：

- `--permission-mode plan` 下 WebFetch 要权限确认，非交互直接卡死；而且上游模型
  会拿「plan 模式不能输出」当借口整个拒跑 → 改用 bypass + 工具黑名单。
- 走中转上游（CC Switch → qwen）时 WebSearch/WebFetch 抓不到外网，**curl 可以**
  （认系统代理），所以题目里让员工优先 `curl -sL`。
- 查价结果不落盘是有意的：单价直接影响钱，宁可多一步确认。

## 员工头像

内置三位（Codex / 豆包 / Kimi）各有一张固定的机器人头像，新建的自定义员工默认只有一个
「名字首字」的圆片，卡片墙上很难认。员工弹窗里现在有 10 个可选头像：

`琥珀 / 珊瑚 / 紫罗兰 / 靛蓝 / 天空 / 青碧 / 青柠 / 石墨 / 墨黑 / 可可`

- 存在 `gateway.config.json` 的 `agents.<id>.avatar`，**只存 key**（如 `"violet"`），不存路径；
- 白名单校验：传一个不存在的 key 直接拒绝，避免写出 404 空图；
- 选「默认」= 清空：内置员工回到自己的固定头像，自定义员工回到首字圆片；
- 图是 `public/assets/avatars/<key>.svg`，96 视口、纯手写 SVG，无外部依赖、无位图。

换头像：员工页 → 卡片上的「配置」→ 头像行点一个 → 保存并生效。

## Codex CLI 定位（重要）

网关通过 `codex` 命令调用本机 CLI。Codex 的真实二进制在
`%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\`，**不在 PATH 里**。

`~\.codex\.sandbox-bin\codex.exe` 也有一份，但它通常**缺少 `codex-code-mode-host.exe`**。
缺了这个文件，Codex 会 fail closed：任务状态变成 `completed`，却一条命令都执行不了，
只返回一句"命令通道不可用"。

判据：**看 `codex.exe` 同目录有没有 `codex-code-mode-host.exe`**。
`start.ps1` 和 `scripts\watchdog.ps1` 都会自动探测并优先选择完整的那份，
在 `gateway.config.json` 的 `codexHome` 里可以手动指定。

## 常驻部署（推荐）

让网关作为常驻进程运行：登录 Windows 自动启动，崩溃自动拉起。

```powershell
.\scripts\install-autostart.ps1     # 安装并立即启动
.\scripts\uninstall-autostart.ps1   # 卸载并停止
```

机制：

- 自启位置 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\WorkBuddyCodexGateway`
  —— 本机 Startup 文件夹被 ACL 锁定，`.vbs` 和 `.lnk` 都写不进去，注册表是唯一可用位置
- `scripts\watchdog.ps1` 每 10 秒做一次 `/health` 检查；进程退出、或连续 3 次无响应即重启，
  带 3→5→10→20→30 秒退避
- watchdog 用 WMI `Win32_Process.Create` 启动，避免被父 shell 的进程树清理带走
- 日志：`logs\watchdog-YYYY-MM-DD.log`（守护事件）、`logs\gateway-YYYY-MM-DD.log`（网关输出）
- 全部运行参数集中在 `gateway.config.json`：token、白名单、端口、Codex 路径、退避策略

停止：创建 `logs\.stop` 触发优雅退出，或直接运行卸载脚本。

> 本机环境有两个已知坑，脚本里已处理：代理工具同时设置了 `HTTPS_PROXY` 与 `https_proxy`
> 会让 .NET 的进程环境字典撞键；PowerShell 5.1 会把无 BOM 的 UTF-8 脚本按 ANSI 解析导致中文乱码。

## WorkBuddy 接入

### 方式一：MCP（推荐）

`mcp\codex-gateway-mcp.mjs` 把网关包装成 MCP 工具，WorkBuddy 可直接调用，
已注册在 `~\.workbuddy\mcp.json`：

```json
{
  "mcpServers": {
    "codex-gateway": {
      "command": "<node.exe 的绝对路径>",
      "args": ["<项目目录>\\mcp\\codex-gateway-mcp.mjs"],
      "env": { "WORKBUDDY_GATEWAY_URL": "http://127.0.0.1:4317" }
    }
  }
}
```

暴露 7 个工具：`codex_dispatch`（默认立即返回任务 ID）、`codex_task_status`、
`codex_task_events`、`codex_task_list`、`codex_task_cancel`、
`codex_task_resolve_approval`、`codex_gateway_health`。

长任务不要占住一次 MCP 调用：先用 `codex_dispatch` 提交，再用
`codex_task_status` 或 `codex_task_events` 查询。只有明确传入 `wait: true` 才会短暂等待，
默认 90 秒、上限 120 秒；到期后任务仍在网关中继续运行。

Token 不必写进 `mcp.json`——桥会自动读取 `gateway.config.json`，改一处即可生效。
首次使用需在 WorkBuddy 连接器管理页对 `codex-gateway` 点 **Trust**，否则工具不会加载。

### 方式二：OpenAPI / HTTP Action

可将 `openapi.yaml`（原内部参考未随附） 导入支持 OpenAPI Action 的 WorkBuddy，或手工配置下面的 HTTP Action。生产使用时请把 Token 放在 WorkBuddy 的密钥存储中，不要写进提示词。

```http
POST http://127.0.0.1:4317/v1/tasks
Authorization: Bearer {{WORKBUDDY_GATEWAY_TOKEN}}
Content-Type: application/json
X-Idempotency-Key: {{workbuddy_message_id}}

{
  "prompt": "检查登录模块，修复超时重试问题并补充测试",
  "cwd": "C:\\code\\project-a",
  "mode": "workspace-write",
  "label": "修复登录重试"
}
```

成功后返回 `202 Accepted`：

```json
{
  "id": "task-uuid",
  "status": "queued",
  "threadId": null
}
```

WorkBuddy 可以轮询结果：

```http
GET http://127.0.0.1:4317/v1/tasks/{{task_id}}
Authorization: Bearer {{WORKBUDDY_GATEWAY_TOKEN}}
```

当 `status` 为 `completed` 时，读取 `finalResponse`。后续指令可携带返回的 `threadId`，让 Codex 延续上下文：

```json
{
  "prompt": "继续执行刚才的方案，并运行完整测试",
  "cwd": "C:\\code\\project-a",
  "threadId": "0199..."
}
```

取消任务：

```http
POST http://127.0.0.1:4317/v1/tasks/{{task_id}}/cancel
Authorization: Bearer {{WORKBUDDY_GATEWAY_TOKEN}}
```

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 健康状态，不需要鉴权 |
| `GET` | `/v1/meta` | 白名单目录、并发上限、重启恢复统计（控制台用它填充目录下拉） |
| `POST` | `/v1/tasks` | 创建任务 |
| `GET` | `/v1/tasks` | 获取任务列表 |
| `GET` | `/v1/tasks/:id` | 获取任务和最终结果；加 `?events=1` 返回历史事件 |
| `GET` | `/v1/tasks/:id/events` | SSE 实时事件流 |
| `GET` | `/v1/tasks/:id/events.json?after=N` | 从事件序号 N 之后增量读取，适合轮询和断线恢复 |
| `GET` | `/v1/metrics` | 成功率、排队/首输出/执行时延 P50/P95、重连与审批等待计数 |
| `POST` | `/v1/tasks/:id/cancel` | 取消排队中或执行中的任务 |
| `POST` | `/v1/tasks/:id/approvals/:approvalId` | 处理待审批操作，body 为 `{ "decision": "accept" }` |

工作台接口（部分）：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/system/update` | 当前版本、上次检查结果、更新设置、可用备份 |
| `POST` | `/api/system/update/check` | 拉清单比对版本，写入 `state/update.json` |
| `POST` | `/api/system/update/apply` | 下载安装（body 可带 `manifest`），返回 `pendingRestart: true` |
| `POST` | `/api/system/update/rollback` | 回滚到最近备份 |
| `PATCH` | `/api/system/update/settings` | `{ autoCheck, autoInstall, intervalHours, manifestUrl }` |
| `POST` | `/api/system/restart` | 重启服务（由 `scripts/relaunch.mjs` 接生） |

知识库接口组（`/api/knowledge/*`，独立模块，见 `src/workbench/knowledge/`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/knowledge/bootstrap` | 空间/类型/密级/统计/Vault 与备份路径/启动同步结果 |
| `GET` | `/api/knowledge/topics?space=&status=&type=` | 主题列表 |
| `POST` | `/api/knowledge/topics` | 新建主题（草稿） |
| `GET` | `/api/knowledge/topics/:id` | 详情：引用、版本、冲突 |
| `PATCH` | `/api/knowledge/topics/:id/draft` | 保存草稿（标题/摘要/正文/类型/密级） |
| `POST` | `/api/knowledge/topics/:id/submit` | 提交审核（生成待审核项） |
| `POST` | `/api/knowledge/topics/:id/publish` | 发布并回写 Vault |
| `POST` | `/api/knowledge/topics/:id/archive` | 归档 |
| `POST` | `/api/knowledge/topics/:id/rollback` | 回滚到指定版本 `{ version }` |
| `POST` | `/api/knowledge/ask` | 知识库问答 `{ question }`：检索主题正文段落 + 来源片段后交给模型；返回 `{ answer, citations[{ n, sourceName, locator, text, topicId }], topics, modelKind, retrieval{ terms, topics, entries } }`。零命中不调模型，直接回提示 |
| `POST` | `/api/collab/push` | 成员推送（成员 Token）：`?task=&kind=artifact\|note&agent=&title=`，body 为文本或文件字节，≤40MB |
| `GET` | `/api/collab/tasks` | 成员视角任务列表（选「当前任务」用） |
| `GET` | `/api/collab/tasks/:id/pushes` | 任务协作流（主 Token），返回 `items` 与按档计数 `counts` |
| `GET` | `/api/collab/stream` | SSE：新推送 / 成员变化实时广播（`?token=`） |
| `GET` | `/api/collab/files/:pushId` | 推送附件（图片内联、文件下载） |
| `POST` | `/api/collab/members` | 新建成员，返回一次性明文 Token |
| `POST` | `/api/collab/members/:id/token` | 轮换 Token（旧 Token 立即失效） |
| `POST` | `/api/collab/pushes/:id` | 把推送挪到别的任务（body `{ task }`） |
| `DELETE` | `/api/collab/pushes/:id` | 删除推送（连同落盘附件） |
| `POST` | `/api/knowledge/repair-links` | 死链自愈：重连被移动/改名的页面、软删同标题重复记录、清空失联路径；返回 `{ merged, cleared, relinked, synced }` |
| `POST` | `/api/knowledge/inbox` | 灵感随手记 `{ text, title?, attachments?:[id], space?, type? }`：一步建灵感主题并落 Vault；返回 `{ topic, attachments }`，`topic.attachments` 带附件元信息；空内容直接 400 |
| `POST` | `/api/knowledge/attachments?name=` | 原始字节上传附件（≤40MB），存 `40-灵感模型/_附件/` 并登记；返回 `{ id, name, path, kind, size, url }` |
| `GET` | `/api/knowledge/attachments/:id` | 读取附件原文件（图片按真实 MIME 返回，供卡片缩略图与正文嵌入用；需 Bearer） |
| `POST` | `/api/knowledge/topics/:id/spawn` | 灵感流转 `{ space, type, title? }`：在目标空间建派生主题并记有向关系，**原件不搬**；返回 `{ idea, topic, reused }`，`reused=true` 表示这条灵感已经往同一标题流过，交回已有主题 |
| `POST` | `/api/knowledge/topics/:id/move` | 空间迁移 `{ space, type }`：同步搬移 Vault 文件、改写 frontmatter，返回 `moved/from/to/removed` |
| `POST` | `/api/knowledge/topics/:id/summarize` | 按概述章节重新摘取摘要 `{ apply }`（`apply: false` 只预览） |
| `POST` | `/api/knowledge/summaries/recompute` | 批量重算摘要 `{ space?, force? }`（默认只补空摘要与截断摘要） |
| `POST` | `/api/knowledge/topics/bulk-submit` | 批量提交审核 `{ ids? }`：传 ids 只提交勾选项，否则按 `space/type/classification` 筛选全部草稿 |
| `POST` | `/api/knowledge/topics/bulk-move` | 批量迁移 `{ ids, space, type }`：逐个搬 Vault 文件 + 改 frontmatter，返回成功/失败明细 |
| `POST` | `/api/knowledge/topics/bulk-delete` | 批量废止 `{ ids }`：状态置 deleted，Vault 页面移入 `90-归档/<space>/` |
| `POST` | `/api/knowledge/topics/bulk-export` | 批量导出 `{ ids }`：返回 `application/zip`，每篇一个 Markdown（零依赖 store 模式打包） |
| `GET` | `/api/knowledge/search?q=&space=&status=&scope=` | 双索引检索（`scope` = all/summary/body），返回 `_match`（摘要命中/正文命中）与 tookMs |
| `POST` | `/api/knowledge/imports/files?name=&space=&classification=` | 原始字节上传导入（≤200MB） |
| `POST` | `/api/knowledge/imports/text` | 粘贴文本导入 |
| `POST` | `/api/knowledge/imports/url` | 网页链接导入（手动提交） |
| `GET` | `/api/knowledge/imports` | 导入批次 |
| `GET` | `/api/knowledge/sources` / `/sources/:id` | 来源列表 / 详情与片段（含失联判定） |
| `GET` | `/api/knowledge/reviews?status=` | 审核列表 |
| `POST` | `/api/knowledge/reviews/:id/decide` | `{ status, comment }`；通过即发布，退回转待修订 |
| `GET`/`POST` | `/api/knowledge/health` | 健康检查（失联来源/无引用/冲突） |
| `GET` | `/api/knowledge/backups` | 备份目标可用性 + 历史 |
| `POST` | `/api/knowledge/backups/run` | 立即备份 `{ kind: "full" \| "incremental" }` |
| `POST` | `/api/knowledge/backups/restore` | 恢复（必须 `confirm: true`） |
| `GET` | `/api/knowledge/audit?limit=` | 只追加审计日志 |
| `GET` | `/api/knowledge/ops` | 运行记录：导入批次 + 审计 + 健康问题 |

任务字段：

| 字段 | 必填 | 说明 |
|---|---:|---|
| `prompt` | 是 | 给 Codex 的清晰任务指令 |
| `cwd` | 建议 | 必须位于 `allowedRoots` 内；省略时使用第一个允许目录 |
| `mode` | 否 | `workspace-write`（默认）或 `read-only` |
| `model` | 否 | 指定模型；省略时使用本机 Codex 默认配置 |
| `threadId` | 否 | 恢复已有 Codex 线程 |
| `label` | 否 | WorkBuddy 中显示的短标题 |
| `agent` | 否 | `codex`、`doubao` 或 `kimi`；省略时 `/v1/tasks` 默认 Codex，工作台 `/api/tasks` 自动匹配 |

## 配置

配置文件是 `gateway.config.json`，网关启动时自己读取——不需要预先注入一堆环境变量。环境变量仍然可用，且优先级高于文件（适合临时覆盖）。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `4317` | 监听地址与端口 |
| `tokenFile` | `secrets.json` | 凭据文件，相对本文件解析 |
| `agentSecretsFile` | `agent-secrets.json` | 豆包/Kimi API Key 文件；不要提交 |
| `agents.doubao` / `agents.kimi` | 见配置文件 | 启用状态、API 地址、默认模型和最大输出长度 |
| `allowedRoots` | 项目目录 | Codex 可工作的目录白名单（数组） |
| `codexHome` | 自动探测 | Codex 安装目录，留空则选带 `codex-code-mode-host.exe` 的那个 |
| `maxConcurrency` | `2` | 最大并发任务数 |
| `taskTimeoutMs` | `1800000` | 单任务超时，默认 30 分钟 |
| `stateFile` | `state/tasks.jsonl` | 任务持久化文件 |
| `eventFile` | `state/events.jsonl` | 可跨重启续读的事件日志 |
| `runnerMode` | `app-server` | 正常使用常驻 app-server；紧急回滚可设 `exec` |
| `allowExecFallback` | `true` | 仅允许在 turn 尚未启动时安全回退 |
| `taskRetention` | `500` | 内存中保留的任务数上限 |

对应环境变量：`WORKBUDDY_HOST`、`WORKBUDDY_PORT`、`WORKBUDDY_GATEWAY_TOKEN`、`WORKBUDDY_ALLOWED_ROOTS`、`WORKBUDDY_MAX_CONCURRENCY`、`WORKBUDDY_TASK_TIMEOUT_MS`、`WORKBUDDY_MAX_PROMPT_CHARS`、`WORKBUDDY_STATE_FILE`、`WORKBUDDY_TASK_RETENTION`、`WORKBUDDY_CONFIG_FILE`、`ARK_API_KEY`、`MOONSHOT_API_KEY`、`WORKBUDDY_DOUBAO_MODEL`、`WORKBUDDY_KIMI_MODEL`。

### 凭据

Token 不在 `gateway.config.json` 里，而在独立的 `secrets.json`（已列入 `.gitignore`），文件权限在生成时收紧到当前用户。网关和 MCP 桥都从同一处读取，轮换一次即可两边生效。

```powershell
.\scripts\rotate-token.ps1              # 生成新 token，不重启
.\scripts\rotate-token.ps1 -Restart     # 生成并重启，立即生效
.\scripts\rotate-token.ps1 -Show        # 顺带打印一次新 token
```

MCP 桥遇到 401 会自动重读凭据并重试，所以轮换后不需要重启 WorkBuddy 的 MCP 服务。

### 任务持久化

每个任务的状态变更追加到 `state/tasks.jsonl`，事件帧追加到 `state/events.jsonl`，每个任务重放最近 500 条。网关重启后自动恢复历史任务与 SSE 序号；重启时仍在运行或等待审批的任务会标为 `interrupted`，并保留 `threadId`，下一任务可通过 `thread/resume` 继续。幂等键同样持久化，重启后重放不会重复执行。

文件行数超过 `taskRetention × 3` 时，启动阶段会自动压缩为每任务一条快照。

## 测试

```powershell
npm test
```

受控比较直连与系统代理时，使用同一只读短任务、固定 `low` 推理强度，并按轮次交错运行：

```powershell
node scripts/benchmark-codex.mjs --runs=10 --modes=direct,system
```

报告写入 `reports/codex-benchmark-*.json`，包含成功率、P50/P95、首输出时延和重连次数。
正式判断至少收集 10～20 次/模式；不要用一次烟测推导固定的“上游五分钟上限”或代理倍率。

## 安全建议

- 保持默认的 `127.0.0.1`；如需跨机器访问，请放在 TLS 反向代理、VPN 和防火墙之后。
- 定期运行 `scripts\rotate-token.ps1` 轮换凭据；不要把它写进提示词或截图。
- 将 `allowedRoots` 收窄到实际仓库，不要配置系统盘根目录或用户主目录。
- 网关刻意不提供 `danger-full-access`。写入任务使用 Codex 的 `workspace-write` 沙箱及自动审批检查。
- `secrets.json`、`state/`、`logs/` 都在 `.gitignore` 里，不要把项目目录整个打包外发。

