"""Scientific display labels for model parameters."""

from __future__ import annotations


def beta_mode_label(mode: str) -> str:
    """Return beta-decay notation for a neutron-emission mode such as 0n."""
    text = str(mode)
    if not text.endswith("n"):
        return text
    count = text[:-1]
    if count == "0":
        return "β⁻"
    return f"β⁻{count}n"


def scientific_label(name: str) -> str:
    """Return a publication-style label for a posterior variable name."""
    text = str(name)
    if text == "b_neutron_sum":
        return "Σ BR(β⁻xn), x≥1"
    if text.startswith("b_") and text.endswith("n"):
        return f"BR({beta_mode_label(text[2:])})"
    if text.startswith("T_g") and text.endswith("n"):
        return f"T₁/₂ granddaughter after {beta_mode_label(text[3:])}"
    if text.startswith("T_") and text.endswith("n"):
        return f"T₁/₂ daughter after {beta_mode_label(text[2:])}"
    if text.startswith("bgd_") and text.endswith("n"):
        return f"BR(daughter→granddaughter | {beta_mode_label(text[4:])})"
    if text == "T_parent":
        return "Parent T₁/₂"
    if text == "A0":
        return "A0"
    if text == "bkg_rate":
        return "Background rate"
    if text == "bkg0":
        return "Background intercept"
    if text == "bg_halflife":
        return "Background T1/2"
    if text == "bg_amp":
        return "Background amplitude"
    if text == "sigma_y":
        return "Normal likelihood σ"
    return text
