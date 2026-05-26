function safeDiff(a, b) {
  const d = a - b;
  if (Math.abs(d) < 1e-12) return d >= 0 ? 1e-12 : -1e-12;
  return d;
}

function intExp(lam, t1, t2) {
  return (Math.exp(-lam * t1) - Math.exp(-lam * t2)) / lam;
}

function modelPoint(params, x, binw) {
  const { a0, tParent, daughterHL, daughterBR, gdHL, gdBR, bgType, bgParams } = params;
  const lamP = Math.LN2 / tParent;
  const t1 = x - 0.5 * binw;
  const t2 = x + 0.5 * binw;
  let total = a0 * intExp(lamP, t1, t2);

  for (const mode of ["0n", "1n", "2n", "3n"]) {
    if (!(mode in daughterHL)) continue;
    const lamD = Math.LN2 / daughterHL[mode];
    const denom = safeDiff(lamD, lamP);
    const coeff = a0 * daughterBR[mode] * lamD / denom;
    total += coeff * (intExp(lamP, t1, t2) - intExp(lamD, t1, t2));

    if (mode in gdHL) {
      const lamG = Math.LN2 / gdHL[mode];
      const dDP = safeDiff(lamD, lamP);
      const dGP = safeDiff(lamG, lamP);
      const dGD = safeDiff(lamG, lamD);
      const c = a0 * daughterBR[mode] * gdBR[mode] * lamD * lamG;
      total += c * (
        intExp(lamP, t1, t2) / (dDP * dGP)
        + intExp(lamD, t1, t2) / ((-dDP) * dGD)
        + intExp(lamG, t1, t2) / ((-dGP) * (-dGD))
      );
    }
  }

  if (bgType === "constant") total += (bgParams.bkg_rate || 0) * binw;
  if (bgType === "linear") total += ((bgParams.bkg0 || 0) + (bgParams.slope || 0) * x) * binw;
  if (bgType === "exponential") {
    const lamBg = Math.LN2 / Math.max(bgParams.bg_halflife || 1, 1e-12);
    total += (bgParams.bg_amp || 0) * intExp(lamBg, t1, t2);
  }

  return Math.max(total, 1e-12);
}
