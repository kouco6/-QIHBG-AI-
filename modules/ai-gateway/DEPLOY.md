# 内网部署指南

工作台是**零 npm 依赖**的纯 Node 应用（只用 `node:http` 等内置模块），部署到内网服务器就是「复制目录 + 有 Node」两步。

## 1. 准备目标机器

- Windows / Linux / macOS 均可，装 **Node.js ≥ 18**（`node -v` 确认）
- 无需 `npm install`——项目没有任何第三方依赖

## 2. 复制目录

把整个项目目录拷过去（至少包含）：

```
src/               服务端代码
public/            前端页面
gateway.config.json  运行配置（host/port，不含密钥）
secrets.json       网关访问令牌（不要提交到 git）
agent-secrets.json 各云端员工的 API Key（不要提交到 git）
state/             任务与流程数据（可选，带上可保留历史）
```

> 密钥文件建议只放在服务器上；没有 Key 的员工会显示「未配置密钥」并自动停用。

## 3. 启动

```bash
node src/server.mjs
```

- 默认监听 `127.0.0.1:4317`（仅本机）
- 常驻运行推荐用 PM2 / NSSM / systemd 包一层；Windows 本机日常用桌面图标「AI网关-开关」双击开关即可

## 4. 开放给内网同事

两种方式任选：

**方式 A（推荐）：设置页切换**
打开工作台 → 设置 → 「服务与开关」→ 选「局域网开放（0.0.0.0）」→ 应用。
监听即时生效，配置也会写回 `gateway.config.json`，重启后保持。

**方式 B：改配置文件**
`gateway.config.json` 里 `"host": "0.0.0.0"`，然后重启进程。

然后在服务器防火墙放行端口（Windows 示例）：

```powershell
netsh advfirewall firewall add rule name="WorkBuddy Gateway" dir=in action=allow protocol=TCP localport=4317
```

## 5. 同事怎么访问

- 设置页「服务与开关」会列出内网地址（如 `http://192.168.1.20:4317`）
- 点「复制访问链接」得到 **带密钥的链接**（`http://<ip>:4317/?token=...`），发给同事
- 同事浏览器打开即进入工作台，token 自动落会话，地址栏会自动清掉，不需要手输

> 安全说明：令牌是唯一门槛，请勿把带 token 的链接发到公网或大群。轮换令牌用 `scripts/rotate-token.ps1`。

## 6. 数据在哪

| 内容 | 位置 |
|---|---|
| 任务历史 / 事件流 | `state/`（`gateway.config.json` 可改路径） |
| 流程模板与运行实例 | `state/flows.json` |
| 任务产出文件 | 各任务运行目录（产出库页可跳转） |

## 7. 常见问题

- **端口被占用**：设置页改端口再应用，或改 `gateway.config.json` 的 `port`
- **同事打开 401**：链接里没带 token——重新「复制访问链接」
- **切换局域网后自己打不开**：确认用的是列表里的内网地址或本机 `127.0.0.1`，`0.0.0.0` 只是监听地址不是访问地址
