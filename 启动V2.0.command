#!/bin/zsh
cd "$(dirname "$0")"

PY="$(command -v python3.12 || true)"
if [ -z "$PY" ]; then
  echo "没有找到 python3.12 命令，请先安装 Python 3.12 或更新版本（推荐 python.org 官方安装包），再双击本文件。"
  echo "按回车键关闭窗口…"; read -r _
  exit 1
fi
if ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)'; then
  echo "当前 python3.12 版本过低，需要 Python 3.12+：$("$PY" --version 2>&1)"
  echo "按回车键关闭窗口…"; read -r _
  exit 1
fi

echo "使用 $("$PY" --version 2>&1)"
"$PY" -B scripts/launch.py
STATUS=$?
echo ""
if [ "$STATUS" -ne 0 ]; then
  echo "启动未完成，请查看上方报错。"
  echo "按回车键关闭窗口…"; read -r _
fi
exit "$STATUS"
