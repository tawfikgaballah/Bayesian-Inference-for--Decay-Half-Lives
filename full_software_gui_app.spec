# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

project = Path(SPECPATH)

block_cipher = None

datas = [
    (str(project / "src" / "full_software_gui_app" / "assets"), "full_software_gui_app/assets"),
]
hiddenimports = [
    "arviz",
    "corner",
    "h5netcdf",
    "matplotlib.backends.backend_agg",
    "netCDF4",
    "numpy",
    "pandas",
    "pymc",
    "pytensor",
]

for package in [
    "arviz",
    "arviz_base",
    "arviz_stats",
    "arviz_plots",
    "pymc",
    "pytensor",
]:
    datas += collect_data_files(package)
    hiddenimports += collect_submodules(package)


a = Analysis(
    [str(project / "run_gui.py")],
    pathex=[str(project / "src")],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="full-software-gui",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="full-software-gui",
)
