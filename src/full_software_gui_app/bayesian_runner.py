"""Bayesian model runner for the standalone browser GUI."""

import threading
import time
import traceback

from .bateman import daughter_mod, granddaughter_mod, int_exp, parent_mod
from .results import build_and_save_results


def run_bayesian_job(job_id, payload, job, result_dir=None):
    job_started = time.monotonic()

    def log(message):
        elapsed = time.monotonic() - job_started
        job["log"].append(f"{elapsed:7.1f}s  {message}")

    def heartbeat(label, interval=15.0):
        state = {"running": True, "started": time.monotonic()}

        def beat():
            while state["running"]:
                time.sleep(interval)
                if state["running"]:
                    elapsed = time.monotonic() - state["started"]
                    log(f"{label} still running ({elapsed:.1f}s elapsed).")

        thread = threading.Thread(target=beat, daemon=True)
        thread.start()

        def stop():
            state["running"] = False

        return stop

    try:
        log("Importing Bayesian libraries...")
        import arviz as az
        import inspect
        import numpy as np
        import pymc as pm
        import pytensor.tensor as pt

        config = payload["config"]
        rows = payload["fit_rows"]
        design = payload.get("design", {})
        unit = config.get("output_unit", "unit")
        nucleus = config.get("parent_nucleus", "Nucleus")

        x = np.array([float(r["BinCenter"]) for r in rows], dtype=float)
        binw = np.array([float(r["BinWidth"]) for r in rows], dtype=float)
        y = np.array([float(r["BinContent"]) for r in rows], dtype=float)
        if len(x) == 0:
            raise ValueError("No fit rows were sent to the Bayesian runner.")
        log(
            "Loaded fit data: "
            f"{len(x):,} bins, "
            f"time {float(np.min(x)):.6g} to {float(np.max(x)):.6g} {unit}, "
            f"total counts {float(np.sum(y)):.6g}."
        )

        def make_prior(name, spec, positive=False):
            dist = str(spec.get("dist", "normal")).lower()
            if dist == "fixed":
                value = pt.as_tensor_variable(float(spec.get("value", spec.get("mu", 1.0))))
                return pm.Deterministic(name, value)
            if dist == "normal":
                rv = pm.Normal(
                    name,
                    mu=float(spec.get("mu", 1.0)),
                    sigma=max(float(spec.get("sigma", 1.0)), 1e-12),
                )
            elif dist == "uniform":
                rv = pm.Uniform(
                    name,
                    lower=float(spec.get("lower", 0.0)),
                    upper=float(spec.get("upper", 1.0)),
                )
            elif dist == "halfnormal":
                rv = pm.HalfNormal(
                    name,
                    sigma=max(float(spec.get("sigma", 1.0)), 1e-12),
                )
            elif dist == "lognormal":
                scale = str(spec.get("scale", "natural")).lower()
                if scale == "log":
                    log_mu = float(spec.get("mu", 0.0))
                    log_sigma = float(spec.get("sigma", 1.0))
                    natural_mu = float(np.exp(np.clip(log_mu, -700, 700)))
                else:
                    natural_mu = float(spec.get("mu", 1.0))
                    natural_sigma = float(spec.get("sigma", 1.0))
                    if natural_mu <= 0:
                        raise ValueError(f"{name} lognormal mu must be > 0 before log conversion.")
                    if natural_sigma <= 0:
                        raise ValueError(f"{name} lognormal sigma must be > 0 before log conversion.")
                    log_mu = float(np.log(natural_mu))
                    log_sigma = float(np.log1p(natural_sigma / natural_mu))
                if log_sigma <= 0:
                    raise ValueError(f"{name} lognormal sigma must be > 0 after log conversion.")
                if name == "A0":
                    log(
                        "A0 LogNormal prior: "
                        f"natural_mu={natural_mu:.6g}, "
                        f"pymc_mu={log_mu:.6g}, "
                        f"pymc_sigma={log_sigma:.6g}"
                    )
                rv = pm.LogNormal(
                    name,
                    mu=log_mu,
                    sigma=max(log_sigma, 1e-12),
                    initval=max(natural_mu, 1e-12),
                )
            else:
                raise ValueError(f"Unknown prior distribution: {dist}")
            if positive:
                return pm.Deterministic(f"{name}_positive", pt.maximum(rv, 1e-12))
            return rv

        priors = design.get("priors", {})
        sampling = design.get("sampling", {})

        def neutron_sort_key(mode):
            return int(str(mode).replace("n", ""))

        log(
            "Building PyMC model "
            f"(likelihood={config.get('likelihood', 'poisson')}, "
            f"background={config.get('background_type', 'constant')}, "
            f"branching={design.get('branching_mode', 'fixed')})."
        )
        with pm.Model() as model:
            a0 = make_prior(
                "A0",
                priors.get(
                    "A0",
                    {
                        "dist": "lognormal",
                        "mu": max(float(config.get("A0_estimate", 1.0)), 1e-12),
                        "sigma": max(float(config.get("A0_estimate", 1.0)), 1e-12),
                    },
                ),
                positive=True,
            )
            t_parent = make_prior(
                "T_parent",
                priors.get(
                    "T_parent",
                    {"dist": "normal", "mu": config["t_parent"], "sigma": config["t_parent"]},
                ),
                positive=True,
            )

            daughter_halflives = {}
            daughter_uncertainties = config.get("daughter_halflife_uncertainties", {})
            for mode, value in config.get("daughter_halflives", {}).items():
                sigma = daughter_uncertainties.get(mode, value)
                daughter_halflives[mode] = make_prior(
                    f"T_{mode}",
                    priors.get(f"T_{mode}", {"dist": "normal", "mu": value, "sigma": sigma}),
                    positive=True,
                )

            granddaughter_halflives = {}
            granddaughter_uncertainties = config.get("granddaughter_halflife_uncertainties", {})
            for mode, value in config.get("granddaughter_halflives", {}).items():
                sigma = granddaughter_uncertainties.get(mode, value)
                granddaughter_halflives[mode] = make_prior(
                    f"T_g{mode}",
                    priors.get(f"T_g{mode}", {"dist": "normal", "mu": value, "sigma": sigma}),
                    positive=True,
                )

            daughter_modes = sorted(daughter_halflives.keys(), key=neutron_sort_key)
            n_br = len(daughter_modes)
            branching_mode = str(design.get("branching_mode", "fixed")).lower()
            daughter_branches = {}
            if n_br:
                if branching_mode == "fixed":
                    fixed = design.get("fixed_daughter_branches") or config.get("daughter_branches", {})
                    for mode in daughter_modes:
                        daughter_branches[mode] = pt.as_tensor_variable(float(fixed.get(mode, 0.0)))
                        pm.Deterministic(f"b_{mode}", daughter_branches[mode])

                elif branching_mode == "dirichlet":
                    alpha = np.asarray(priors.get("b_dirichlet_alpha", [1.0] * n_br), dtype=float)
                    if alpha.size != n_br:
                        alpha = np.pad(alpha, (0, max(0, n_br - alpha.size)), constant_values=1.0)[:n_br]
                    b = pm.Dirichlet("b", a=alpha)
                    for i, mode in enumerate(daughter_modes):
                        daughter_branches[mode] = b[i]
                        pm.Deterministic(f"b_{mode}", b[i])

                elif branching_mode == "softmax":
                    loc = np.asarray(priors.get("b_softmax_loc", [0.0] * n_br), dtype=float)
                    if loc.size != n_br:
                        loc = np.pad(loc, (0, max(0, n_br - loc.size)), constant_values=0.0)[:n_br]
                    sig = max(float(priors.get("b_softmax_sigma", 1.0)), 1e-12)
                    logits = pm.Normal("logits", mu=loc, sigma=sig, shape=n_br)
                    exp_logits = pt.exp(logits - pt.max(logits))
                    b = pm.Deterministic("b", exp_logits / pt.sum(exp_logits))
                    for i, mode in enumerate(daughter_modes):
                        daughter_branches[mode] = b[i]
                        pm.Deterministic(f"b_{mode}", b[i])

                elif branching_mode == "normalized_raw":
                    raw = pt.stack([
                        make_prior(
                            f"b_raw{i}",
                            priors.get(f"b_raw{i}", {"dist": "halfnormal", "sigma": 1.0}),
                            positive=True,
                        )
                        for i in range(n_br)
                    ])
                    b = pm.Deterministic("b", raw / pt.sum(raw))
                    for i, mode in enumerate(daughter_modes):
                        daughter_branches[mode] = b[i]
                        pm.Deterministic(f"b_{mode}", b[i])

                else:
                    raise ValueError(f"Unknown branching mode: {branching_mode}")

            granddaughter_branches = {}
            gd_specs = design.get("granddaughter_branch_specs", {})
            for mode in sorted(granddaughter_halflives.keys(), key=neutron_sort_key):
                spec = gd_specs.get(mode, {"dist": "fixed", "value": 1.0})
                dist = str(spec.get("dist", "fixed")).lower()
                if dist == "fixed":
                    value = float(spec.get("value", 1.0))
                    if not 0 <= value <= 1:
                        raise ValueError(f"Granddaughter branch {mode} fixed value must be between 0 and 1.")
                    granddaughter_branches[mode] = pt.as_tensor_variable(value)
                    pm.Deterministic(f"bgd_{mode}", granddaughter_branches[mode])
                elif dist == "uniform":
                    lower = float(spec.get("lower", 0.0))
                    upper = float(spec.get("upper", 1.0))
                    if lower < 0 or upper > 1 or lower >= upper:
                        raise ValueError(f"Granddaughter branch {mode} uniform range must satisfy 0 <= lower < upper <= 1.")
                    granddaughter_branches[mode] = pm.Uniform(f"bgd_{mode}", lower=lower, upper=upper)
                else:
                    raise ValueError(f"Unknown granddaughter branch prior for {mode}: {dist}")

            mu = parent_mod(np, pt, x, binw, t_parent, a0)
            for mode in daughter_modes:
                t_d = daughter_halflives[mode]
                b_pd = daughter_branches[mode]
                mu = mu + daughter_mod(np, pt, x, binw, t_d, t_parent, a0, b_pd)
                if mode in granddaughter_halflives:
                    b_dg = granddaughter_branches.get(mode, pt.as_tensor_variable(1.0))
                    mu = mu + granddaughter_mod(
                        np,
                        pt,
                        x,
                        binw,
                        granddaughter_halflives[mode],
                        t_d,
                        t_parent,
                        a0,
                        b_pd,
                        b_dg,
                    )

            bg_type = config.get("background_type", "constant")
            bg_params = config.get("background_params", {})
            if bg_type == "constant":
                bkg = make_prior(
                    "bkg_rate",
                    priors.get(
                        "bkg_rate",
                        {
                            "dist": "normal",
                            "mu": bg_params.get("bkg_rate", 0.0),
                            "sigma": max(bg_params.get("bkg_rate", 1.0), 1e-6),
                        },
                    ),
                    positive=True,
                )
                mu = mu + bkg * binw
            elif bg_type == "linear":
                bkg0 = make_prior(
                    "bkg0",
                    priors.get("bkg0", {"dist": "normal", "mu": bg_params.get("bkg0", 0.0), "sigma": 1.0}),
                    positive=True,
                )
                slope = make_prior(
                    "slope",
                    priors.get("slope", {"dist": "normal", "mu": bg_params.get("slope", 0.0), "sigma": 0.01}),
                )
                mu = mu + (bkg0 + slope * x) * binw
            elif bg_type == "exponential":
                bg_amp = make_prior(
                    "bg_amp",
                    priors.get("bg_amp", {"dist": "normal", "mu": bg_params.get("bg_amp", 0.0), "sigma": 1.0}),
                    positive=True,
                )
                bg_half = make_prior(
                    "bg_halflife",
                    priors.get("bg_halflife", {"dist": "normal", "mu": bg_params.get("bg_halflife", 1.0), "sigma": 1.0}),
                    positive=True,
                )
                lam_bg = np.log(2.0) / bg_half
                mu = mu + bg_amp * int_exp(pt, lam_bg, x - 0.5 * binw, x + 0.5 * binw)

            mu = pt.clip(mu, 1e-12, 1e100)
            if config.get("likelihood", "poisson") == "normal":
                sigma_y = make_prior(
                    "sigma_y",
                    priors.get("sigma_y", {"dist": "halfnormal", "sigma": max(float(np.std(y)), 1.0)}),
                    positive=True,
                )
                pm.Normal("obs", mu=mu, sigma=sigma_y, observed=y)
            else:
                pm.Poisson("obs", mu=mu, observed=y)

            draws = int(sampling.get("draws", 1000))
            tune = int(sampling.get("tune", 1000))
            chains = int(sampling.get("chains", 4))
            cores = int(sampling.get("cores", 1))
            target_accept = float(sampling.get("target_accept", 0.9))
            log(
                "Sampling posterior: "
                f"{chains} chain(s), {tune:,} tune + {draws:,} draws each, "
                f"cores={cores}, target_accept={target_accept:g}."
            )

            sample_started = time.monotonic()
            sample_progress = {"last_log": 0.0}

            def sample_callback(trace, draw):
                try:
                    now = time.monotonic()
                    draw_idx = int(getattr(draw, "draw_idx", 0))
                    chain_idx = getattr(draw, "chain", "?")
                    tuning = bool(getattr(draw, "tuning", False))
                    phase = "tuning" if tuning else "posterior"
                    if now - sample_progress["last_log"] < 3.0 and draw_idx not in {0, tune, tune + draws - 1}:
                        return
                    sample_progress["last_log"] = now
                    log(f"Sampling progress: chain {chain_idx}, {phase}, draw index {draw_idx:,}.")
                except Exception:
                    pass

            sample_kwargs = {
                "draws": draws,
                "tune": tune,
                "chains": chains,
                "cores": cores,
                "target_accept": target_accept,
                "return_inferencedata": True,
                "progressbar": False,
                "compute_convergence_checks": False,
            }
            if "callback" in inspect.signature(pm.sample).parameters:
                sample_kwargs["callback"] = sample_callback
            stop_heartbeat = heartbeat("Sampling posterior")
            try:
                idata = pm.sample(**sample_kwargs)
            finally:
                stop_heartbeat()
            log(f"Posterior sampling finished in {time.monotonic() - sample_started:.1f}s.")

            ppc_obs = None
            try:
                chain_count = int(idata.posterior.sizes.get("chain", 1))
                draw_count = int(idata.posterior.sizes.get("draw", 1))
                max_ppc_draws = 800
                draws_per_chain = max(1, min(draw_count, int(np.ceil(max_ppc_draws / max(chain_count, 1)))))
                draw_indices = np.unique(np.linspace(0, draw_count - 1, draws_per_chain, dtype=int))
                posterior_subset = idata.posterior.isel(draw=draw_indices)
                ppc_trace = az.InferenceData(posterior=posterior_subset)
                log(
                    "Sampling posterior predictive: "
                    f"{chain_count * len(draw_indices):,} posterior draw(s) used for PPC plot."
                )
                ppc_started = time.monotonic()
                stop_ppc_heartbeat = heartbeat("Posterior predictive sampling")
                try:
                    ppc_data = pm.sample_posterior_predictive(
                        ppc_trace,
                        var_names=["obs"],
                        return_inferencedata=False,
                        progressbar=False,
                    )
                finally:
                    stop_ppc_heartbeat()
                ppc_obs = np.asarray(ppc_data.get("obs")) if "obs" in ppc_data else None
                log(f"Posterior predictive sampling finished in {time.monotonic() - ppc_started:.1f}s.")
            except Exception as ppc_exc:
                log(f"Posterior predictive plot will be skipped: {ppc_exc}")

        log("Preparing and saving result artifacts...")
        job["result"] = build_and_save_results(
            job_id=job_id,
            payload=payload,
            idata=idata,
            ppc_obs=ppc_obs,
            x=x,
            y=y,
            unit=unit,
            nucleus=nucleus,
            result_dir=result_dir,
            log=log,
            az=az,
            np=np,
        )
        job["status"] = "complete"
        log("Complete.")
    except Exception:
        job["status"] = "error"
        job["error"] = traceback.format_exc()
        log("Model run failed.")
