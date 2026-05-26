"""Result summarization, plotting, and artifact saving for Bayesian runs."""

from __future__ import annotations

import base64
import csv
import io
import json
from pathlib import Path

from .labels import scientific_label


def build_and_save_results(
    *,
    job_id,
    payload,
    idata,
    ppc_obs,
    x,
    y,
    unit,
    nucleus,
    result_dir,
    log,
    az,
    np,
):
    """Create GUI result payload and save all run artifacts to disk."""
    config = payload.get("config", {})
    design = payload.get("design", {})

    log("Computing posterior summary table...")
    posterior_items = posterior_arrays(idata, np)
    posterior_names = [name for name, _ in posterior_items]
    log(f"Posterior variables available: {', '.join(posterior_names) if posterior_names else 'none'}.")

    summary_rows = summarize_posteriors(posterior_items, az, np)
    log(f"Posterior summary table ready: {len(summary_rows):,} parameter row(s).")

    run_dir = make_run_dir(job_id, nucleus, result_dir)
    plots_dir = run_dir / "plots"
    data_dir = run_dir / "data"
    plots_dir.mkdir(parents=True, exist_ok=True)
    data_dir.mkdir(parents=True, exist_ok=True)
    log(f"Saving all run results under: {run_dir}")

    saved_files = {}
    saved_files["payload_json"] = str(write_json(data_dir / "run_payload.json", payload))
    saved_files["config_json"] = str(write_json(data_dir / "config.json", config))
    saved_files["design_json"] = str(write_json(data_dir / "design.json", design))
    saved_files["summary_json"] = str(write_json(data_dir / "posterior_summary.json", summary_rows))
    saved_files["posterior_variables_json"] = str(write_json(data_dir / "posterior_variables.json", posterior_names))
    saved_files["posterior_labels_json"] = str(
        write_json(data_dir / "posterior_labels.json", {name: scientific_label(name) for name in posterior_names})
    )
    saved_files["fit_data_csv"] = str(write_fit_data_csv(data_dir / "fit_data.csv", x, y, payload.get("fit_rows", [])))

    summary_csv_path = data_dir / "posterior_summary.csv"
    write_summary_csv(summary_csv_path, summary_rows)
    saved_files["summary_csv"] = str(summary_csv_path)

    nc_path = save_inference_data(
        idata=idata,
        ppc_obs=ppc_obs,
        az=az,
        np=np,
        nc_path=run_dir / "inference_data.nc",
        log=log,
    )
    if nc_path is not None:
        saved_files["inference_data_nc"] = str(nc_path)

    if ppc_obs is not None and np.size(ppc_obs):
        ppc_npz_path = data_dir / "posterior_predictive_samples.npz"
        np.savez_compressed(ppc_npz_path, obs=np.asarray(ppc_obs))
        saved_files["posterior_predictive_npz"] = str(ppc_npz_path)

    result_point_indices = spaced_indices(len(x), 2500, np)
    plots = make_and_save_plots(
        posterior_items=posterior_items,
        design=design,
        ppc_obs=ppc_obs,
        x=x,
        y=y,
        unit=unit,
        nucleus=nucleus,
        result_point_indices=result_point_indices,
        plots_dir=plots_dir,
        log=log,
        np=np,
    )
    saved_files.update({f"plot_{name}_png": info["path"] for name, info in plots.items() if info.get("path")})

    result_payload = {
        "unit": unit,
        "x": x[result_point_indices].tolist(),
        "y": y[result_point_indices].tolist(),
        "mu_mean": [],
        "summary": summary_rows,
        "posterior_variables": posterior_names,
        "inference_data_path": str(nc_path) if nc_path is not None else None,
        "result_dir": str(run_dir),
        "saved_files": saved_files,
        "plots": {name: info["data_url"] for name, info in plots.items() if info.get("data_url")},
    }

    saved_files["gui_result_json"] = str(write_json(data_dir / "gui_result.json", result_payload))
    log(f"Saved {len(saved_files):,} result artifact(s).")
    return result_payload


def make_run_dir(job_id, nucleus, result_dir):
    base = Path(result_dir or Path.cwd() / "bayesian_results").resolve()
    safe_nucleus = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in str(nucleus)).strip("_") or "nucleus"
    return base / f"{safe_nucleus}_{job_id}"


