# Bayesian Inference for Beta-Decay Half-Lives

This repository contains a standalone GUI for designing and running Bayesian
beta-decay half-life analyses. The GUI prepares the decay chain, rebins and
previews histogram data, builds the PyMC model design, runs the Bayesian
sampler, saves result artifacts, and can export a standalone Python script for
the designed model.

The original notebook/source files outside this package are not required to run
the standalone GUI.

## Repository Layout

- `data/nndc_nudat_data_export.csv` is the included literature decay-data source.
- `src/full_software_gui_app/server.py` starts the local GUI server and API.
- `src/full_software_gui_app/bayesian_runner.py` builds and runs the PyMC model.
- `src/full_software_gui_app/results.py` saves posterior summaries, plots, data,
  and NetCDF InferenceData output.
- `src/full_software_gui_app/bateman.py` contains the PyMC Bateman equations.
- `src/full_software_gui_app/assets/` contains the GUI HTML, CSS, and JavaScript.
- `scripts/` contains install, run, and compile helpers.
- `Makefile` provides Linux/WSL/macOS targets for install, run, compile, and clean.

## Literature Decay Data

The included file

```text
data/nndc_nudat_data_export.csv
```

is the literature input table used by the GUI to look up parent, daughter, and
granddaughter states. It was exported from NNDC/NuDat3 decay information.

You can replace this file with a different literature source, but the CSV must
keep the same column names and meanings. The GUI does not require the filename
to be identical because the file is selected manually, but the structure must
match.

Required columns:

```text
z
n
name
levelEnergy(MeV)
halflife
halflifeUnit
halflifeUncertainty
decayMode
branchingRatio
branchingRatioUncertainty
```

Column meanings:

- `z`: proton number of the nucleus.
- `n`: neutron number of the nucleus.
- `name`: nucleus name, for example `72Co`.
- `levelEnergy(MeV)`: state or isomer level energy in MeV.
- `halflife`: half-life value for that state.
- `halflifeUnit`: half-life unit. Supported GUI units include `ns`, `us`, `ms`,
  `s`, `m`, `h`, `d`, and `y`.
- `halflifeUncertainty`: uncertainty on the half-life in the same unit as
  `halflifeUnit`.
- `decayMode`: decay mode, for example beta-minus, beta-minus delayed neutron,
  beta-minus delayed 2-neutron, etc. The GUI normalizes common beta-minus text
  encodings.
- `branchingRatio`: branching ratio in percent, not fraction. For example,
  enter `25` for 25 percent.
- `branchingRatioUncertainty`: uncertainty on the branching ratio in percent.

Each nucleus can appear in multiple rows because each row represents one decay
mode or branch for a particular state. If a nucleus has multiple states/isomers,
the GUI asks which state to use.

## Histogram Data

The histogram CSV is the experimental time-correlation histogram. It is loaded
separately from the literature decay-data file.

Required histogram columns:

```text
BinCenter
BinContent
```

Optional histogram column:

```text
BinWidth
```

Column meanings:

- `BinCenter`: center of each time bin. Use the same time unit you select in the
  GUI, for example milliseconds if the GUI output unit is `ms`.
- `BinContent`: observed counts in that bin.
- `BinWidth`: width of the original bin. If this column is absent or blank, the
  GUI infers the original bin spacing from adjacent `BinCenter` values.

The histogram should include the full time range needed for the analysis. If you
want to estimate background from reverse correlation, include negative-time bins
and set the reverse-background range in the Bayesian design controls. The fit
range should usually be positive time bins.

The GUI rebins the loaded histogram using the selected bin width. The plotted
histogram is shown after rebinning, and the fit rows are selected from the
rebinned histogram.

## Fresh Clone Quick Start

First clone the repository and enter the project directory:

```bash
git clone https://github.com/tawfikgaballah/Bayesian-Inference-for--Decay-Half-Lives.git
cd Bayesian-Inference-for--Decay-Half-Lives
```

The repository root is the standalone GUI package. The commands below should be
run from that directory.

## Install with Helper Scripts

### Linux, WSL, or macOS

```bash
./scripts/install.sh
make run
```

