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
          </div>
          <label class="chart-range" data-r="rangeWrap" style="display:none">range <input type="number" data-r="range" min="0.01" step="any"></label>
          <span class="chart-status" data-r="status"></span>
        </div>
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
    els.range.addEventListener("change", () => { if (S && S.type === "range") { S.range = Number(els.range.value) || S.range; render(true); } });
  }

  function close() {
    modal.classList.remove("open");
    if (S && S.chart) S.chart.remove();
    if (S && S.posTimer) clearInterval(S.posTimer);
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
    const base = S.type === "ha" ? toHA(S.bars) : S.bars;
    displayedT = base.slice(S.dayIdx).map(b => b.t);
    return base.slice(S.dayIdx);
  }

  function render(fit) {
    const disp = displayed();
    S.lastDisp = disp[disp.length - 1] || null;
    const list = series(disp);
    S.series.setData(list);
    S.listLen = list.length;
    S.lastTime = list.length ? list[list.length - 1].time : 0;
    S.dispT = displayedT; S.dispTimes = list.map(x => x.time);
    if (fit) {
      // A month of bars is loaded; open zoomed on the recent ones (scroll / zoom back for the rest).
      const n = list.length;
      if (n > 160) S.chart.timeScale().setVisibleLogicalRange({ from: n - 140, to: n + 6 }); else S.chart.timeScale().fitContent();
    }
    drawOverlay(); drawMarkers();
    status();
  }

  // ── Indicator tab: the instrument's own indicator lines (server computes via chartOverlay.js) ──
  const SHORT = { CHOP: "CHOP", VOLUME: "VOL", LONG_CANDLE: "LONGC", HTF: "HTF", DOUBLE_ORDER: "2X", DAILY_HA: "DHA", ENTRY_TIME: "TIME" };
  const LONGNAME = { CHOP: "choppiness index", VOLUME: "volume below SMA", LONG_CANDLE: "long-candle filter", HTF: "higher-timeframe trend", DOUBLE_ORDER: "double-order guard", DAILY_HA: "daily HA direction", ENTRY_TIME: "before entry time" };
  function drawOverlay() {
    (S.lineSeries || []).forEach(ls => S.chart.removeSeries(ls));
    S.lineSeries = [];
    const ov = S.overlay;
    if (!S.ind || !ov || !ov.lines) return;
    const step = window.LightweightCharts.LineType ? window.LightweightCharts.LineType.WithSteps : undefined;
    for (const l of ov.lines) {
      const stepped = step !== undefined && !l.width;   // bands step; a "mid" style line (width set) draws as a plain line
      const ls = S.chart.addLineSeries({ color: l.color, lineWidth: l.width || 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...(stepped ? { lineType: step } : {}) });
      let prev = 0; const data = [];
      for (const [t, v, col] of l.points) { const time = Math.floor(t / 1000) + IST_S; if (time > prev) { data.push(col ? { time, value: v, color: col } : { time, value: v }); prev = time; } }
      ls.setData(data);
      S.lineSeries.push(ls);
    }
  }

  // ── Filters tab: markers where an entry gate blocked a signal ──
  function drawMarkers() {
    if (!S.filters || !S.dispT || !S.dispT.length) { S.series.setMarkers([]); return; }
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
    S.series.setMarkers(marks);
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
    drawOverlay(); drawMarkers(); info();
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
      drawOverlay(); drawMarkers(); info();
    } catch { /* keep what we have */ }
  }
  function onBlock(msg) {
    if (!S || !S.isToday || msg.engine !== S.data.underlying || !Array.isArray(msg.reasons)) return;
    if (msg.proc && S.inst && S.inst.name && msg.proc !== S.inst.name) return;   // another candle-type deployment of the same instrument
    S.blocks.push({ ts: msg.ts || Date.now(), side: msg.side, price: msg.price, reasons: msg.reasons });
    drawMarkers(); info();
  }

  // OHLC of the candle under the crosshair (else the latest candle) + the open position's entry price.
  function legend(hover) {
    if (!els.legend || !S) return;
    let k = hover || null;
    if (!k) { const l = S.lastDisp; if (l) k = { open: l.o, high: l.h, low: l.l, close: l.c }; }
    const f = v => Number(v).toFixed(2);
    const parts = [];
    if (k) parts.push(`O ${f(k.open)}  H ${f(k.high)}  L ${f(k.low)}  C ${f(k.close)}`);
    if (S.position && S.position.entry_price != null) parts.push(`${S.position.position} entry @ ${f(S.position.entry_price)}`);
    els.legend.textContent = parts.join("   |   ");
    els.legend.style.display = parts.length ? "" : "none";
  }
  async function refreshPosition() {
    if (!S) return;
    const mine = S;
    try {
      const r = await fetch(`/api/state/${encodeURIComponent(mine.inst.underlying)}/${encodeURIComponent(mine.inst.strategy)}?candle=${encodeURIComponent(mine.inst.candleType || "")}`);
      const d = await r.json();
      if (S !== mine) return;
      S.position = d.position || null;
      legend(S.hover || null);
    } catch { /* keep last */ }
  }

  function status() {
    const live = S.isToday ? "LIVE" : "closed — last session";
    els.status.textContent = `${S.data.timeframe} · ${S.dispT && S.dispT.length > 1 && S.type !== "range" ? "last " + (S.data.timeframe === "1d" ? "5 months" : "month") : S.data.day} · ${live}${S.last !== null ? " · " + S.last.toFixed(2) : ""}`;
    legend(S.hover || null);
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
    if (!S || !S.isToday || msg.engine !== S.data.underlying) return;
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
  function flush() {
    if (!S) return;
    S.timer = null;
    if (!S.dirty) return;
    S.dirty = false;
    const disp = displayed();
    const last = disp[disp.length - 1];
    if (!last) return;
    S.lastDisp = last;
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

  async function open(inst) {
    if (!modal) build();
    if (S && S.chart) S.chart.remove();
    if (S && S.posTimer) clearInterval(S.posTimer);
    stopDepth();
    S = null;
    els.title.textContent = `${inst.underlying} · ${inst.strategy}${" · " + (inst.candleType || (window.nativeCandleOf ? window.nativeCandleOf(inst.strategy) : ""))}`;
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
        layout: { background: { color: "#050806" }, textColor: "#9fd8b6", fontFamily: "JetBrains Mono, monospace" },
        grid: { vertLines: { color: "rgba(70,255,150,0.07)" }, horzLines: { color: "rgba(70,255,150,0.07)" } },
        rightPriceScale: { borderColor: "rgba(70,255,150,0.25)" },
        timeScale: { borderColor: "rgba(70,255,150,0.25)", timeVisible: true, secondsVisible: false },
        crosshair: { mode: 0 },
        handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
        handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: true },
        kineticScroll: { touch: true, mouse: true },   // inertia after a flick / drag
      });
      chart.timeScale().applyOptions({ rightOffset: 6, barSpacing: 9, minBarSpacing: 1.5, fixLeftEdge: false, shiftVisibleRangeOnNewBar: true });
      const sr = chart.addCandlestickSeries({
        upColor: "#33ff88", downColor: "#ff5266", borderUpColor: "#33ff88", borderDownColor: "#ff5266",
        wickUpColor: "#33ff88", wickDownColor: "#ff5266",
      });
      S = {
        inst, data, bars, dayIdx, chart, series: sr, type: "raw", range: (effType === "RANGE" && inst.rangeSize) ? inst.rangeSize : data.suggestedRange, last: null,
        overlay: data.overlay, blocks: (data.blocks || []).slice(), ind: false, filters: false, lineSeries: [], dispT: null, dispTimes: null,
        points: minutePoints(data.minuteBars.map(toBar)), minutesLoaded: data.minuteBars.length > 0, isToday: data.day === istDay(Date.now()), timer: null, dirty: false, lastTime: 0,
      };
      if (bars.length) S.last = bars[bars.length - 1].c;
      S.hover = null; S.position = null; S.depthOn = true;
      els.depth.style.display = "";
      modal.querySelector('[data-toggle="depth"]').classList.add("active");
      startDepth();
      chart.subscribeCrosshairMove(param => {
        const d = param && param.seriesData ? param.seriesData.get(sr) : null;
        S.hover = d && d.open !== undefined ? d : null;
        legend(S.hover);
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
    els.pick.innerHTML = list.map(i => `<option value="${i.name}">${i.underlying} · ${i.strategy}${i.candleType ? " · " + i.candleType : ""}</option>`).join("");
  };
  window.chartOnLtp = onLtp;
  window.chartOnDepth = onDepth;
  window.chartOnSocketOpen = subscribeDepth;   // re-subscribe after a socket reconnect
  window.chartOnBlock = onBlock;
})();
