#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .venv/bin/activate ]; then
  . .venv/bin/activate
fi
export PYTHONPATH="$PWD/src${PYTHONPATH:+:$PYTHONPATH}"
python -m full_software_gui_app "$@"
