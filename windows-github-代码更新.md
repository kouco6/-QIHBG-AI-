# Windows GitHub 代码更新说明

更新日期：2026-11-23（Asia/Shanghai）

## GitHub 更新状态总览（避免重复更新）

本表记录本文件所列代码向 GitHub `v2.0` 分支的实际同步状态，供下次核对，**标记「已上传」的文件请勿重复提交**。

- 目标仓库：`kouco6/-QIHBG-AI-`；目标分支：`v2.0`（与 `main` 相互独立，未触碰 main 上的旧平台代码）。
- 同步提交：9ce8cc3（组件/CSS与Logo初次上传）；72c988e（App路由）；f51f887（侧栏入口）；88b5930（登录品牌）；3a304e2（README）；7b68b22（进度记录）。
- 本地校验：2026-11-23 在本地独立工程执行 `npm --prefix web run build` 通过；仍提示 `/ai/layout.css` 构建时缺失、主 JS chunk 超过 500 kB。此结果不代表远程 v2.0 已构建通过。

### 分支分叉背景与本次增量合并

同步前发现远程 `v2.0` 已包含展会页、数据看板与人员/企划后端。2026-11-23 在远程版本上增量加入审核中心路由、管理员侧栏入口和登录品牌，保留展会、看板与人员功能，未修改 `main`。审核中心组件/CSS与两张Logo已由前序提交上传。

| 批次 | 文件 | 状态 |
| --- | --- | --- |
| 审核中心（本次） | `web/src/components/approval-center.tsx` | ✅ 已上传 |
| 审核中心（本次） | `web/src/components/approval-center.css` | ✅ 已上传 |
| 登录页品牌（前次） | `web/public/login-brand-logo-dark.png` | ✅ 已上传 |
| 登录页品牌（前次） | `web/public/login-brand-logo-light.png` | ✅ 已上传 |
| 记录文档 | `windows-github-代码更新.md` | ✅ 已上传（本文件，含本状态表） |

### 共享文件同步状态（2026-11-23）

以下远程共享文件已在保留展会、看板和人员功能的前提下增量合并并提交到 `v2.0`：

| 文件 | 状态 | 影响 |
| --- | --- | --- |
| `web/src/App.tsx` | ✅ 已上传（72c988e） | 审核中心路由已注册，同时保留远程展会、看板和人员页。 |
| `web/src/components/app-sidebar.tsx` | ✅ 已上传（f51f887） | 管理员可见该入口，点击可打开审核中心。 |
| `web/src/components/login-page.tsx` | ✅ 已上传（88b5930） | 引用分支现有浅色/深色 Logo，并更新标题和文案。 |
| `README.md` | ✅ 已上传（3a304e2） | 已补充审核中心与登录品牌范围说明。 |
| `进度&规则.md` | ✅ 已上传（7b68b22） | 已记录同步范围和本地构建/远程验证边界。 |

审核中心组件/CSS及两张品牌Logo此前已上传；表中共享文件现已同步到 `v2.0`，审核中心管理员入口与登录品牌已纳入远程版本。

### 其他未纳入的改动（避免下次误判为遗漏）

以下属于 2026-11-19「任务执行界面原生控件适配」批次，与审核中心/登录页两批无关，也不在本文档上传清单内，**未上传**：

- `底层能力/交互组件/README.md`、`src/ui/catalog.ts`、`src/ui/checkbox.tsx`、`src/ui/native-controls.ts`、`src/ui/select.tsx`
- `web/src/scheduler.css`

若后续确需同步，请单独确认后再提交，以免把不同批次混在一起。

## 本次更新：审核中心前端原型

在“工作空间管理”下新增管理员可见的“审核中心”页面。页面采用审核队列、事项列表和详情区三栏布局，支持搜索、状态/未读筛选、查看合成事项与审核记录，并可模拟通过、退回补充和驳回。

审核事项均为合成数据；操作只更新当前页面状态，不调用审核 API、不连接真实业务数据。无后端、数据结构、依赖清单或图片资源变更。

### 本次更新目录

```text
web/src/
├─ App.tsx                                  # 页面注册与管理员角色检查
└─ components/
   ├─ app-sidebar.tsx                       # 工作空间管理菜单新增“审核中心”
   ├─ approval-center.tsx                   # 审核中心页面与演示交互
   └─ approval-center.css                   # 三栏布局、主题样式与窄屏适配
```

