PYTHON ?= python3
VENV ?= .venv
VENV_PY := $(VENV)/bin/python

.PHONY: install run compile compiler clean

$(VENV_PY):
	$(PYTHON) -m venv $(VENV)

install: $(VENV_PY)
	$(VENV_PY) -m pip install --upgrade pip
	$(VENV_PY) -m pip install -r requirements.txt
	$(VENV_PY) -m pip install -e .

run: $(VENV_PY)
	PYTHONPATH=src $(VENV_PY) -m full_software_gui_app

compile: $(VENV_PY)
	$(VENV_PY) -m pip install --upgrade pip
	$(VENV_PY) -m pip install -r requirements.txt
	$(VENV_PY) -m pip install -e .
	$(VENV_PY) scripts/check_dependencies.py
	$(VENV_PY) -m PyInstaller --clean --noconfirm full_software_gui_app.spec

compiler: compile

clean:
	$(VENV_PY) -c "import shutil, pathlib; [shutil.rmtree(p, ignore_errors=True) for p in ['build', 'dist']]; [p.unlink() for p in pathlib.Path('.').glob('*.spec.bak') if p.exists()]"
