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
          <button class="btn btn-ghost" data-r="close">Close</button>
        </div>
        <div class="chart-controls">
          <div class="chart-seg">
            <button class="btn btn-ghost chart-type active" data-type="raw">Raw</button>
            <button class="btn btn-ghost chart-type" data-type="ha">HA</button>
            <button class="btn btn-ghost chart-type" data-type="range">Range</button>
          </div>
          <label class="chart-range" data-r="rangeWrap" style="display:none">range <input type="number" data-r="range" min="0.01" step="any"></label>
          <span class="chart-status" data-r="status"></span>
        </div>
        <div class="chart-box" data-r="box"></div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelectorAll("[data-r]").forEach(e => { els[e.dataset.r] = e; });
    els.close.addEventListener("click", close);
    modal.addEventListener("click", e => { if (e.target === modal) close(); });
    modal.querySelectorAll(".chart-type").forEach(b => b.addEventListener("click", () => setType(b.dataset.type)));
    els.range.addEventListener("change", () => { if (S && S.type === "range") { S.range = Number(els.range.value) || S.range; render(true); } });
  }

  function close() {
    modal.classList.remove("open");
    if (S && S.chart) S.chart.remove();
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

  function displayed() {
    if (S.type === "range") {
      const { bars, forming } = window.makeRangeBars(S.points, S.range);
      const all = bars.map(b => ({ t: b.time, o: b.open, h: b.high, l: b.low, c: b.close }));
      if (forming && (forming.high !== forming.low || !all.length)) all.push({ t: forming.time, o: forming.open, h: forming.high, l: forming.low, c: forming.close });
      return all;
    }
    const base = S.type === "ha" ? toHA(S.bars) : S.bars;
    return base.slice(S.dayIdx);
  }

  function render(fit) {
    const list = series(displayed());
    S.series.setData(list);
    S.lastTime = list.length ? list[list.length - 1].time : 0;
    if (fit) S.chart.timeScale().fitContent();
    status();
  }

  function status() {
    const live = S.isToday ? "LIVE" : "closed — last session";
    els.status.textContent = `${S.data.timeframe} · ${S.data.day} · ${live}${S.last !== null ? " · " + S.last.toFixed(2) : ""}`;
  }

  function setType(type) {
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
    S.points.push({ price, time: ts });
    // fold into the instrument-timeframe bar for this slot (anchored on the day's first bar)
    const slot = S.data.tfMinutes * 60000, anchor = S.bars[S.dayIdx] ? S.bars[S.dayIdx].t : null;
    if (anchor !== null && ts >= anchor) {
      const start = anchor + Math.floor((ts - anchor) / slot) * slot;
      const lastBar = S.bars[S.bars.length - 1];
      if (lastBar.t === start) { lastBar.h = Math.max(lastBar.h, price); lastBar.l = Math.min(lastBar.l, price); lastBar.c = price; }
      else if (start > lastBar.t) S.bars.push({ t: start, o: price, h: price, l: price, c: price });
    }
    S.dirty = true;
    if (!S.timer) S.timer = setTimeout(flush, 250);   // coalesce bursts
  }
  function flush() {
    if (!S) return;
    S.timer = null;
    if (!S.dirty) return;
    S.dirty = false;
    if (S.type === "range") { render(false); return; }
    const list = displayed();
    const last = list[list.length - 1];
    if (!last) return;
    const x = lw(last, undefined);
    if (x.time < S.lastTime) return;
    S.series.update(x);
    S.lastTime = x.time;
    status();
  }

  // ── open ──────────────────────────────────────────────────────────────────
  async function open(inst) {
    if (!modal) build();
    if (S && S.chart) S.chart.remove();
    S = null;
    els.title.textContent = `${inst.underlying} · ${inst.strategy}`;
    els.status.textContent = "loading…";
    els.box.innerHTML = "";
    modal.classList.add("open");
    try {
      await ensureLibs();
      const r = await fetch(`/api/chart/${encodeURIComponent(inst.name)}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "chart request failed");
      const bars = data.tfBars.map(toBar);
      const dayIdx = Math.max(0, bars.findIndex(b => istDay(b.t) === data.day));
      const chart = window.LightweightCharts.createChart(els.box, {
        autoSize: true,
        layout: { background: { color: "#050806" }, textColor: "#9fd8b6", fontFamily: "JetBrains Mono, monospace" },
        grid: { vertLines: { color: "rgba(70,255,150,0.07)" }, horzLines: { color: "rgba(70,255,150,0.07)" } },
        rightPriceScale: { borderColor: "rgba(70,255,150,0.25)" },
        timeScale: { borderColor: "rgba(70,255,150,0.25)", timeVisible: true, secondsVisible: false },
        crosshair: { mode: 0 },
      });
      const sr = chart.addCandlestickSeries({
        upColor: "#33ff88", downColor: "#ff5266", borderUpColor: "#33ff88", borderDownColor: "#ff5266",
        wickUpColor: "#33ff88", wickDownColor: "#ff5266",
      });
      S = {
        inst, data, bars, dayIdx, chart, series: sr, type: "raw", range: data.suggestedRange, last: null,
        points: minutePoints(data.minuteBars.map(toBar)), isToday: data.day === istDay(Date.now()), timer: null, dirty: false, lastTime: 0,
      };
      if (bars.length) S.last = bars[bars.length - 1].c;
      els.range.value = S.range;
      setType("raw");
    } catch (err) {
      els.status.textContent = "error: " + err.message;
    }
  }

  window.openInstrumentChart = open;
  window.chartOnLtp = onLtp;
})();
