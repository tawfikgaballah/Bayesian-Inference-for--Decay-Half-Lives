"""Bateman equation helpers used by the PyMC model.

The functions in this module stay dependency-light at import time. The runner
passes in NumPy and PyTensor modules after it has loaded the Bayesian stack.
"""


def safe_diff(pt, a, b, eps=1e-12):
    """Return a - b while avoiding exactly-zero denominators."""
    diff = a - b
    return pt.switch(
        pt.lt(pt.abs(diff), eps),
        pt.switch(pt.ge(diff, 0.0), eps, -eps),
        diff,
    )


def int_exp(pt, lam, t1, t2):
    """Integral of exp(-lambda t) from t1 to t2."""
    return (pt.exp(-lam * t1) - pt.exp(-lam * t2)) / lam


def parent_mod(np, pt, x, binw, t_parent, a0):
    lam_p = np.log(2.0) / t_parent
    t1 = x - 0.5 * binw
    t2 = x + 0.5 * binw
    return a0 * int_exp(pt, lam_p, t1, t2)


def daughter_mod(np, pt, x, binw, t_daughter, t_parent, a0, branch):
    lam_p = np.log(2.0) / t_parent
    lam_d = np.log(2.0) / t_daughter
    t1 = x - 0.5 * binw
    t2 = x + 0.5 * binw
    coeff = a0 * branch * lam_d / safe_diff(pt, lam_d, lam_p)
    return coeff * (int_exp(pt, lam_p, t1, t2) - int_exp(pt, lam_d, t1, t2))


def granddaughter_mod(np, pt, x, binw, t_g, t_d, t_p, a0, b_pd, b_dg):
    lam_p = np.log(2.0) / t_p
    lam_d = np.log(2.0) / t_d
    lam_g = np.log(2.0) / t_g
    t1 = x - 0.5 * binw
    t2 = x + 0.5 * binw
    d_dp = safe_diff(pt, lam_d, lam_p)
    d_gp = safe_diff(pt, lam_g, lam_p)
    d_gd = safe_diff(pt, lam_g, lam_d)
    coeff = a0 * b_pd * b_dg * lam_d * lam_g
    return coeff * (
        int_exp(pt, lam_p, t1, t2) / (d_dp * d_gp)
        + int_exp(pt, lam_d, t1, t2) / ((-d_dp) * d_gd)
        + int_exp(pt, lam_g, t1, t2) / ((-d_gp) * (-d_gd))
    )
