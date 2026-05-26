#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .venv/bin/activate ]; then
  . .venv/bin/activate
fi
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m pip install -e .
python scripts/check_dependencies.py
python -m PyInstaller --clean --noconfirm full_software_gui_app.spec
echo "Compiled app is in dist/full-software-gui"
