// chartpage.js — standalone chart window (chart.html): the same chart as the dashboard modal, on its own page,
// with its own dashboard socket, so it can live in another tab / on a second monitor. The session cookie from
// unlocking the dashboard is shared by every tab of this browser.
"use strict";
(function () {
  window.chartStandalone = true;
  const msgEl = document.getElementById("chartPageMsg");
  const say = html => { msgEl.innerHTML = html; msgEl.style.display = ""; };
  let socket = null, replayRemaining = 0;

  window.wdSend = obj => { try { if (socket && socket.readyState === 1) { socket.send(JSON.stringify(obj)); return true; } } catch { /* ignore */ } return false; };

  function connect() {
    socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);
    socket.addEventListener("open", () => { if (window.chartOnSocketOpen) window.chartOnSocketOpen(); });
    socket.addEventListener("close", () => setTimeout(connect, 3000));
    socket.addEventListener("error", () => socket.close());
    socket.addEventListener("message", ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "DEPTH" || m.type === "DEPTH_ERR") { window.chartOnDepth && window.chartOnDepth(m); return; }
      if (m.type === "HELLO") { replayRemaining = m.replaying || 0; return; }
      if (m.type === "LTP") { window.chartOnLtp && window.chartOnLtp(m); return; }
      const replay = replayRemaining > 0; if (replay) replayRemaining--;
      if (m.type === "BLOCK" && !replay) window.chartOnBlock && window.chartOnBlock(m);
    });
  }

  async function init() {
    try {
      const st = await (await fetch("/api/auth/status")).json();
      if (st.enabled && !st.authenticated) { say('Dashboard is locked. <a href="/">Open the dashboard and enter the PIN</a>, then reload this page.'); return; }
      const [insts, strats] = await Promise.all([
        fetch("/api/instruments").then(r => r.json()),
        fetch("/api/toolbox/strategies").then(r => r.json()).catch(() => ({ strategies: [] })),
      ]);
      const native = {}; (strats.strategies || []).forEach(s => { native[s.key] = s.nativeCandle; });
      window.nativeCandleOf = k => native[k] || "RAW";
      const list = (Array.isArray(insts) ? insts : []).filter(i => i && i.name);
      if (!list.length) { say("No instruments found."); return; }
      window.chartInstruments = list;
      window.chartFillPicker(list);
      const want = new URLSearchParams(location.search).get("name");
      const inst = list.find(i => i.name === want) || list[0];
      connect();
      window.openInstrumentChart(inst);
    } catch (err) { say("Could not start the chart: " + err.message); }
  }
  init();
})();
