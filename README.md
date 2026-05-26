# Full Software Decay GUI Standalone Package

This folder is a standalone, package-style version of the GUI. The original `full_software_gui.py` and `full_software_gui.html` files in the parent folder are not modified.

## Layout

- `src/full_software_gui_app/server.py` starts the local browser GUI server and exposes the API endpoints.
- `src/full_software_gui_app/bayesian_runner.py` builds/runs the PyMC model.
- `src/full_software_gui_app/results.py` creates summaries/plots and saves all result artifacts.
- `src/full_software_gui_app/bateman.py` contains the PyMC Bateman equations.
- `src/full_software_gui_app/assets/index.html` is the GUI shell.
- `src/full_software_gui_app/assets/css/app.css` contains the UI styles.
- `src/full_software_gui_app/assets/js/app.js` contains the browser-side GUI logic.
- `scripts/` contains install, run, and compile helpers.
- `Makefile` provides `install`, `run`, `compile`, and `clean` targets.

## Linux / WSL / macOS

```bash
cd standalone_decay_gui
./scripts/install.sh
make run
```

If the editable package install was interrupted, `make run` still uses `PYTHONPATH=src` so the local package can be found.
The `Makefile` is for Linux/WSL/macOS and uses `.venv/bin/python`. On Windows, use the PowerShell scripts below.

To compile a distributable app folder with PyInstaller:

```bash
make compile
./dist/full-software-gui/full-software-gui
```

## Windows PowerShell

```powershell
cd standalone_decay_gui
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
.\scripts\run.ps1
```

To compile:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\compile.ps1
.\dist\full-software-gui\full-software-gui.exe
```

## Notes

- Bayesian runs save a full result folder under `bayesian_results/` by default.
- Each result folder includes the `.nc` InferenceData file, posterior summary CSV/JSON, fit data CSV, run payload/config/design JSON, plot PNGs, GUI result JSON, and posterior predictive samples when available.
- The GUI can export a standalone Python runner script after the fit preview and Bayesian design are ready. Run the exported script from this package environment with `PYTHONPATH=src .venv/bin/python /path/to/exported_script.py`.
- Results include the derived posterior `b_neutron_sum`, which is `b1n + b2n + ...` and excludes `b0n`.
- You can change the output directory with `--results-dir`:

```bash
PYTHONPATH=src .venv/bin/python -m full_software_gui_app --results-dir ./my_results
```

- The GUI opens a local browser page. It does not require Tkinter.
- PyMC and PyInstaller can take a while to install and compile, especially the first time.
