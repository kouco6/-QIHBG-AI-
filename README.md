# 企划设计BG平台（三合一）

纯净源码交付，业务代码基于本地 `ad2ec77`。`modules/` 为三个模块，`portal/` 为公共入口，`config/` 为依赖锁和无密钥配置示例，`scripts/` 为集成、构建及隔离启动所需源码。每次全新启动会准备本地账号 `bg`，可进入三个模块。

保留界面图片、维度模板、初始化规则、数据库迁移和运行时 Skill；不包含真实数据库、凭证、用户文件、依赖目录、构建结果、独立测试目录、开发规则或方案报告。开发资料保存在本地开发仓库。

开发环境：macOS arm64、Python 3.12、Node.js 22.18；使用公开 Codex CLI 和公共依赖缓存。安装、构建及启动：

```sh
python3.12 scripts/dev_environment.py install --node "$dev_node" --codex "$dev_codex" --wheelhouse "$dev_wheelhouse" --npm-cache "$dev_npm_cache"
python3.12 scripts/dev_environment.py build --deps "$dev_dependency_dir"
python3.12 scripts/dev_environment.py start --build "$dev_build_dir" --open
```

将两次输出中的 dependency_dir、build_dir 分别用于后续命令。ZIP 解压使用时先在解压目录执行 `git init` 和 `git add .`；构建按 Git 纳管路径读取源码。

启动建立全新合成数据并使用 Mock，不接入现用数据或真实模型。生产账号初始化、正式报告兼容和完整构建字节一致性仍待处理；最终业务验收由用户人工完成。当前交付范围为开发源码。
