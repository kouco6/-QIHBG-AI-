#!/bin/zsh
set -e
cd "$(dirname "$0")"
python3.12 scripts/build.py
python3.12 scripts/run.py