def posterior_arrays(idata, np):
    items = []
    for var_name in idata.posterior.data_vars:
        if var_name in {"mu"}:
            continue
        arr = np.asarray(idata.posterior[var_name].values)
        if arr.ndim == 2:
            items.append((var_name, arr.reshape(-1)))
        else:
            for idx in np.ndindex(arr.shape[2:]):
                vals = arr[(slice(None), slice(None), *idx)].reshape(-1)
                label = f"{var_name}[{','.join(map(str, idx))}]"
                items.append((label, vals))
    add_neutron_branch_sum(items, np)
    return items


def add_neutron_branch_sum(items, np):
    branch_arrays = []
    for name, vals in items:
        if not name.startswith("b_") or not name.endswith("n"):
            continue
        neutron_count = name[2:-1]
        if not neutron_count.isdigit() or int(neutron_count) <= 0:
            continue
        branch_arrays.append(np.asarray(vals))

    if not branch_arrays:
        return

    min_len = min(arr.size for arr in branch_arrays)
    if min_len == 0:
        return
    neutron_sum = np.sum([arr[:min_len] for arr in branch_arrays], axis=0)
    items.append(("b_neutron_sum", neutron_sum.reshape(-1)))


def summarize_posteriors(posterior_items, az, np):
    summary_rows = []
    for name, vals in posterior_items:
        vals = vals[np.isfinite(vals)]
        if vals.size == 0:
            continue
        try:
            hdi = az.hdi(vals, hdi_prob=0.68)
            hdi_low = float(hdi[0])
            hdi_high = float(hdi[1])
        except Exception:
            hdi_low = float(np.quantile(vals, 0.16))
            hdi_high = float(np.quantile(vals, 0.84))
        summary_rows.append(
            {
                "variable": name,
                "parameter": scientific_label(name),
                "mean": float(np.mean(vals)),
                "std": float(np.std(vals, ddof=1)),
                "median": float(np.median(vals)),
                "hdi_16%": hdi_low,
                "hdi_84%": hdi_high,
            }
        )
    return summary_rows


def save_inference_data(*, idata, ppc_obs, az, np, nc_path, log):
    try:
        log("Saving InferenceData NetCDF file...")
        idata_to_save = idata.copy()
        if ppc_obs is not None and np.size(ppc_obs):
            try:
                ppc_idata = az.from_dict(posterior_predictive={"obs": np.asarray(ppc_obs)})
                idata_to_save.add_groups(posterior_predictive=ppc_idata.posterior_predictive)
                log("Attached posterior predictive samples to saved InferenceData.")
            except Exception as ppc_save_exc:
                log(f"Saved InferenceData will not include PPC samples: {ppc_save_exc}")
        idata_to_save.to_netcdf(nc_path)
        log(f"Saved InferenceData NetCDF: {nc_path}")
        return nc_path
    except Exception as save_exc:
        log(f"InferenceData NetCDF save failed: {save_exc}")
        return None


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, ensure_ascii=False)
    return path


def write_summary_csv(path, summary_rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    cols = ["variable", "parameter", "mean", "std", "median", "hdi_16%", "hdi_84%"]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=cols)
        writer.writeheader()
        for row in summary_rows:
            writer.writerow(row)


def write_fit_data_csv(path, x, y, fit_rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        cols = ["BinCenter", "BinWidth", "BinContent"]
        writer = csv.DictWriter(handle, fieldnames=cols)
        writer.writeheader()
        if fit_rows:
            for row in fit_rows:
                writer.writerow({col: row.get(col, "") for col in cols})
        else:
            for center, content in zip(x, y):
                writer.writerow({"BinCenter": float(center), "BinWidth": "", "BinContent": float(content)})
    return path


def spaced_indices(n, max_n, np):
    if n <= max_n:
        return np.arange(n, dtype=int)
    return np.unique(np.linspace(0, n - 1, max_n, dtype=int))


def sampled_finite(vals, np, max_n=5000):
    vals = vals[np.isfinite(vals)]
    if vals.size > max_n:
        rng = np.random.default_rng(12345)
        vals = vals[rng.choice(vals.size, size=max_n, replace=False)]
    return vals


def fig_to_data_url(fig):
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=110, bbox_inches="tight")
    encoded = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def save_fig_and_encode(fig, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, format="png", dpi=220, bbox_inches="tight")
    return {"path": str(path), "data_url": fig_to_data_url(fig)}


