"""Local HTTP server for the standalone browser GUI."""

from __future__ import annotations

import functools
import json
import os
import threading
import uuid
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import as_file, files
from pathlib import Path
from typing import Any

from .bayesian_runner import run_bayesian_job


class BayesianRequestHandler(SimpleHTTPRequestHandler):
    jobs: dict[str, dict[str, Any]] = {}
    results_dir: str | None = None

    def _send_json(self, payload: Any, code: int = 200) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:
        if self.path.startswith("/api/jobs/") and self.path.endswith("/cancel"):
            job_id = self.path.split("/")[-2]
            job = self.jobs.get(job_id)
            if job is None:
                self._send_json({"error": "Unknown job"}, 404)
                return
            if job.get("status") in {"complete", "error", "canceled"}:
                self._send_json(job)
                return
            job["cancel_requested"] = True
            job["status"] = "canceling"
            job.setdefault("log", []).append("Cancel requested by user.")
            self._send_json(job)
            return

        if self.path != "/api/run-bayesian":
            self._send_json({"error": "Unknown endpoint"}, 404)
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception as exc:
            self._send_json({"error": f"Invalid JSON payload: {exc}"}, 400)
            return

        job_id = str(uuid.uuid4())
        self.jobs[job_id] = {
            "status": "running",
            "log": ["Queued Bayesian model run."],
            "result": None,
            "error": None,
            "cancel_requested": False,
        }
        worker = threading.Thread(
            target=run_bayesian_job,
            args=(job_id, payload, self.jobs[job_id], self.results_dir),
            daemon=True,
        )
        worker.start()
        self._send_json({"job_id": job_id})

    def do_GET(self) -> None:
        if self.path in {"/", ""}:
            self.path = "/index.html"
        if self.path.startswith("/assets/"):
            self.path = self.path[len("/assets"):]
        if self.path.startswith("/api/jobs/"):
            job_id = self.path.rsplit("/", 1)[-1]
            job = self.jobs.get(job_id)
            if job is None:
                self._send_json({"error": "Unknown job"}, 404)
                return
            self._send_json(job)
            return
        super().do_GET()


def default_results_dir() -> str:
    return os.path.abspath(os.path.join(os.getcwd(), "bayesian_results"))


def start_server(
    host: str = "127.0.0.1",
    port: int = 0,
    open_browser: bool = True,
    results_dir: str | None = None,
) -> None:
    asset_ref = files("full_software_gui_app").joinpath("assets")
    with as_file(asset_ref) as asset_dir:
        result_path = os.path.abspath(results_dir or default_results_dir())
        Path(result_path).mkdir(parents=True, exist_ok=True)

        handler_cls = type(
            "StandaloneBayesianRequestHandler",
            (BayesianRequestHandler,),
            {"jobs": {}, "results_dir": result_path},
        )
        handler = functools.partial(handler_cls, directory=str(asset_dir))
        server = ThreadingHTTPServer((host, int(port)), handler)
        actual_host, actual_port = server.server_address
        url = f"http://{actual_host}:{actual_port}/index.html"

        print("Full Software Decay GUI")
        print(f"Serving: {url}")
        print(f"Saving Bayesian results to: {result_path}")
        print("Press Ctrl+C to stop the local server.")

        try:
            if open_browser:
                webbrowser.open(url)
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")
        finally:
            server.server_close()
