const units = { ns: 1e-9, us: 1e-6, ms: 1e-3, s: 1, m: 60, h: 3600, d: 86400, y: 365.25 * 86400 };
    const validUnits = Object.keys(units);
    const requiredDecayColumns = ["z","n","name","levelEnergy(MeV)","halflife","halflifeUnit","halflifeUncertainty","decayMode","branchingRatio","branchingRatioUncertainty"];
    const state = { decayRows: [], histRows: [], rebinnedRows: [], chain: [], fitRows: [], modelCurve: [], config: null, modelPayload: null, modelPayloadDirty: true, branchDraft: null, granddaughterBranchDraft: null, bayesianJob: null, bayesianRunActive: false, lastBayesianPayload: null, bayesianResult: null, plotFrame: null, plotVarSelection: { distributions: [], corner: [], names: [], touched: false } };

    const $ = id => document.getElementById(id);
    const status = text => $("status").textContent = text;
    const num = value => {
      const n = Number(value);
      return Number.isFinite(n) ? n : NaN;
    };
    const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    const isMissing = value => value === null || value === undefined || value === "" || String(value).toLowerCase() === "nan";
    const toNumber = value => isMissing(value) ? NaN : num(value);
    const unique = list => [...new Set(list)];
    const cloneData = value => JSON.parse(JSON.stringify(value));

    function parseCSV(text) {
      const rows = [];
      let row = [], cell = "", quoted = false;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i], next = text[i + 1];
        if (quoted) {
          if (ch === '"' && next === '"') { cell += '"'; i++; }
          else if (ch === '"') quoted = false;
          else cell += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ",") { row.push(cell); cell = ""; }
        else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
        else if (ch !== "\r") cell += ch;
      }
      if (cell.length || row.length) { row.push(cell); rows.push(row); }
      if (!rows.length) return [];
      const headers = rows[0].map(h => h.trim());
      return rows.slice(1).filter(r => r.some(v => String(v).trim() !== "")).map(r => {
        const obj = {};
        headers.forEach((h, i) => obj[h] = r[i] ?? "");
        return obj;
      });
    }

    function convertHalfLife(value, fromUnit, toUnit) {
      const v = toNumber(value);
      if (!Number.isFinite(v) || !(fromUnit in units) || !(toUnit in units)) return NaN;
      return v * units[fromUnit] / units[toUnit];
    }
    function formatValueError(value, error, unit = "") {
      if (!Number.isFinite(value)) return "Not determined";
      if (!Number.isFinite(error)) return `${value.toPrecision(6)} ${unit}`.trim();
      return `${value.toPrecision(6)} +/- ${error.toPrecision(6)} ${unit}`.trim();
    }
    function formatBR(value, error) {
      const v = toNumber(value), e = toNumber(error);
      if (!Number.isFinite(v)) return "Not determined";
      if (!Number.isFinite(e)) return `${v.toPrecision(6)}%`;
      return `${v.toPrecision(6)} +/- ${e.toPrecision(6)}%`;
    }
    function normalizeMode(mode) {
      return String(mode ?? "")
        .replaceAll("β", "B").replaceAll("−", "-").replaceAll("⁻", "-")
        .replaceAll("ε", "EC").replaceAll("α", "alpha").replaceAll(" ", "")
        .replace(/^beta-/i, "B-").replace(/^beta\+/i, "B+").replace(/^b-/i, "B-").replace(/^b\+/i, "B+");
    }
    function describeMode(mode) {
      const m = normalizeMode(mode);
      return ({
        "B-": "Beta-minus decay",
        "B+": "Beta-plus decay",
        "B-n": "Beta-minus delayed neutron emission",
        "B-1n": "Beta-minus delayed neutron emission",
        "B-2n": "Beta-minus delayed 2-neutron emission",
        "B-3n": "Beta-minus delayed 3-neutron emission",
        "B-alpha": "Beta-minus delayed alpha decay",
        "EC": "Electron capture",
        "EC+B+": "Electron capture + beta-plus decay",
        "alpha": "Alpha decay",
        "IT": "Isomeric transition"
      })[m] || m;
    }
    function expectedMode(decayType, neutronEmission) {
      if (decayType === "beta-") return neutronEmission === 0 ? "B-" : `B-${neutronEmission}n`;
      if (decayType === "beta+") return neutronEmission === 0 ? "B+" : null;
      return null;
    }
    function getBranchingInfo(rows, decayType, neutronEmission) {
      const target = expectedMode(decayType, neutronEmission);
      if (!target) return { decay_mode: "Not available", description: "Not available", branchingRatio: NaN, branchingRatioUncertainty: NaN };
      const found = rows.find(r => normalizeMode(r.decayMode) === target);
      if (!found) return { decay_mode: target, description: describeMode(target), branchingRatio: NaN, branchingRatioUncertainty: NaN };
      return { decay_mode: found.decayMode, description: describeMode(found.decayMode), branchingRatio: found.branchingRatio, branchingRatioUncertainty: found.branchingRatioUncertainty };
    }
    function findNucleusFromZN(z, n) {
      const row = state.decayRows.find(r => Number(r.z) === z && Number(r.n) === n);
      return row ? String(row.name) : null;
    }
    function getDaughterName(info, decayType, neutronEmission) {
      const z = Number(info.z), n = Number(info.n);
      if (decayType === "beta-") return findNucleusFromZN(z + 1, n - 1 - neutronEmission);
      if (decayType === "beta+") return findNucleusFromZN(z - 1, n + 1 - neutronEmission);
      return null;
    }
    function getIsomers(rows) {
      const seen = new Set(), out = [];
      for (const r of rows) {
        const iso = { "levelEnergy(MeV)": r["levelEnergy(MeV)"], halflife: r.halflife, halflifeUnit: r.halflifeUnit, halflifeUncertainty: r.halflifeUncertainty };
        const key = JSON.stringify(iso);
        if (!seen.has(key)) { seen.add(key); out.push(iso); }
      }
      return out;
    }
    function filterIsomerRows(rows, iso) {
      let selected = rows.filter(r => String(r["levelEnergy(MeV)"]) === String(iso["levelEnergy(MeV)"]));
      if (!isMissing(iso.halflife)) selected = selected.filter(r => String(r.halflife) === String(iso.halflife));
      if (!isMissing(iso.halflifeUnit)) selected = selected.filter(r => String(r.halflifeUnit) === String(iso.halflifeUnit));
      return selected.length ? selected : rows;
    }
    function chooseIsomer(nucleusName) {
      const rows = state.decayRows.filter(r => String(r.name) === String(nucleusName));
      if (!rows.length) return Promise.resolve(null);
      const isomers = getIsomers(rows);
      if (isomers.length === 1) return Promise.resolve(makeStateInfo(nucleusName, filterIsomerRows(rows, isomers[0]), isomers[0]));
      return new Promise(resolve => {
        const table = $("isomerTable");
        const unit = $("outputUnit").value;
        $("isomerTitle").textContent = `Choose state for ${nucleusName}`;
        table.innerHTML = `<thead><tr><th>Index</th><th>Level Energy (MeV)</th><th>T1/2 (${unit})</th><th>Uncertainty (${unit})</th></tr></thead><tbody></tbody>`;
        const tbody = table.querySelector("tbody");
        let selected = 0;
        isomers.forEach((iso, idx) => {
          const hl = convertHalfLife(iso.halflife, iso.halflifeUnit, unit);
          const unc = convertHalfLife(iso.halflifeUncertainty, iso.halflifeUnit, unit);
          const tr = document.createElement("tr");
          tr.innerHTML = `<td>${idx}</td><td>${iso["levelEnergy(MeV)"]}</td><td>${Number.isFinite(hl) ? hl.toPrecision(6) : "Not determined"}</td><td>${Number.isFinite(unc) ? unc.toPrecision(6) : "Not determined"}</td>`;
          if (idx === 0) tr.classList.add("selected-row");
          tr.onclick = () => {
            selected = idx;
            tbody.querySelectorAll("tr").forEach(x => x.classList.remove("selected-row"));
            tr.classList.add("selected-row");
          };
          tbody.appendChild(tr);
        });
        const dialog = $("isomerDialog");
        $("cancelIsomer").onclick = () => { dialog.close(); resolve(null); };
        $("useIsomer").onclick = () => {
          dialog.close();
          const iso = isomers[selected];
          resolve(makeStateInfo(nucleusName, filterIsomerRows(rows, iso), iso));
        };
        dialog.showModal();
      });
    }
    function makeStateInfo(nucleusName, rows, iso) {
      const first = rows[0];
      return { nucleus: nucleusName, rows, z: Number(first.z), n: Number(first.n), energy: iso["levelEnergy(MeV)"], halflife: iso.halflife, halflife_unc: iso.halflifeUncertainty, unit: iso.halflifeUnit };
    }

    function inferBinWidth(rows) {
      const xs = rows.map(r => Number(r.BinCenter)).filter(Number.isFinite).sort((a,b) => a-b);
      const diffs = [];
      for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > 0) diffs.push(xs[i] - xs[i - 1]);
      if (!diffs.length) throw new Error("Could not infer original bin width.");
      diffs.sort((a,b) => a-b);
      return diffs[Math.floor(diffs.length / 2)];
    }
    function rebinHistogram(rows, desiredWidth) {
      if (!(desiredWidth > 0)) throw new Error("Desired bin width must be greater than 0.");
      const sorted = [...rows].sort((a,b) => Number(a.BinCenter) - Number(b.BinCenter));
      const orig = inferBinWidth(sorted);
      const xmin = Number(sorted[0].BinCenter), xmax = Number(sorted[sorted.length - 1].BinCenter);
      const left = xmin - 0.5 * orig, right = xmax + 0.5 * orig;
      const bins = new Map();
      for (const r of sorted) {
        const x = Number(r.BinCenter);
        const idx = Math.floor((x - left) / desiredWidth);
        if (idx < 0) continue;
        const center = left + (idx + 0.5) * desiredWidth;
        bins.set(idx, (bins.get(idx) || 0) + Number(r.BinContent || 0));
      }
      return [...bins.entries()].sort((a,b) => a[0] - b[0]).map(([idx, content]) => ({ BinCenter: left + (idx + 0.5) * desiredWidth, BinWidth: desiredWidth, BinContent: content }));
    }
    function selectFitRange(rows, xmin, xmax) {
      return rows.filter(r => r.BinCenter >= xmin && r.BinCenter <= xmax);
    }
    function estimateBg(rows, lo, hi) {
      if (lo >= hi) throw new Error("Reverse background range must satisfy low < high.");
      const neg = rows.filter(r => r.BinCenter >= lo && r.BinCenter < hi);
      const exposure = neg.reduce((s, r) => s + Number(r.BinWidth), 0);
      const k = neg.reduce((s, r) => s + Number(r.BinContent), 0);
      return { k_neg: k, n_bins_neg: neg.length, exposure_neg_ms: exposure, exposure, bg_hat: exposure > 0 ? k / exposure : 0 };
    }
    function estimateBackgroundForType(rows, bgType, lo, hi, fitMin, fitMax) {
      const base = estimateBg(rows, lo, hi);
      const bgHat = Math.max(base.bg_hat, 0);
      const span = Math.max(Math.abs(fitMax - fitMin), 1);
      if (bgType === "linear") {
        return {
          ...base,
          params: { bkg0: bgHat, slope: 0 },
          priors: {
            bkg0: { dist: "normal", mu: bgHat, sigma: Math.max(bgHat, 1e-6) },
            slope: { dist: "normal", mu: 0, sigma: Math.max(bgHat / span, 1e-6) }
          }
        };
      }
      if (bgType === "exponential") {
        return {
          ...base,
          params: { bg_amp: bgHat, bg_halflife: span },
          priors: {
            bg_amp: { dist: "normal", mu: bgHat, sigma: Math.max(bgHat, 1e-6) },
            bg_halflife: { dist: "normal", mu: span, sigma: span }
          }
        };
      }
      return {
        ...base,
        params: { bkg_rate: bgHat },
        priors: {
          bkg_rate: { dist: "normal", mu: bgHat, sigma: Math.max(bgHat, 1e-6) }
        }
      };
    }
    function estimateA0(rows, bgRate, nEarlyBins = 5) {
      if (!rows.length) return 1;
      const early = [...rows].sort((a,b) => a.BinCenter - b.BinCenter).slice(0, Math.max(1, Math.floor(nEarlyBins)));
      const rates = early.map(r => r.BinContent / r.BinWidth - bgRate).filter(v => Number.isFinite(v) && v > 0).sort((a,b) => a-b);
      if (!rates.length) return 1;
      const mid = Math.floor(rates.length / 2);
      return rates.length % 2 ? rates[mid] : 0.5 * (rates[mid - 1] + rates[mid]);
    }
    function estimateTailBgRate(rows, fitMax, nTailBins = 5) {
      const sorted = [...rows]
        .filter(r => Number.isFinite(Number(r.BinCenter)))
        .sort((a,b) => Number(a.BinCenter) - Number(b.BinCenter));
      if (!sorted.length) return 0;
      const beyondFit = sorted.filter(r => Number(r.BinCenter) > Number(fitMax));
      const source = beyondFit.length ? beyondFit : sorted;
      const tail = source.slice(-Math.max(1, Math.floor(nTailBins)));
      let counts = 0;
      let exposure = 0;
      for (const row of tail) {
        const width = Number(row.BinWidth);
        const content = Number(row.BinContent);
        if (Number.isFinite(width) && width > 0 && Number.isFinite(content)) {
          exposure += width;
          counts += content;
        }
      }
      return exposure > 0 ? counts / exposure : 0;
    }
    function a0BackgroundRate() {
      if ($("useReverseBg")?.checked) return Math.max(Number(state.config?.background_estimate?.bg_hat || 0), 0);
      const fitMax = Number($("fitMax")?.value ?? state.config?.fit_max ?? NaN);
      const rows = state.rebinnedRows.length ? state.rebinnedRows : state.histRows;
      return Math.max(estimateTailBgRate(rows, fitMax, 5), 0);
    }
    function a0EarlyBinCount() {
      const value = Number($("a0EarlyBins")?.value);
      return Number.isFinite(value) && value > 0 ? Math.floor(value) : 5;
    }
    function a0PriorRelSigma() {
      const value = Number($("a0RelSigma")?.value);
      return Number.isFinite(value) && value > 0 ? value : 0.75;
    }

    function currentHistogramRows() {
      return state.rebinnedRows.length ? state.rebinnedRows : state.histRows;
    }
    function rowExtent(rows) {
      const xs = rows.map(r => Number(r.BinCenter)).filter(Number.isFinite);
      if (!xs.length) return null;
      return { min: Math.min(...xs), max: Math.max(...xs) };
    }
    function parentHalfLifeInSelectedUnit() {
      const parent = state.chain[0]?.info;
      if (!parent) return NaN;
      return convertHalfLife(parent.halflife, parent.unit, $("outputUnit").value);
    }
    function applyFitDefaults() {
      const halfLife = parentHalfLifeInSelectedUnit();
      if (Number.isFinite(halfLife) && halfLife > 0) {
        $("binWidth").value = Number((halfLife / 10).toPrecision(10));
        $("fitMin").value = 0;
        $("fitMax").value = Number((7 * halfLife).toPrecision(10));
      }
      const extent = rowExtent(state.histRows);
      if (extent) {
        $("bgMin").value = Number(extent.min.toPrecision(10));
        $("bgMax").value = 0;
      }
    }
    function setPlotInputs(min, max) {
      $("plotMin").value = Number.isFinite(min) ? Number(min.toPrecision(10)) : "";
      $("plotMax").value = Number.isFinite(max) ? Number(max.toPrecision(10)) : "";
    }
    function setPlotRangeFromRows(rows) {
      const extent = rowExtent(rows);
      if (extent) setPlotInputs(extent.min, extent.max);
    }
    function plotCurvePoints(curve = state.modelCurve, curveRows = state.fitRows) {
      return curve
        ? curveRows.map((row, i) => ({ x: Number(row.BinCenter), y: Number(curve[i]) }))
            .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
        : [];
    }
    function yValuesForRows(rows, curve = null, curveRows = []) {
      const rowValues = rows.map(r => Number(r.BinContent)).filter(Number.isFinite);
      const curveValues = plotCurvePoints(curve, curveRows).map(p => p.y);
      return [...rowValues, ...curveValues].filter(Number.isFinite);
    }
    function yExtent(values) {
      const finite = values.filter(v => Number.isFinite(v));
      const logMode = $("yScale").value === "log";
      const usable = logMode ? finite.filter(v => v > 0) : finite;
      if (!usable.length) return logMode ? { min: 1, max: 10 } : { min: 0, max: 1 };
      const max = Math.max(...usable, 1);
      const min = logMode ? Math.min(...usable) : Math.min(0, ...usable);
      if (min === max) {
        return logMode
          ? { min: Math.max(min / 10, 1e-12), max: max * 10 }
          : { min: Math.min(0, min - 1), max: max + 1 };
      }
      return { min, max };
    }
    function setYInputs(min, max) {
      $("plotYMin").value = Number.isFinite(min) ? Number(min.toPrecision(10)) : "";
      $("plotYMax").value = Number.isFinite(max) ? Number(max.toPrecision(10)) : "";
    }
    function setYRangeFromRows(rows, curve = null, curveRows = []) {
      const extent = yExtent(yValuesForRows(rows, curve, curveRows));
      setYInputs(extent.min, extent.max);
    }
    function getPlotRange() {
      const rows = currentHistogramRows();
      const extent = rowExtent(rows);
      if (!extent) return null;
      let min = Number($("plotMin").value);
      let max = Number($("plotMax").value);
      if (!Number.isFinite(min)) min = extent.min;
      if (!Number.isFinite(max)) max = extent.max;
      if (min > max) [min, max] = [max, min];
      if (min === max) {
        min = extent.min;
        max = extent.max;
      }
      return { min, max };
    }
    function getYRange(values) {
      const extent = yExtent(values);
      const logMode = $("yScale").value === "log";
      let min = Number($("plotYMin").value);
      let max = Number($("plotYMax").value);
      if (!Number.isFinite(min)) min = extent.min;
      if (!Number.isFinite(max)) max = extent.max;
      if (logMode && min <= 0) min = extent.min;
      if (logMode && max <= 0) max = extent.max;
      if (min > max) [min, max] = [max, min];
      if (min === max) {
        if (logMode) {
          min = Math.max(min / 10, 1e-12);
          max = max * 10;
        } else {
          min = Math.min(0, min - 1);
          max = max + 1;
        }
      }
      return { min, max, logMode };
    }
    function redrawHistogram() {
      drawPlot(currentHistogramRows(), state.modelCurve, { curveRows: state.fitRows });
    }
    function applyPlotRange() {
      redrawHistogram();
      activateTab("plotView");
    }
    function fullPlotRange() {
      const rows = currentHistogramRows();
      setPlotRangeFromRows(rows);
      setYRangeFromRows(rows, state.modelCurve, state.fitRows);
      redrawHistogram();
    }
    function fitPlotRange() {
      if (!state.fitRows.length) return alert("Prepare the fit preview first.");
      setPlotRangeFromRows(state.fitRows);
      setYRangeFromRows(state.fitRows, state.modelCurve, state.fitRows);
      redrawHistogram();
    }
    function xFullRange() {
      setPlotRangeFromRows(currentHistogramRows());
      redrawHistogram();
    }
    function xFitRange() {
      if (!state.fitRows.length) return alert("Prepare the fit preview first.");
      setPlotRangeFromRows(state.fitRows);
      redrawHistogram();
    }
    function yFullRange() {
      setYRangeFromRows(currentHistogramRows(), state.modelCurve, state.fitRows);
      redrawHistogram();
    }
    function yFitRange() {
      if (!state.fitRows.length) return alert("Prepare the fit preview first.");
      setYRangeFromRows(state.fitRows, state.modelCurve, state.fitRows);
      redrawHistogram();
    }
    function zoomX(scale) {
      const range = getPlotRange();
      const extent = rowExtent(currentHistogramRows());
      if (!range || !extent) return;
      const center = 0.5 * (range.min + range.max);
      const half = 0.5 * (range.max - range.min) * scale;
      const min = Math.max(extent.min, center - half);
      const max = Math.min(extent.max, center + half);
      setPlotInputs(min, max);
      redrawHistogram();
    }
    function zoomY(scale) {
      const values = yValuesForRows(currentHistogramRows(), state.modelCurve, state.fitRows);
      const extent = yExtent(values);
      const range = getYRange(values);
      if (!range || !extent) return;
      if (range.logMode) {
        const minLog = Math.log10(range.min);
        const maxLog = Math.log10(range.max);
        const extentMinLog = Math.log10(extent.min);
        const extentMaxLog = Math.log10(extent.max);
        const center = 0.5 * (minLog + maxLog);
        const half = 0.5 * (maxLog - minLog) * scale;
        const nextMin = Math.max(extentMinLog, center - half);
        const nextMax = Math.min(extentMaxLog, center + half);
        setYInputs(10 ** nextMin, 10 ** nextMax);
      } else {
        const center = 0.5 * (range.min + range.max);
        const half = 0.5 * (range.max - range.min) * scale;
        const min = Math.max(extent.min, center - half);
        const max = Math.min(extent.max, center + half);
        setYInputs(min, max);
      }
      redrawHistogram();
    }
    function clampRange(min, max, fullMin, fullMax) {
      const span = max - min;
      const fullSpan = fullMax - fullMin;
      if (!(span > 0) || !(fullSpan > 0)) return { min: fullMin, max: fullMax };
      if (span >= fullSpan) return { min: fullMin, max: fullMax };
      if (min < fullMin) {
        max += fullMin - min;
        min = fullMin;
      }
      if (max > fullMax) {
        min -= max - fullMax;
        max = fullMax;
      }
      return { min: Math.max(min, fullMin), max: Math.min(max, fullMax) };
    }
    function zoomPlotWithMouse(event) {
      const frame = state.plotFrame;
      if (!frame) return;
      event.preventDefault();
      const rect = $("plot").getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const scale = event.deltaY < 0 ? 0.82 : 1.22;
      const insideX = px >= frame.ml && px <= frame.ml + frame.pw;
      const insideY = py >= frame.mt && py <= frame.mt + frame.ph;
      const overXAxis = insideX && py > frame.mt + frame.ph && py <= frame.mt + frame.ph + 54;
      const overYAxis = insideY && px >= frame.ml - 64 && px < frame.ml;
      const axis = overXAxis ? "x" : overYAxis ? "y" : "both";

      if ((axis === "x" || axis === "both") && insideX) {
        const full = rowExtent(currentHistogramRows());
        const center = frame.xmin + (px - frame.ml) / frame.pw * (frame.xmax - frame.xmin);
        const min = center - (center - frame.xmin) * scale;
        const max = center + (frame.xmax - center) * scale;
        const next = clampRange(min, max, full.min, full.max);
        setPlotInputs(next.min, next.max);
      }

      if ((axis === "y" || axis === "both") && insideY) {
        const values = yValuesForRows(currentHistogramRows(), state.modelCurve, state.fitRows);
        const full = yExtent(values);
        const yFrac = 1 - (py - frame.mt) / frame.ph;
        if (frame.logMode) {
          const frameMin = Math.log10(frame.ymin);
          const frameMax = Math.log10(frame.ymax);
          const center = frameMin + yFrac * (frameMax - frameMin);
          const min = center - (center - frameMin) * scale;
          const max = center + (frameMax - center) * scale;
          const fullMin = Math.log10(full.min);
          const fullMax = Math.log10(full.max);
          const next = clampRange(min, max, fullMin, fullMax);
          setYInputs(10 ** next.min, 10 ** next.max);
        } else {
          const center = frame.ymin + yFrac * (frame.ymax - frame.ymin);
          const min = center - (center - frame.ymin) * scale;
          const max = center + (frame.ymax - center) * scale;
          const next = clampRange(min, max, full.min, full.max);
          setYInputs(next.min, next.max);
        }
      }
      redrawHistogram();
    }
    function niceStep(span, targetTicks = 8) {
      const raw = Math.abs(span) / Math.max(targetTicks, 1);
      if (!(raw > 0)) return 1;
      const mag = 10 ** Math.floor(Math.log10(raw));
      const norm = raw / mag;
      const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
      return nice * mag;
    }
    function linearTicks(min, max, targetTicks = 8) {
      const step = niceStep(max - min, targetTicks);
      const start = Math.ceil(min / step) * step;
      const ticks = [];
      for (let v = start; v <= max + step * 1e-9; v += step) {
        if (v >= min - step * 1e-9) ticks.push(Number(v.toPrecision(12)));
      }
      return ticks;
    }
    function logTicks(min, max) {
      const major = [];
      const minor = [];
      const lo = Math.floor(Math.log10(min));
      const hi = Math.ceil(Math.log10(max));
      for (let p = lo; p <= hi; p++) {
        const base = 10 ** p;
        for (let m = 1; m < 10; m++) {
          const value = m * base;
          if (value < min || value > max) continue;
          if (m === 1) major.push(value);
          else minor.push(value);
        }
      }
      return { major, minor };
    }
    function tickLabel(value) {
      if (value === 0) return "0";
      const abs = Math.abs(value);
      if (abs >= 1e4 || abs < 1e-3) return value.toExponential(1);
      return Number(value.toPrecision(5)).toString();
    }
    function drawTicks(ctx, frame, transforms) {
      const { ml, mt, pw, ph, xmin, xmax, ymin, ymax, logMode } = frame;
      const { sx, sy } = transforms;
      ctx.save();
      ctx.strokeStyle = "#b8c0cc";
      ctx.fillStyle = "#333";
      ctx.lineWidth = 1;
      ctx.font = "12px Segoe UI, system-ui, sans-serif";

      const xTicks = linearTicks(xmin, xmax, 9);
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const tick of xTicks) {
        const x = sx(tick);
        ctx.beginPath();
        ctx.moveTo(x, mt + ph);
        ctx.lineTo(x, mt + ph + 6);
        ctx.stroke();
        ctx.fillText(tickLabel(tick), x, mt + ph + 9);
      }

      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      if (logMode) {
        const ticks = logTicks(ymin, ymax);
        ctx.strokeStyle = "#d8dee8";
        for (const tick of ticks.minor) {
          const y = sy(tick);
          ctx.beginPath();
          ctx.moveTo(ml - 4, y);
          ctx.lineTo(ml, y);
          ctx.stroke();
        }
        ctx.strokeStyle = "#b8c0cc";
        for (const tick of ticks.major) {
          const y = sy(tick);
          ctx.beginPath();
          ctx.moveTo(ml - 7, y);
          ctx.lineTo(ml, y);
          ctx.stroke();
          ctx.fillText(tickLabel(tick), ml - 10, y);
        }
      } else {
        const yTicks = linearTicks(ymin, ymax, 8);
        for (const tick of yTicks) {
          const y = sy(tick);
          ctx.beginPath();
          ctx.moveTo(ml - 7, y);
          ctx.lineTo(ml, y);
          ctx.stroke();
          ctx.fillText(tickLabel(tick), ml - 10, y);
        }
      }
      ctx.restore();
    }

    async function buildChain() {
      if (!state.decayRows.length) return alert("Load the decay CSV first.");
      const nucleus = $("parentNucleus").value.trim();
      if (!nucleus) return alert("Enter the parent nucleus.");
      const parent = await chooseIsomer(nucleus);
      if (!parent) return alert(`No rows found for ${nucleus}.`);
      const decayType = $("decayType").value;
      const chain = [{ generation: "parent", label: "parent", info: parent, from_branch: null }];
      const daughterInfos = new Map();
      for (let dn = 0; dn < 4; dn++) {
        if (!$(`d${dn}`).checked) continue;
        const name = getDaughterName(parent, decayType, dn);
        const branch = getBranchingInfo(parent.rows, decayType, dn);
        if (!name) continue;
        const info = await chooseIsomer(name);
        if (!info) continue;
        daughterInfos.set(dn, info);
        chain.push({ generation: "daughter", label: `${dn}n daughter`, info, from_branch: branch });
      }
      if ($("includeGd").checked) {
        for (const [dn, daughter] of daughterInfos) {
          if (!$(`g${dn}`).checked) continue;
          const name = getDaughterName(daughter, decayType, 0);
          const branch = getBranchingInfo(daughter.rows, decayType, 0);
          if (!name) continue;
          const info = await chooseIsomer(name);
          if (!info) continue;
          chain.push({ generation: "granddaughter", label: `granddaughter from ${dn}n daughter via beta-/0n`, info, from_branch: branch });
        }
      }
      state.chain = chain;
      state.fitRows = [];
      state.modelCurve = [];
      state.config = null;
      state.branchDraft = null;
      state.granddaughterBranchDraft = null;
      markModelDesignDirty("Decay chain changed. Prepare the fit preview again.");
      applyFitDefaults();
      renderChain();
      status(`Built chain with ${chain.length} states.`);
    }

    function renderChain(extra = "") {
      const unit = $("outputUnit").value;
      const lines = ["FINAL DECAY CHAIN", "=".repeat(80)];
      const table = $("chainTable");
      table.innerHTML = "<thead><tr><th>Type</th><th>Nucleus</th><th>Z</th><th>N</th><th>Energy</th><th>Half-life</th><th>Feeding</th><th>Branch</th></tr></thead><tbody></tbody>";
      const tbody = table.querySelector("tbody");
      for (const entry of state.chain) {
        const info = entry.info;
        const hl = convertHalfLife(info.halflife, info.unit, unit);
        const unc = convertHalfLife(info.halflife_unc, info.unit, unit);
        const feeding = entry.from_branch?.description || "";
        const branch = entry.from_branch ? formatBR(entry.from_branch.branchingRatio, entry.from_branch.branchingRatioUncertainty) : "";
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${entry.label}</td><td>${info.nucleus}</td><td>${info.z}</td><td>${info.n}</td><td>${info.energy}</td><td>${formatValueError(hl, unc, unit)}</td><td>${feeding}</td><td>${branch}</td>`;
        tbody.appendChild(tr);
        lines.push("", entry.label, "-".repeat(80), `Nucleus      : ${info.nucleus}`, `Z, N         : ${info.z}, ${info.n}`, `Level Energy : ${info.energy} MeV`, `Half-life    : ${formatValueError(hl, unc, unit)}`);
        if (feeding) lines.push(`Feeding mode : ${feeding}`, `Feeding BR   : ${branch}`);
        lines.push("Available decay modes:");
        const modeKeys = new Set();
        for (const row of info.rows) {
          const key = `${row.decayMode}|${row.branchingRatio}|${row.branchingRatioUncertainty}`;
          if (modeKeys.has(key)) continue;
          modeKeys.add(key);
          lines.push(`  ${row.decayMode}   ${describeMode(row.decayMode)}   BR=${formatBR(row.branchingRatio, row.branchingRatioUncertainty)}`);
        }
      }
      if (extra) lines.push("", extra);
      $("summary").textContent = lines.join("\n");
    }

    function prepareFitPreview() {
      if (!state.chain.length) return alert("Build the decay chain first.");
      if (!state.histRows.length) return alert("Load the histogram CSV first.");
      const unit = $("outputUnit").value;
      const rebinned = rebinHistogram(state.histRows, Number($("binWidth").value));
      const fitRows = selectFitRange(rebinned, Number($("fitMin").value), Number($("fitMax").value));
      if (!fitRows.length) return alert("Fit range contains no bins.");
      const fitMin = Number($("fitMin").value);
      const fitMax = Number($("fitMax").value);
      const bgType = $("backgroundType").value;
      const bg = estimateBackgroundForType(rebinned, bgType, Number($("bgMin").value), Number($("bgMax").value), fitMin, fitMax);
      const bgHat = Math.max(bg.bg_hat, 0);
      const parent = state.chain[0].info;
      const tParent = convertHalfLife(parent.halflife, parent.unit, unit);
      if (!(tParent > 0)) return alert("Parent half-life is missing or invalid.");
      const daughterHL = {}, daughterHLUnc = {}, daughterBR = {}, gdHL = {}, gdHLUnc = {}, gdBR = {};
      for (const entry of state.chain) {
        if (entry.generation === "daughter") {
          const mode = entry.label.split(" ")[0];
          const t = convertHalfLife(entry.info.halflife, entry.info.unit, unit);
          if (t > 0) {
            daughterHL[mode] = t;
            const unc = convertHalfLife(entry.info.halflife_unc, entry.info.unit, unit);
            if (unc > 0) daughterHLUnc[mode] = unc;
            const br = toNumber(entry.from_branch.branchingRatio) / 100;
            daughterBR[mode] = br > 0 ? br : 1;
          }
        }
        if (entry.generation === "granddaughter") {
          const mode = entry.label.split("from ")[1].split("n daughter")[0] + "n";
          const t = convertHalfLife(entry.info.halflife, entry.info.unit, unit);
          if (t > 0) {
            gdHL[mode] = t;
            const unc = convertHalfLife(entry.info.halflife_unc, entry.info.unit, unit);
            if (unc > 0) gdHLUnc[mode] = unc;
            const br = toNumber(entry.from_branch.branchingRatio) / 100;
            gdBR[mode] = br > 0 ? br : 1;
          }
        }
      }
      const sumBR = Object.values(daughterBR).reduce((a,b) => a + b, 0);
      if (sumBR > 0) for (const k of Object.keys(daughterBR)) daughterBR[k] /= sumBR;
      const a0BgRate = $("useReverseBg").checked ? bgHat : Math.max(estimateTailBgRate(rebinned, fitMax, 5), 0);
      const a0BgSource = $("useReverseBg").checked ? "reverse correlation" : "last 5 bins beyond fit";
      const a0 = estimateA0(fitRows, a0BgRate);
      const bgParams = bg.params;
      const params = { a0, tParent, daughterHL, daughterBR, gdHL, gdBR, bgType, bgParams };
      const curve = fitRows.map(r => modelPoint(params, r.BinCenter, r.BinWidth));
      state.rebinnedRows = rebinned;
      state.fitRows = fitRows;
      state.modelCurve = curve;
      state.config = { parent_nucleus: parent.nucleus, output_unit: unit, histogram_unit: unit, likelihood: $("likelihood").value, background_type: bgType, background_params: bgParams, background_estimate: bg, background_prior_estimates: bg.priors, reverse_bg_range: { low: Number($("bgMin").value), high: Number($("bgMax").value) }, A0_estimate: a0, A0_background_rate: a0BgRate, A0_background_source: a0BgSource, fit_min: fitMin, fit_max: fitMax, t_parent: tParent, daughter_halflives: daughterHL, daughter_halflife_uncertainties: daughterHLUnc, daughter_branches: daughterBR, granddaughter_halflives: gdHL, granddaughter_halflife_uncertainties: gdHLUnc, granddaughter_branches: gdBR, fit_rows: fitRows.length };
      setPlotRangeFromRows(rebinned);
      setYRangeFromRows(rebinned, curve, fitRows);
      redrawHistogram();
      renderChain(["FIT PREVIEW", "=".repeat(80), `Rebinned bins       : ${rebinned.length}`, `Fit bins            : ${fitRows.length}`, `Histogram unit      : ${unit}`, `Background estimate : ${bgHat.toPrecision(6)} counts/${unit}`, `A0 BG rate          : ${a0BgRate.toPrecision(6)} counts/${unit} (${a0BgSource})`, `A0 estimate         : ${a0.toPrecision(6)} counts/${unit}`, `Parent T1/2         : ${tParent.toPrecision(6)} ${unit}`, `Daughter branches   : ${JSON.stringify(daughterBR)}`].join("\n"));
      renderBayesianDesign();
      markModelDesignDirty("Fit preview prepared. Review the priors, then update the model.");
      status("Fit preview prepared.");
      activateTab("plotView");
    }

    function drawPlot(rows, curve = null, options = {}) {
      const canvas = $("plot"), ctx = canvas.getContext("2d");
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(900, Math.floor(rect.width * devicePixelRatio));
      canvas.height = Math.max(450, Math.floor(rect.height * devicePixelRatio));
      ctx.setTransform(1,0,0,1,0,0);
      ctx.clearRect(0,0,canvas.width,canvas.height);
      ctx.scale(devicePixelRatio, devicePixelRatio);
      const w = canvas.width / devicePixelRatio, h = canvas.height / devicePixelRatio;
      ctx.fillStyle = "#fff"; ctx.fillRect(0,0,w,h);
      if (!rows?.length) return;
      const ml = 76, mr = 20, mt = 22, mb = 64, pw = w - ml - mr, ph = h - mt - mb;
      const plotRange = getPlotRange();
      const visibleRows = plotRange ? rows.filter(r => Number(r.BinCenter) >= plotRange.min && Number(r.BinCenter) <= plotRange.max) : rows;
      if (!visibleRows.length) {
        ctx.fillStyle = "#333";
        ctx.fillText("No bins in selected plot range.", ml, mt + 20);
        return;
      }
      const curveRows = options.curveRows || rows;
      const curvePoints = curve
        ? curveRows.map((row, i) => ({ x: Number(row.BinCenter), y: Number(curve[i]) })).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y) && (!plotRange || (p.x >= plotRange.min && p.x <= plotRange.max)))
        : [];
      const xs = visibleRows.map(r => Number(r.BinCenter)), ys = visibleRows.map(r => Number(r.BinContent));
      const xmin = plotRange ? plotRange.min : Math.min(...xs);
      const xmax = plotRange ? plotRange.max : Math.max(...xs);
      const yRange = getYRange([...ys, ...curvePoints.map(p => p.y)]);
      const ymin = yRange.min;
      const ymax = yRange.max;
      state.plotFrame = { ml, mt, pw, ph, xmin, xmax, ymin, ymax, logMode: yRange.logMode };
      const sx = x => ml + (x - xmin) / Math.max(xmax - xmin, 1e-12) * pw;
      const yValue = y => yRange.logMode ? Math.log10(Math.max(y, ymin)) : y;
      const y0 = yValue(ymin);
      const y1 = yValue(ymax);
      const sy = y => mt + ph - (yValue(y) - y0) / Math.max(y1 - y0, 1e-12) * ph;
      ctx.strokeStyle = "#333"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(ml, mt); ctx.lineTo(ml, mt + ph); ctx.lineTo(ml + pw, mt + ph); ctx.stroke();
      drawTicks(ctx, state.plotFrame, { sx, sy });
      const unit = $("outputUnit").value;
      ctx.fillStyle = "#333";
      ctx.textAlign = "center";
      ctx.fillText(`Time (${unit})`, ml + pw / 2, h - 16);
      ctx.save();
      ctx.translate(18, mt + ph / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(yRange.logMode ? "Counts per bin (log)" : "Counts per bin", 0, 0);
      ctx.restore();
      ctx.textAlign = "start";
      const bw = xs.length > 1 ? Math.abs(sx(xs[1]) - sx(xs[0])) * .82 : 4;
      ctx.save();
      ctx.beginPath();
      ctx.rect(ml, mt, pw, ph);
      ctx.clip();
      ctx.fillStyle = "#87a8d0";
      visibleRows.forEach(r => {
        const rawY = Number(r.BinContent);
        if (yRange.logMode && rawY <= 0) return;
        const x = sx(r.BinCenter);
        const y = sy(rawY);
        const base = sy(ymin);
        ctx.fillRect(x - bw/2, y, bw, Math.max(base - y, 1));
      });
      if (curvePoints.length) {
        ctx.strokeStyle = "#bd3d32"; ctx.lineWidth = 2; ctx.beginPath();
        let started = false;
        curvePoints.forEach((p) => {
          if (yRange.logMode && p.y <= 0) return;
          const x = sx(p.x), py = sy(p.y);
          if (started) ctx.lineTo(x, py); else { ctx.moveTo(x, py); started = true; }
        });
        ctx.stroke();
      }
      ctx.restore();
    }

    function priorRow(param, label, dist, mu, sigma, lower = "", upper = "") {
      return `<tr data-param="${esc(param)}">
        <td>${esc(label)}</td>
        <td>
          <select class="prior-dist">
            ${["normal","lognormal","halfnormal","uniform","fixed"].map(d => `<option ${d === dist ? "selected" : ""}>${d}</option>`).join("")}
          </select>
        </td>
        <td><input class="prior-mu" type="number" step="any" value="${esc(mu)}" /></td>
        <td><input class="prior-sigma" type="number" step="any" value="${esc(sigma)}" /></td>
        <td><input class="prior-lower" type="number" step="any" value="${esc(lower)}" /></td>
        <td><input class="prior-upper" type="number" step="any" value="${esc(upper)}" /></td>
        <td class="pymc-preview"></td>
      </tr>`;
    }

    function updatePriorPreviewRow(row) {
      const dist = row.querySelector(".prior-dist")?.value;
      const mu = Number(row.querySelector(".prior-mu")?.value);
      const sigma = Number(row.querySelector(".prior-sigma")?.value);
      const lower = Number(row.querySelector(".prior-lower")?.value);
      const upper = Number(row.querySelector(".prior-upper")?.value);
      const cell = row.querySelector(".pymc-preview");
      if (!cell) return;
      if (dist === "lognormal" && mu > 0 && sigma > 0) {
        cell.textContent = `PyMC mu=${Math.log(mu).toPrecision(6)}, sigma=${Math.log1p(sigma / mu).toPrecision(6)}`;
      } else if (dist === "lognormal") {
        cell.textContent = "natural inputs -> log-space";
      } else if (dist === "fixed" && Number.isFinite(mu)) {
        cell.textContent = `fixed ${mu.toPrecision(6)}`;
      } else if (dist === "uniform" && Number.isFinite(lower) && Number.isFinite(upper)) {
        cell.textContent = `Uniform(${lower.toPrecision(6)}, ${upper.toPrecision(6)})`;
      } else if (dist === "halfnormal" && sigma > 0) {
        cell.textContent = `HalfNormal sigma=${sigma.toPrecision(6)}`;
      } else if (dist === "normal" && Number.isFinite(mu) && sigma > 0) {
        cell.textContent = `Normal mu=${mu.toPrecision(6)}, sigma=${sigma.toPrecision(6)}`;
      } else {
        cell.textContent = "";
      }
    }

    function updatePriorPreviews(root = document) {
      root.querySelectorAll("tr[data-param]").forEach(updatePriorPreviewRow);
    }

    function neutronSortKey(mode) {
      return Number(String(mode).replace("n", ""));
    }
    function betaModeLabel(mode) {
      const text = String(mode);
      const count = text.endsWith("n") ? text.slice(0, -1) : text;
      return count === "0" ? "β⁻" : `β⁻${count}n`;
    }
    function scientificParameterLabel(name) {
      const text = String(name);
      if (text === "b_neutron_sum") return "Σ BR(β⁻xn), x≥1";
      if (text.startsWith("b_") && text.endsWith("n")) return `BR(${betaModeLabel(text.slice(2))})`;
      if (text.startsWith("T_g") && text.endsWith("n")) return `T₁/₂ granddaughter after ${betaModeLabel(text.slice(3))}`;
      if (text.startsWith("T_") && text.endsWith("n")) return `T₁/₂ daughter after ${betaModeLabel(text.slice(2))}`;
      if (text.startsWith("bgd_") && text.endsWith("n")) return `BR(daughter→granddaughter | ${betaModeLabel(text.slice(4))})`;
      if (text === "T_parent") return "Parent T₁/₂";
      if (text === "bkg_rate") return "Background rate";
      if (text === "bkg0") return "Background intercept";
      if (text === "bg_halflife") return "Background T1/2";
      if (text === "bg_amp") return "Background amplitude";
      if (text === "sigma_y") return "Normal likelihood σ";
      return text;
    }
    function daughterModesFromConfig() {
      return Object.keys(state.config?.daughter_halflives || {}).sort((a, b) => neutronSortKey(a) - neutronSortKey(b));
    }
    function granddaughterModesFromConfig() {
      return Object.keys(state.config?.granddaughter_halflives || {}).sort((a, b) => neutronSortKey(a) - neutronSortKey(b));
    }
    function priorRowDraft(row) {
      return {
        dist: row.querySelector(".prior-dist")?.value ?? "halfnormal",
        mu: row.querySelector(".prior-mu")?.value ?? "",
        sigma: row.querySelector(".prior-sigma")?.value ?? "",
        lower: row.querySelector(".prior-lower")?.value ?? "",
        upper: row.querySelector(".prior-upper")?.value ?? ""
      };
    }
    function captureBranchDraft() {
      const table = $("branchTable");
      if (!table || !table.querySelector("tbody")) return state.branchDraft;
      const draft = state.branchDraft || {};
      const mode = $("branchingMode")?.value || draft.mode || "fixed";
      draft.mode = mode;
      draft.fixed = draft.fixed || {};
      draft.dirichlet = draft.dirichlet || {};
      draft.softmax = draft.softmax || {};
      draft.raw = draft.raw || {};
      table.querySelectorAll("tbody tr[data-mode]").forEach(row => {
        const branchMode = row.dataset.mode;
        const fixed = row.querySelector(".b-fixed");
        const alpha = row.querySelector(".b-alpha");
        const loc = row.querySelector(".b-loc");
        if (fixed) draft.fixed[branchMode] = fixed.value;
        if (alpha) draft.dirichlet[branchMode] = alpha.value;
        if (loc) draft.softmax[branchMode] = loc.value;
      });
      table.querySelectorAll("tbody tr[data-param]").forEach(row => {
        draft.raw[row.dataset.param] = priorRowDraft(row);
      });
      const softmaxSigma = $("bSoftmaxSigma");
      if (softmaxSigma) draft.softmax_sigma = softmaxSigma.value;
      state.branchDraft = draft;
      return draft;
    }
    function captureGranddaughterBranchDraft() {
      const table = $("gdBranchTable");
      if (!table || !table.querySelector("tbody")) return state.granddaughterBranchDraft;
      const draft = state.granddaughterBranchDraft || {};
      table.querySelectorAll("tbody tr[data-mode]").forEach(row => {
        const mode = row.dataset.mode;
        draft[mode] = {
          dist: row.querySelector(".gd-dist")?.value ?? "fixed",
          value: row.querySelector(".gd-value")?.value ?? "",
          lower: row.querySelector(".gd-lower")?.value ?? "0",
          upper: row.querySelector(".gd-upper")?.value ?? "1"
        };
      });
      state.granddaughterBranchDraft = draft;
      return draft;
    }
    function captureModelDraftControls() {
      captureBranchDraft();
      captureGranddaughterBranchDraft();
    }
    function renderBranchingDesign() {
      const table = $("branchTable");
      if (!state.config) {
        table.innerHTML = "";
        return;
      }
      const draft = captureBranchDraft() || {};
      const modes = daughterModesFromConfig();
      const mode = $("branchingMode").value;
      if (!modes.length) {
        table.innerHTML = "<tbody><tr><td>No daughter branches in the current chain.</td></tr></tbody>";
        return;
      }
      if (mode === "fixed") {
        table.innerHTML = `<thead><tr><th>Branch</th><th>Fixed fraction</th></tr></thead><tbody>${
          modes.map(m => `<tr data-mode="${esc(m)}"><td>${esc(betaModeLabel(m))}</td><td><input class="b-fixed" type="number" step="any" min="0" max="1" value="${esc(draft.fixed?.[m] ?? state.config.daughter_branches?.[m] ?? "")}" /></td></tr>`).join("")
        }</tbody>`;
      } else if (mode === "dirichlet") {
        table.innerHTML = `<thead><tr><th>Branch</th><th>Dirichlet alpha</th></tr></thead><tbody>${
          modes.map(m => `<tr data-mode="${esc(m)}"><td>${esc(betaModeLabel(m))}</td><td><input class="b-alpha" type="number" step="any" min="0.000001" value="${esc(draft.dirichlet?.[m] ?? "1")}" /></td></tr>`).join("")
        }</tbody>`;
      } else if (mode === "softmax") {
        table.innerHTML = `<thead><tr><th>Parameter</th><th>Value</th></tr></thead><tbody>
          ${modes.map(m => `<tr data-mode="${esc(m)}"><td>logit loc ${esc(betaModeLabel(m))}</td><td><input class="b-loc" type="number" step="any" value="${esc(draft.softmax?.[m] ?? "0")}" /></td></tr>`).join("")}
          <tr><td>logit sigma</td><td><input id="bSoftmaxSigma" type="number" step="any" min="0.000001" value="${esc(draft.softmax_sigma ?? "1")}" /></td></tr>
        </tbody>`;
      } else {
        table.innerHTML = `<thead><tr><th>Parameter</th><th>Distribution</th><th>Mu / Value</th><th>Sigma</th><th>Lower</th><th>Upper</th><th>PyMC Preview</th></tr></thead><tbody>${
          modes.map((m, i) => {
            const param = `b_raw${i}`;
            const raw = draft.raw?.[param] || {};
            return priorRow(param, `Raw branch weight ${betaModeLabel(m)}`, raw.dist || "halfnormal", raw.mu ?? "", raw.sigma ?? "1", raw.lower ?? "", raw.upper ?? "");
          }).join("")
        }</tbody>`;
        updatePriorPreviews(table);
      }
    }
    function renderGranddaughterBranchDesign() {
      const table = $("gdBranchTable");
      if (!state.config) {
        table.innerHTML = "";
        return;
      }
      const draft = captureGranddaughterBranchDraft() || {};
      const modes = granddaughterModesFromConfig();
      if (!modes.length) {
        table.innerHTML = "<tbody><tr><td>No granddaughter branches in the current chain.</td></tr></tbody>";
        return;
      }
      table.innerHTML = `<thead><tr><th>From Daughter</th><th>Prior</th><th>Fixed value</th><th>Lower</th><th>Upper</th></tr></thead><tbody>${
        modes.map(m => {
          const saved = draft[m] || {};
          const dist = saved.dist || "fixed";
          return `<tr data-mode="${esc(m)}">
          <td>${esc(betaModeLabel(m))}</td>
          <td><select class="gd-dist"><option value="fixed" ${dist === "fixed" ? "selected" : ""}>fixed</option><option value="uniform" ${dist === "uniform" ? "selected" : ""}>uniform</option></select></td>
          <td><input class="gd-value" type="number" step="any" min="0" max="1" value="${esc(saved.value ?? state.config.granddaughter_branches?.[m] ?? 1)}" /></td>
          <td><input class="gd-lower" type="number" step="any" min="0" max="1" value="${esc(saved.lower ?? "0")}" /></td>
          <td><input class="gd-upper" type="number" step="any" min="0" max="1" value="${esc(saved.upper ?? "1")}" /></td>
        </tr>`;
        }).join("")
      }</tbody>`;
    }

    function capturePosteriorPlotSelection() {
      const rows = [...document.querySelectorAll("#posteriorVarTable tbody tr[data-var]")];
      if (!rows.length) return;
      state.plotVarSelection = {
        distributions: rows.filter(r => r.querySelector(".plot-dist")?.checked).map(r => r.dataset.var),
        corner: rows.filter(r => r.querySelector(".plot-corner")?.checked).map(r => r.dataset.var),
        names: rows.map(r => r.dataset.var),
        touched: true
      };
    }

    function expectedPosteriorVariables() {
      const cfg = state.config;
      if (!cfg) return [];
      const vars = [];
      const seen = new Set();
      function add(name, label, distDefault = true, cornerDefault = false) {
        if (!name || seen.has(name)) return;
        seen.add(name);
        vars.push({ name, label, distDefault, cornerDefault });
      }

      add("A0", "A0", true, true);
      add("T_parent", `Parent T1/2 (${cfg.output_unit})`, true, true);
      const daughterModes = daughterModesFromConfig();
      const branchingMode = $("branchingMode").value;
      daughterModes.forEach((mode, index) => {
        add(`b_${mode}`, `Branching ratio for ${betaModeLabel(mode)} (${mode})`, true, true);
      });
      if (daughterModes.some(mode => neutronSortKey(mode) > 0)) {
        add("b_neutron_sum", "Sum of neutron-emission beta branches; excludes β⁻", true, true);
      }
      if (branchingMode === "dirichlet" || branchingMode === "softmax" || branchingMode === "normalized_raw") {
        daughterModes.forEach((mode, index) => add(`b[${index}]`, `branch vector ${index} for ${betaModeLabel(mode)}`, false, false));
      }
      if (branchingMode === "softmax") {
        daughterModes.forEach((mode, index) => add(`logits[${index}]`, `softmax logit for ${betaModeLabel(mode)}`, false, false));
      }
      if (branchingMode === "normalized_raw") {
        daughterModes.forEach((mode, index) => add(`b_raw${index}`, `raw branch weight for ${betaModeLabel(mode)}`, false, false));
      }
      for (const mode of daughterModesFromConfig()) {
        add(`T_${mode}`, `${mode} daughter T1/2`, true, false);
      }
      for (const mode of granddaughterModesFromConfig()) {
        add(`T_g${mode}`, `${mode} granddaughter T1/2`, true, false);
      }

      if (cfg.background_type === "constant") {
        add("bkg_rate", "Background rate", true, false);
      } else if (cfg.background_type === "linear") {
        add("bkg0", "Background intercept", true, false);
        add("slope", "Background slope", true, false);
      } else if (cfg.background_type === "exponential") {
        add("bg_amp", "Background amplitude", true, false);
        add("bg_halflife", "Background T1/2", true, false);
      }
      if ($("likelihood").value === "normal") add("sigma_y", "Normal likelihood sigma", true, false);

      for (const mode of granddaughterModesFromConfig()) {
        add(`bgd_${mode}`, `granddaughter branch ${mode}`, true, false);
      }
      return vars;
    }

    function renderPosteriorPlotSelection() {
      capturePosteriorPlotSelection();
      const table = $("posteriorVarTable");
      if (!state.config) {
        table.innerHTML = "";
        return;
      }
      const vars = expectedPosteriorVariables();
      const saved = state.plotVarSelection || { distributions: [], corner: [], names: [], touched: false };
      const savedDist = new Set(saved.distributions || []);
      const savedCorner = new Set(saved.corner || []);
      const savedNames = new Set(saved.names || []);
      table.innerHTML = `<thead><tr><th>Posterior</th><th>Distribution</th><th>Corner</th></tr></thead><tbody>${
        vars.map(v => {
          const hadSaved = saved.touched && savedNames.has(v.name);
          const distChecked = hadSaved ? savedDist.has(v.name) : v.distDefault;
          const cornerChecked = hadSaved ? savedCorner.has(v.name) : v.cornerDefault;
          return `<tr data-var="${esc(v.name)}">
            <td><strong>${esc(scientificParameterLabel(v.name))}</strong><br><span class="pymc-preview">${esc(v.name)} · ${esc(v.label)}</span></td>
            <td><input class="plot-dist" type="checkbox" ${distChecked ? "checked" : ""} /></td>
            <td><input class="plot-corner" type="checkbox" ${cornerChecked ? "checked" : ""} /></td>
          </tr>`;
        }).join("")
      }</tbody>`;
      capturePosteriorPlotSelection();
    }

    function setPosteriorPlotColumn(column, checked) {
      const selector = column === "corner" ? ".plot-corner" : ".plot-dist";
      document.querySelectorAll(`#posteriorVarTable ${selector}`).forEach(input => { input.checked = checked; });
      capturePosteriorPlotSelection();
    }

    function selectedPosteriorPlotVariables() {
      capturePosteriorPlotSelection();
      return {
        distributions: [...(state.plotVarSelection.distributions || [])],
        corner: [...(state.plotVarSelection.corner || [])]
      };
    }

    function renderBayesianDesign() {
      const table = $("priorTable");
      if (!state.config) {
        table.innerHTML = "";
        $("branchTable").innerHTML = "";
        $("gdBranchTable").innerHTML = "";
        $("posteriorVarTable").innerHTML = "";
        return;
      }
      captureModelDraftControls();
      const cfg = state.config;
      const rows = [];
      if ($("useA0Estimate").checked) {
        const a0Bins = a0EarlyBinCount();
        const a0Rel = a0PriorRelSigma();
        const a0BgRate = a0BackgroundRate();
        const a0Hat = estimateA0(state.fitRows, a0BgRate, a0Bins);
        const a0SigmaNatural = Math.max(a0Hat * (Math.exp(a0Rel) - 1), 1e-12);
        cfg.A0_estimate = a0Hat;
        cfg.A0_n_early_bins = a0Bins;
        cfg.A0_prior_rel_sigma = a0Rel;
        cfg.A0_background_rate = a0BgRate;
        cfg.A0_background_source = $("useReverseBg").checked ? "reverse correlation" : "last 5 bins beyond fit";
        rows.push(priorRow("A0", `A0 (${a0Bins} early bins)`, "lognormal", Math.max(a0Hat, 1e-12).toPrecision(6), a0SigmaNatural.toPrecision(6)));
      } else {
        rows.push(priorRow("A0", "A0", "lognormal", "", ""));
      }
      rows.push(priorRow("T_parent", `Parent T1/2 (${cfg.output_unit})`, "normal", cfg.t_parent.toPrecision(6), Math.max(cfg.t_parent, 1e-12).toPrecision(6)));
      for (const [mode, value] of Object.entries(cfg.daughter_halflives || {})) {
        const unc = cfg.daughter_halflife_uncertainties?.[mode];
        rows.push(priorRow(`T_${mode}`, `Daughter T₁/₂ after ${betaModeLabel(mode)} (${cfg.output_unit})`, "normal", Number(value).toPrecision(6), Number(unc) > 0 ? Number(unc).toPrecision(6) : ""));
      }
      for (const [mode, value] of Object.entries(cfg.granddaughter_halflives || {})) {
        const unc = cfg.granddaughter_halflife_uncertainties?.[mode];
        rows.push(priorRow(`T_g${mode}`, `Granddaughter T₁/₂ after ${betaModeLabel(mode)} (${cfg.output_unit})`, "normal", Number(value).toPrecision(6), Number(unc) > 0 ? Number(unc).toPrecision(6) : ""));
      }
      const useReverse = $("useReverseBg").checked;
      const bgPriors = useReverse ? (cfg.background_prior_estimates || {}) : {};
      if (cfg.background_type === "constant") {
        const spec = bgPriors.bkg_rate || {};
        rows.push(priorRow("bkg_rate", `Background (counts/${cfg.output_unit})`, spec.dist || "normal", spec.mu ?? "", spec.sigma ?? ""));
      } else if (cfg.background_type === "linear") {
        const bkg0 = bgPriors.bkg0 || {};
        const slope = bgPriors.slope || {};
        rows.push(priorRow("bkg0", `Background intercept (counts/${cfg.output_unit})`, bkg0.dist || "normal", bkg0.mu ?? "", bkg0.sigma ?? ""));
        rows.push(priorRow("slope", `Background slope`, slope.dist || "normal", slope.mu ?? "", slope.sigma ?? ""));
      } else if (cfg.background_type === "exponential") {
        const amp = bgPriors.bg_amp || {};
        const half = bgPriors.bg_halflife || {};
        rows.push(priorRow("bg_amp", `Background amplitude`, amp.dist || "normal", amp.mu ?? "", amp.sigma ?? ""));
        rows.push(priorRow("bg_halflife", `Background T1/2 (${cfg.output_unit})`, half.dist || "normal", half.mu ?? "", half.sigma ?? ""));
      }
      if ($("likelihood").value === "normal") {
        cfg.likelihood = "normal";
        const y = state.fitRows.map(r => Number(r.BinContent)).filter(Number.isFinite);
        const mean = y.reduce((a, b) => a + b, 0) / Math.max(y.length, 1);
        const variance = y.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(y.length, 1);
        rows.push(priorRow("sigma_y", "Normal likelihood sigma", "halfnormal", "", Math.max(Math.sqrt(variance), 1).toPrecision(6)));
      } else {
        cfg.likelihood = $("likelihood").value;
      }
      table.innerHTML = `<thead><tr><th>Parameter</th><th>Distribution</th><th>Mu / Value</th><th>Sigma</th><th>Lower</th><th>Upper</th><th>PyMC Preview</th></tr></thead><tbody>${rows.join("")}</tbody>`;
      updatePriorPreviews(table);
      renderBranchingDesign();
      renderGranddaughterBranchDesign();
      renderPosteriorPlotSelection();
    }

    function collectBayesianDesign() {
      const priors = {};
      const errors = [];
      function collectPriorRows(selector) {
        document.querySelectorAll(selector).forEach(row => {
        const param = row.dataset.param;
        const label = row.cells[0]?.textContent?.trim() || param;
        const dist = row.querySelector(".prior-dist").value;
        const mu = Number(row.querySelector(".prior-mu").value);
        const sigma = Number(row.querySelector(".prior-sigma").value);
        const lower = Number(row.querySelector(".prior-lower").value);
        const upper = Number(row.querySelector(".prior-upper").value);
        const spec = { dist };
        if (dist === "fixed") {
          if (!Number.isFinite(mu)) errors.push(`${label}: enter a fixed value in Mu / Value.`);
          spec.value = mu;
        }
        else if (dist === "uniform") {
          if (!Number.isFinite(lower) || !Number.isFinite(upper)) errors.push(`${label}: enter lower and upper values.`);
          else if (lower >= upper) errors.push(`${label}: lower must be less than upper.`);
          spec.lower = lower;
          spec.upper = upper;
        } else if (dist === "halfnormal") {
          if (!Number.isFinite(sigma) || sigma <= 0) errors.push(`${label}: enter a positive sigma.`);
          spec.sigma = sigma;
        } else if (dist === "lognormal") {
          if (!Number.isFinite(mu) || mu <= 0) errors.push(`${label}: enter a positive mu value for lognormal.`);
          if (!Number.isFinite(sigma) || sigma <= 0) errors.push(`${label}: enter a positive sigma for lognormal.`);
          spec.scale = "natural";
          spec.mu = mu;
          spec.sigma = sigma;
        } else {
          if (!Number.isFinite(mu)) errors.push(`${label}: enter a mu value.`);
          if (!Number.isFinite(sigma) || sigma <= 0) errors.push(`${label}: enter a positive sigma.`);
          spec.mu = mu;
          spec.sigma = sigma;
        }
        priors[param] = spec;
        });
      }
      collectPriorRows("#priorTable tbody tr[data-param]");
      const branchingMode = $("branchingMode").value;
      const fixedBranches = {};
      if (branchingMode === "fixed") {
        document.querySelectorAll("#branchTable tbody tr[data-mode]").forEach(row => {
          const mode = row.dataset.mode;
          const value = Number(row.querySelector(".b-fixed").value);
          if (!Number.isFinite(value) || value < 0 || value > 1) errors.push(`Fixed branch ${mode}: enter a value from 0 to 1.`);
          fixedBranches[mode] = value;
        });
        const totalFixed = Object.values(fixedBranches).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
        if (Object.keys(fixedBranches).length && Math.abs(totalFixed - 1) > 1e-6) {
          errors.push(`Fixed neutron branches must sum to 1. Current sum is ${totalFixed.toPrecision(6)}.`);
        }
      } else if (branchingMode === "dirichlet") {
        const alpha = [];
        document.querySelectorAll("#branchTable tbody tr[data-mode]").forEach(row => {
          const mode = row.dataset.mode;
          const value = Number(row.querySelector(".b-alpha").value);
          if (!Number.isFinite(value) || value <= 0) errors.push(`Dirichlet alpha ${mode}: enter a positive value.`);
          alpha.push(value);
        });
        priors.b_dirichlet_alpha = alpha;
      } else if (branchingMode === "softmax") {
        const loc = [];
        document.querySelectorAll("#branchTable tbody tr[data-mode]").forEach(row => {
          const mode = row.dataset.mode;
          const value = Number(row.querySelector(".b-loc").value);
          if (!Number.isFinite(value)) errors.push(`Softmax loc ${mode}: enter a value.`);
          loc.push(value);
        });
        const sigma = Number($("bSoftmaxSigma")?.value);
        if (!Number.isFinite(sigma) || sigma <= 0) errors.push("Softmax sigma: enter a positive value.");
        priors.b_softmax_loc = loc;
        priors.b_softmax_sigma = sigma;
      } else if (branchingMode === "normalized_raw") {
        collectPriorRows("#branchTable tbody tr[data-param]");
      }
      const granddaughterBranchSpecs = {};
      document.querySelectorAll("#gdBranchTable tbody tr[data-mode]").forEach(row => {
        const mode = row.dataset.mode;
        const dist = row.querySelector(".gd-dist").value;
        if (dist === "fixed") {
          const value = Number(row.querySelector(".gd-value").value);
          if (!Number.isFinite(value) || value < 0 || value > 1) errors.push(`Granddaughter branch ${mode}: fixed value must be from 0 to 1.`);
          granddaughterBranchSpecs[mode] = { dist: "fixed", value };
        } else {
          const lower = Number(row.querySelector(".gd-lower").value);
          const upper = Number(row.querySelector(".gd-upper").value);
          if (!Number.isFinite(lower) || !Number.isFinite(upper)) errors.push(`Granddaughter branch ${mode}: enter lower and upper values.`);
          else if (lower < 0 || upper > 1 || lower >= upper) errors.push(`Granddaughter branch ${mode}: uniform range must satisfy 0 <= lower < upper <= 1.`);
          granddaughterBranchSpecs[mode] = { dist: "uniform", lower, upper };
        }
      });
      if (errors.length) throw new Error(errors.join("\n"));
      return {
        use_reverse_background: $("useReverseBg").checked,
        reverse_background_range: state.config?.reverse_bg_range || null,
        estimate_A0: $("useA0Estimate").checked,
        A0_n_early_bins: a0EarlyBinCount(),
        A0_prior_rel_sigma: a0PriorRelSigma(),
        sampling: {
          draws: Number($("bayesDraws").value),
          tune: Number($("bayesTune").value),
          chains: Number($("bayesChains").value),
          cores: Number($("bayesCores").value),
          target_accept: Number($("bayesTargetAccept").value)
        },
        branching_mode: branchingMode,
        fixed_daughter_branches: fixedBranches,
        granddaughter_branch_specs: granddaughterBranchSpecs,
        plot_variables: selectedPosteriorPlotVariables(),
        priors
      };
    }

    function setModelDesignStatus(text, isError = false) {
      const el = $("modelDesignStatus");
      if (!el) return;
      el.textContent = text;
      el.style.color = isError ? "var(--red)" : "var(--muted)";
    }

    function markModelDesignDirty(reason = "Model design changed. Update the model before exporting or running.") {
      state.modelPayloadDirty = true;
      state.modelPayload = null;
      setModelDesignStatus(reason);
    }

    function updateModelDesignSnapshot(options = {}) {
      const quiet = Boolean(options.quiet);
      if (!state.config || !state.fitRows.length) {
        const message = "Prepare the fit preview first.";
        setModelDesignStatus(message, true);
        throw new Error(message);
      }
      captureModelDraftControls();
      const design = collectBayesianDesign();
      const config = cloneData(state.config);
      config.daughter_branching_mode = design.branching_mode;
      config.daughter_branches = effectiveDaughterBranchSummary(config, design);
      config.daughter_branch_design = {
        mode: design.branching_mode,
        fixed_daughter_branches: cloneData(design.fixed_daughter_branches || {}),
        b_dirichlet_alpha: cloneData(design.priors?.b_dirichlet_alpha || null),
        b_softmax_loc: cloneData(design.priors?.b_softmax_loc || null),
        b_softmax_sigma: design.priors?.b_softmax_sigma ?? null
      };
      state.config.daughter_branching_mode = config.daughter_branching_mode;
      state.config.daughter_branches = cloneData(config.daughter_branches);
      state.config.daughter_branch_design = cloneData(config.daughter_branch_design);
      const payload = {
        config,
        fit_rows: cloneData(state.fitRows),
        design
      };
      payload.design.updated_at = new Date().toISOString();
      state.modelPayload = payload;
      state.modelPayloadDirty = false;
      if (!quiet) {
        setModelDesignStatus(`Model updated with ${Object.keys(design.priors || {}).length} prior entries.`);
        status("Bayesian model design updated.");
      }
      return payload;
    }

    function currentModelPayload(options = {}) {
      if (!state.modelPayload || state.modelPayloadDirty || options.forceUpdate) {
        return updateModelDesignSnapshot({ quiet: Boolean(options.quiet) });
      }
      return cloneData(state.modelPayload);
    }

    function normalizeBranchObject(values) {
      const finiteEntries = Object.entries(values || {})
        .map(([mode, value]) => [mode, Number(value)])
        .filter(([, value]) => Number.isFinite(value) && value >= 0);
      const total = finiteEntries.reduce((sum, [, value]) => sum + value, 0);
      if (total <= 0) return {};
      return Object.fromEntries(finiteEntries.map(([mode, value]) => [mode, value / total]));
    }

    function effectiveDaughterBranchSummary(config, design) {
      const modes = Object.keys(config?.daughter_halflives || {}).sort((a, b) => neutronSortKey(a) - neutronSortKey(b));
      if (!modes.length) return {};
      const branchingMode = String(design?.branching_mode || "fixed").toLowerCase();
      if (branchingMode === "fixed") {
        return normalizeBranchObject(design.fixed_daughter_branches || {});
      }
      if (branchingMode === "dirichlet") {
        const alpha = design.priors?.b_dirichlet_alpha || [];
        return normalizeBranchObject(Object.fromEntries(modes.map((mode, i) => [mode, alpha[i] ?? 1])));
      }
      if (branchingMode === "softmax") {
        const loc = modes.map((mode, i) => Number(design.priors?.b_softmax_loc?.[i] ?? 0));
        const maxLoc = Math.max(...loc.filter(Number.isFinite), 0);
        const weights = Object.fromEntries(modes.map((mode, i) => {
          const value = Number.isFinite(loc[i]) ? Math.exp(loc[i] - maxLoc) : 1;
          return [mode, value];
        }));
        return normalizeBranchObject(weights);
      }
      if (branchingMode === "normalized_raw") {
        const weights = {};
        modes.forEach((mode, i) => {
          const spec = design.priors?.[`b_raw${i}`] || {};
          const dist = String(spec.dist || "").toLowerCase();
          let value = Number.NaN;
          if (dist === "fixed") value = Number(spec.value);
          else if (dist === "uniform") value = 0.5 * (Number(spec.lower) + Number(spec.upper));
          else if (dist === "lognormal" || dist === "normal") value = Number(spec.mu);
          else if (dist === "halfnormal") value = Number(spec.sigma);
          weights[mode] = Number.isFinite(value) && value > 0 ? value : Number(config.daughter_branches?.[mode] ?? 1);
        });
        return normalizeBranchObject(weights);
      }
      return normalizeBranchObject(config.daughter_branches || {});
    }

    function setBayesianRunControls(running) {
      state.bayesianRunActive = running;
      const runButton = $("runBayesian");
      const cancelButton = $("cancelBayesian");
      const rerunButton = $("rerunBayesian");
      if (runButton) runButton.disabled = running;
      if (cancelButton) cancelButton.disabled = !running || !state.bayesianJob;
      if (rerunButton) rerunButton.disabled = running || !state.lastBayesianPayload;
    }

    async function submitBayesianPayload(payload, label = "Submitting Bayesian model...") {
      const logBox = $("progressLog");
      logBox.textContent = `${label}\n`;
      activateTab("runView");
      setBayesianRunControls(true);
      try {
        const response = await fetch("/api/run-bayesian", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!response.ok) throw new Error(await response.text());
        const data = await response.json();
        state.bayesianJob = data.job_id;
        state.lastBayesianPayload = cloneData(payload);
        setBayesianRunControls(true);
        pollBayesianJob(data.job_id);
      } catch (error) {
        logBox.textContent += `\nCould not start the model run.\n${error.message}\n\nStart the GUI with python full_software_gui.py so the local Python runner is available.`;
        state.bayesianJob = null;
        setBayesianRunControls(false);
      }
    }

    async function runBayesianModel() {
      if (!state.config || !state.fitRows.length) return alert("Prepare the fit preview first.");
      let payload;
      try {
        payload = currentModelPayload({ forceUpdate: true, quiet: false });
      } catch (error) {
        $("progressLog").textContent = error.message;
        alert(error.message);
        return;
      }
      submitBayesianPayload(payload);
    }

    function rerunBayesianModel() {
      if (!state.lastBayesianPayload) return alert("No previous Bayesian model run is available to rerun.");
      submitBayesianPayload(cloneData(state.lastBayesianPayload), "Submitting previous Bayesian model...");
    }

    async function cancelBayesianModel() {
      if (!state.bayesianJob || !state.bayesianRunActive) return;
      const jobId = state.bayesianJob;
      $("cancelBayesian").disabled = true;
      $("progressLog").textContent += "\nCancel requested. Waiting for the runner to stop...\n";
      try {
        const response = await fetch(`/api/jobs/${jobId}/cancel`, { method: "POST" });
        if (!response.ok) throw new Error(await response.text());
      } catch (error) {
        $("progressLog").textContent += `\nCould not request cancellation: ${error.message}`;
        setBayesianRunControls(true);
      }
    }

    async function pollBayesianJob(jobId) {
      const logBox = $("progressLog");
      const response = await fetch(`/api/jobs/${jobId}`);
      const job = await response.json();
      if (state.bayesianJob !== jobId) return;
      logBox.textContent = (job.log || []).join("\n");
      logBox.scrollTop = logBox.scrollHeight;
      status(job.status === "complete" ? "Bayesian model complete." : job.status === "error" ? "Bayesian model failed." : job.status === "canceled" ? "Bayesian model canceled." : job.status === "canceling" ? "Canceling Bayesian model..." : "Bayesian model running...");
      if (job.status === "complete") {
        state.bayesianResult = job.result;
        state.bayesianJob = null;
        setBayesianRunControls(false);
        renderBayesianResults(job.result);
        activateTab("resultsView");
        return;
      }
      if (job.status === "error") {
        logBox.textContent += `\n\n${job.error || "Unknown error"}`;
        state.bayesianJob = null;
        setBayesianRunControls(false);
        return;
      }
      if (job.status === "canceled") {
        state.bayesianJob = null;
        setBayesianRunControls(false);
        return;
      }
      setTimeout(() => pollBayesianJob(jobId), 1500);
    }

    function renderBayesianResults(result) {
      const table = $("resultSummary");
      const rows = result.summary || [];
      const cols = ["parameter", "mean", "std", "median", "hdi_16%", "hdi_84%"];
      table.innerHTML = cols.length
        ? `<thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${cols.map(c => `<td>${esc(r[c])}</td>`).join("")}</tr>`).join("")}</tbody>`
        : "";
      const plots = result.plots || {};
      const savedLines = [];
      if (result.result_dir) savedLines.push(`Result folder: ${result.result_dir}`);
      savedLines.push(result.inference_data_path
        ? `Saved NetCDF: ${result.inference_data_path}`
        : "No NetCDF file was saved for this run.");
      if (result.saved_files) savedLines.push(`Saved files: ${Object.keys(result.saved_files).length}`);
      $("ncPath").textContent = savedLines.join("\n");
      const imageMap = [
        ["ppcPlot", plots.ppc],
        ["distPlot", plots.distributions],
        ["cornerPlot", plots.corner],
      ];
      imageMap.forEach(([id, src]) => {
        const img = $(id);
        if (src) {
          img.src = src;
          img.style.display = "block";
        } else {
          img.removeAttribute("src");
          img.style.display = "none";
        }
      });
    }

    function exportConfig() {
      if (!state.config) return alert("Prepare the fit preview first.");
      let payload;
      try {
        payload = currentModelPayload({ forceUpdate: true, quiet: false });
      } catch (error) {
        alert(error.message);
        return;
      }
      downloadText("full_software_pymc_model_snapshot.json", JSON.stringify(payload, null, 2), "application/json");
    }

    function utf8ToBase64(text) {
      const bytes = new TextEncoder().encode(text);
      let binary = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode(...chunk);
      }
      return btoa(binary);
    }

    function downloadText(filename, text, type = "text/plain") {
      const blob = new Blob([text], { type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    }

    function makeBayesianPayload() {
      return currentModelPayload({ forceUpdate: true, quiet: false });
    }

    function pythonString(value) {
      return JSON.stringify(String(value));
    }

    function exportedPythonScript(payload) {
      if (!window.DecayPythonExporter?.exportedPythonScript) {
        throw new Error("Python exporter module is not loaded.");
      }
      return window.DecayPythonExporter.exportedPythonScript(payload);
    }

    function exportPythonRunner() {
      let payload;
      try {
        payload = makeBayesianPayload();
      } catch (error) {
        alert(error.message);
        return;
      }
      const nucleus = String(payload.config?.parent_nucleus || "nucleus").replace(/[^A-Za-z0-9_-]+/g, "_") || "nucleus";
      downloadText(`${nucleus}_bayesian_run.py`, exportedPythonScript(payload), "text/x-python");
    }

    async function loadFile(fileInput, kind) {
      const file = fileInput.files[0];
      if (!file) return;
      const rows = parseCSV(await file.text());
      if (kind === "decay") {
        const missing = requiredDecayColumns.filter(c => !(c in (rows[0] || {})));
        if (missing.length) return alert(`Missing decay CSV columns: ${missing.join(", ")}`);
        state.decayRows = rows;
        status(`Loaded decay CSV with ${rows.length.toLocaleString()} rows.`);
      } else {
        if (!("BinCenter" in (rows[0] || {})) || !("BinContent" in (rows[0] || {}))) return alert("Histogram CSV needs BinCenter and BinContent columns.");
        state.histRows = rows.map(r => ({ ...r, BinCenter: Number(r.BinCenter), BinContent: Number(r.BinContent), BinWidth: Number(r.BinWidth || NaN) }));
        state.rebinnedRows = [];
        state.fitRows = [];
        state.modelCurve = [];
        state.config = null;
        state.branchDraft = null;
        state.granddaughterBranchDraft = null;
        markModelDesignDirty("Histogram changed. Prepare the fit preview again.");
        const xs = state.histRows.map(r => r.BinCenter).filter(Number.isFinite);
        if (xs.length && !state.chain.length) { $("fitMin").value = Math.min(...xs); $("fitMax").value = Math.max(...xs); }
        applyFitDefaults();
        setPlotRangeFromRows(state.histRows);
        setYRangeFromRows(state.histRows);
        redrawHistogram();
        status(`Loaded histogram CSV with ${rows.length.toLocaleString()} bins.`);
      }
    }

    function activateTab(id) {
      document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === id));
      document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === id));
      if (id === "plotView" && currentHistogramRows().length) requestAnimationFrame(redrawHistogram);
    }

    function init() {
      $("outputUnit").innerHTML = validUnits.map(u => `<option ${u === "ms" ? "selected" : ""}>${u}</option>`).join("");
      $("daughterChecks").innerHTML = [0,1,2,3].map(i => `<label><input id="d${i}" type="checkbox" ${i === 0 ? "checked" : ""} /> ${esc(betaModeLabel(`${i}n`))}</label>`).join("");
      $("granddaughterChecks").innerHTML = [0,1,2,3].map(i => `<label><input id="g${i}" type="checkbox" ${i === 0 ? "checked" : ""} /> from ${esc(betaModeLabel(`${i}n`))}</label>`).join("");
      $("decayFile").addEventListener("change", e => loadFile(e.target, "decay"));
      $("histFile").addEventListener("change", e => loadFile(e.target, "hist"));
      $("outputUnit").addEventListener("change", updateUnitLabels);
      $("useReverseBg").addEventListener("change", renderBayesianDesign);
      $("useA0Estimate").addEventListener("change", renderBayesianDesign);
      $("a0EarlyBins").addEventListener("input", renderBayesianDesign);
      $("a0RelSigma").addEventListener("input", renderBayesianDesign);
      $("branchingMode").addEventListener("change", () => {
        renderBranchingDesign();
        renderPosteriorPlotSelection();
      });
      $("plotDistAll").addEventListener("click", () => setPosteriorPlotColumn("distributions", true));
      $("plotDistNone").addEventListener("click", () => setPosteriorPlotColumn("distributions", false));
      $("plotCornerAll").addEventListener("click", () => setPosteriorPlotColumn("corner", true));
      $("plotCornerNone").addEventListener("click", () => setPosteriorPlotColumn("corner", false));
      $("posteriorVarTable").addEventListener("change", capturePosteriorPlotSelection);
      document.addEventListener("input", event => {
        const row = event.target.closest?.("tr[data-param]");
        if (row) updatePriorPreviewRow(row);
        if (event.target.closest?.("#bayesDesignView")) markModelDesignDirty();
      });
      document.addEventListener("change", event => {
        const row = event.target.closest?.("tr[data-param]");
        if (row) updatePriorPreviewRow(row);
        if (event.target.closest?.("#bayesDesignView")) markModelDesignDirty();
      });
      $("likelihood").addEventListener("change", () => {
        if (state.config) state.config.likelihood = $("likelihood").value;
        renderBayesianDesign();
      });
      $("buildChain").addEventListener("click", buildChain);
      $("previewFit").addEventListener("click", prepareFitPreview);
      $("updateModelDesign").addEventListener("click", () => {
        try {
          updateModelDesignSnapshot();
        } catch (error) {
          alert(error.message);
        }
      });
      $("exportConfig").addEventListener("click", exportConfig);
      $("exportPythonRunner").addEventListener("click", exportPythonRunner);
      $("runBayesian").addEventListener("click", runBayesianModel);
      $("cancelBayesian").addEventListener("click", cancelBayesianModel);
      $("rerunBayesian").addEventListener("click", rerunBayesianModel);
      $("resetPlotView").addEventListener("click", fullPlotRange);
      $("plot").addEventListener("wheel", zoomPlotWithMouse, { passive: false });
      $("yScale").addEventListener("change", fullPlotRange);
      document.querySelectorAll(".tab").forEach(button => button.addEventListener("click", () => activateTab(button.dataset.tab)));
      $("summary").textContent = "Load the decay CSV, choose a parent nucleus, build the chain, then load a histogram and preview the Bateman fit.";
      setBayesianRunControls(false);
      updateUnitLabels();
    }
    function updateUnitLabels() {
      const unit = $("outputUnit").value;
      document.querySelectorAll(".unit-label").forEach(label => label.textContent = unit);
      applyFitDefaults();
      if (currentHistogramRows().length) redrawHistogram();
    }
    Object.assign(window, {
      fullSoftwareState: state,
      buildChain,
      prepareFitPreview,
      renderChain,
      drawPlot,
      updateUnitLabels,
      applyFitDefaults,
      redrawHistogram,
      applyPlotRange,
      fullPlotRange,
      fitPlotRange,
      xFullRange,
      xFitRange,
      yFullRange,
      yFitRange,
      zoomX,
      zoomY,
      rebinHistogram,
      estimateBg,
      estimateA0,
      renderBayesianDesign,
      collectBayesianDesign,
      updateModelDesignSnapshot,
      runBayesianModel,
      cancelBayesianModel,
      rerunBayesianModel,
      exportPythonRunner
    });
    init();
