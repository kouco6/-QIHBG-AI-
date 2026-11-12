# 体验工作台（UEI Experience Workbench）

将公司现行 UEI 体验体系（V4.0，散落于 Excel / 邮件 / 微信群）沉淀为**在线、结构化、可追溯、可自动计分**的内部 Web 工作台。

- 单一体验人员角色，每人一号，仅用于操作溯源；首账号额外拥有「系统设置」入口
- 五个阶段 / **13 个工作节点**全程在线跑通
- 体验字典（软件 / 硬件 / 硬件单品 / 交互控件）真实导入
- **20 套评分方案**（4 业务比 × 5 问题比）、**160 个矩阵单元**
- **L1 单产品 / L2 产品线 / L3 事业部** 三层分值并列，**禁止跨层比较**
- 外部集成统一 Provider，默认 **Mock**，不执行真实外部调用

## 一键启动

前置：**Python ≥ 3.11**、**Node.js ≥ 18**（均需在 PATH 中）。

```powershell
pwsh -File .\start.ps1
```

脚本按序执行：环境检查 → 后端虚拟环境与依赖 → 数据库迁移 → 种子校验 → 前端依赖 → 启动前后端。

启动后：

| 服务 | 地址 |
|---|---|
| 前端 | http://127.0.0.1:5173 |
| 后端 API 文档 | http://127.0.0.1:8000/api/docs |
| 健康检查 | http://127.0.0.1:8000/api/health |

常用参数：

```powershell
pwsh -File .\start.ps1 -SkipInstall      # 依赖已就绪，加速启动
pwsh -File .\start.ps1 -BackendOnly      # 仅后端
pwsh -File .\start.ps1 -FrontendOnly     # 仅前端
pwsh -File .\start.ps1 -NoLaunch         # 只初始化与迁移，不启动服务
pwsh -File .\scripts\stop.ps1            # 停止服务
```

## 配置

复制 `.env.example` 为 `.env` 后按需修改。

**安全约定**：密钥只从环境变量读取，**绝不写入数据库**；日志脱敏；未配置外部凭证时 Provider 自动降级为 Mock。

## 目录结构

```text
/
  start.ps1                 # 一键启动
  README.md
  .env.example
  backend/
    app/
      api/                  # REST 路由（/api/v1）
      core/                 # 配置、数据库、统一错误
      domain/               # 状态机与业务规则
      models/               # SQLAlchemy 模型
      schemas/              # Pydantic 契约
      services/             # 业务服务
      providers/            # 外部集成（默认 Mock）
      repositories/         # 仓储层（隔离方言）
      migrations/           # Alembic 迁移
      seeds/                # 种子与源清单
    tests/
    pyproject.toml
  frontend/
    src/
      app/ pages/ components/ features/ services/ styles/
    tests/
    package.json
  scripts/
    import_uei_workbook.py  # 源字典导入
    verify_seed_counts.py   # 种子与计数校验
    benchmark_local.ps1     # 本地性能基准
    stop.ps1
  docs/
    SOURCE_AUDIT.md         # 源资料只读审计
    BEI_THRESHOLD_SOURCE.md # BEI 经验阈值来源（PRD §8.8.6）
    SOURCE_DIFFERENCES.md   # 源口径差异报告
    DATA_DICTIONARY.md      # 数据字典（T06）
    API.md                  # 接口说明（T13）
    OPERATIONS.md           # 运维手册（T15）
    TRACEABILITY.md         # 需求追溯（T15）
  test-results/
```

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | React 18 + TypeScript + Vite，高密度工作台界面 |
| 后端 | FastAPI + Pydantic v2，REST `/api/v1` |
| 数据 | SQLAlchemy 2.0 + Alembic，SQLite（WAL） |
| 部署 | 本地单体，PowerShell 一键启动 |

## 关键约定

- **统一错误形状**：`{code, message, field_errors, request_id}`；401 未登录 / 403 设置越权 / 404 不存在 / 409 状态或版本冲突 / 422 校验失败
- **请求 ID**：贯穿前后端（`X-Request-Id`），错误提示可追溯
- **计算精度**：后端使用 Decimal，展示保留 1 位；快照保存未舍入中间值
- **快照不可变**：追加写，不提供覆盖 / 更新 / 删除
- **业务删除**：使用停用 / 归档；仅未被引用的临时草稿可受控删除
- **分层设计令牌**：前端颜色 / 字号 / 间距统一取自 `frontend/src/styles/tokens.css`，禁止组件内写死色值

## 开发

```powershell
# 后端
cd backend
.\.venv\Scripts\python -m pytest              # 测试
.\.venv\Scripts\python -m alembic upgrade head # 迁移
.\.venv\Scripts\python -m uvicorn app.main:app --reload

# 前端
cd frontend
npm run dev
npm run typecheck
npm test
```

## 基线（冻结，不得改动）

| 对象 | 口径 |
|---|---|
| 工作节点 | 13（N01–N13，四阶段） |
| 评分方案 / 矩阵单元 | 20 / 160 |
| 软件指标 | 一级 1 / 二级 4 / 三级 33 / 检查项 114（连续 1–114） |
| 硬件指标三级 | 15 |
| 硬件单品维度 / 数据行 | 56 / 224（物理 226 行） |
| 交互控件（软件） | 46 组件（细则数以源表实测为准，见 `docs/SOURCE_DIFFERENCES.md` D-01） |
| 回归样例 | 会议一体机 V7.32：核心 55.2 + 非核心 5.4 = 60.6 → **UEI 39.4** |
| 默认方案 | `8:2 / 7:5:3:1` |
| BEI 维度权重 | D1 20% / D2 25% / D3 20% / D4 20% / D5 15% |
| 人工印象分上限 | 20%（其余 ≥80% 来自系统数据） |

## 许可与范围

内部使用。所有外部集成在本期均以 Mock 运行；系统不得自行发起真实外部调用、发布或不可逆操作。
