# Git 日常操作

本公开仓库从已审核的 `7b4898b` 源码快照建立新历史；不要从原本机仓库推送旧分支、标签或备份。

```sh
git clone https://github.com/kouco6/-QIHBG-AI-.git
cd -- -QIHBG-AI-
git config core.hooksPath .githooks
git switch -c codex/my-task       # Cursor 使用 cursor/my-task
git status --short
git diff
# 按改动运行必要基础测试，见 docs/dev-001-operations.md
git add <本次文件>
git diff --cached
git commit -m "说明改动及验证结果"
git push -u origin HEAD
```

合并前检查差异和必要测试，通过 Pull Request 合并。并行开发使用各自分支或独立 clone，不共用数据库、虚拟环境、依赖目录和会话。

已发布改动用 `git revert <提交号>` 撤回，再测试和提交；不对公共分支强制推送。回滚代码不会回滚数据库。真实数据迁移、密钥处理和稳定环境更新需单独确认。

最终业务验收由用户人工完成；不把基础测试通过当作业务验收通过。