def default_plot_items(posterior_items, max_vars):
    def priority(item):
        name = item[0]
        if name.startswith("b_") and not name.startswith("bkg"):
            return 0
        if name in {"A0", "T_parent"}:
            return 1
        if name.startswith("bgd_"):
            return 2
        if name.startswith("T_"):
            return 3
        return 4

    return sorted(posterior_items, key=priority)[:max_vars]


def plot_items_from_selection(
    *,
    requested,
    purpose,
    default_max,
    posterior_items,
    item_by_name,
    log,
    np,
    selected_max=None,
    dynamic_only=False,
):
    if isinstance(requested, list):
        if len(requested) == 0:
            log(f"{purpose} plot skipped: no posterior variables selected.")
            return []
        items = []
        missing = []
        for name in requested:
            if name in item_by_name:
                items.append(item_by_name[name])
            else:
                missing.append(name)
        for name in missing:
            log(f"{purpose} plot: requested posterior variable not found: {name}")
    else:
        items = default_plot_items(posterior_items, default_max)

    if dynamic_only:
        dynamic_items = []
        for name, vals in items:
            vals = vals[np.isfinite(vals)]
            if vals.size == 0:
                continue
            if float(np.std(vals)) < 1e-10:
                log(f"[corner] Skipping {name} (no dynamic range).")
                continue
            dynamic_items.append((name, vals))
        items = dynamic_items

    if selected_max is not None and len(items) > selected_max:
        log(f"{purpose} plot: using first {selected_max} selected variables out of {len(items)}.")
        items = items[:selected_max]
    if items:
        log(f"{purpose} plot variables: {', '.join(scientific_label(name) for name, _ in items)}.")
    return items


