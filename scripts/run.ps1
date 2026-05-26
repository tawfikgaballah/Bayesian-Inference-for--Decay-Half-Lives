$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$python = ".\.venv\Scripts\python.exe"
if (-not (Test-Path $python)) { $python = "python" }
$src = (Resolve-Path "src").Path
if ($env:PYTHONPATH) { $env:PYTHONPATH = "$src;$env:PYTHONPATH" } else { $env:PYTHONPATH = $src }
& $python -m full_software_gui_app @args