**底层能力没有更新。** `底层能力/交互组件`、`底层能力/表格组件`、`底层能力/文字` 均未修改。页面复用既有 `@capability-ui/*` 组件；没有复制或新增底层共享组件。

### 本次上传到 GitHub

审核中心运行所需的本批源码只有以下四个文件：

```text
web/src/App.tsx
web/src/components/app-sidebar.tsx
web/src/components/approval-center.tsx
web/src/components/approval-center.css
```

Windows PowerShell 可只暂存以上代码：

```powershell
git add web/src/App.tsx web/src/components/app-sidebar.tsx web/src/components/approval-center.tsx web/src/components/approval-center.css
```

若要同步项目范围与更新记录，再额外提交以下文档；它们不参与页面运行：

```powershell
git add README.md '进度&规则.md' 'windows-github-代码更新.md'
```

本次未修改 `底层能力/`、`backend/`、`services/`、`baseline/`、`package.json` 或锁文件，因此无需为审核中心上传这些目录或依赖文件。本清单以目标 GitHub 仓库已有 V2.0 独立工程及其共享组件为前提。

## 前次更新：登录页品牌展示

前次只调整 V2.0 登录页品牌展示：左侧中央显示平台 Logo，按主题切换图片；顶部“企划设计BG平台”加大加粗；左下文案改为“挖掘、创造每一个产品的无穷可能性”。登录与身份校验逻辑没有改动。

### 前次更新目录

```text
web/
├─ src/components/login-page.tsx       # 登录页布局、主题 Logo 切换与品牌文案
└─ public/
   ├─ login-brand-logo-dark.png         # 深色主题：彩色透明 Logo
   └─ login-brand-logo-light.png        # 浅色主题：白色透明 Logo
```

**底层能力没有更新。** `底层能力/交互组件`、`底层能力/表格组件`、`底层能力/文字` 均未修改；后端、调度服务和模板基线也未修改。

### 前次登录页更新的 GitHub 文件

要让登录页更新正常运行，至少上传以下三个应用源文件，Logo 图片也必须一起上传：

```text
web/src/components/login-page.tsx
web/public/login-brand-logo-dark.png
web/public/login-brand-logo-light.png
```

在 Windows PowerShell 中可逐项暂存：

```powershell
git add web/src/components/login-page.tsx web/public/login-brand-logo-dark.png web/public/login-brand-logo-light.png
```

如果当时也要同步项目记录和更新说明，再额外上传：

```text
进度&规则.md
windows-github-代码更新.md
```

这两个文档不参与登录页运行。`底层能力/` 没有改动，前次无需上传该目录下的文件。

## 不要作为本次源码上传的内容

- `web/dist/`：前端构建产物，可在目标环境重新构建。
- `web/node_modules/`：本机依赖目录。
- `data/`、`.runtime/`：本机运行数据和运行时文件。
- `release/` 下的 ZIP 与校验文件：源码归档产物，不是本次审核中心运行所需文件。
- 日志、临时目录中的附件副本、密钥及本地环境配置。

`SOURCE-MANIFEST.json` 是独立源码 ZIP 的清单，不是审核中心运行依赖。若之后要发布新的干净源码 ZIP，再按仓库流程运行 `python scripts/package_source.py`，不要手工拼装或把构建目录混入源码包。

## 本次验证记录

`npm --prefix web run build` 已通过。构建仍提示 `/ai/layout.css` 在构建时缺失，以及主 JS chunk 超过 500 kB。本次只验证 TypeScript 与生产构建；未做浏览器视觉/窄屏验收或真实审核流程验收。


## 2026-11-23 本次同步到 GitHub

直接在已登录的 GitHub 网页账号下将增量改动提交至 `v2.0`，没有修改 `main`。提交包括：App 路由 `72c988e`、侧栏入口 `f51f887`、登录品牌 `88b5930`、README `3a304e2`、进度记录 `7b68b22`。审核中心组件/CSS与浅色、深色 Logo 已在分支，故未重复上传。

保留远程已有的展会、看板和人员功能；未改后端、共享组件或真实审核流程。`npm --prefix web run build` 在本地独立工程通过，远程 `v2.0` 未做完整构建或浏览器验收；构建提示见上方。
