# 隔离开发、构建与启动

`modules/` 是开发源码，`portal/` 是公共入口；`scripts/adapt_sources.py` 应用现有集成转换。隔离运行产物生成于 `data-dev/dev-001/builds/<编号>/runtime/`，不要手工修改或提交。

验证平台：macOS arm64、Python 3.12、Node.js 22.18。Python 锁文件限定此平台；Windows/Linux 未验证。另需可执行的 Codex CLI，仅用于本地版本和健康检查，不需要复制账号配置。

先准备公共包缓存。以下网络下载步骤是供新机器使用的准备方式，本轮未验证新机器下载：

```sh
python3.12 -m pip download --only-binary=:all: --require-hashes \
  -r config/dev-python-macos-arm64.lock --dest "$dev_wheelhouse"
# 在新的空目录中放入 frontend/package.json 和 package-lock.json，再执行：
npm ci --ignore-scripts --no-audit --no-fund --cache "$dev_npm_cache"
```

将 `dev_node`、`dev_codex` 设为本机公开可执行文件，将包目录变量设为上述缓存。回到 Git 仓库根目录：

```sh
python3.12 scripts/dev_environment.py --workspace "$PWD" install \
  --node "$dev_node" --codex "$dev_codex" \
  --wheelhouse "$dev_wheelhouse" --npm-cache "$dev_npm_cache"
# 把输出的 dependency_dir、build_dir 分别填入下两条命令。
python3.12 scripts/dev_environment.py --workspace "$PWD" build --deps "$dev_dependency_dir"
python3.12 scripts/dev_environment.py --workspace "$PWD" start --build "$dev_build_dir" --open
```

每次修改源码后重新 build，再启动新产物。构建只读取 Git 纳管路径，新增源码先经敏感检查再暂存。启动在回环地址的新空闲端口运行，每次建立新合成账号和测试数据库；Provider 为 Mock。Ctrl-C 停止此实例。不要复制真实数据库、用户目录、登录资料或凭证。

必要基础检查：`python3.12 -B scripts/test_dev_environment.py`、`python3.12 -B scripts/test_sidebar_contract.py`；前端在独立依赖环境按改动运行 typecheck / 单元测试。不要自动运行旧截图、逐页验收或真实模型任务。

原生产准备与打包脚本依赖旧原包/私有身份文件，不能替代本开发流程。完整生产安装与数据迁移需单独设计和确认。最终业务验收由用户人工完成，未关闭事项见 [RISKS.md](RISKS.md)。
