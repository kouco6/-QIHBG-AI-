#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if ! command -v node >/dev/null 2>&1; then
    for candidate in "$HOME"/.local/node-*/bin; do
        if [ -x "$candidate/node" ]; then PATH="$candidate:$PATH"; export PATH; break; fi
    done
fi
if [ ! -x .venv/bin/python ]; then
    platform_python="${PLATFORM_PYTHON:-}"
    if [ -z "$platform_python" ]; then
        for candidate in python3.12 python3.13 python3.11 python3 \
            "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3.12"; do
            if "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 11))' >/dev/null 2>&1; then
                platform_python="$candidate"
                break
            fi
        done
    fi
    if [ -z "$platform_python" ]; then
        printf '%s\n' 'Install Python 3.12 or set PLATFORM_PYTHON to its full path.' >&2
        exit 1
    fi
    "$platform_python" -m venv .venv
    .venv/bin/python -m pip install -r config/experience-baseline-requirements.txt
fi
exec .venv/bin/python scripts/platform_local.py start --open