def make_and_save_plots(*, posterior_items, design, ppc_obs, x, y, unit, nucleus, result_point_indices, plots_dir, log, np):
    plots = {}
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        item_by_name = {name: (name, vals) for name, vals in posterior_items}
        plot_variable_selection = design.get("plot_variables", {}) if isinstance(design.get("plot_variables", {}), dict) else {}

        log("Generating posterior distribution plot...")
        plot_items = plot_items_from_selection(
            requested=plot_variable_selection.get("distributions"),
            purpose="Posterior distribution",
            default_max=8,
            selected_max=24,
            posterior_items=posterior_items,
            item_by_name=item_by_name,
            log=log,
            np=np,
        )
        if plot_items:
            n = len(plot_items)
            cols = min(3, n)
            rows_n = int(np.ceil(n / cols))
            fig, axes = plt.subplots(rows_n, cols, figsize=(4 * cols, 2.8 * rows_n))
            axes = np.asarray(axes).reshape(-1)
            for ax, (name, vals) in zip(axes, plot_items):
                vals = sampled_finite(vals, np)
                ax.hist(vals, bins=40, color="#5f86b8", alpha=0.85)
                if vals.size:
                    q16, q50, q84 = np.percentile(vals, [16, 50, 84])
                    ax.axvline(q50, color="#bd3d32", linewidth=1.6, label="median")
                    ax.axvline(q16, color="#2f7d68", linestyle="--", linewidth=1.2, label="68% interval")
                    ax.axvline(q84, color="#2f7d68", linestyle="--", linewidth=1.2)
                    ax.legend(fontsize=7, frameon=False)
                ax.set_title(scientific_label(name))
                ax.set_ylabel("draws")
                ax.grid(alpha=0.25)
            for ax in axes[len(plot_items):]:
                ax.axis("off")
            fig.suptitle("Posterior distributions")
            plots["distributions"] = save_fig_and_encode(fig, plots_dir / "posterior_distributions.png")
            plt.close(fig)
            log("Posterior distribution plot ready.")
        else:
            log("Posterior distribution plot skipped: no scalar posterior variables found.")

        log("Generating corner plot...")
        corner_items = plot_items_from_selection(
            requested=plot_variable_selection.get("corner"),
            purpose="Corner",
            default_max=6,
            selected_max=10,
            dynamic_only=True,
            posterior_items=posterior_items,
            item_by_name=item_by_name,
            log=log,
            np=np,
        )
        if len(corner_items) >= 2:
            names = [scientific_label(name) for name, _ in corner_items]
            values = [vals[np.isfinite(vals)] for _, vals in corner_items]
            min_len = min(len(vals) for vals in values)
            if min_len > 0:
                rng = np.random.default_rng(12345)
                take = min(min_len, 2500)
                idx = rng.choice(min_len, size=take, replace=False) if min_len > take else np.arange(min_len)
                values = [vals[:min_len][idx] for vals in values]
                samples = np.column_stack(values)
                try:
                    import corner

                    fig = corner.corner(
                        samples,
                        labels=names,
                        show_titles=True,
                        quantiles=[0.16, 0.5, 0.84],
                        title_fmt=".3g",
                    )
                except Exception as corner_exc:
                    log(f"corner package unavailable or failed; using built-in corner plot. Details: {corner_exc}")
                    n = len(values)
                    fig, axes = plt.subplots(n, n, figsize=(2.2 * n, 2.2 * n))
                    for i in range(n):
                        for j in range(n):
                            ax = axes[i, j]
                            if i == j:
                                ax.hist(values[i], bins=30, color="#5f86b8", alpha=0.85)
                                q16, q50, q84 = np.percentile(values[i], [16, 50, 84])
                                ax.axvline(q50, color="#bd3d32", linewidth=1.2)
                                ax.axvline(q16, color="#2f7d68", linestyle="--", linewidth=1.0)
                                ax.axvline(q84, color="#2f7d68", linestyle="--", linewidth=1.0)
                            elif i > j:
                                ax.scatter(values[j], values[i], s=3, alpha=0.18, color="#243b55")
                            else:
                                ax.axis("off")
                            if i == n - 1:
                                ax.set_xlabel(names[j], fontsize=8)
                            else:
                                ax.set_xticklabels([])
                            if j == 0 and i > 0:
                                ax.set_ylabel(names[i], fontsize=8)
                            elif j != 0:
                                ax.set_yticklabels([])
                    fig.suptitle("Corner plot")
                plots["corner"] = save_fig_and_encode(fig, plots_dir / "corner_plot.png")
                plt.close(fig)
                log("Corner plot ready.")
        else:
            log("Corner plot skipped: fewer than two posterior variables found.")

        log("Generating posterior predictive check plot...")
        if ppc_obs is not None and np.size(ppc_obs):
            ppc = np.asarray(ppc_obs)
            ppc = ppc.reshape(-1, ppc.shape[-1])
            draw_idx = spaced_indices(ppc.shape[0], 800, np)
            point_idx = result_point_indices
            ppc = ppc[draw_idx][:, point_idx]
            ppc_mean = np.mean(ppc, axis=0)
            ppc_low = np.percentile(ppc, 16, axis=0)
            ppc_high = np.percentile(ppc, 84, axis=0)
            x_plot = x[point_idx]
            y_plot = y[point_idx]
            fig, ax = plt.subplots(figsize=(8, 5))
            ax.step(x_plot, y_plot, where="mid", label="Observed", linewidth=1.4, color="#243b55")
            ax.plot(x_plot, ppc_mean, label="PPC mean", color="#bd3d32")
            ax.fill_between(x_plot, ppc_low, ppc_high, alpha=0.25, label="68% PPC band", color="#bd3d32")
            ax.set_xlabel(f"Decay Time ({unit})")
            ax.set_ylabel("Counts")
            ax.set_title(f"{nucleus} PPC")
            ax.grid(alpha=0.3)
            ax.legend()
            fig.tight_layout()
            plots["ppc"] = save_fig_and_encode(fig, plots_dir / "posterior_predictive_check.png")
            plt.close(fig)
            log(f"Posterior predictive check plot ready with {len(point_idx):,} display point(s).")
        else:
            log("Posterior predictive check plot skipped: PPC samples were not available.")
    except Exception as plot_exc:
        log(f"Plot generation failed: {plot_exc}")
    return plots
