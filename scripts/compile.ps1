$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$python = ".\.venv\Scripts\python.exe"
if (-not (Test-Path $python)) { $python = "python" }
& $python -m pip install --upgrade pip
& $python -m pip install -r requirements.txt
& $python -m pip install -e .
& $python scripts/check_dependencies.py
& $python -m PyInstaller --clean --noconfirm full_software_gui_app.spec
Write-Host "Compiled app is in dist\full-software-gui"
