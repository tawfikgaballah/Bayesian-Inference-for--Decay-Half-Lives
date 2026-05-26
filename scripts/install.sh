#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -d .venv ] && [ ! -f .venv/bin/activate ]; then
  echo "Removing incompatible .venv. A Linux/WSL virtual environment needs .venv/bin/activate."
  rm -rf .venv
fi

python3 -m venv .venv
if [ ! -f .venv/bin/activate ]; then
  echo "Could not create a Linux/WSL virtual environment at .venv."
  echo "Install python3-venv, then rerun this script."
  echo "For Ubuntu/WSL: sudo apt install python3-venv"
  exit 1
fi

. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m pip install -e .
echo "Installed. Run: make run"
