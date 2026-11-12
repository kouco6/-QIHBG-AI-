# 原版路由与整合路径 · L00-06 / L01

| 模块 | 原入口与健康 | 页面、资源及 API | 原鉴权及业务边界 |
|---|---|---|---|
| BG | `server.py --port 8765`，`GET /api/health` | `/` 内部 UI 状态，`/dimension-assets/*`，`/api/state`、`/api/session`、`/api/workbuddy/round1/*`；维度 iframe 用同源 `postMessage` | 回环 Host 限制；写入检查 Origin、`X-BG-Token` 和 revision。状态库以单条 JSON 聚合，没有员工主体映射 |
| AI 网关 | `node src/server.mjs`，默认 4317，`GET /health` | `/`、`/styles.css`、`/app.js`、`/assets/*`、`/api/*`、`/v1/*`；任务、流程、协作有 SSE，任务协议支持断点续读 | 原控制台 Token 在 sessionStorage；API 校验 Bearer；协作成员 Token 独立。主 Token 和管理操作属于不同于平台账号的权限层 |
| 体验工作台 | Vite 5173 转发 FastAPI 8000；`GET /api/health` | React Router 业务深链，Vite 资源与静态构建，`/api/v1/*`；下载、表单及认证走原 API | 原 `uei_session` HttpOnly Cookie，`Path=/`；后端逐请求查会话，区分首账号。需保留原账号 ID 及审计归属 |

证据入口：BG `server.py` 的 `Handler` 与 `index.html`；AI 网关 `src/server.mjs`、`public/app.js`、`src/workbench/collab/api.mjs`；体验工作台 `frontend/vite.config.ts`、`frontend/src/app/App.tsx`、`frontend/src/services/api.ts`、`backend/app/api/v1/auth.py`。

整合版在同一 localhost 上按 `/bg/`、`/ai/`、`/experience/` 路由，三个后端继续独立。原版存在根相对 URL 和重叠的 `/api/*`，各模块的前端静态资源、业务接口、深链已配置明确前缀。BG 维度 frame 继续同源，入口在改写上游 Origin 前检查平台会话、模块授权和请求来源。AI SSE 采用流式转发。体验前端使用构建时 basename，业务 API 通过原账号 ID 映射识别用户。

平台层账号、会话和业务数据独立。网关主 Token 由入口在服务器端读取，AI 本机所有者和体验原账号的绑定方式见 本地账号与数据说明（原内部参考未随附）。健康接口和实际通过的回归范围见 本地验收记录（原内部参考未随附）。