### Windows PowerShell

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
.\scripts\run.ps1
```

The install scripts create a local virtual environment named `.venv`, install
the packages listed in `requirements.txt`, and install this project in editable
mode. 

## Manual Environment Setup

Use these commands if you want to see every step or if the helper script is not
available on your system.

### Linux, WSL, or macOS

Create and activate the virtual environment:

```bash
python3 -m venv .venv
source .venv/bin/activate
```

Upgrade `pip`, install requirements, and install the package in editable mode:

```bash
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m pip install -e .
```

Run the GUI:

```bash
PYTHONPATH=src python -m full_software_gui_app
```

Equivalent Makefile command:

```bash
make run
```

To run with a custom result directory:

```bash
PYTHONPATH=src .venv/bin/python -m full_software_gui_app --results-dir ./my_results
```

### Windows PowerShell

Create and activate the virtual environment:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

If PowerShell blocks activation, use:

```powershell
powershell -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
```

Upgrade `pip`, install requirements, and install the package in editable mode:

```powershell
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m pip install -e .
```

Run the GUI:

```powershell
$env:PYTHONPATH = "src"
python -m full_software_gui_app
```

Equivalent helper command:

```powershell
.\scripts\run.ps1
```

To run with a custom result directory:

```powershell
$env:PYTHONPATH = "src"
.\.venv\Scripts\python.exe -m full_software_gui_app --results-dir .\my_results
```

## Compile a Distributable App Folder

Compiling uses PyInstaller and can take several minutes, especially the first
time because PyMC, PyTensor, ArviZ, Matplotlib, and their data files must be
collected.

### Linux, WSL, or macOS

If you have not installed the environment yet:

```bash
./scripts/install.sh
```

Compile:

```bash
make compile
```

Run the compiled app:

```bash
./dist/full-software-gui/full-software-gui
```

Manual compile command:

```bash
PYTHONPATH=src .venv/bin/python -m PyInstaller --clean --noconfirm full_software_gui_app.spec
```

### Windows PowerShell

If you have not installed the environment yet:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

Compile:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\compile.ps1
```

Run the compiled app:

```powershell
.\dist\full-software-gui\full-software-gui.exe
```

Manual compile command:

```powershell
.\.venv\Scripts\python.exe -m PyInstaller --clean --noconfirm full_software_gui_app.spec
```

The compiled app folder is written to `dist/full-software-gui/`. Build artifacts
under `build/` and `dist/` are ignored by git.

## Basic GUI Workflow

1. Load `data/nndc_nudat_data_export.csv` as the decay/literature CSV.
2. Load your experimental histogram CSV.
3. Enter the parent nucleus name, for example `72Co`.
4. Choose the output time unit.
5. Select daughter neutron branches and optional granddaughter branches.
6. Click `Build decay chain`.
7. Set the bin width, fit range, background model, and reverse-background range.
8. Click `Prepare fit and preview model`.
9. Open the Bayesian design tab and edit priors, branching mode, sampling
   settings, and selected posterior plot variables.
10. Click `Update model from current design`.
11. Run the Bayesian model, or export the JSON/Python model runner.

## Bayesian Model Options

The GUI supports:

- Poisson or normal likelihood.
- Constant, linear, or exponential background.
- Optional background prior estimates from reverse correlation bins.
- Optional A0 estimate from early positive-time fit bins.
- Fixed, Dirichlet, softmax, or normalized raw neutron branching models.
- Fixed or uniform granddaughter branch priors.
- User-selected posterior variables for distribution and corner plots.

For lognormal priors, the GUI accepts natural-space `mu` and `sigma` inputs and
the runner converts them to PyMC log-space parameters.

## Results

Bayesian runs save a full result folder under `bayesian_results/` by default.
Each run folder includes:

- `inference_data.nc`: ArviZ/PyMC InferenceData NetCDF file.
- `data/run_payload.json`: full input payload used for the run.
- `data/config.json`: model configuration.
- `data/design.json`: Bayesian design and priors.
- `data/fit_data.csv`: fit histogram rows.
- `data/posterior_summary.csv` and `.json`.
- `data/posterior_variables.json`.
- `data/posterior_labels.json`.
- posterior predictive samples when available.
- plot PNGs for posterior predictive check, posterior distributions, and corner
  plot.

The posterior summary includes the derived parameter `b_neutron_sum`, defined as
the sum of neutron-emission beta branches (`b_1n + b_2n + ...`) excluding the
zero-neutron beta branch.

## Exported Python Runner

After preparing the fit preview and updating the Bayesian design, the GUI can
export a standalone Python script. The exported script contains the current
model design and fit rows and builds the PyMC model directly.

Run an exported script from this package environment:

```bash
cd Bayesian-Inference-for--Decay-Half-Lives
PYTHONPATH=src .venv/bin/python /path/to/exported_model_runner.py
```

On Windows PowerShell:

```powershell
cd Bayesian-Inference-for--Decay-Half-Lives
$env:PYTHONPATH = "src"
.\.venv\Scripts\python.exe C:\path\to\exported_model_runner.py
```

## Notes

- The GUI opens a local browser page served from your machine. It does not
  require Tkinter.
- Do not commit `.venv`, `build`, `dist`, `bayesian_results`, or local output
  folders. They are ignored by `.gitignore`.
