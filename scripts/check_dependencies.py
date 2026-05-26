"""Fail fast if the compile environment is missing required packages."""

from __future__ import annotations

import importlib
import sys


REQUIRED_IMPORTS = [
    ("numpy", "numpy"),
    ("pandas", "pandas"),
    ("matplotlib", "matplotlib"),
    ("matplotlib Agg backend", "matplotlib.backends.backend_agg"),
    ("pymc", "pymc"),
    ("pytensor", "pytensor"),
    ("arviz", "arviz"),
    ("corner", "corner"),
    ("h5netcdf", "h5netcdf"),
    ("netCDF4", "netCDF4"),
    ("PyInstaller", "PyInstaller"),
]


def main() -> int:
    missing: list[str] = []
    for label, module_name in REQUIRED_IMPORTS:
        try:
            importlib.import_module(module_name)
        except Exception as exc:
            missing.append(f"{label} ({module_name}): {exc}")

    if missing:
        print("Missing or broken dependencies in this Python environment:")
        for item in missing:
            print(f"  - {item}")
        print("\nRun ./scripts/install.sh, then run make compile again.")
        return 1

    print("Dependency check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
