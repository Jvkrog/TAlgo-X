// chart.js — per-instrument live chart for the dashboard.
// History: GET /api/chart/:name (the instrument's own timeframe bars + 1-minute bars of the
// displayed day). Live: the engine's throttled "LTP" events, relayed over /ws (app.js calls
// window.chartOnLtp). Three candle types, switchable while open:
//   RAW   — the instrument's timeframe candles as-is
//   HA    — Heikin-Ashi of those candles (seeded from the previous days' bars)
//   RANGE — range bars (rangeBars.js, the same builder the engines use) built from the
//           day's 1-minute history (O/H/L/C walked as ticks) and then the live ticks
"use strict";
(function () {
  const IST_S = 19800;   // lightweight-charts has no time zones: shift UTC seconds so labels read IST
  const LWC_SRC = "/vendor/lightweight-charts.js";   // self-hosted (lightweight-charts 4.1.3, Apache-2.0) — no CDN dependency
  const istDay = ms => new Date(ms + IST_S * 1000).toISOString().split("T")[0];

  let modal, els = {}, S = null;   // S = state of the open chart, null when closed

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error("could not load " + src));
      document.head.appendChild(s);
    });
  }
  const ensureLibs = async () => {
    if (!window.LightweightCharts) await loadScript(LWC_SRC);
    if (!window.makeRangeBars) await loadScript("/rangeBars.js");
  };

  // ── candle / chart colours (custom panel; saved in this browser) ──────────────
  const CC_KEY = "talgox.chartColors";
  const CC_DEFAULT = { up: "#33ff88", down: "#ff5266", bUp: "#33ff88", bDown: "#ff5266", wUp: "#33ff88", wDown: "#ff5266", bg: "#050806", grid: "#46ff96", hollow: false, sync: true };
  const CC_PRESETS = {
    "Terminal":       { up: "#33ff88", down: "#ff5266" },
    "Classic":        { up: "#26a69a", down: "#ef5350" },
    "Blue / Orange":  { up: "#2f9bff", down: "#ff9d2e" },
    "Cyan / Magenta": { up: "#22e5ff", down: "#ff3df2" },
    "Yellow / Purple":{ up: "#ffd23f", down: "#a259ff" },
    "White / Grey":   { up: "#f2f2f2", down: "#6b6f76" },
    "Green / Black":  { up: "#33ff88", down: "#0b0f0c", bDown: "#33ff88", wDown: "#33ff88" },
    "Red / Green (Indian)": { up: "#ff5266", down: "#33ff88" },
  };
  const CC_FIELDS = [["up", "Up body"], ["down", "Down body"], ["bUp", "Up border"], ["bDown", "Down border"], ["wUp", "Up wick"], ["wDown", "Down wick"], ["bg", "Background"], ["grid", "Grid"]];
  const isHex = v => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
  let CC = loadColors();
  function loadColors() {
    let o = {};
    try { o = JSON.parse(localStorage.getItem(CC_KEY) || "{}") || {}; } catch { o = {}; }
    const c = { ...CC_DEFAULT };
    for (const k of Object.keys(CC_DEFAULT)) {
      if (k === "hollow" || k === "sync") { if (typeof o[k] === "boolean") c[k] = o[k]; }
      else if (isHex(o[k])) c[k] = o[k];
    }
    return c;
  }
  function saveColors() { try { localStorage.setItem(CC_KEY, JSON.stringify(CC)); } catch { /* private mode: just not remembered */ } }
  const gridRgba = hex => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},0.09)`; };
  const seriesColors = () => ({
    upColor: CC.hollow ? "rgba(0,0,0,0)" : CC.up, downColor: CC.down,
    borderUpColor: CC.bUp, borderDownColor: CC.bDown, wickUpColor: CC.wUp, wickDownColor: CC.wDown,
  });
  function applyColors() {
    if (!S || !S.chart) return;
    S.series.applyOptions(seriesColors());
    S.chart.applyOptions({ layout: { background: { color: CC.bg } }, grid: { vertLines: { color: gridRgba(CC.grid) }, horzLines: { color: gridRgba(CC.grid) } } });
  }
  function syncColorInputs() {
    els.colors.querySelectorAll("input[data-k]").forEach(i => { i.value = CC[i.dataset.k]; });
    els.colors.querySelector('[data-k2="hollow"]').checked = CC.hollow;
    els.colors.querySelector('[data-k2="sync"]').checked = CC.sync;
  }
  function buildColorPanel() {
    els.colors.innerHTML = `
      <div class="cc-row"><span class="cc-label">Presets</span>${Object.keys(CC_PRESETS).map(n => `<button class="btn btn-ghost cc-preset" data-preset="${n}"><i style="background:${CC_PRESETS[n].up}"></i><i style="background:${CC_PRESETS[n].down}"></i>${n}</button>`).join("")}</div>
      <div class="cc-row"><span class="cc-label">Custom</span>${CC_FIELDS.map(([k, n]) => `<label class="cc-pick">${n}<input type="color" data-k="${k}"></label>`).join("")}</div>
      <div class="cc-row">
        <label class="cc-chk"><input type="checkbox" data-k2="sync"> Border &amp; wick follow body</label>
        <label class="cc-chk"><input type="checkbox" data-k2="hollow"> Hollow up candles</label>
        <button class="btn btn-ghost" data-cc="reset">Reset</button>
      </div>`;
    els.colors.addEventListener("input", e => {
      const i = e.target.closest("input[data-k]"); if (!i) return;
      const k = i.dataset.k; CC[k] = i.value;
      if (CC.sync) {
        if (k === "up") { CC.bUp = CC.wUp = i.value; }
        if (k === "down") { CC.bDown = CC.wDown = i.value; }
        syncColorInputs();
      }
      saveColors(); applyColors();
    });
    els.colors.addEventListener("change", e => {
      const c = e.target.closest("input[data-k2]"); if (!c) return;
      CC[c.dataset.k2] = c.checked;
      if (c.dataset.k2 === "sync" && c.checked) { CC.bUp = CC.wUp = CC.up; CC.bDown = CC.wDown = CC.down; syncColorInputs(); }
      saveColors(); applyColors();
    });
    els.colors.addEventListener("click", e => {
      const p = e.target.closest(".cc-preset"), r = e.target.closest('[data-cc="reset"]');
      if (p) {
        const pr = CC_PRESETS[p.dataset.preset];
        CC = { ...CC, up: pr.up, down: pr.down, bUp: pr.bUp || pr.up, bDown: pr.bDown || pr.down, wUp: pr.wUp || pr.up, wDown: pr.wDown || pr.down };
      } else if (r) CC = { ...CC_DEFAULT };
      else return;
      syncColorInputs(); saveColors(); applyColors();
    });
    syncColorInputs();
  }

  // ── DSB indicator: configurable like TradingView (band step, source candles, direction-change markers, style) ──
  // Computed in the browser from the loaded bars with the same stepper the engine uses (dynamicBandReader.js createBandStepper),
  // so changing a value redraws instantly; "Backtest" runs the real engine replay with the same band step.
  const DSB_KEY = "talgox.chartDsb.";
  const DSB_DEFAULT = { show: false, step: "", source: "auto", dirChanges: true, up: "#33ff88", down: "#ff5266", width: 2, edges: false, days: 30 };
  function loadDsb(name) {
    let o = {}, saved = false;
    try { const raw = localStorage.getItem(DSB_KEY + name); if (raw) { o = JSON.parse(raw) || {}; saved = true; } } catch { o = {}; }
    const d = { ...DSB_DEFAULT };
    if (typeof o.show === "boolean") d.show = o.show;
    if (o.step === "" || Number(o.step) > 0) d.step = o.step;
    if (["auto", "raw", "ha", "range"].includes(o.source)) d.source = o.source;
    if (typeof o.dirChanges === "boolean") d.dirChanges = o.dirChanges;
    if (isHex(o.up)) d.up = o.up;
    if (isHex(o.down)) d.down = o.down;
    if ([1, 2, 3, 4].includes(Number(o.width))) d.width = Number(o.width);
    if (typeof o.edges === "boolean") d.edges = o.edges;
    if ([7, 15, 30, 60, 90].includes(Number(o.days))) d.days = Number(o.days);
    return { d, saved };
  }
  function saveDsb() { if (!S) return; S.dsbSaved = true; try { localStorage.setItem(DSB_KEY + S.inst.name, JSON.stringify(S.dsb)); } catch { /* not remembered */ } }
  const dsbStep = () => { const v = Number(S.dsb.step); return v > 0 ? v : (Number(S.data.bandStep) > 0 ? Number(S.data.bandStep) : 1); };
  const dsbSourceKey = () => S.dsb.source !== "auto" ? S.dsb.source : (S.effType === "HA" ? "ha" : S.effType === "RANGE" ? "range" : "raw");
  function dsbCompute(src, step) {
    let mid = null, high = null, low = null, pos = null, prevColor = "green";
    const pts = [];
    for (const b of src) {
      const close = b.c;
      if (mid === null) { mid = close; high = mid + step; low = mid - step; }
      else {
        const bh = close > high, bl = close < low;
        if (pos === "LONG") { if (bh) mid += step; else if (bl) { pos = "SHORT"; mid -= step; } }
        else if (pos === "SHORT") { if (bl) mid -= step; else if (bh) { pos = "LONG"; mid += step; } }
        else { if (bh) { pos = "LONG"; mid += step; } else if (bl) { pos = "SHORT"; mid -= step; } }
        high = mid + step; low = mid - step;
      }
      const color = pos === "SHORT" ? "red" : "green";
      pts.push({ t: b.t, mid, high, low, color, flip: color !== prevColor });
      prevColor = color;
    }
    return pts;
  }
  function dsbClear() {
    if (S.dsbSeries) { Object.values(S.dsbSeries).forEach(ls => { try { S.chart.removeSeries(ls); } catch { /* already gone */ } }); }
    S.dsbSeries = null; S.dsbMarks = [];
  }
  function drawDsb(rebuild) {
    if (!S || !S.chart) return;
    if (rebuild || !S.dsb.show) dsbClear();
    if (!S.dsb.show || !S.dispTimes || !S.dispTimes.length) { S.dsbMarks = []; S.dsbMap = null; legend(); return; }
    const key = dsbSourceKey();
    const src = key === "ha" ? toHA(S.bars) : key === "range" ? displayed() : S.bars;
    const pts = dsbCompute(src, dsbStep());
    const cutoff = S.dispTimes[0];
    const D = S.dsb, lw0 = { priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, autoscaleInfoProvider: manualScale };
    if (!S.dsbSeries) {
      S.dsbSeries = { mid: S.chart.addLineSeries({ ...lw0, color: D.up, lineWidth: D.width }) };
      if (D.edges) { S.dsbSeries.hi = S.chart.addLineSeries({ ...lw0, color: D.up, lineWidth: 1, lineStyle: 2 }); S.dsbSeries.lo = S.chart.addLineSeries({ ...lw0, color: D.down, lineWidth: 1, lineStyle: 2 }); }
    }
    S.dsbMap = new Map(pts.map(p => [Math.floor(p.t / 1000) + IST_S, p]));
    const col = p => (p.color === "red" ? D.down : D.up);
    const mk = f => { const out = []; let prev = 0; for (const p of pts) { const time = Math.floor(p.t / 1000) + IST_S; if (time > prev && time >= cutoff) { out.push(f(p, time)); prev = time; } } return out; };
    S.dsbSeries.mid.setData(mk((p, time) => ({ time, value: p.mid, color: col(p) })));
    if (S.dsbSeries.hi) S.dsbSeries.hi.setData(mk((p, time) => ({ time, value: p.high, color: col(p) + "88" })));
    if (S.dsbSeries.lo) S.dsbSeries.lo.setData(mk((p, time) => ({ time, value: p.low, color: col(p) + "88" })));
    S.dsbMarks = D.dirChanges ? mk((p, time) => (p.flip ? {
      time, position: p.color === "green" ? "belowBar" : "aboveBar", shape: p.color === "green" ? "arrowUp" : "arrowDown", color: col(p), text: p.color === "green" ? "UP" : "DOWN",
    } : null)).filter(Boolean) : [];
    legend();
  }
  function syncDsbInputs() {
    if (!S) return;
    const q = k => els.dsbPanel.querySelector(`[data-d="${k}"]`), D = S.dsb;
    q("show").checked = D.show; q("step").value = D.step; q("step").placeholder = String(Number(S.data.bandStep) > 0 ? S.data.bandStep : 1);
    q("source").value = D.source; q("dirChanges").checked = D.dirChanges; q("up").value = D.up; q("down").value = D.down;
    q("width").value = String(D.width); q("edges").checked = D.edges; q("days").value = String(D.days);
  }
  function buildDsbPanel() {
    els.dsbPanel.innerHTML = `
      <div class="cc-row"><span class="cc-label">Inputs</span>
        <label class="cc-chk"><input type="checkbox" data-d="show"> Show DSB</label>
        <label class="cc-pick">Band step<input type="number" class="dsb-num" data-d="step" min="0" step="any"></label>
        <label class="cc-pick">Source<select class="dsb-sel" data-d="source"><option value="auto">Instrument default</option><option value="raw">Raw candles</option><option value="ha">Heikin-Ashi</option><option value="range">Range bars (chart)</option></select></label>
        <label class="cc-chk"><input type="checkbox" data-d="dirChanges"> Show direction changes</label>
      </div>
      <div class="cc-row"><span class="cc-label">Style</span>
        <label class="cc-pick">Up<input type="color" data-d="up"></label>
        <label class="cc-pick">Down<input type="color" data-d="down"></label>
        <label class="cc-pick">Line<select class="dsb-sel" data-d="width"><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option></select></label>
        <label class="cc-chk"><input type="checkbox" data-d="edges"> Band edges</label>
        <button class="btn btn-ghost" data-d="reset">Reset</button>
      </div>
      <div class="cc-row"><span class="cc-label">Backtest</span>
        <label class="cc-pick">Last<select class="dsb-sel" data-d="days"><option value="7">7 days</option><option value="15">15 days</option><option value="30">30 days</option><option value="60">60 days</option><option value="90">90 days</option></select></label>
        <button class="btn btn-ghost" data-d="backtest">Backtest with these values</button>
        <span class="dsb-bt" data-d="btOut"></span>
      </div>`;
    const redraw = rebuild => { drawDsb(rebuild); drawMarkers(); };
    els.dsbPanel.addEventListener("input", e => {
      const el = e.target.closest("[data-d]"); if (!el || !S) return;
      const k = el.dataset.d, D = S.dsb;
      if (k === "step") D.step = el.value === "" ? "" : (Number(el.value) > 0 ? Number(el.value) : D.step);
      else if (k === "up" || k === "down") D[k] = el.value;
      else return;
      saveDsb(); redraw(false);
    });
    els.dsbPanel.addEventListener("change", e => {
      const el = e.target.closest("[data-d]"); if (!el || !S) return;
      const k = el.dataset.d, D = S.dsb;
      if (k === "show" || k === "dirChanges" || k === "edges") D[k] = el.checked;
      else if (k === "source") D.source = el.value;
      else if (k === "width" || k === "days") D[k] = Number(el.value);
      else return;
      saveDsb(); redraw(k === "edges" || k === "show" || k === "width");
    });
    els.dsbPanel.addEventListener("click", e => {
      const b = e.target.closest("button[data-d]"); if (!b || !S) return;
      if (b.dataset.d === "reset") { S.dsb = { ...DSB_DEFAULT, show: true }; saveDsb(); syncDsbInputs(); redraw(true); }
      else if (b.dataset.d === "backtest") runDsbBacktest(b);
    });
  }
  const DSB_FAMILY = ["DYNAMIC_BAND", "DYNAMIC_MID_COLOR", "DYNAMIC_MID_COLOR_HL", "ALMA_DSB", "DSB_DUAL"];
  async function runDsbBacktest(btn) {
    const out = els.dsbPanel.querySelector('[data-d="btOut"]');
    const D = S.dsb, key = dsbSourceKey(), inst = S.inst, step = dsbStep();
    const strategy = DSB_FAMILY.includes(inst.strategy) ? inst.strategy : "DYNAMIC_MID_COLOR";
    const body = {
      underlying: S.data.underlying, exchange: S.data.exchange || "MCX", strategy, timeframe: S.data.timeframe, days: D.days,
      params: { BAND_STEP_DEFAULT: step }, candleType: key === "ha" ? "HA" : key === "range" ? "RANGE" : "RAW",
    };
    if (key === "range") body.rangeSize = S.range;
    if (inst.lotMult) body.lotMultOverride = inst.lotMult;
    btn.disabled = true; out.className = "dsb-bt"; out.textContent = "running backtest…";
    try {
      const r = await fetch("/api/toolbox/backtest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "backtest failed");
      const m = j.summary || {}, f = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? "–" : Number(v).toFixed(d));
      const pnl = Number(m.netPnL);
      out.innerHTML = `${strategy.replace(/_/g, " ")} · step ${step} · ${key.toUpperCase()} · ${D.days}d &mdash; ${m.trades ?? 0} trades · win ${f(m.winRate, 1)}% · PF ${f(m.profitFactor)} · net <b class="${pnl >= 0 ? "dsb-pos" : "dsb-neg"}">${pnl >= 0 ? "+" : ""}${f(m.netPnL, 0)}</b> · max DD ${f(m.maxDrawdown, 0)} · <a href="${j.reportUrl}" target="_blank" rel="noopener">open report</a>`;
    } catch (err) {
      out.className = "dsb-bt dsb-neg"; out.textContent = "backtest error: " + err.message;
    } finally { btn.disabled = false; }
  }

  function build() {
    modal = document.createElement("div");
    modal.className = "tb-modal";
    modal.innerHTML = `
      <div class="tb-modal-content chart-modal">
        <div class="tb-modal-head">
          <span data-r="title">Chart</span>
          <span class="chart-head-btns">
            <select class="chart-pick" data-r="pick" style="display:none" title="Switch instrument"></select>
            <button class="btn btn-ghost" data-r="popout" title="Open this chart in its own tab / window (e.g. for a second monitor)">Open in new tab</button>
            <button class="btn btn-ghost" data-r="close">Close</button>
          </span>
        </div>
        <div class="chart-controls">
          <div class="chart-seg">
            <button class="btn btn-ghost chart-type active" data-type="raw">Raw</button>
            <button class="btn btn-ghost chart-type" data-type="ha">HA</button>
            <button class="btn btn-ghost chart-type" data-type="range">Range</button>
          </div>
          <div class="chart-seg">
            <button class="btn btn-ghost chart-toggle" data-toggle="indicator">Indicator</button>
            <button class="btn btn-ghost chart-toggle" data-toggle="filters">Filters</button>
            <button class="btn btn-ghost chart-toggle active" data-toggle="depth">Order book</button>
            <button class="btn btn-ghost" data-r="dsbBtn" title="Dynamic Step Band — settings, direction changes, backtest">DSB &#9881;</button>
            <button class="btn btn-ghost" data-r="colorsBtn" title="Candle and chart colours">Colors</button>
          </div>
          <label class="chart-range" data-r="rangeWrap" style="display:none">range <input type="number" data-r="range" min="0.01" step="any"></label>
          <span class="chart-status" data-r="status"></span>
        </div>
        <div class="chart-colors" data-r="colors" style="display:none"></div>
        <div class="chart-colors chart-dsb" data-r="dsbPanel" style="display:none"></div>
        <div class="chart-legend" data-r="legend"></div>
        <div class="chart-info" data-r="info"></div>
        <div class="chart-main">
          <div class="chart-box" data-r="box"></div>
          <div class="depth-panel" data-r="depth"></div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelectorAll("[data-r]").forEach(e => { els[e.dataset.r] = e; });
    els.close.addEventListener("click", close);
    els.popout.addEventListener("click", () => { if (S) window.open("/chart.html?name=" + encodeURIComponent(S.inst.name), "_blank"); });
    els.pick.addEventListener("change", () => { const i = (window.chartInstruments || []).find(x => x.name === els.pick.value); if (i) { history.replaceState(null, "", "?name=" + encodeURIComponent(i.name)); open(i); } });
    modal.addEventListener("click", e => { if (e.target === modal && !window.chartStandalone) close(); });
    modal.querySelectorAll(".chart-type").forEach(b => b.addEventListener("click", () => setType(b.dataset.type)));
    modal.querySelectorAll(".chart-toggle").forEach(b => b.addEventListener("click", () => toggle(b.dataset.toggle)));
    buildColorPanel();
    buildDsbPanel();
    els.dsbBtn.addEventListener("click", () => {
      const on = els.dsbPanel.style.display === "none";
      els.dsbPanel.style.display = on ? "" : "none";
      els.dsbBtn.classList.toggle("active", on);
      if (on && S && !S.dsbSaved && !S.dsb.show) { S.dsb.show = true; saveDsb(); syncDsbInputs(); drawDsb(true); drawMarkers(); }   // first open: switch it on so there is something to configure
    });
    els.colorsBtn.addEventListener("click", () => {
      const on = els.colors.style.display === "none";
      els.colors.style.display = on ? "" : "none";
      els.colorsBtn.classList.toggle("active", on);
    });
    els.range.addEventListener("change", () => { if (S && S.type === "range") { S.range = Number(els.range.value) || S.range; render(true); } });
  }

  function close() {
    modal.classList.remove("open");
    if (S && S.chart) S.chart.remove();
    if (S && S.posTimer) clearInterval(S.posTimer);
    if (S && S.axisTimer) clearInterval(S.axisTimer);
    if (S && S.tagTimer) clearInterval(S.tagTimer);
    stopDepth();
    S = null;
  }

  // ── data shaping ──────────────────────────────────────────────────────────
  const toBar = r => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4] });
  function toHA(bars) {
    const out = []; let prev = null;
    for (const b of bars) {
      const c = (b.o + b.h + b.l + b.c) / 4;
      const o = prev ? (prev.o + prev.c) / 2 : (b.o + b.c) / 2;
      const ha = { t: b.t, o, c, h: Math.max(b.h, o, c), l: Math.min(b.l, o, c) };
      out.push(ha); prev = ha;
    }
    return out;
  }
  function minutePoints(mins) {
    const pts = [];
    for (const m of mins) {
      const seq = m.c >= m.o ? [m.o, m.l, m.h, m.c] : [m.o, m.h, m.l, m.c];   // walk the minute's range in a plausible order
      for (const p of seq) pts.push({ price: p, time: m.t });
    }
    return pts;
  }
  const lw = (b, prevT) => {
    let t = Math.floor(b.t / 1000) + IST_S;
    if (prevT !== undefined && t <= prevT) t = prevT + 1;
    return { time: t, open: b.o, high: b.h, low: b.l, close: b.c };
  };
  const series = list => { const out = []; let prev; for (const b of list) { const x = lw(b, prev); out.push(x); prev = x.time; } return out; };

  let displayedT = null;   // bar-start ms of the displayed list (range bars: set from the list below)
  function displayed() {
    if (S.type === "range") {
      const { bars, forming } = window.makeRangeBars(S.points, S.range);
      const all = bars.map(b => ({ t: b.time, o: b.open, h: b.high, l: b.low, c: b.close }));
      displayedT = null;
      if (forming && (forming.high !== forming.low || !all.length)) all.push({ t: forming.time, o: forming.open, h: forming.high, l: forming.low, c: forming.close });
      displayedT = all.map(b => b.t);
      return all;
    }
    let base = S.type === "ha" ? toHA(S.bars) : S.bars;
    if (S.type === "ha" && base.length && S.bars.length) {
      // The candle still forming is drawn from the live price: body from the HA open to the last traded price, wicks from the
      // raw high / low. Once the bar closes it becomes the true Heikin-Ashi candle the engine uses.
      const raw = S.bars[S.bars.length - 1], ha = base[base.length - 1];
      base = base.slice(0, -1).concat([{ t: ha.t, o: ha.o, c: raw.c, h: Math.max(raw.h, ha.o, raw.c), l: Math.min(raw.l, ha.o, raw.c) }]);
    }
    displayedT = base.slice(S.dayIdx).map(b => b.t);
    return base.slice(S.dayIdx);
  }

  function render(fit) {
    const disp = displayed();
    S.lastDisp = disp[disp.length - 1] || null;
    S.dispList = disp;
    const list = series(disp);
    S.series.setData(list);
    S.listLen = list.length;
    S.lastTime = list.length ? list[list.length - 1].time : 0;
    S.dispT = displayedT; S.dispTimes = list.map(x => x.time);
    if (fit && S.manual) resetManual();
    if (fit) {
      // A month of bars is loaded; open zoomed on the recent ones (scroll / zoom back for the rest).
      const n = list.length;
      if (n > 160) S.chart.timeScale().setVisibleLogicalRange({ from: n - 140, to: n + 6 }); else S.chart.timeScale().fitContent();
    }
    drawOverlay(); drawDsb(false); drawMarkers();
    status();
  }

  // ── Indicator tab: the instrument's own indicator lines (server computes via chartOverlay.js) ──
  const SHORT = { CHOP: "CHOP", VOLUME: "VOL", LONG_CANDLE: "LONGC", HTF: "HTF", DOUBLE_ORDER: "2X", DAILY_HA: "DHA", ENTRY_TIME: "TIME" };
  const LONGNAME = { CHOP: "choppiness index", VOLUME: "volume below SMA", LONG_CANDLE: "long-candle filter", HTF: "higher-timeframe trend", DOUBLE_ORDER: "double-order guard", DAILY_HA: "daily HA direction", ENTRY_TIME: "before entry time" };
  // Indicator / DSB lines must obey a manual price zoom too, or their own range keeps the axis from zooming in.
  const manualScale = orig => (S && S.manual ? { priceRange: { minValue: S.manual.min, maxValue: S.manual.max } } : orig());
  function drawOverlay() {
    (S.lineSeries || []).forEach(ls => S.chart.removeSeries(ls));
    S.lineSeries = [];
    const ov = S.overlay;
    if (!S.ind || !ov || !ov.lines) return;
    const step = window.LightweightCharts.LineType ? window.LightweightCharts.LineType.WithSteps : undefined;
    for (const l of ov.lines) {
      const stepped = step !== undefined && !l.width;   // bands step; a "mid" style line (width set) draws as a plain line
      const ls = S.chart.addLineSeries({ color: l.color, lineWidth: l.width || 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, autoscaleInfoProvider: manualScale, ...(stepped ? { lineType: step } : {}) });
      let prev = 0; const data = [];
      for (const [t, v, col] of l.points) { const time = Math.floor(t / 1000) + IST_S; if (time > prev) { data.push(col ? { time, value: v, color: col } : { time, value: v }); prev = time; } }
      ls.setData(data);
      S.lineSeries.push(ls);
    }
  }

  // ── Filters tab: markers where an entry gate blocked a signal ──
  function drawMarkers() {
    const dsbMarks = S.dsbMarks || [];
    if (!S.filters || !S.dispT || !S.dispT.length) { S.series.setMarkers(dsbMarks.slice().sort((a, b) => a.time - b.time)); return; }
    const groups = new Map();   // "time|side" -> Set(reasons)
    for (const b of S.blocks) {
      let idx = -1;   // last displayed bar that started at/before the block
      for (let i = S.dispT.length - 1; i >= 0; i--) { if (S.dispT[i] <= b.ts) { idx = i; break; } }
      if (idx < 0) continue;
      const key = S.dispTimes[idx] + "|" + b.side;
      if (!groups.has(key)) groups.set(key, new Set());
      b.reasons.forEach(r => groups.get(key).add(r));
    }
    const marks = [...groups.entries()].map(([key, rs]) => {
      const [time, side] = key.split("|");
      return { time: Number(time), position: side === "LONG" ? "belowBar" : "aboveBar", shape: side === "LONG" ? "arrowUp" : "arrowDown", color: "#ffb347", text: [...rs].map(r => SHORT[r] || r).join("+") };
    }).sort((a, b) => a.time - b.time);
    S.series.setMarkers(marks.concat(dsbMarks).sort((a, b) => a.time - b.time));
  }

  function toggle(which) {
    if (!S) return;
    if (which === "depth") {
      S.depthOn = !S.depthOn;
      modal.querySelector('[data-toggle="depth"]').classList.toggle("active", S.depthOn);
      els.depth.style.display = S.depthOn ? "" : "none";
      if (S.depthOn) startDepth(); else stopDepth();
      return;
    }
    S[which === "indicator" ? "ind" : "filters"] = !S[which === "indicator" ? "ind" : "filters"];
    modal.querySelector(`[data-toggle="${which}"]`).classList.toggle("active", S[which === "indicator" ? "ind" : "filters"]);
    drawOverlay(); drawMarkers(); info(); legend();
  }

  function info() {
    const bits = [];
    if (S.ind) bits.push(S.overlay && S.overlay.label ? "Indicator: " + S.overlay.label : (S.overlay && S.overlay.note) || "no indicator data");
    if (S.filters) {
      const used = new Set(); S.blocks.forEach(b => b.reasons.forEach(r => used.add(r)));
      bits.push(S.blocks.length ? `Blocked entries: ${S.blocks.length} (▲ long blocked, ▼ short blocked) — ` + [...used].map(r => `${SHORT[r] || r} = ${LONGNAME[r] || r}`).join(" · ") : "Filters: no blocked entries found for this day in the live feed or the instrument PM2 log");
    }
    els.info.textContent = bits.join("   |   ");
    els.info.style.display = bits.length ? "" : "none";
  }

  async function refreshOverlay() {
    if (!S) return;
    try {
      const r = await fetch(`/api/chart/${encodeURIComponent(S.inst.name)}/overlay`);
      const d = await r.json();
      if (!r.ok || !S) return;
      S.overlay = d.overlay;
      const have = new Set(S.blocks.map(b => b.ts + "|" + b.side));
      d.blocks.forEach(b => { if (!have.has(b.ts + "|" + b.side)) S.blocks.push(b); });
      drawOverlay(); drawMarkers(); info(); legend();
    } catch { /* keep what we have */ }
  }
  function onBlock(msg) {
    if (!S || !S.isToday || msg.engine !== S.data.underlying || !Array.isArray(msg.reasons)) return;
    if (msg.proc && S.inst && S.inst.name && msg.proc !== S.inst.name) return;   // another candle-type deployment of the same instrument
    S.blocks.push({ ts: msg.ts || Date.now(), side: msg.side, price: msg.price, reasons: msg.reasons });
    drawMarkers(); info();
  }

  // OHLC of the candle under the crosshair (else the latest candle) + the open position's entry price.
  // Like TradingView: the O/H/L/C line, the DSB value and the two value tags on the price axis follow the candle under the crosshair /
  // the tapped candle / (when scrolled back) the right-most visible candle. The live price line and tag stay on the real traded price.
  function refBar() {
    if (S.hover) return { k: S.hover, time: S.hoverTime, past: true };
    if (S.pinned) return { k: S.pinned, time: S.pinnedTime, past: true };
    const i = S.edgeIdx;
    if (i !== null && i !== undefined && S.dispList && S.dispList[i] && S.dispTimes) {
      const b = S.dispList[i];
      return { k: { open: b.o, high: b.h, low: b.l, close: b.c }, time: S.dispTimes[i], past: true };
    }
    return null;
  }
  // Value of the strategy's own indicator lines (the "Indicator" button) at chart time `time` (seconds, IST-shifted).
  function overlayValues(time) {
    const ov = S.overlay, out = [];
    if (!S.ind || !ov || !ov.lines) return out;
    for (const l of ov.lines.slice(0, 3)) {
      const pts = l.points || []; let lo = 0, hi = pts.length - 1, at = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (Math.floor(pts[m][0] / 1000) + IST_S <= time) { at = m; lo = m + 1; } else hi = m - 1; }
      if (at >= 0) out.push({ name: l.name, v: pts[at][1], color: pts[at][2] || l.color });
    }
    return out;
  }
  // TradingView-style value boxes on the price axis (outlined, coloured): the reference candle's close (when it is a past candle),
  // the DSB value and the strategy-indicator values. DOM overlay, positioned from the series' price scale — cheap to move while panning / zooming.
  function positionTags() {
    if (!S || !S.tagEl) return;
    const tags = S.tags || [];
    while (S.tagEl.children.length < tags.length) { const d = document.createElement("div"); d.className = "chart-tag"; S.tagEl.appendChild(d); }
    const ps = S.chart.priceScale("right"), w = (ps.width && ps.width()) || 56, ph = els.box.clientHeight - ((S.chart.timeScale().height && S.chart.timeScale().height()) || 26);
    const placed = tags.map(t => ({ t, y: S.series.priceToCoordinate(t.price) })).filter(p => p.y !== null && p.y > -4 && p.y < ph + 4).sort((a, b) => a.y - b.y);
    let prev = -Infinity;
    for (const p of placed) { if (p.y < prev + 18) p.y = prev + 18; prev = p.y; }
    Array.from(S.tagEl.children).forEach((el, i) => {
      const p = placed[i];
      if (!p) { el.style.display = "none"; return; }
      el.style.display = ""; el.style.width = Math.max(40, w) + "px"; el.style.top = Math.round(p.y - 9) + "px";
      el.style.borderColor = p.t.color; el.style.color = p.t.color; el.textContent = Number(p.t.price).toFixed(2);
    });
  }
  // Never let the read-out / value boxes break the chart: on any error switch them off and say so in the status line.
  function legend() {
    if (!S || S.legendOff) return;
    try { legendInner(); } catch (err) {
      S.legendOff = true; console.error("chart legend error", err);
      if (S.tagEl) S.tagEl.style.display = "none";
      els.status.textContent = "read-out off (" + err.message + ")";
    }
  }
  function markTags() {
    if (!S || S.tagRaf) return;
    S.tagRaf = requestAnimationFrame(() => { if (!S) return; S.tagRaf = 0; try { positionTags(); } catch { /* ignore */ } });
  }
  function legendInner() {
    if (!els.legend || !S) return;
    const ref = refBar();
    let k = ref ? ref.k : null, time = ref ? ref.time : (S.dispTimes && S.dispTimes.length ? S.dispTimes[S.dispTimes.length - 1] : null);
    if (!k) { const l = S.lastDisp; if (l) k = { open: l.o, high: l.h, low: l.l, close: l.c }; }
    const f = v => Number(v).toFixed(2);
    const parts = [], tags = [];
    if (k) {
      parts.push(`O ${f(k.open)}  H ${f(k.high)}  L ${f(k.low)}  C ${f(k.close)}`);
      if (ref && ref.past) tags.push({ price: Number(k.close), color: Number(k.close) >= Number(k.open) ? CC.up : CC.down });
    }
    const pt = S.dsb && S.dsb.show && S.dsbMap && time !== null ? S.dsbMap.get(time) : null;
    if (pt) {
      parts.push(`DSB (step ${dsbStep()}) ${f(pt.mid)} ${pt.color === "red" ? "\u25BC short" : "\u25B2 long"}${S.dsb.edges ? `  (${f(pt.low)} / ${f(pt.high)})` : ""}`);
      tags.push({ price: pt.mid, color: pt.color === "red" ? S.dsb.down : S.dsb.up });
    }
    if (time !== null) for (const o of overlayValues(time)) { parts.push(`${o.name} ${f(o.v)}`); tags.push({ price: o.v, color: o.color }); }
    if (S.position && S.position.entry_price != null) parts.push(`${S.position.position} entry @ ${f(S.position.entry_price)}`);
    const text = parts.join("   |   ");
    if (els.legend.textContent !== text) els.legend.textContent = text;
    els.legend.style.display = parts.length ? "" : "none";
    S.tags = tags;
    markTags();
  }
  // Pan / zoom fire many range events: coalesce to one legend + tag update per frame.
  function scheduleLegend() {
    if (!S || S.legendRaf) return;
    S.legendRaf = requestAnimationFrame(() => { if (S) { S.legendRaf = 0; legend(); } });
  }
  async function refreshPosition() {
    if (!S || S.inst.dual) return;   // a dual hedge deployment has two legs on two accounts: no single position to show
    const mine = S;
    try {
      const r = await fetch(`/api/state/${encodeURIComponent(mine.inst.underlying)}/${encodeURIComponent(mine.inst.strategy)}?candle=${encodeURIComponent(mine.inst.candleType || "")}`);
      const d = await r.json();
      if (S !== mine) return;
      S.position = d.position || null;
      legend();
    } catch { /* keep last */ }
  }

  // Real last traded price (same number as the instrument card), drawn as its own line + axis label. On HA / range charts the
  // candle series' own "last value" is the synthetic bar close, which differs from the traded price.
  function drawLtpLine() {
    if (!S || !Number.isFinite(S.last)) return;
    const l = S.lastDisp, up = l ? l.c >= l.o : true, color = up ? "#33ff88" : "#ff5266";
    if (!S.ltpLine) S.ltpLine = S.series.createPriceLine({ price: S.last, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "" });
    else S.ltpLine.applyOptions({ price: S.last, color });
  }
  // History actually loaded, from the real first / last bar (IST), e.g. "17 Sep – 16 Oct · 412 bars".
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dmy = ms => { const d = new Date(ms + IST_S * 1000); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
  function histSpan() {
    const first = S.bars[S.dayIdx], last = S.bars[S.bars.length - 1];
    if (!first || !last) return S.data.day;
    const n = S.bars.length - S.dayIdx;
    const span = dmy(first.t) === dmy(last.t) ? dmy(last.t) : `${dmy(first.t)} \u2013 ${dmy(last.t)}`;
    return S.type === "range" ? span : `${span} \u00b7 ${n} bars`;
  }
  function status() {
    drawLtpLine();
    const live = S.isToday ? "LIVE" : "closed — last session";
    const dc = window.dayChangeFor && S.last !== null ? window.dayChangeFor(S.inst.name, S.last) : null;
    els.status.classList.toggle("up", !!dc && dc.pts > 0); els.status.classList.toggle("down", !!dc && dc.pts < 0);
    els.status.textContent = `${S.data.timeframe} · ${histSpan()} · ${live}${S.last !== null ? " · " + S.last.toFixed(2) : ""}${dc ? "  " + window.fmtDayChange(dc) : ""}`;
    legend();
  }

  async function ensureMinutes() {
    if (!S || S.minutesLoaded || S.minutesLoading) return;
    S.minutesLoading = true;
    const mine = S;
    els.status.textContent = "loading 1-minute history for range bars…";
    try {
      const r = await fetch(`/api/chart/${encodeURIComponent(mine.inst.name)}?only=minutes`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "minute history failed");
      if (S !== mine) return;
      const live = mine.points.filter(p => p.live);   // ticks already received while this loaded
      mine.points = minutePoints(d.minuteBars.map(toBar)).concat(live);
      mine.minutesLoaded = true;
    } catch (err) { if (S === mine) els.status.textContent = "error: " + err.message; }
    finally { mine.minutesLoading = false; }
  }
  async function setType(type) {
    if (!S) return;
    if (type === "range" && !S.minutesLoaded) await ensureMinutes();
    if (!S) return;
    S.type = type;
    modal.querySelectorAll(".chart-type").forEach(b => b.classList.toggle("active", b.dataset.type === type));
    els.rangeWrap.style.display = type === "range" ? "" : "none";
    render(true);
  }

  // ── live ticks ────────────────────────────────────────────────────────────
  function onLtp(msg) {
    if (!S || !S.isToday || msg.engine !== (S.data.ltpEngine || S.data.underlying)) return;
    const price = Number(msg.price), ts = msg.ts || Date.now();
    if (!Number.isFinite(price)) return;
    S.last = price;
    S.points.push({ price, time: ts, live: true });
    // fold into the instrument-timeframe bar for this slot (anchored on the day's first bar)
    const slot = S.data.tfMinutes * 60000, anchor = S.bars[S.dayIdx] ? S.bars[S.dayIdx].t : null;
    if (anchor !== null && ts >= anchor) {
      const start = anchor + Math.floor((ts - anchor) / slot) * slot;
      const lastBar = S.bars[S.bars.length - 1];
      if (lastBar.t === start) { lastBar.h = Math.max(lastBar.h, price); lastBar.l = Math.min(lastBar.l, price); lastBar.c = price; }
      else if (start > lastBar.t) { S.bars.push({ t: start, o: price, h: price, l: price, c: price }); setTimeout(refreshOverlay, 4000); }
    }
    S.dirty = true;
    if (!S.timer) S.timer = setTimeout(flush, S.type === "range" ? 1000 : 250);   // coalesce bursts
  }
  // After a manual price pan/zoom the library no longer auto-fits, so a live price that moves out of the chosen range would
  // vanish off the chart. While the newest bar is on screen, widen the range just enough to keep the live price visible.
  function keepLiveVisible(price) {
    if (!S || !S.manual || !Number.isFinite(price)) return;
    const lr = S.chart.timeScale().getVisibleLogicalRange();
    if (!lr || lr.to < (S.listLen || 0) - 2) return;   // scrolled back in history: leave the range alone
    const pad = (S.manual.max - S.manual.min) * 0.06;
    if (price > S.manual.max - pad) applyManual(S.manual.min, price + pad);
    else if (price < S.manual.min + pad) applyManual(price - pad, S.manual.max);
  }
  function flush() {
    if (!S) return;
    S.timer = null;
    if (!S.dirty) return;
    S.dirty = false;
    const disp = displayed();
    const last = disp[disp.length - 1];
    if (!last) return;
    S.lastDisp = last;
    S.dispList = disp;
    keepLiveVisible(last.c);
    keepLiveVisible(last.h); keepLiveVisible(last.l);
    if (S.type === "range") {
      const list = series(disp);
      if (list.length === S.listLen) S.series.update(list[list.length - 1]);   // same bar count: touch only the forming bar
      else { S.series.setData(list); S.listLen = list.length; S.dispT = displayedT; S.dispTimes = list.map(x => x.time); drawMarkers(); }
      S.lastTime = list.length ? list[list.length - 1].time : S.lastTime;
      status();
      return;
    }
    const x = lw(last, undefined);
    if (x.time < S.lastTime) return;
    S.series.update(x);
    S.lastTime = x.time;
    try {
      if (S.dsb.show && Date.now() - (S.dsbAt || 0) > 1000) { S.dsbAt = Date.now(); drawDsb(false); drawMarkers(); }   // follow the forming candle
    } catch (err) { S.dsb.show = false; console.error("chart DSB error", err); }
    if (!S.hover && !S.pinned) legend();   // keep O/H/L/C of the live (or scrolled-to) candle current
    status();
  }

  // ── open ──────────────────────────────────────────────────────────────────
  // ── order book (market depth) side panel ─────────────────────────────────────────────
  const fmtQ = n => (n === null || n === undefined ? "–" : Number(n).toLocaleString("en-IN"));
  function drawDepth(d) {
    if (!S || !els.depth) return;
    const asks = (d.asks || []).slice(0, 5), bids = (d.bids || []).slice(0, 5);
    const max = Math.max(1, ...asks.map(l => l.qty), ...bids.map(l => l.qty));
    const row = (l, cls) => `<div class="depth-row ${cls}"><span class="depth-bar" style="width:${Math.round((l.qty / max) * 100)}%"></span><span class="depth-px">${l.price.toFixed(2)}</span><span class="depth-qty">${fmtQ(l.qty)}</span><span class="depth-ord">${l.orders}</span></div>`;
    const tb = Number(d.totalBuy) || 0, ts = Number(d.totalSell) || 0, imb = tb + ts > 0 ? Math.round((tb / (tb + ts)) * 100) : null;
    const spread = asks.length && bids.length ? (asks[0].price - bids[0].price) : null;
    els.depth.innerHTML = `
      <div class="depth-head"><span>Order book</span><span class="depth-sym">${d.symbol || ""}</span></div>
      <div class="depth-cols"><span>Price</span><span>Qty</span><span>Ord</span></div>
      ${asks.slice().reverse().map(l => row(l, "ask")).join("") || '<div class="depth-empty">no asks</div>'}
      <div class="depth-mid"><b>${d.ltp !== undefined ? Number(d.ltp).toFixed(2) : "–"}</b><span>${spread !== null ? "spread " + spread.toFixed(2) : ""}</span></div>
      ${bids.map(l => row(l, "bid")).join("") || '<div class="depth-empty">no bids</div>'}
      <div class="depth-foot">
        <div><span>Total bid</span><b class="bid-t">${fmtQ(d.totalBuy)}</b></div>
        <div><span>Total ask</span><b class="ask-t">${fmtQ(d.totalSell)}</b></div>
        ${imb !== null ? `<div class="depth-imb"><i style="width:${imb}%"></i></div><div class="depth-imb-l"><span>${imb}% bids</span><span>${100 - imb}% asks</span></div>` : ""}
        ${d.volume !== null ? `<div><span>Volume</span><b>${fmtQ(d.volume)}</b></div>` : ""}
        ${d.oi ? `<div><span>OI</span><b>${fmtQ(d.oi)}</b></div>` : ""}
      </div>`;
  }
  // Streamed over the dashboard socket (server -> Kite WebSocket, "full" mode). REST polling is only a fallback:
  // used when no streamed tick has arrived for a few seconds (stream unavailable, market closed, socket down).
  function subscribeDepth() { if (S && S.depthOn) window.wdSend && window.wdSend({ type: "DEPTH_SUB", name: S.inst.name }); }
  function onDepth(msg) {
    if (!S || !S.depthOn || msg.name !== S.inst.name) return;
    if (msg.type === "DEPTH_ERR") { S.depthErr = msg.error; return; }
    S.depthStreamAt = Date.now();
    drawDepth(msg.data);
  }
  function startDepth() {
    if (!S || !S.depthOn) return;
    S.depthStreamAt = 0;
    subscribeDepth();
    pollDepth();   // immediate first paint from a REST snapshot
    if (S.depthTimer) clearInterval(S.depthTimer);
    S.depthTimer = setInterval(() => {
      if (!S || !S.depthOn) return;
      if (Date.now() - (S.depthStreamAt || 0) > 5000) pollDepth();   // fallback only
    }, 3000);
  }
  function stopDepth() {
    if (S && S.depthTimer) { clearInterval(S.depthTimer); S.depthTimer = null; }
    window.wdSend && window.wdSend({ type: "DEPTH_UNSUB" });
  }
  async function pollDepth() {
    if (!S || !S.depthOn) return;
    const mine = S;
    try {
      const r = await fetch(`/api/depth/${encodeURIComponent(S.inst.name)}`);
      const d = await r.json();
      if (S !== mine) return;
      if (!r.ok) { els.depth.innerHTML = `<div class="depth-head"><span>Order book</span></div><div class="depth-empty">${d.error || "unavailable"}</div>`; return; }
      drawDepth(d);
    } catch { /* transient — the next poll retries */ }
  }

  // ── price-axis zoom: drag a finger / the mouse up-down on the price scale, or wheel over it, to zoom the price range
  // (double-tap / double-click resets to auto-fit). One handler for touch and mouse so desktop behaves the same as phone.
  function visiblePriceRange() {
    const h = els.box.clientHeight - (S.chart.timeScale().height ? S.chart.timeScale().height() : 26);
    const top = S.series.coordinateToPrice(0), bot = S.series.coordinateToPrice(Math.max(1, h));
    return top === null || bot === null ? null : { min: Math.min(top, bot), max: Math.max(top, bot) };
  }
  function applyManual(min, max) {
    if (!S) return;
    S.manual = { min, max };
    S.series.applyOptions({ autoscaleInfoProvider: orig => (S && S.manual ? { priceRange: { minValue: S.manual.min, maxValue: S.manual.max } } : orig()) });
  }
  function resetManual() {
    if (!S) return;
    S.manual = null;
    S.series.applyOptions({ autoscaleInfoProvider: orig => (S && S.manual ? { priceRange: { minValue: S.manual.min, maxValue: S.manual.max } } : orig()) });
    S.chart.priceScale("right").applyOptions({ autoScale: true });
  }
  // Finger drag inside the plot pans freely in any direction (time and price together, diagonals included) with a little
  // inertia. Done here rather than by the library, which on touch only pans along one axis at a time. Pinch stays with the
  // library; a press-and-hold shows the crosshair instead of panning.
  function attachTouchPan() {
    if (els.box._vp) return;   // the box element is reused across opens
    els.box._vp = true;
    const touches = new Set();
    let d = null, raf = 0;
    const stopInertia = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };
    const panBy = (dx, dy, base) => {
      if (!S) return;
      const ts = S.chart.timeScale(), lr = ts.getVisibleLogicalRange();
      if (lr && dx) {
        const plotW = Math.max(1, els.box.clientWidth - 60), perPx = (lr.to - lr.from) / plotW;
        ts.setVisibleLogicalRange({ from: lr.from - dx * perPx, to: lr.to - dx * perPx });
      }
      if (dy && base) {
        const cur = S.manual || base, h = Math.max(1, els.box.clientHeight - 26);
        const shift = dy * (cur.max - cur.min) / h;   // finger down -> chart down -> visible prices move up
        applyManual(cur.min + shift, cur.max + shift);
      }
    };
    els.box.addEventListener("pointerdown", e => {
      if (!S || (e.pointerType === "mouse" && e.button !== 0)) return;
      if (e.pointerType === "mouse") { try { els.box.setPointerCapture(e.pointerId); } catch { /* ignore */ } }
      touches.add(e.pointerId);
      stopInertia();
      if (touches.size > 1 || e.target.closest(".axis-zoom")) { d = null; return; }   // pinch / axis strip: not a pan
      d = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now(), moved: false, hold: false, vx: 0, vy: 0, lt: Date.now() };
    }, true);
    els.box.addEventListener("pointermove", e => {
      if (!d || e.pointerId !== d.id || !S || touches.size > 1) return;
      if (e.pointerType === "mouse" && !(e.buttons & 1)) return;
      if (!d.moved) {
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
        d.hold = e.pointerType === "touch" && Date.now() - d.t > 450;   // touch press-and-hold then move = crosshair, leave it to the library
        d.moved = true;
        if (!d.hold) S.chart.applyOptions({ crosshair: { mode: 2 } });   // hide the crosshair while dragging (2 = hidden)
      }
      if (d.hold) return;
      if (!d.base) d.base = visiblePriceRange();
      const dx = e.clientX - d.x, dy = e.clientY - d.y, now = Date.now(), dt = Math.max(1, now - d.lt);
      d.vx = 0.8 * d.vx + 0.2 * (dx / dt); d.vy = 0.8 * d.vy + 0.2 * (dy / dt);
      d.x = e.clientX; d.y = e.clientY; d.lt = now;
      panBy(dx, dy, d.base);
    }, true);
    const end = e => {
      touches.delete(e.pointerId);
      if (!d || e.pointerId !== d.id) return;
      const v = d; d = null;
      if (S) S.chart.applyOptions({ crosshair: { mode: 0 } });
      if (!v.moved || v.hold || Date.now() - v.lt > 80) return;
      let vx = v.vx * 16, vy = v.vy * 16;   // px per frame
      const step = () => {
        vx *= 0.94; vy *= 0.94;
        if (!S || (Math.abs(vx) < 0.3 && Math.abs(vy) < 0.3)) { raf = 0; return; }
        panBy(vx, vy, visiblePriceRange());
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };
    els.box.addEventListener("pointerup", end, true); els.box.addEventListener("pointercancel", end, true);
  }
  function attachPriceAxisZoom() {
    attachTouchPan();
    const strip = document.createElement("div");
    strip.className = "axis-zoom";
    els.box.style.position = "relative";
    els.box.appendChild(strip);
    const place = () => {
      if (!S) return;
      const w = (S.chart.priceScale("right").width && S.chart.priceScale("right").width()) || 64;
      strip.style.width = Math.max(48, w) + "px";
      strip.style.bottom = ((S.chart.timeScale().height && S.chart.timeScale().height()) || 26) + "px";
    };
    place();
    S.axisTimer = setInterval(place, 1000);
    let drag = null;
    const zoomBy = (base, f) => { const mid = (base.min + base.max) / 2, r = Math.max((base.max - base.min) * f, 1e-6); applyManual(mid - r / 2, mid + r / 2); };
    strip.addEventListener("pointerdown", e => {
      const base = S.manual || visiblePriceRange();
      if (!base) return;
      drag = { y: e.clientY, base: { ...base } };
      strip.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    strip.addEventListener("pointermove", e => { if (drag) zoomBy(drag.base, Math.exp((e.clientY - drag.y) / 180)); });   // drag up = zoom in, down = zoom out
    const end = () => { drag = null; };
    strip.addEventListener("pointerup", end); strip.addEventListener("pointercancel", end);
    strip.addEventListener("wheel", e => { e.preventDefault(); const base = S.manual || visiblePriceRange(); if (base) zoomBy(base, Math.exp(Math.max(-200, Math.min(200, e.deltaY)) / 600)); }, { passive: false });
    strip.addEventListener("dblclick", resetManual);
    let lastTap = 0;
    strip.addEventListener("pointerup", e => { if (e.pointerType === "touch") { const now = Date.now(); if (now - lastTap < 320) resetManual(); lastTap = now; } });
  }

  async function open(inst) {
    if (!modal) build();
    if (S && S.chart) S.chart.remove();
    if (S && S.posTimer) clearInterval(S.posTimer);
    if (S && S.axisTimer) clearInterval(S.axisTimer);
    if (S && S.tagTimer) clearInterval(S.tagTimer);
    stopDepth();
    S = null;
    els.title.textContent = `${inst.underlying} · ${inst.label || inst.strategy}${" · " + (inst.candleType || (window.nativeCandleOf ? window.nativeCandleOf(inst.strategy) : ""))}`;
    els.status.textContent = "loading…";
    els.box.innerHTML = "";
    els.popout.style.display = window.chartStandalone ? "none" : "";
    els.close.style.display = window.chartStandalone ? "none" : "";
    els.pick.style.display = window.chartStandalone && (window.chartInstruments || []).length ? "" : "none";
    if (window.chartStandalone) els.pick.value = inst.name;
    modal.classList.add("open");
    try {
      await ensureLibs();
      const r = await fetch(`/api/chart/${encodeURIComponent(inst.name)}${(inst.candleType || (window.nativeCandleOf ? window.nativeCandleOf(inst.strategy) : "")) === "RANGE" ? "?minutes=1" : ""}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "chart request failed");
      // Open on the candle type the instrument actually trades: its override, else the strategy's own native type.
      const effType = inst.candleType || (window.nativeCandleOf ? window.nativeCandleOf(inst.strategy) : "RAW");
      const bars = data.tfBars.map(toBar);
      const dayIdx = Math.max(0, bars.findIndex(b => b.t >= data.fromTs));   // first bar of the 1-month window (earlier bars are indicator / HA warm-up)
      const chart = window.LightweightCharts.createChart(els.box, {
        autoSize: true,
        layout: { background: { color: CC.bg }, textColor: "#9fd8b6", fontFamily: "JetBrains Mono, monospace" },
        grid: { vertLines: { color: gridRgba(CC.grid) }, horzLines: { color: gridRgba(CC.grid) } },
        rightPriceScale: { borderColor: "rgba(70,255,150,0.25)" },
        timeScale: { borderColor: "rgba(70,255,150,0.25)", timeVisible: true, secondsVisible: false },
        crosshair: { mode: 0 },
        handleScroll: { mouseWheel: true, pressedMouseMove: false, horzTouchDrag: false, vertTouchDrag: false },
        handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: true },
        kineticScroll: { touch: true, mouse: true },   // inertia after a flick / drag
      });
      chart.timeScale().applyOptions({ rightOffset: 6, barSpacing: 9, minBarSpacing: 1.5, fixLeftEdge: false, shiftVisibleRangeOnNewBar: true });
      const sr = chart.addCandlestickSeries({
        ...seriesColors(),
        priceLineVisible: false, lastValueVisible: false,   // the live-price line below shows the real traded price, not an HA / range-bar close
        autoscaleInfoProvider: orig => (S && S.manual ? { priceRange: { minValue: S.manual.min, maxValue: S.manual.max } } : orig()),
      });
      S = {
        inst, data, bars, dayIdx, chart, series: sr, type: "raw", range: (effType === "RANGE" && inst.rangeSize) ? inst.rangeSize : data.suggestedRange, last: null,
        overlay: data.overlay, blocks: (data.blocks || []).slice(), ind: false, filters: false, lineSeries: [], dispT: null, dispTimes: null,
        points: minutePoints(data.minuteBars.map(toBar)), minutesLoaded: data.minuteBars.length > 0, isToday: data.day === istDay(Date.now()), timer: null, dirty: false, lastTime: 0,
      };
      if (bars.length) S.last = bars[bars.length - 1].c;
      attachPriceAxisZoom();
      S.tagEl = document.createElement("div"); S.tagEl.className = "chart-tags"; els.box.appendChild(S.tagEl);
      S.tagTimer = setInterval(markTags, 400);   // safety net: the price axis can auto-scale without any event of ours
      // A touch screen keeps the crosshair where the finger last was (there is no mouse-leave), which would freeze the read-out on that
      // candle. When a finger lifts, forget the crosshair candle so the read-out goes back to the tapped / right-most visible candle.
      S.gesture = { moved: false, multi: false }; S.ptrs = new Set();
      els.box.addEventListener("pointerdown", e => {
        S.ptrs.add(e.pointerId);
        if (S.ptrs.size === 1) S.gesture = { moved: false, multi: false, x: e.clientX, y: e.clientY };
        else S.gesture.multi = true;
      }, true);
      els.box.addEventListener("pointermove", e => { if (S.ptrs.has(e.pointerId) && S.gesture.x !== undefined && Math.hypot(e.clientX - S.gesture.x, e.clientY - S.gesture.y) > 8) S.gesture.moved = true; }, true);
      ["pointerup", "pointercancel"].forEach(ev => els.box.addEventListener(ev, e => { S.ptrs.delete(e.pointerId); }, true));
      ["pointerup", "pointercancel"].forEach(ev => els.box.addEventListener(ev, e => {
        if (e.pointerType !== "touch") return;
        setTimeout(() => { if (S) { S.hover = null; S.hoverTime = null; legend(); } }, 80);
      }, true));
      ["pointermove", "pointerup", "wheel", "touchmove"].forEach(ev => els.box.addEventListener(ev, markTags, { passive: true, capture: true }));
      S.hover = null; S.pinned = null; S.edgeIdx = null; S.position = null; S.depthOn = true;
      S.effType = effType;
      { const L = loadDsb(inst.name); S.dsb = L.d; S.dsbSaved = L.saved; S.dsbSeries = null; S.dsbMarks = []; syncDsbInputs(); }
      els.dsbBtn.classList.toggle("active", els.dsbPanel.style.display !== "none");
      els.depth.style.display = "";
      modal.querySelector('[data-toggle="depth"]').classList.add("active");
      startDepth();
      chart.subscribeCrosshairMove(param => {
        const d = param && param.seriesData ? param.seriesData.get(sr) : null;
        S.hover = d && d.open !== undefined ? d : null;
        S.hoverTime = S.hover ? param.time : null;
        legend();
      });
      // Tap / click a candle to read its O/H/L/C (touch screens have no hover); tap empty space to go back to the live candle.
      chart.subscribeClick(param => {
        if (S.gesture && (S.gesture.moved || S.gesture.multi)) return;   // the end of a pan / pinch is not a tap
        const d = param && param.seriesData ? param.seriesData.get(sr) : null;
        S.pinned = d && d.open !== undefined ? d : null;
        S.pinnedTime = S.pinned ? param.time : null;
        legend();
      });
      // Scrolling back: the right-most visible candle becomes the reference (touch screens have no crosshair).
      chart.timeScale().subscribeVisibleLogicalRangeChange(r => {
        if (!S || !r) return;
        const n = S.listLen || 0, i = Math.min(Math.floor(r.to), n - 1);
        const next = i >= n - 1 || n === 0 ? null : Math.max(0, i);
        if (next === S.edgeIdx) return;
        S.edgeIdx = next;
        S.pinned = null;   // scrolling moves on from a tapped candle
        scheduleLegend();
      });
      refreshPosition();
      S.posTimer = setInterval(refreshPosition, 10000);
      els.range.value = S.range;
      modal.querySelectorAll(".chart-toggle").forEach(b => b.classList.toggle("active", b.dataset.toggle === "depth" && S.depthOn));
      info();
      await setType(effType === "HA" ? "ha" : effType === "RANGE" ? "range" : "raw");   // open on the series the instrument actually trades
    } catch (err) {
      els.status.textContent = "error: " + err.message;
    }
  }

  window.openInstrumentChart = open;
  window.chartFillPicker = list => {
    if (!modal) build();
    els.pick.innerHTML = list.map(i => `<option value="${i.name}">${i.underlying} · ${i.label || i.strategy}${i.candleType ? " · " + i.candleType : ""}</option>`).join("");
  };
  window.chartOnLtp = onLtp;
  window.chartOnDepth = onDepth;
  window.chartOnSocketOpen = subscribeDepth;   // re-subscribe after a socket reconnect
  window.chartOnBlock = onBlock;
})();
