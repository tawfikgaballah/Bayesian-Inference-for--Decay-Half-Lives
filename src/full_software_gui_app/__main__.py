"""Command-line entry point for the standalone GUI."""

from __future__ import annotations

import argparse

from full_software_gui_app.server import start_server


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Full Software decay-analysis GUI.")
    parser.add_argument("--host", default="127.0.0.1", help="Host interface for the local server.")
    parser.add_argument("--port", type=int, default=0, help="Port for the local server. Use 0 for an available port.")
    parser.add_argument("--no-browser", action="store_true", help="Do not automatically open a browser window.")
    parser.add_argument("--results-dir", default=None, help="Directory for NetCDF InferenceData output.")
    args = parser.parse_args()
    start_server(
        host=args.host,
        port=args.port,
        open_browser=not args.no_browser,
        results_dir=args.results_dir,
    )


if __name__ == "__main__":
    main()
