"use strict";

// NOTE on identity: live events from eventBridge.js carry `engine` = the
// underlying's tgPrefix (e.g. "ZINCMINI") — not the PM2 process name, and
// not strategy-specific. If the same underlying is ever run under two
// strategies at once, a tick is applied to every card for that underlying
// — the same ambiguity the existing Telegram alerts already have (they key
// off tgPrefix too). Not a regression introduced here.

const grid       = document.getElementById("instrumentGrid");
const hedgePairsPanel = document.getElementById("hedgePairsPanel");
const hedgePairsGrid  = document.getElementById("hedgePairsGrid");
const dualHedgePanel  = document.getElementById("dualHedgePanel");
const dualHedgeGrid   = document.getElementById("dualHedgeGrid");
const logStream  = document.getElementById("logStream");
const connStatus = document.getElementById("connStatus");
const totalPnlEl = document.getElementById("totalSessionPnl");
const engineCountEl = document.getElementById("engineCount");
const autoscrollToggle = document.getElementById("autoscrollToggle");
const refreshBtn = document.getElementById("refreshBtn");
const layoutEditToggle = document.getElementById("layoutEditToggle");
const layoutResetBtn = document.getElementById("layoutResetBtn");
const tokenBtn = document.getElementById("tokenBtn");
const tokenDot = document.getElementById("tokenDot");
const tokenLabel = document.getElementById("tokenLabel");
const tokenPanel = document.getElementById("tokenPanel");
const tokenAccountList = document.getElementById("tokenAccountList");
const appRoot = document.getElementById("appRoot");
const lockScreen = document.getElementById("lockScreen");
const lockDots = document.getElementById("lockDots");
const lockError = document.getElementById("lockError");
const lockSubtitle = document.getElementById("lockSubtitle");
const lockKeypad = document.getElementById("lockKeypad");
const lockSuccess = document.getElementById("lockSuccess");
const successParticles = document.getElementById("successParticles");

let instruments = []; // [{name, underlying, strategy, status, live, ...}]
const sessionPnlByUnderlying = new Map();

function fmtSigned(n) {
  const v = Number(n) || 0;
  return (v >= 0 ? "+" : "") + v.toFixed(0);
}

function cls(n) {
  if (n > 0) return "pos";
  if (n < 0) return "neg";
  return "flat";
}

// ── instrument cards ────────────────────────────────────────────────────
function cardId(inst) { return `card-${inst.name}`; }

let renderedInstrumentNames = null; // null = never rendered yet

function buildCard(inst) {
  const el = document.createElement("div");
  el.className = "card";
  el.id = cardId(inst);
  el.innerHTML = `
    <div class="card-top">
      <div class="card-id">
        <span class="card-underlying">${inst.underlying}</span>
        <span class="card-strategy">${inst.strategy}</span>
      </div>
      <div>
        <span class="status-pill ${inst.status === "online" ? "online" : "offline"}" data-role="status">${inst.status}</span>
        <span class="mode-pill ${inst.live ? "live" : ""}" data-role="mode">${inst.live ? "live" : "paper"}</span>
      </div>
    </div>
    <div class="card-price-row">
      <span class="state-marker flat" data-role="marker">●</span>
      <span class="card-price" data-role="price">—</span>
    </div>
    <div class="pnl-row">
      <div class="pnl-box">
        <span class="pnl-label">Unrealized</span>
        <span class="pnl-value flat" data-role="upnl">+0</span>
      </div>
      <div class="pnl-box">
        <span class="pnl-label">Session</span>
        <span class="pnl-value flat" data-role="session">+0</span>
      </div>
    </div>
    <div class="card-controls">
      <button class="btn btn-start" data-action="start">Start</button>
      <button class="btn btn-stop" data-action="stop">Stop</button>
      <button class="btn btn-restart" data-action="restart">Restart</button>
    </div>
  `;
  el.querySelectorAll("[data-action]").forEach(btn => {
    btn.addEventListener("click", () => control(inst.name, btn.dataset.action, el));
  });
  return el;
}

function renderInstruments() {
  if (instruments.length === 0) {
    grid.innerHTML = `<div class="empty-state">No engines detected — waiting on PM2...</div>`;
    engineCountEl.textContent = "0";
    renderedInstrumentNames = null;
    return;
  }

  engineCountEl.textContent = String(instruments.length);

  const currentNames = instruments.map(i => i.name).sort().join(",");
  const sameSet = renderedInstrumentNames === currentNames;

  if (!sameSet) {
    // Real change in what's running (added/removed engine, or first load)
    // — full rebuild is correct here, there's nothing live to preserve for
    // a card that didn't exist a moment ago.
    grid.innerHTML = "";
    for (const inst of instruments) {
      grid.appendChild(buildCard(inst));
      loadEngineState(inst);
    }
    renderedInstrumentNames = currentNames;
    return;
  }

  // Same instruments still running — patch status/mode pills in place only.
  // This is the fix for values going blank after a while: the 30s periodic
  // resync used to call this and blow away every card (innerHTML = ""),
  // resetting price/marker/uPnl to placeholders until the next WS tick
  // arrived — which could be minutes away on a 15m timeframe. Now a
  // resync that doesn't actually change anything touches nothing live.
  instruments.forEach(inst => {
    const el = document.getElementById(cardId(inst));
    if (!el) return;
    const statusEl = el.querySelector('[data-role="status"]');
    statusEl.textContent = inst.status;
    statusEl.className = `status-pill ${inst.status === "online" ? "online" : "offline"}`;
    const modeEl = el.querySelector('[data-role="mode"]');
    modeEl.textContent = inst.live ? "live" : "paper";
    modeEl.className = `mode-pill ${inst.live ? "live" : ""}`;
  });
}

// ── hedge pair cards — main dashboard visibility (previously ONLY visible
// inside the Toolbox "⇄ hedge pairs" modal, which meant a hedge pair
// process running live gave no signal at all on the primary operator
// view — reported directly). Card shell (status/lots/controls) polls the
// same /api/toolbox/hedgepairs list the toolbox modal uses, on the same
// 30s cadence as loadInstruments(), and reuses the generic /api/control
// endpoint for start/stop/restart (name-based, no dependency on the
// single-instrument getEngineProcesses() shape). The 4 PnL panes and the
// main Live Log panel are different: CHANGED Sep 2026 — hedgePairEngine.js
// still runs no live WS ticker (see its own header, still accurate), but
// now emits a per-leg TICK over the SAME eventBridge/WS every poll cycle
// (60s default) via REST LTP polling, same event type strategies.js's
// per-candle TICK already uses — reported directly, this was both "no
// visible logs at all from a running hedge pair" and "no live PnL on its
// card" at once, same root cause.
let hedgePairs = [];

// leg tgPrefix -> {pairName, leg:"core"|"hedge"} — rebuilt every
// loadHedgePairs() poll. Assumes tgPrefix === underlying + "_" + CORE/HEDGE
// (true for every pair running today, ZINC/ZINCMINI and NATURALGAS/
// NATGASMINI included — none of them override context.tgPrefix away from
// the raw underlying string in context.js). If a future pair's underlying
// DOES carry a tgPrefix override, its leg ticks just won't match a card
// here — same silent-no-op the TICK handler already falls back to for any
// unrecognized `msg.engine`, not a new failure mode.
let hedgePairLegIndex = new Map();
// tgPrefix -> last {uPnl, session} this session — survives individual TICK
// events arriving for only one leg at a time, so the aggregate panes always
// reflect both legs' latest known numbers, not just whichever leg just ticked.
const hedgePairLegPnl = new Map();

function buildHedgePairCard(p) {
  const el = document.createElement("div");
  el.className = "card";
  el.id = `hp-${p.name}`;
  el.innerHTML = `
    <div class="card-top">
      <div class="card-id">
        <span class="card-underlying">${p.coreUnderlying}/${p.hedgeUnderlying}</span>
        <span class="card-strategy">hedge pair \u00b7 unwind:${p.unwindMode}</span>
      </div>
      <div>
        <span class="status-pill ${p.status === "online" ? "online" : "offline"}" data-role="status">${p.status}</span>
        <span class="mode-pill ${p.live ? "live" : ""}">${p.live ? "live" : "paper"}</span>
      </div>
    </div>
    <div class="card-price-row">
      <span class="card-price">core ${p.coreLots} lot NRML \u00b7 hedge ${p.hedgeLots} lots</span>
    </div>
    <div class="pnl-row">
      <div class="pnl-box">
        <span class="pnl-label">${p.coreUnderlying} (full lot)</span>
        <span class="pnl-value flat" data-role="core-pnl">+0</span>
      </div>
      <div class="pnl-box">
        <span class="pnl-label">${p.hedgeUnderlying} (mini lot)</span>
        <span class="pnl-value flat" data-role="hedge-pnl">+0</span>
      </div>
      <div class="pnl-box">
        <span class="pnl-label">Unrealized</span>
        <span class="pnl-value flat" data-role="unrealized">+0</span>
      </div>
      <div class="pnl-box">
        <span class="pnl-label">Realized</span>
        <span class="pnl-value flat" data-role="realized">+0</span>
      </div>
    </div>
    <div class="card-controls">
      <button class="btn btn-start" data-action="start">Start</button>
      <button class="btn btn-stop" data-action="stop">Stop</button>
      <button class="btn btn-restart" data-action="restart">Restart</button>
    </div>
  `;
  el.querySelectorAll("[data-action]").forEach(btn => {
    btn.addEventListener("click", () => control(p.name, btn.dataset.action, el));
  });
  return el;
}

// Called from handleEvent() for any TICK/ENTRY/EXIT whose msg.engine
// matches a known hedge-pair leg tgPrefix. uPnl/session default to the
// leg's last-known values (from hedgePairLegPnl) when an ENTRY/EXIT event
// doesn't carry them, so an entry on one leg doesn't blank the other leg's
// still-valid numbers.
function updateHedgePairLeg(engine, uPnl, session) {
  const hit = hedgePairLegIndex.get(engine);
  if (!hit) return;
  if (uPnl !== undefined) hedgePairLegPnl.set(engine, { uPnl: uPnl || 0, session: session || 0 });

  const el = document.getElementById(`hp-${hit.pairName}`);
  if (!el) return;

  const own = hedgePairLegPnl.get(engine) || { uPnl: 0, session: 0 };
  const ownEl = el.querySelector(`[data-role="${hit.leg}-pnl"]`);
  if (ownEl) { ownEl.textContent = fmtSigned(own.session); ownEl.className = `pnl-value ${cls(own.session)}`; }

  const coreKey  = `${hit.core}_CORE`, hedgeKey = `${hit.hedge}_HEDGE`;
  const c1 = hedgePairLegPnl.get(coreKey)  || { uPnl: 0, session: 0 };
  const c2 = hedgePairLegPnl.get(hedgeKey) || { uPnl: 0, session: 0 };
  const totalUnrealized = c1.uPnl + c2.uPnl;
  const totalRealized   = (c1.session - c1.uPnl) + (c2.session - c2.uPnl);

  const uEl = el.querySelector('[data-role="unrealized"]');
  if (uEl) { uEl.textContent = fmtSigned(totalUnrealized); uEl.className = `pnl-value ${cls(totalUnrealized)}`; }
  const rEl = el.querySelector('[data-role="realized"]');
  if (rEl) { rEl.textContent = fmtSigned(totalRealized); rEl.className = `pnl-value ${cls(totalRealized)}`; }
}

async function loadHedgePairs() {
  try {
    const data = await (await fetch("/api/toolbox/hedgepairs")).json();
    hedgePairs = data.pairs || [];
    if (hedgePairs.length === 0) {
      hedgePairsPanel.style.display = "none";
      return;
    }
    hedgePairsPanel.style.display = "";
    hedgePairsGrid.innerHTML = "";
    hedgePairLegIndex = new Map();
    hedgePairs.forEach(p => {
      hedgePairsGrid.appendChild(buildHedgePairCard(p));
      const legMeta = { pairName: p.name, core: p.coreUnderlying, hedge: p.hedgeUnderlying };
      hedgePairLegIndex.set(`${p.coreUnderlying}_CORE`,   { ...legMeta, leg: "core" });
      hedgePairLegIndex.set(`${p.hedgeUnderlying}_HEDGE`, { ...legMeta, leg: "hedge" });
    });
  } catch (err) {
    // Best-effort, same as loadEngineState — a failed poll just leaves the
    // panel as it was rather than erroring the whole dashboard load.
  }
}

// ── dual hedge cards — same main-dashboard-visibility treatment as hedge
// pair cards above (mirrors that block exactly), for the same reason: a
// dual-hedge deployment running live previously gave no signal at all on
// the primary operator view, only inside the Toolbox "⇅ dual hedge" modal.
// One real difference from hedge pairs: BOTH legs of a dual-hedge
// deployment trade the SAME underlying (see dualHedgeEngine.js's header)
// — dualHedgeContext.js suffixes tgPrefix as `${underlying}_DH_LONG` /
// `${underlying}_DH_SHORT` specifically so the two legs' events don't
// collide with each other OR with a plain single-account engine on that
// same underlying (which would just be `${underlying}` with no suffix).
let dualHedges = [];
let dualHedgeLegIndex = new Map(); // tgPrefix -> {dealName, leg:"long"|"short"}
const dualHedgeLegPnl = new Map(); // tgPrefix -> last {uPnl, session}

function dualHedgeStrategyText(d) {
  if (d.strategy === "BIAS") {
    const unwind = d.unwindMode === "EOD_ONLY" ? "held to EOD" : "unwinds when the band flips back";
    return `dual bias hedge \u00b7 core: daily HA @${d.entryTime} \u00b7 hedge: ${d.bandTimeframe} band (${unwind}) \u00b7 flat ${d.eodTime || "EOD"}`;
  }
  return `dual hedge \u00b7 stop:${d.slMode === "ATR" ? `${d.atrSlMult}x ATR/${d.atrTimeframe}` : `\u20b9${d.maxLoss}`} \u00b7 tp:\u20b9${d.takeProfit}${d.rangeSize ? ` \u00b7 range:${d.rangeSize}` : ""} (armed only after a flip)${d.gapCapture ? ` \u00b7 gap capture ${d.gcEntry}\u2192${d.gcExit}` : ""}`;
}

function buildDualHedgeCard(d) {
  const el = document.createElement("div");
  el.className = "card";
  el.id = `dh-${d.name}`;
  el.innerHTML = `
    <div class="card-top">
      <div class="card-id">
        <span class="card-underlying">${d.underlying}</span>
        <span class="card-strategy">${dualHedgeStrategyText(d)}</span>
      </div>
      <div>
        <span class="status-pill ${d.status === "online" ? "online" : "offline"}" data-role="status">${d.status}</span>
        <span class="mode-pill ${d.live ? "live" : ""}">${d.live ? "live" : "paper"}</span>
      </div>
    </div>
    <div class="card-price-row">
      <span class="card-price">LONG:${d.longUser} \u00b7 SHORT:${d.shortUser} \u00b7 ${d.lots} lot ${d.strategy === "BIAS" ? "each \u00b7 flat at EOD" : "NRML each"}</span>
    </div>
    <div class="pnl-row">
      <div class="pnl-box">
        <span class="pnl-label">LONG (${d.longUser})</span>
        <span class="pnl-value flat" data-role="long-pnl">+0</span>
      </div>
      <div class="pnl-box">
        <span class="pnl-label">SHORT (${d.shortUser})</span>
        <span class="pnl-value flat" data-role="short-pnl">+0</span>
      </div>
      <div class="pnl-box">
        <span class="pnl-label">Unrealized</span>
        <span class="pnl-value flat" data-role="unrealized">+0</span>
      </div>
      <div class="pnl-box">
        <span class="pnl-label">Realized</span>
        <span class="pnl-value flat" data-role="realized">+0</span>
      </div>
    </div>
    <div class="card-controls">
      <button class="btn btn-start" data-action="start">Start</button>
      <button class="btn btn-stop" data-action="stop">Stop</button>
      <button class="btn btn-restart" data-action="restart">Restart</button>
    </div>
  `;
  el.querySelectorAll("[data-action]").forEach(btn => {
    btn.addEventListener("click", () => control(d.name, btn.dataset.action, el));
  });
  return el;
}

// Same shape as updateHedgePairLeg() — see that function's own comment.
function updateDualHedgeLeg(engine, uPnl, session) {
  const hit = dualHedgeLegIndex.get(engine);
  if (!hit) return;
  if (uPnl !== undefined) dualHedgeLegPnl.set(engine, { uPnl: uPnl || 0, session: session || 0 });

  const el = document.getElementById(`dh-${hit.dealName}`);
  if (!el) return;

  const own = dualHedgeLegPnl.get(engine) || { uPnl: 0, session: 0 };
  const ownEl = el.querySelector(`[data-role="${hit.leg}-pnl"]`);
  if (ownEl) { ownEl.textContent = fmtSigned(own.session); ownEl.className = `pnl-value ${cls(own.session)}`; }

  const longKey = `${hit.underlying}_DH_LONG`, shortKey = `${hit.underlying}_DH_SHORT`;
  const c1 = dualHedgeLegPnl.get(longKey)  || { uPnl: 0, session: 0 };
  const c2 = dualHedgeLegPnl.get(shortKey) || { uPnl: 0, session: 0 };
  const totalUnrealized = c1.uPnl + c2.uPnl;
  const totalRealized   = (c1.session - c1.uPnl) + (c2.session - c2.uPnl);

  const uEl = el.querySelector('[data-role="unrealized"]');
  if (uEl) { uEl.textContent = fmtSigned(totalUnrealized); uEl.className = `pnl-value ${cls(totalUnrealized)}`; }
  const rEl = el.querySelector('[data-role="realized"]');
  if (rEl) { rEl.textContent = fmtSigned(totalRealized); rEl.className = `pnl-value ${cls(totalRealized)}`; }
}

async function loadDualHedges() {
  try {
    const data = await (await fetch("/api/toolbox/dualhedge")).json();
    dualHedges = data.deployments || [];
    if (dualHedges.length === 0) {
      dualHedgePanel.style.display = "none";
      return;
    }
    dualHedgePanel.style.display = "";
    dualHedgeGrid.innerHTML = "";
    dualHedgeLegIndex = new Map();
    dualHedges.forEach(d => {
      dualHedgeGrid.appendChild(buildDualHedgeCard(d));
      const legMeta = { dealName: d.name, underlying: d.underlying };
      dualHedgeLegIndex.set(`${d.underlying}_DH_LONG`,  { ...legMeta, leg: "long" });
      dualHedgeLegIndex.set(`${d.underlying}_DH_SHORT`, { ...legMeta, leg: "short" });
    });
  } catch (err) {
    // best-effort, same as loadHedgePairs
  }
}

async function loadEngineState(inst) {
  try {
    const res = await fetch(`/api/state/${encodeURIComponent(inst.underlying)}/${encodeURIComponent(inst.strategy)}`);
    const state = await res.json();
    const session = state.realizedToday || 0;
    sessionPnlByUnderlying.set(inst.underlying, session);
    updateCardPnl(inst.underlying, null, session);
    updateTotalPnl();
  } catch { /* best-effort initial load */ }
}

function updateCardPnl(underlying, uPnl, session) {
  instruments
    .filter(i => i.underlying === underlying)
    .forEach(i => {
      const el = document.getElementById(cardId(i));
      if (!el) return;
      if (uPnl !== null) {
        const uEl = el.querySelector('[data-role="upnl"]');
        uEl.textContent = fmtSigned(uPnl);
        uEl.className = `pnl-value ${cls(uPnl)}`;
      }
      const sEl = el.querySelector('[data-role="session"]');
      sEl.textContent = fmtSigned(session);
      sEl.className = `pnl-value ${cls(session)}`;
    });
}

function updateTotalPnl() {
  let total = 0;
  sessionPnlByUnderlying.forEach(v => total += v);
  totalPnlEl.textContent = fmtSigned(total);
  totalPnlEl.className = `session-value ${cls(total)}`;
}

function flashCards(underlying, direction) {
  instruments
    .filter(i => i.underlying === underlying)
    .forEach(i => {
      const el = document.getElementById(cardId(i));
      if (!el) return;
      el.classList.remove("flash-up", "flash-down");
      void el.offsetWidth; // restart animation
      el.classList.add(direction > 0 ? "flash-up" : "flash-down");
      setTimeout(() => el.classList.remove("flash-up", "flash-down"), 900);
    });
}

async function control(name, action, cardEl) {
  cardEl.style.opacity = "0.6";
  try {
    const res = await fetch("/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, action }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      appendLog({ type: "ERROR", text: `control failed (${name} ${action}): ${err.error || res.statusText}` });
    } else {
      appendLog({ type: "SYS", text: `${name} — ${action} sent` });
      setTimeout(loadInstruments, 1500);
    }
  } catch (err) {
    appendLog({ type: "ERROR", text: `control failed (${name} ${action}): ${err.message}` });
  } finally {
    cardEl.style.opacity = "1";
  }
}

async function loadInstruments() {
  try {
    instruments = await (await fetch("/api/instruments")).json();
    renderInstruments();
  } catch (err) {
    appendLog({ type: "ERROR", text: `failed to load instrument list: ${err.message}` });
  }
}

refreshBtn.addEventListener("click", () => { loadInstruments(); loadHedgePairs(); loadDualHedges(); });

// ── kite access token ───────────────────────────────────────────────────
// Unified panel: the app's own global account PLUS every Dual Hedge/Gap
// Capture user (they share one registry — see dualHedgeUsers.js's
// header) rendered as one list, each row wired the same way — a real <a>
// href set to Kite's real login URL (works as a normal link tap, no
// popup-blocker issues on mobile) that ALSO reveals an inline paste-back
// panel for pasting the request_token (or full redirect URL) Kite sends
// back. Previously this only existed per-account inside the Dual Hedge
// modal's separate "Manage Users" screen — moved up here so generating (or
// checking the freshness of) ANY account's token doesn't require first
// digging into that modal. tokenAccounts caches the last /api/token/status
// fetch so exchange handlers (added once per render) can look up the right
// endpoint/body shape for whichever row they belong to.
let tokenAccounts = [];

function tokenAccountDescriptor(u) {
  // u === null → the app's own global engineConfig account. Otherwise a
  // redacted dual-hedge/gap-capture user (from /api/token/status's users[]).
  if (u === null) {
    return {
      key: "global", label: "global account",
      hasApiKey: true, // /api/token/login-url itself 400s if API_KEY is unset; treat as "try it"
      hasAccessToken: tokenGlobalSet, tokenFresh: tokenGlobalFresh, accessTokenDate: tokenGlobalDate,
      loginUrlPath: "/api/token/login-url",
      exchangePath: "/api/token/exchange",
      buildBody: val => ({ input: val }),
    };
  }
  return {
    key: u.name, label: u.name,
    hasApiKey: u.hasApiKey, hasAccessToken: u.hasAccessToken, tokenFresh: u.tokenFresh, accessTokenDate: u.accessTokenDate,
    loginUrlPath: `/api/toolbox/dualhedge/users/${encodeURIComponent(u.name)}/login-url`,
    exchangePath: "/api/toolbox/dualhedge/users/token",
    buildBody: val => ({ name: u.name, requestToken: val }),
  };
}

let tokenGlobalSet = false, tokenGlobalFresh = false, tokenGlobalDate = null;

function renderTokenAccountRow(acc) {
  const statusClass = !acc.hasAccessToken ? "unset" : (acc.tokenFresh ? "set" : "stale");
  const statusText  = !acc.hasAccessToken ? "no token" : (acc.tokenFresh ? "fresh" : `stale — ${acc.accessTokenDate || "Unknown date"}`);
  const linkDisabled = !acc.hasApiKey;
  return `
    <div class="token-account-row">
      <div class="token-account-main">
        <span class="token-dot ${statusClass}"></span>
        <span class="token-account-label">${acc.label}</span>
        <span class="token-account-status">${statusText}</span>
      </div>
      <a class="token-account-link${linkDisabled ? " disabled" : ""}" id="tokenGenLink-${acc.key}"
         data-token-toggle="${acc.key}" href="#" target="_blank" rel="noopener">${linkDisabled ? "no API key" : "generate"}</a>
    </div>
    <div class="token-account-panel" id="tokenGenPanel-${acc.key}" style="display:none">
      <div class="token-panel-row">
        <input type="text" id="tokenGenInput-${acc.key}" class="token-input" placeholder="request_token or redirect URL">
        <button class="btn btn-restart" data-token-exchange="${acc.key}">Exchange</button>
      </div>
      <div id="tokenGenErr-${acc.key}"></div>
    </div>`;
}

async function refreshTokenStatus() {
  try {
    const status = await (await fetch("/api/token/status")).json();
    tokenGlobalSet = status.set; tokenGlobalFresh = status.fresh; tokenGlobalDate = status.tokenDate;
    tokenAccounts = [tokenAccountDescriptor(null), ...(status.users || []).map(u => tokenAccountDescriptor(u))];

    // Badge: red the moment ANY account is stale/missing (global OR any
    // Dual Hedge/Gap Capture user) — not just the global one. Flips
    // automatically at the IST date rollover — see engineConfig.js's
    // isAccessTokenFresh() for why no separate EOD-triggered job is needed.
    const needsAttention = tokenAccounts.filter(a => !a.hasAccessToken || !a.tokenFresh);
    if (needsAttention.length === 0) {
      tokenDot.className = "token-dot set";
      tokenLabel.textContent = "Tokens fresh";
    } else {
      tokenDot.className = "token-dot unset";
      tokenLabel.textContent = needsAttention.length === 1 && needsAttention[0].key === "global"
        ? (tokenGlobalSet ? "token stale" : "generate token")
        : `${needsAttention.length} stale`;
    }

    tokenAccountList.innerHTML = tokenAccounts.map(renderTokenAccountRow).join("");

    // Prefetch each row's real login URL (pure local string build server-
    // side, no Kite network call — cheap to do for everyone up front, same
    // reasoning the old per-user Dual Hedge panel already used).
    tokenAccounts.filter(a => a.hasApiKey).forEach(async acc => {
      try {
        const data = await (await fetch(acc.loginUrlPath)).json();
        const link = tokenAccountList.querySelector(`#tokenGenLink-${CSS.escape(acc.key)}`);
        if (data.url && link) link.href = data.url;
      } catch { /* leave href as "#" — click still reveals the paste panel */ }
    });

    tokenAccountList.querySelectorAll("[data-token-toggle]").forEach(link => {
      link.addEventListener("click", () => {
        // Real navigation to Kite's login page happens via the href itself
        // (target="_blank") — this handler's only job is to also reveal
        // the paste-back panel for when they come back with a token.
        const panel = tokenAccountList.querySelector(`#tokenGenPanel-${CSS.escape(link.dataset.tokenToggle)}`);
        if (panel) panel.style.display = panel.style.display === "none" ? "" : "none";
      });
    });
    tokenAccountList.querySelectorAll("[data-token-exchange]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const key = btn.dataset.tokenExchange;
        const acc = tokenAccounts.find(a => a.key === key);
        const input = tokenAccountList.querySelector(`#tokenGenInput-${CSS.escape(key)}`);
        const errBox = tokenAccountList.querySelector(`#tokenGenErr-${CSS.escape(key)}`);
        const val = input.value.trim();
        if (!val || !acc) return;
        btn.disabled = true; btn.textContent = "...";
        try {
          const res = await fetch(acc.exchangePath, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(acc.buildBody(val)),
          });
          const data = await res.json();
          if (!res.ok) {
            errBox.innerHTML = `<div class="tb-err-box">${data.error || "Failed"}</div>`;
            btn.disabled = false; btn.textContent = "Exchange";
            return;
          }
          appendLog({ type: "SYS", text: `[token] ${acc.label} access token updated — restart engines to pick it up` });
          refreshTokenStatus();
        } catch (err) {
          errBox.innerHTML = `<div class="tb-err-box">${err.message}</div>`;
          btn.disabled = false; btn.textContent = "Exchange";
        }
      });
    });
  } catch {
    tokenDot.className = "token-dot";
    tokenLabel.textContent = "Generate token";
  }
}

tokenBtn.addEventListener("click", e => {
  e.preventDefault(); // href is a placeholder now — this button only toggles the panel, each row has its own real login link
  tokenPanel.classList.toggle("open");
});

// Two ways a Kite login can land back here:
//  (a) Redirect URL = /api/token/callback — the server already exchanged the
//      token and bounced to /?token=ok|error&account=NAME.
//  (b) Redirect URL = the dashboard root (http://localhost:4790/) — the URL
//      arrives with request_token in it and nothing has been exchanged yet, so
//      it's done here (this page is already logged in, so the /api routes are
//      reachable). `account` comes from the login link's redirect_params;
//      without it (an old bookmark) the token is treated as the global account's.
async function handleTokenRedirectParams() {
  const params = new URLSearchParams(location.search);

  if (params.has("request_token")) {
    const rt      = params.get("request_token");
    const account = params.get("account") || "global";
    history.replaceState({}, "", location.pathname);   // never leave the one-time token in the address bar
    try {
      const res = await fetch(
        account === "global" ? "/api/token/exchange" : "/api/toolbox/dualhedge/users/token",
        {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(account === "global" ? { input: rt } : { name: account, requestToken: rt }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "exchange failed");
      appendLog({ type: "SYS", text: `[token] ${account === "global" ? "global account" : account} access token captured and updated — restart engines to pick it up` });
    } catch (err) {
      appendLog({ type: "ERROR", text: `[token] ${account === "global" ? "global account" : account} auto-capture failed: ${err.message} — paste the redirect URL into that account's row instead` });
    }
    refreshTokenStatus();
    return;
  }

  if (!params.has("token")) return;
  const who = params.get("account") && params.get("account") !== "global" ? `${params.get("account")} ` : "";
  if (params.get("token") === "ok") {
    appendLog({ type: "SYS", text: `[token] ${who}access token captured and updated automatically — restart engines to pick it up` });
  } else {
    appendLog({ type: "ERROR", text: `[token] ${who}auto-capture failed: ${params.get("msg") || "Unknown error"}` });
  }
  history.replaceState({}, "", location.pathname);
  refreshTokenStatus();
}

// ── log stream ───────────────────────────────────────────────────────────
const MAX_LOG_LINES = 400;

function ts() {
  return new Date().toLocaleTimeString("en-IN", { hour12: false });
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Structured segments instead of one padded string — each field is its own
// non-breaking span, so the row wraps (if it must, on a narrow phone)
// between fields rather than splitting a number in half. Fixes the
// "+1300" landing on its own line that padStart+pre-wrap used to produce.
function logRowHtml(segments) {
  return segments.map(([cls, text]) => `<span class="${cls}">${escHtml(text)}</span>`).join("");
}

// Short fixed-width category label shown at the start of every log line —
// lets the eye scan the left edge of the panel and tell TICK/ENTRY/EXIT/
// SYS/ERROR apart without reading the row, since several types otherwise
// share the same pos/neg green-or-red coloring.
const CAT_LABEL = {
  TICK: "tick", ENTRY: "entry", EXIT: "exit", MODE: "mode",
  SHUTDOWN: "eod", SYS: "sys", ERROR: "err",
};

function appendLog({ type, cssClass, text, instant, segments }) {
  const line = document.createElement("div");
  line.className = `log-line ${type.toLowerCase()} ${cssClass || ""}`.trim();
  if (instant) line.style.animation = "none", line.style.opacity = "1";
  const catLabel = CAT_LABEL[type] || type.toLowerCase();
  const catHtml = `<span class="lf-cat lf-cat-${type.toLowerCase()}">${catLabel}</span>`;
  if (segments) line.innerHTML = catHtml + logRowHtml(segments);
  else line.innerHTML = catHtml + `<span class="lf-text">${escHtml(text)}</span>`;
  logStream.appendChild(line);
  while (logStream.childElementCount > MAX_LOG_LINES) logStream.removeChild(logStream.firstChild);
  if (autoscrollToggle.checked) logStream.scrollTop = logStream.scrollHeight;
}

// ── websocket relay ──────────────────────────────────────────────────────
let socket = null;

function setConnStatus(state) {
  connStatus.classList.remove("live", "down");
  if (state === "live") {
    connStatus.classList.add("live");
    connStatus.querySelector(".conn-label").textContent = "Live";
  } else if (state === "down") {
    connStatus.classList.add("down");
    connStatus.querySelector(".conn-label").textContent = "Disconnected";
  } else {
    connStatus.querySelector(".conn-label").textContent = "Connecting";
  }
}

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${proto}//${location.host}/ws`);

  socket.addEventListener("open", () => setConnStatus("live"));
  socket.addEventListener("close", () => { setConnStatus("down"); setTimeout(connect, 3000); });
  socket.addEventListener("error", () => socket.close());

  socket.addEventListener("message", ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleEvent(msg);
  });
}

let replayRemaining = 0;

function handleEvent(msg) {
  if (msg.type === "HELLO") {
    replayRemaining = msg.replaying || 0;
    return;
  }
  const isReplay = replayRemaining > 0;
  if (isReplay) replayRemaining--;

  const time = ts();

  if (msg.type === "TICK") {
    // DYNAMIC_MID_COLOR (and any future strategy that sets `color`) tags
    // its own TICK payload with a position-DIRECTION color (green=LONG,
    // red=SHORT, white=flat) rather than the default profit-direction
    // marker every other strategy gets. Reuses the existing up/down/flat
    // marker classes (already green/red/white) rather than adding new
    // CSS — just a different circle glyph so it doesn't read as a
    // profit/loss arrow when it isn't one.
    const hasDirectionColor = typeof msg.color === "string";
    const marker = hasDirectionColor
      ? "●"
      : (msg.position ? (msg.uPnl > 0 ? "▲" : msg.uPnl < 0 ? "▼" : "●") : "●");
    const markerCls = hasDirectionColor
      ? (msg.color === "green" ? "up" : msg.color === "red" ? "down" : "flat")
      : (marker === "▲" ? "up" : marker === "▼" ? "down" : "flat");
    const cardsForEngine = instruments.filter(i => i.underlying === msg.engine);
    cardsForEngine.forEach(i => {
      const el = document.getElementById(cardId(i));
      if (!el) return;
      el.querySelector('[data-role="price"]').textContent = Number(msg.price).toFixed(2);
      const mEl = el.querySelector('[data-role="marker"]');
      mEl.textContent = marker;
      mEl.className = `state-marker ${markerCls}`;
    });
    updateCardPnl(msg.engine, msg.uPnl, msg.session);
    updateHedgePairLeg(msg.engine, msg.uPnl, msg.session);
    updateDualHedgeLeg(msg.engine, msg.uPnl, msg.session);
    sessionPnlByUnderlying.set(msg.engine, msg.session);
    updateTotalPnl();

    const pnlCls = hasDirectionColor
      ? (msg.color === "green" ? "pos" : msg.color === "red" ? "neg" : "flat")
      : (msg.position ? cls(msg.uPnl) : "flat");
    appendLog({
      type: "TICK",
      cssClass: pnlCls,
      instant: isReplay,
      segments: [
        ["lf-engine", msg.engine],
        ["lf-time", time],
        [`lf-marker lf-marker-${markerCls}`, marker],
        ["lf-price", Number(msg.price).toFixed(2)],
        ["lf-num", fmtSigned(msg.uPnl)],
        ["lf-num lf-num-session", fmtSigned(msg.session)],
      ],
    });
    return;
  }

  if (msg.type === "ENTRY") {
    if (!isReplay) flashCards(msg.engine, 1);
    updateHedgePairLeg(msg.engine, undefined, undefined);
    updateDualHedgeLeg(msg.engine, undefined, undefined);
    // msg.arrow (▲/▼) is currently only sent by DYNAMIC_MID_COLOR — every
    // other strategy's ENTRY payload has no `arrow` field, so this is a
    // no-op for them (undefined -> empty prefix, unchanged tag).
    appendLog({
      type: "ENTRY",
      instant: isReplay,
      segments: [
        ["lf-engine", msg.engine],
        ["lf-time", time],
        ["lf-tag", `${msg.arrow ? msg.arrow + " " : ""}${msg.side} ENTRY`],
        ["lf-price", `@ ${Number(msg.price).toFixed(2)}`],
        ["lf-meta", `Tr:${msg.trail != null ? Number(msg.trail).toFixed(2) : "-"}`],
      ],
    });
    return;
  }

  if (msg.type === "EXIT") {
    if (!isReplay) flashCards(msg.engine, msg.pnl >= 0 ? 1 : -1);
    updateHedgePairLeg(msg.engine, 0, msg.session);
    updateDualHedgeLeg(msg.engine, 0, msg.session);
    sessionPnlByUnderlying.set(msg.engine, msg.session);
    updateTotalPnl();
    appendLog({
      type: "EXIT",
      cssClass: cls(msg.pnl),
      instant: isReplay,
      segments: [
        ["lf-engine", msg.engine],
        ["lf-time", time],
        ["lf-tag", `${msg.side} ${msg.action}`],
        ["lf-price", `@ ${Number(msg.price).toFixed(2)}`],
        ["lf-meta", msg.reason],
        ["lf-num", `pnl:${fmtSigned(msg.pnl)}`],
        ["lf-num", `sess:${fmtSigned(msg.session)}`],
      ],
    });
    return;
  }

  if (msg.type === "MODE") {
    appendLog({
      type: "MODE",
      instant: isReplay,
      segments: [
        ["lf-engine", msg.engine],
        ["lf-time", time],
        ["lf-tag", msg.label],
        ["lf-meta", msg.detail],
      ],
    });
    return;
  }

  if (msg.type === "SHUTDOWN") {
    // EOD session end — separate from the EXIT event a closed position
    // already produced (positions.js emits that one). This just marks the
    // instrument offline immediately instead of waiting for the next PM2
    // status poll (up to 30s), and logs a clear session-summary line.
    if (!isReplay) {
      instruments
        .filter(i => i.underlying === msg.engine)
        .forEach(i => {
          const el = document.getElementById(cardId(i));
          if (!el) return;
          const statusEl = el.querySelector('[data-role="status"]');
          if (statusEl) { statusEl.textContent = "Offline"; statusEl.className = "status-pill offline"; }
        });
    }
    appendLog({
      type: "SHUTDOWN",
      cssClass: cls(msg.pnl),
      instant: isReplay,
      segments: [
        ["lf-engine", msg.engine],
        ["lf-time", time],
        ["lf-tag", "EOD SHUTDOWN"],
        ["lf-meta", msg.positionLeftOpen ? "position left open — check manually" : `${msg.trades} trades  ${msg.winRate}% win`],
        ["lf-num", `pnl:${fmtSigned(msg.pnl)}`],
      ],
    });
    return;
  }
}

// ── freeform dashboard layout (drag + resize any panel) ─────────────────
// Off by default (the plain CSS grid auto-flow keeps working exactly as
// before) — toggled on via the "layout" button in the tabbar. Positions/
// sizes are per-browser (localStorage), not synced anywhere — this is a
// personal arrangement preference, same scope as e.g. autoscrollToggle.
// Once turned on for the first time, freeform stays on for that browser
// (a saved layout existing IS the signal — see reapplySavedLayoutIfAny()
// below) even across reloads; "reset" clears it back to the plain grid.
const LAYOUT_STORAGE_KEY = "talgox_dashboard_layout_v1";
let layoutEditMode = false;
let layoutZTop = 10;

function loadSavedLayout() {
  try { return JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) || "{}"); }
  catch { return {}; }
}
function saveLayout(layout) {
  try { localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout)); }
  catch { /* storage full/unavailable (e.g. private browsing) — layout just won't persist across reloads, still works this session */ }
}
function dashboardPanels() {
  return Array.from(dashboardView.querySelectorAll(":scope > .panel"));
}

// Freezes each currently-visible panel's rendered position/size (from
// normal grid flow, or from a PREVIOUS freeform session) into absolute
// px — but only for panels that don't already have a saved entry, so
// turning freeform on doesn't jump anything, and a panel that only just
// became visible (hedgePairsPanel/dualHedgePanel toggle display:none -> ""
// once real deployments exist) still gets a sane starting spot instead of
// overlapping everything else at 0,0.
function freezeCurrentPositions(saved) {
  const containerRect = dashboardView.getBoundingClientRect();
  dashboardPanels().forEach(panel => {
    if (panel.style.display === "none" || saved[panel.id]) return;
    const r = panel.getBoundingClientRect();
    saved[panel.id] = {
      left: Math.round(r.left - containerRect.left + dashboardView.scrollLeft),
      top: Math.round(r.top - containerRect.top + dashboardView.scrollTop),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  });
  return saved;
}

function applyLayout(layout) {
  let maxBottom = 0;
  dashboardPanels().forEach(panel => {
    const pos = layout[panel.id];
    if (!pos) return;
    panel.style.left = pos.left + "px";
    panel.style.top = pos.top + "px";
    panel.style.width = pos.width + "px";
    panel.style.height = pos.height + "px";
    if (panel.style.display !== "none") maxBottom = Math.max(maxBottom, pos.top + pos.height);
  });
  dashboardView.style.minHeight = (maxBottom + 40) + "px";
}

function ensureResizeHandle(panel) {
  if (panel.querySelector(":scope > .panel-resize-handle")) return;
  const handle = document.createElement("div");
  handle.className = "panel-resize-handle";
  panel.appendChild(handle);
}

function wirePanelDragAndResize(panel) {
  if (panel.dataset.layoutWired) return;
  panel.dataset.layoutWired = "1";
  ensureResizeHandle(panel);
  const head = panel.querySelector(":scope > .panel-head");
  const resizeHandle = panel.querySelector(":scope > .panel-resize-handle");

  function persist() {
    const layout = loadSavedLayout();
    layout[panel.id] = { left: panel.offsetLeft, top: panel.offsetTop, width: panel.offsetWidth, height: panel.offsetHeight };
    saveLayout(layout);
    applyLayout(layout); // recompute container min-height against the new bounds
  }

  head?.addEventListener("pointerdown", e => {
    if (!layoutEditMode) return;
    if (e.target.closest("button, input, label")) return; // don't hijack the refresh/autoscroll controls living in the same head
    e.preventDefault();
    panel.style.zIndex = String(++layoutZTop);
    const startX = e.clientX, startY = e.clientY;
    const startLeft = panel.offsetLeft, startTop = panel.offsetTop;
    head.setPointerCapture(e.pointerId);
    function onMove(ev) {
      panel.style.left = Math.max(0, startLeft + (ev.clientX - startX)) + "px";
      panel.style.top  = Math.max(0, startTop  + (ev.clientY - startY)) + "px";
    }
    function onUp() {
      head.removeEventListener("pointermove", onMove);
      persist();
    }
    head.addEventListener("pointermove", onMove);
    head.addEventListener("pointerup", onUp, { once: true });
  });

  resizeHandle.addEventListener("pointerdown", e => {
    if (!layoutEditMode) return;
    e.preventDefault();
    e.stopPropagation(); // don't also trigger the drag handler above
    panel.style.zIndex = String(++layoutZTop);
    const startX = e.clientX, startY = e.clientY;
    const startWidth = panel.offsetWidth, startHeight = panel.offsetHeight;
    resizeHandle.setPointerCapture(e.pointerId);
    function onMove(ev) {
      panel.style.width  = Math.max(240, startWidth  + (ev.clientX - startX)) + "px";
      panel.style.height = Math.max(140, startHeight + (ev.clientY - startY)) + "px";
    }
    function onUp() {
      resizeHandle.removeEventListener("pointermove", onMove);
      persist();
    }
    resizeHandle.addEventListener("pointermove", onMove);
    resizeHandle.addEventListener("pointerup", onUp, { once: true });
  });
}

function enterLayoutEditMode() {
  // Capture each panel's CURRENT position/size FIRST, while the container
  // is still the plain CSS grid (position:static) — freezeCurrentPositions()
  // reads getBoundingClientRect(), and that has to happen BEFORE
  // .layout-freeform is added, because that class is what switches panels
  // to position:absolute. Adding it first (the original bug) collapsed
  // every panel to the same top-left spot before we ever measured it, so
  // "current position" was already garbage — that's what caused the
  // jumbling on entering edit mode, and Live Log (last in the HTML, so it
  // paints over earlier siblings by default) visually swallowing
  // Instruments once both were stuck at that same wrong spot.
  const layout = freezeCurrentPositions(loadSavedLayout());
  layoutEditMode = true;
  dashboardView.classList.add("layout-freeform", "layout-edit-mode");
  layoutEditToggle.textContent = "\u2713 done";
  layoutResetBtn.style.display = "";
  saveLayout(layout);
  applyLayout(layout);
  dashboardPanels().forEach(wirePanelDragAndResize);
}
function exitLayoutEditMode() {
  layoutEditMode = false;
  dashboardView.classList.remove("layout-edit-mode");
  layoutEditToggle.textContent = "\u26f6 layout";
  // freeform positioning itself stays applied — that IS the point, the
  // custom arrangement should survive leaving edit mode. Only the drag/
  // resize AFFORDANCES (dashed outline, move cursor, resize handles) turn
  // off, via the layout-edit-mode class alone.
}
layoutEditToggle?.addEventListener("click", () => { layoutEditMode ? exitLayoutEditMode() : enterLayoutEditMode(); });
layoutResetBtn?.addEventListener("click", () => {
  try { localStorage.removeItem(LAYOUT_STORAGE_KEY); } catch { /* nothing to clear */ }
  dashboardView.classList.remove("layout-freeform", "layout-edit-mode");
  dashboardView.style.minHeight = "";
  dashboardPanels().forEach(panel => {
    panel.style.left = panel.style.top = panel.style.width = panel.style.height = panel.style.zIndex = "";
  });
  layoutEditMode = false;
  layoutEditToggle.textContent = "\u26f6 layout";
  layoutResetBtn.style.display = "none";
});

// Re-applies a PREVIOUSLY saved layout on boot, if this browser has one —
// covers a page reload while freeform was already on. A panel that toggles
// visible later (real hedge-pair/dual-hedge deployments showing up after
// boot) picks its own starting spot the next time edit mode is opened;
// until then it just renders wherever the plain grid flow would put it,
// since .layout-freeform positions ONLY the panels present in `saved`.
function reapplySavedLayoutIfAny() {
  const saved = loadSavedLayout();
  if (Object.keys(saved).length === 0) return;
  dashboardView.classList.add("layout-freeform");
  dashboardPanels().forEach(ensureResizeHandle);
  applyLayout(saved);
  layoutResetBtn.style.display = "";
}

// ── boot (behind the PIN lock) ──────────────────────────────────────────
let appStarted = false;
function startApp() {
  if (appStarted) return; // re-locking doesn't tear down the live WS/polling — just re-covers the UI
  appStarted = true;
  appendLog({ type: "SYS", text: `[dashboard] booting...` });
  loadInstruments();
  loadHedgePairs();
  loadDualHedges();
  connect();
  refreshTokenStatus();
  handleTokenRedirectParams();
  reapplySavedLayoutIfAny();
  setInterval(loadInstruments, 30000); // periodic resync in case PM2 state changed outside the dashboard
  setInterval(loadHedgePairs, 30000);
  setInterval(loadDualHedges, 30000);
}

function revealApp(instant) {
  if (instant) {
    lockScreen.style.display = "none";
    appRoot.classList.add("unlocked");
    startApp();
    resetIdleTimer();
    return;
  }
  playUnlockSequence();
}

function spawnParticles() {
  successParticles.innerHTML = "";
  const count = 14;
  for (let i = 0; i < count; i++) {
    const p = document.createElement("div");
    p.className = "particle";
    const angle = (Math.PI * 2 * i) / count + (Math.random() * 0.4 - 0.2);
    const dist = 34 + Math.random() * 30;
    const size = 4 + Math.random() * 5;
    const square = Math.random() > 0.5;
    p.style.setProperty("--tx", `${Math.cos(angle) * dist}px`);
    p.style.setProperty("--ty", `${Math.sin(angle) * dist}px`);
    p.style.setProperty("--psize", `${size}px`);
    p.style.setProperty("--pradius", square ? "2px" : "50%");
    p.style.setProperty("--pdelay", `${Math.random() * 80}ms`);
    successParticles.appendChild(p);
  }
}

function playUnlockSequence() {
  pinUnlocked = true;
  // 1. dots + keypad fade out together
  lockDots.classList.add("exit");
  lockKeypad.classList.add("exit");

  // 2. checkmark ring pops in, particles burst outward from it
  setTimeout(() => {
    lockSuccess.classList.add("show");
    spawnParticles();
  }, 180);

  // 3. hold on "access granted" briefly, then dismiss the whole lock screen
  setTimeout(() => {
    lockScreen.classList.add("unlocking");
  }, 900);

  // 4. fully hand off to the app once the dismiss animation finishes
  setTimeout(() => {
    lockScreen.style.display = "none";
    appRoot.classList.add("unlocked");
    startApp();
    resetIdleTimer();
  }, 900 + 520);
}

// ── PIN lock ─────────────────────────────────────────────────────────────
let pinLength = 4;
let pinBuffer = "";
let pinLocked = false;
let pinUnlocked = false;

function renderDots() {
  lockDots.innerHTML = "";
  for (let i = 0; i < pinLength; i++) {
    const dot = document.createElement("div");
    dot.className = "lock-dot" + (i < pinBuffer.length ? " filled" : "");
    lockDots.appendChild(dot);
  }
}

function showLockError(text, isLockout) {
  lockError.textContent = text;
  lockError.classList.add("show");
  if (!isLockout) setTimeout(() => lockError.classList.remove("show"), 2200);
}

function shakeAndClear() {
  lockDots.classList.add("shake");
  setTimeout(() => {
    lockDots.classList.remove("shake");
    pinBuffer = "";
    renderDots();
  }, 420);
}

function setLocked(ms) {
  pinLocked = true;
  lockKeypad.style.opacity = "0.4";
  lockKeypad.style.pointerEvents = "none";
  const until = Date.now() + ms;
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    if (remaining <= 0) {
      pinLocked = false;
      lockKeypad.style.opacity = "1";
      lockKeypad.style.pointerEvents = "auto";
      lockError.classList.remove("show");
      return;
    }
    showLockError(`too many attempts — wait ${remaining}s`, true);
    setTimeout(tick, 1000);
  };
  tick();
}

async function submitPin() {
  try {
    const res = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: pinBuffer }),
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      revealApp(false);
      return;
    }
    if (res.status === 429) {
      shakeAndClear();
      setLocked(data.lockedForMs || 30000);
      return;
    }
    shakeAndClear();
    showLockError(
      data.attemptsLeft != null ? `incorrect pin — ${data.attemptsLeft} attempt(s) left` : "incorrect pin"
    );
  } catch (err) {
    shakeAndClear();
    showLockError("verify failed — check connection");
  }
}

function pressKey(key) {
  if (pinLocked || pinUnlocked) return;
  if (key === "del") {
    pinBuffer = pinBuffer.slice(0, -1);
    renderDots();
    return;
  }
  if (pinBuffer.length >= pinLength) return;
  pinBuffer += key;
  renderDots();
  if (pinBuffer.length === pinLength) submitPin();
}

lockKeypad.addEventListener("click", e => {
  const btn = e.target.closest(".key[data-key]");
  if (btn) pressKey(btn.dataset.key);
});

document.addEventListener("keydown", e => {
  if (lockScreen.style.display === "none") return;
  if (/^[0-9]$/.test(e.key)) pressKey(e.key);
  else if (e.key === "Backspace") pressKey("del");
});

let authEnabledFlag = true;

// ── inactivity auto-lock ─────────────────────────────────────────────────
// Re-locks after 2 minutes of no interaction. This is a real re-lock, not
// cosmetic — /api/auth/lock invalidates the session server-side first, so
// the old session can't be used even if someone inspects the request. The
// background WS/polling started by startApp() is deliberately left running
// through a re-lock (like a phone screen locking — data keeps flowing
// underneath, only the display is covered) rather than torn down and
// reconnected, which would add a lot of complexity for a single-operator
// tool. Only active when a PIN is actually configured — no idle timer to
// speak of when auth is disabled.
const IDLE_LIMIT_MS = 2 * 60 * 1000;
let idleTimer = null;

function resetIdleTimer() {
  if (!authEnabledFlag) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(relock, IDLE_LIMIT_MS);
}

["mousemove", "keydown", "touchstart", "click", "scroll", "wheel"].forEach(evt => {
  document.addEventListener(evt, () => {
    if (appRoot.classList.contains("unlocked")) resetIdleTimer();
  }, { passive: true });
});

async function relock() {
  clearTimeout(idleTimer);
  try { await fetch("/api/auth/lock", { method: "POST" }); } catch { /* re-show the lock screen either way */ }

  appRoot.classList.remove("unlocked");
  lockScreen.style.display = "";
  lockScreen.classList.remove("unlocking");
  lockSuccess.classList.remove("show");
  lockDots.classList.remove("exit");
  lockKeypad.classList.remove("exit");
  lockKeypad.style.opacity = "1";
  lockKeypad.style.pointerEvents = "auto";
  lockSubtitle.textContent = "Session timed out — enter pin to continue";
  pinBuffer = "";
  pinUnlocked = false;
  renderDots();
}

async function initAuth() {
  try {
    const status = await (await fetch("/api/auth/status")).json();
    authEnabledFlag = status.enabled;
    if (!status.enabled) { revealApp(true); return; }
    if (status.authenticated) { revealApp(true); return; }

    pinLength = status.pinLength || 4;
    renderDots();
    if (status.locked) setLocked(status.lockedForMs || 30000);
  } catch {
    lockSubtitle.textContent = "Could not reach server — retrying...";
    setTimeout(initAuth, 3000);
  }
}

// ── toolbox tab ──────────────────────────────────────────────────────────
const tabDashboard = document.getElementById("tabDashboard");
const tabToolbox = document.getElementById("tabToolbox");
const tabRisk = document.getElementById("tabRisk");
const dashboardView = document.getElementById("dashboardView");
const toolboxView = document.getElementById("toolboxView");
const riskView = document.getElementById("riskView");
const tbBoot = document.getElementById("tbBoot");
const tbBanner = document.getElementById("tbBanner");
const tbChecklist = document.getElementById("tbChecklist");
const toolboxList = document.getElementById("toolboxList");
const toolboxRefreshBtn = document.getElementById("toolboxRefreshBtn");
const riskList = document.getElementById("riskList");
const riskRefreshBtn = document.getElementById("riskRefreshBtn");
const tbSelectAll = document.getElementById("tbSelectAll");
const tbStart = document.getElementById("tbStart");
const tbStop = document.getElementById("tbStop");
const tbRestart = document.getElementById("tbRestart");
const tbMode = document.getElementById("tbMode");
const tbDelete = document.getElementById("tbDelete");
const tbLogsModal = document.getElementById("tbLogsModal");
const tbLogsTitle = document.getElementById("tbLogsTitle");
const tbLogsBody = document.getElementById("tbLogsBody");
const tbLogsClose = document.getElementById("tbLogsClose");
const tbModeModal = document.getElementById("tbModeModal");
const tbModeBody = document.getElementById("tbModeBody");
const tbModeClose = document.getElementById("tbModeClose");

// Rendered as real bold text rather than the CLI's block-character ANSI
// Shadow art — block-drawing glyphs (█ ╚ ╝ etc.) don't have consistent
// coverage across mobile browser fonts and came out jagged/uneven with the
// glow applied. Same "TALGO-X" reveal moment, same wordmark styling used
// everywhere else in this dashboard, just without depending on a font's
// Unicode box-drawing support to look clean.
const TB_BANNER_TEXT = "TALGO-X";

let toolboxBootPlayed = false;
let toolboxInstruments = [];
let riskInstruments = [];

function switchTab(tab) {
  if (tab === "dashboard") {
    tabDashboard.classList.add("active");
    tabToolbox.classList.remove("active");
    tabRisk.classList.remove("active");
    dashboardView.style.display = "";
    toolboxView.style.display = "none";
    riskView.style.display = "none";
    return;
  }
  if (tab === "risk") {
    tabRisk.classList.add("active");
    tabDashboard.classList.remove("active");
    tabToolbox.classList.remove("active");
    dashboardView.style.display = "none";
    toolboxView.style.display = "none";
    riskView.style.display = "";
    loadRiskList();
    return;
  }
  tabToolbox.classList.add("active");
  tabDashboard.classList.remove("active");
  tabRisk.classList.remove("active");
  dashboardView.style.display = "none";
  riskView.style.display = "none";

  if (toolboxBootPlayed) {
    toolboxView.style.display = "";
    loadToolboxList();
  } else {
    playToolboxBoot();
  }
}

tabDashboard.addEventListener("click", () => switchTab("dashboard"));
tabToolbox.addEventListener("click", () => switchTab("toolbox"));
tabRisk.addEventListener("click", () => switchTab("risk"));

async function loadRiskList() {
  try {
    riskInstruments = await (await fetch("/api/instruments")).json();
    renderRiskList();
  } catch (err) {
    riskList.innerHTML = `<div class="empty-state">failed to load: ${err.message}</div>`;
  }
}

function renderRiskList() {
  if (riskInstruments.length === 0) {
    riskList.innerHTML = `<div class="empty-state">No engines detected</div>`;
    return;
  }
  riskList.innerHTML = "";
  riskInstruments.forEach(inst => {
    const row = document.createElement("div");
    row.className = "tb-row";
    const chopOn = (inst.strategy === "ALMA_PRO_FAST" || inst.strategy === "ALMA_PRO_SLOW") ? inst.almaChopFilterEnabled !== false : inst.chopFilterEnabled !== false;
    const badges = [
      `<span class="mode-pill ${chopOn ? "live" : ""}">chop ${chopOn ? "on" : "off"}</span>`,
      `<span class="mode-pill ${inst.disableDoubleOrders ? "" : "live"}">double ${inst.disableDoubleOrders ? "off" : "on"}</span>`,
      `<span class="mode-pill ${inst.volumeFilterEnabled ? "live" : ""}">vol ${inst.volumeFilterEnabled ? `sma${inst.volumeSmaPeriod ?? 20}` : "off"}</span>`,
      `<span class="mode-pill ${inst.longCandleFilterEnabled !== false ? "live" : ""}">long-candle ${inst.longCandleFilterEnabled !== false ? "on" : "off"}</span>`,
      `<span class="mode-pill ${inst.htfGateEnabled !== false ? "live" : ""}">htf ${inst.htfGateEnabled !== false ? (inst.htfTimeframe || "1h") : "off"}</span>`,
      `<span class="mode-pill ${inst.dailyHaGateEnabled !== false ? "live" : ""}">dailyha ${inst.dailyHaGateEnabled !== false ? "on" : "off"}</span>`,
    ];
    if (inst.strategy === "PURE_HA") badges.push(`<span class="mode-pill">flip ${inst.flipConfirmCandles ?? 1}</span>`);
    if (inst.strategy === "DAILY_HA_BIAS") badges.push(`<span class="mode-pill">entry ${inst.dailyBiasEntryTime || "10:00"} \u00b7 ${inst.dailyBiasCandle === "CURRENT" ? "today's candle" : "prev candle"}</span>`);
    if (inst.atrSlMult) badges.push(`<span class="mode-pill">atr ${inst.atrSlMult}x</span>`);
    if (inst.maxDailyLoss) badges.push(`<span class="mode-pill">maxloss -₹${inst.maxDailyLoss}</span>`);
    row.innerHTML = `
      <div class="tb-row-id">
        <span class="tb-underlying">${inst.underlying}</span>
        <span class="tb-strategy">${inst.strategy}</span>
      </div>
      <div class="tb-row-pills" style="flex-wrap:wrap">${badges.join("")}</div>
      <button class="tb-row-edit" data-name="${inst.name}">Manage risk</button>
    `;
    riskList.appendChild(row);
  });
}

riskList.addEventListener("click", e => {
  const btn = e.target.closest(".tb-row-edit");
  if (!btn) return;
  const inst = riskInstruments.find(i => i.name === btn.dataset.name);
  if (inst) openEditModal(inst);
});

riskRefreshBtn.addEventListener("click", loadRiskList);


function addCheckLine(text, state) {
  const line = document.createElement("div");
  line.className = `tb-check-line ${state || ""}`.trim();
  line.textContent = text;
  tbChecklist.appendChild(line);
  return line;
}

async function playToolboxBoot() {
  toolboxBootPlayed = true;
  tbBanner.textContent = TB_BANNER_TEXT;
  tbChecklist.innerHTML = "";
  tbBoot.classList.add("playing");

  // re-trigger the clip-path reveal animation each time it's played
  tbBanner.style.animation = "none";
  void tbBanner.offsetWidth;
  tbBanner.style.animation = "";

  await new Promise(r => setTimeout(r, 950));

  addCheckLine("✓ Loading Toolbox");
  await new Promise(r => setTimeout(r, 150));

  const pendingLine = addCheckLine("⏳ Connecting to PM2...", "pending");
  let ok = true;
  try {
    const res = await fetch("/api/instruments");
    if (!res.ok) throw new Error("bad response");
    toolboxInstruments = await res.json();
  } catch {
    ok = false;
  }
  pendingLine.textContent = ok ? "✓ Connecting to PM2" : "✗ Connecting to PM2 — failed";
  pendingLine.className = `tb-check-line ${ok ? "" : "failed"}`;
  await new Promise(r => setTimeout(r, 150));

  addCheckLine(`✓ Checking Running Processes (${toolboxInstruments.length} found)`);
  await new Promise(r => setTimeout(r, 150));
  addCheckLine("✓ Toolbox Ready");
  await new Promise(r => setTimeout(r, 400));

  tbBoot.classList.remove("playing");
  toolboxView.style.display = "";
  renderToolboxList();
}

async function loadToolboxList() {
  try {
    toolboxInstruments = await (await fetch("/api/instruments")).json();
    renderToolboxList();
  } catch (err) {
    toolboxList.innerHTML = `<div class="empty-state">failed to load: ${err.message}</div>`;
  }
}

function renderToolboxList() {
  if (toolboxInstruments.length === 0) {
    toolboxList.innerHTML = `<div class="empty-state">No engines detected</div>`;
    return;
  }
  toolboxList.innerHTML = "";
  toolboxInstruments.forEach(inst => {
    const row = document.createElement("div");
    row.className = "tb-row";
    row.innerHTML = `
      <input type="checkbox" class="tb-check" data-name="${inst.name}">
      <div class="tb-row-id">
        <span class="tb-underlying">${inst.underlying}</span>
        <span class="tb-strategy">${inst.strategy}</span>
      </div>
      <div class="tb-row-pills">
        <span class="status-pill ${inst.status === "online" ? "online" : "offline"}">${inst.status}</span>
        <span class="mode-pill ${inst.live ? "live" : ""}">${inst.live ? "live" : "paper"}</span>
      </div>
      <button class="tb-row-edit" data-name="${inst.name}">Edit</button>
      <button class="tb-row-logs" data-name="${inst.name}">Logs</button>
    `;
    toolboxList.appendChild(row);
  });
}

toolboxRefreshBtn.addEventListener("click", loadToolboxList);

tbSelectAll.addEventListener("change", () => {
  toolboxList.querySelectorAll(".tb-check").forEach(cb => { cb.checked = tbSelectAll.checked; });
});

function getSelectedNames() {
  return Array.from(toolboxList.querySelectorAll(".tb-check:checked")).map(cb => cb.dataset.name);
}

async function bulkControl(action) {
  const names = getSelectedNames();
  if (names.length === 0) return;
  for (const name of names) {
    try {
      await fetch("/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, action }),
      });
    } catch { /* best-effort, report via list refresh */ }
  }
  setTimeout(loadToolboxList, 1200);
}

tbStart.addEventListener("click", () => bulkControl("start"));
tbStop.addEventListener("click", () => bulkControl("stop"));
tbRestart.addEventListener("click", () => bulkControl("restart"));

tbDelete.addEventListener("click", async () => {
  const names = getSelectedNames();
  if (names.length === 0) return;
  if (!confirm(`Remove ${names.length} process(es) from PM2? This stops and deletes them — same as toolbox.js's "D" option.`)) return;
  try {
    await fetch("/api/toolbox/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names }),
    });
  } catch { /* fall through to refresh either way */ }
  loadToolboxList();
});

// ── logs modal ───────────────────────────────────────────────────────────
toolboxList.addEventListener("click", e => {
  const btn = e.target.closest(".tb-row-logs");
  if (!btn) return;
  openLogsModal(btn.dataset.name);
});

// ── edit params modal ──────────────────────────────────────────────────
toolboxList.addEventListener("click", e => {
  const btn = e.target.closest(".tb-row-edit");
  if (!btn) return;
  const inst = toolboxInstruments.find(i => i.name === btn.dataset.name);
  if (inst) openEditModal(inst);
});

const tbEditModal = document.getElementById("tbEditModal");
const tbEditTitle = document.getElementById("tbEditTitle");
const tbEditBody = document.getElementById("tbEditBody");
const tbEditClose = document.getElementById("tbEditClose");

// openEditModal(inst) — web equivalent of toolbox.js's editInstrument().
// Same field set, same strategy-gating, same "blank = keep, 0/clear =
// reset to default" convention for the numeric fields. inst comes straight
// from toolboxInstruments (== getEngineProcesses() output via /api/instruments),
// so every field this needs (lots, targetPoints, targetMode, bandStep,
// greyExitEnabled, almaBandEnabled, almaFastLen, almaBandLen,
// almaChopFilterEnabled, strategy) is already there — no extra fetch.
function openEditModal(inst) {
  tbEditTitle.textContent = `${inst.underlying} — ${inst.strategy}`;

  const isAlmaProFast = inst.strategy === "ALMA_PRO_FAST";
  const isAlmaProSlow = inst.strategy === "ALMA_PRO_SLOW";
  const isDynamicBand = inst.strategy === "DYNAMIC_BAND" || inst.strategy === "DYNAMIC_MID_COLOR" || inst.strategy === "DYNAMIC_MID_COLOR_HL";
  const isAlmaTriBand = inst.strategy === "ALMA_TRI_BAND";

  tbEditBody.innerHTML = `
    <div class="tb-form-row">
      <div class="tb-form-label">Lots</div>
      <input type="number" id="editLots" value="${inst.lots === "default" ? 1 : inst.lots}" min="1" step="1">
    </div>
    <div class="tb-form-row">
      <div class="tb-form-label">Profit target in points (blank = none, "0"/"clear" to remove)</div>
      <input type="number" id="editTarget" min="0" step="any" value="${inst.targetPoints !== null && inst.targetPoints !== undefined ? inst.targetPoints : ""}">
    </div>
    <div class="tb-form-row">
      <label class="tb-form-row-inline"><input type="checkbox" id="editAdaptive" ${inst.targetMode === "adaptive" ? "checked" : ""}><span>Use adaptive target sizing instead (CHOP + DPI efficiency) — only applies while the fixed target above is blank</span></label>
    </div>
    <div class="tb-form-row" style="${isAlmaProFast ? "" : "display:none"}">
      <label class="tb-form-row-inline"><input type="checkbox" id="editAlmaBand" ${inst.almaBandEnabled !== false ? "checked" : ""}><span>Use ALMA band gate</span></label>
    </div>
    <div class="tb-form-row" style="${isAlmaProFast ? "" : "display:none"}">
      <div class="tb-form-label">Fast ALMA length (blank = keep, "0"/"clear" = reset to default)</div>
      <input type="number" id="editAlmaFastLen" min="1" step="1" value="${inst.almaFastLen ?? ""}">
    </div>
    <div class="tb-form-row" id="editAlmaBandLenRow" style="${isAlmaProFast && inst.almaBandEnabled !== false ? "" : "display:none"}">
      <div class="tb-form-label">Band ALMA length (blank = keep, "0"/"clear" = reset to default)</div>
      <input type="number" id="editAlmaBandLen" min="1" step="1" value="${inst.almaBandLen ?? ""}">
    </div>
    <div class="tb-form-row" style="${(isAlmaProFast || isAlmaProSlow) ? "" : "display:none"}">
      <label class="tb-form-row-inline"><input type="checkbox" id="editAlmaChop" ${inst.almaChopFilterEnabled !== false ? "checked" : ""}><span>Use Choppiness Index entry filter</span></label>
    </div>
    <div class="tb-form-row" style="${isDynamicBand ? "" : "display:none"}">
      <div class="tb-form-label">Band step in price points (blank = keep, "0"/"clear" = reset to default)</div>
      <input type="number" id="editBandStep" min="0" step="any" value="${inst.bandStep ?? ""}">
    </div>
    <div class="tb-form-row" style="${isAlmaTriBand ? "" : "display:none"}">
      <label class="tb-form-row-inline"><input type="checkbox" id="editGreyExit" ${inst.greyExitEnabled ? "checked" : ""}><span>Exit on grey state instead of holding through it</span></label>
    </div>
    <div class="tb-form-row">
      <label class="tb-form-row-inline"><input type="checkbox" id="editDisableDouble" ${inst.disableDoubleOrders ? "checked" : ""}><span>Disable double orders (blocks reversal re-entries only)</span></label>
      <div class="tb-form-hint">Reversal re-entries stay gated only by the Choppiness Index check every entry already gets, whether checked or not</div>
    </div>
    <div class="tb-form-row">
      <div class="tb-form-label">ATR stop-loss multiplier (blank = default)</div>
      <input type="number" id="editAtrSlMult" min="0" step="any" value="${inst.atrSlMult ?? ""}">
    </div>
    ${inst.strategy === "PURE_HA" ? `
    <div class="tb-form-row">
      <div class="tb-form-label">reversal candles required to flip, anti-whipsaw (blank = 1, immediate)</div>
      <input type="number" id="editFlipConfirm" min="1" step="1" value="${inst.flipConfirmCandles ?? ""}">
    </div>` : ""}
    ${inst.strategy === "DAILY_HA_BIAS" ? `
    <div class="tb-form-row">
      <div class="tb-form-label">trade entry time IST \u2014 the first ${inst.timeframe || "15m"} candle at/after it takes the previous daily HA candle's side (blank = 10:00)</div>
      <input type="time" id="editDhabEntry" value="${inst.dailyBiasEntryTime ?? ""}">
      <div class="tb-form-label" style="margin-top:8px">Daily candle used \u2014 previous = yesterday's completed daily HA candle; present = today's forming daily HA candle at entry time</div>
      <select id="editDhabCandle">
        <option value="">Previous day (default)</option>
        <option value="PREVIOUS" ${inst.dailyBiasCandle === "PREVIOUS" ? "selected" : ""}>Previous day (explicit)</option>
        <option value="CURRENT" ${inst.dailyBiasCandle === "CURRENT" ? "selected" : ""}>Present day (forming)</option>
      </select>
    </div>` : ""}
    <div class="tb-form-row">
      <label class="tb-form-row-inline"><input type="checkbox" id="editVolumeFilter" ${inst.volumeFilterEnabled ? "checked" : ""}><span>Only enter when volume is above its SMA</span></label>
      <div class="tb-form-hint">Period below only applies while this is checked</div>
      <input type="number" id="editVolumeSmaPeriod" min="1" step="1" value="${inst.volumeSmaPeriod ?? ""}" placeholder="SMA period, blank = default">
    </div>
    <div class="tb-form-row">
      <label class="tb-form-row-inline"><input type="checkbox" id="editLongCandleFilter" ${inst.longCandleFilterEnabled !== false ? "checked" : ""}><span>Block new entries after an abnormally large candle</span></label>
      <div class="tb-form-hint">On by default — Sep 2 NATGASMINI/DYNAMIC_BAND fix. Range >= ATR x multiplier blocks new entries/reversals for a cooldown; existing SL/target/exit are never affected.</div>
      <input type="number" id="editLongCandleAtrPeriod" min="1" step="1" value="${inst.longCandleAtrPeriod ?? ""}" placeholder="ATR period, blank = default (14)">
      <input type="number" id="editLongCandleAtrMult" min="0" step="any" value="${inst.longCandleAtrMult ?? ""}" placeholder="ATR multiplier, blank = default (1.5)">
      <input type="number" id="editLongCandleCooldown" min="0" step="1" value="${inst.longCandleCooldownCandles ?? ""}" placeholder="cooldown candles, blank = default (2)">
    </div>
    <div class="tb-form-row">
      <div class="tb-form-label">Max daily loss in rupees (blank = no floor)</div>
      <input type="number" id="editMaxDailyLoss" min="0" step="any" value="${inst.maxDailyLoss ?? ""}">
    </div>
    <div class="tb-form-row">
      <label class="tb-form-row-inline"><input type="checkbox" id="editHtfGate" ${inst.htfGateEnabled !== false ? "checked" : ""}><span>Block entries when a higher timeframe is trending but price hasn't broken its band yet</span></label>
      <div class="tb-form-hint">On by default. Checks the 1h timeframe; period/max tune its Choppiness Index reading.</div>
      <input type="number" id="editHtfChopPeriod" min="1" step="1" value="${inst.htfChopPeriod ?? ""}" placeholder="chop period, blank = default (9)">
      <input type="number" id="editHtfChopMax" min="0" step="any" value="${inst.htfChopMax ?? ""}" placeholder="chop max, blank = default (58)">
      <label class="tb-form-row-inline"><input type="checkbox" id="editHtfBandBlock" ${inst.htfBandBlockEnabled !== false ? "checked" : ""}><span>Also require price still inside its own ALMA band (uncheck = block on low chop alone)</span></label>
    </div>
    <div class="tb-form-row">
      <label class="tb-form-row-inline"><input type="checkbox" id="editDailyHaGate" ${inst.dailyHaGateEnabled !== false ? "checked" : ""}><span>Only allow entries matching the previous daily HA candle's color (green=long only, red=short only)</span></label>
      <div class="tb-form-hint">On by default, applies universally regardless of strategy.</div>
    </div>
    <div id="editErrBox"></div>
    <button class="tb-submit-btn" id="editSubmit">Save changes (restarts the process)</button>
  `;
  tbEditModal.classList.add("open");

  if (isAlmaProFast) {
    const bandCheck = tbEditBody.querySelector("#editAlmaBand");
    const bandLenRow = tbEditBody.querySelector("#editAlmaBandLenRow");
    bandCheck.addEventListener("change", e => {
      bandLenRow.style.display = e.target.checked ? "" : "none";
    });
  }

  const submitBtn = tbEditBody.querySelector("#editSubmit");
  const errBox = tbEditBody.querySelector("#editErrBox");
  submitBtn.addEventListener("click", async () => {
    submitBtn.disabled = true;
    submitBtn.textContent = "...";
    errBox.textContent = "";

    const body = {
      name: inst.name,
      lots: tbEditBody.querySelector("#editLots").value,
      targetPoints: tbEditBody.querySelector("#editTarget").value || null,
      targetMode: tbEditBody.querySelector("#editAdaptive").checked ? "adaptive" : "fixed",
    };
    if (isAlmaProFast) {
      body.almaBandEnabled = tbEditBody.querySelector("#editAlmaBand").checked;
      body.almaFastLen = tbEditBody.querySelector("#editAlmaFastLen").value || undefined;
      body.almaBandLen = tbEditBody.querySelector("#editAlmaBandLen").value || undefined;
    }
    if (isAlmaProFast || isAlmaProSlow) {
      body.almaChopFilterEnabled = tbEditBody.querySelector("#editAlmaChop").checked;
    }
    if (isDynamicBand) {
      body.bandStep = tbEditBody.querySelector("#editBandStep").value || null;
    }
    if (isAlmaTriBand) {
      body.greyExitEnabled = tbEditBody.querySelector("#editGreyExit").checked;
    }
    body.maxDailyLoss = tbEditBody.querySelector("#editMaxDailyLoss").value || null;
    body.disableDoubleOrders = tbEditBody.querySelector("#editDisableDouble").checked;
    body.atrSlMult = tbEditBody.querySelector("#editAtrSlMult").value || null;
    const editFlipConfirmEl = tbEditBody.querySelector("#editFlipConfirm");
    if (editFlipConfirmEl) body.flipConfirmCandles = editFlipConfirmEl.value || null;
    const editDhabEntryEl = tbEditBody.querySelector("#editDhabEntry");
    if (editDhabEntryEl) body.dailyBiasEntryTime = editDhabEntryEl.value || null;
    const editDhabCandleEl = tbEditBody.querySelector("#editDhabCandle");
    if (editDhabCandleEl) body.dailyBiasCandle = editDhabCandleEl.value || null;
    body.volumeFilterEnabled = tbEditBody.querySelector("#editVolumeFilter").checked;
    body.volumeSmaPeriod = tbEditBody.querySelector("#editVolumeSmaPeriod").value || null;
    body.longCandleFilterEnabled = tbEditBody.querySelector("#editLongCandleFilter").checked;
    body.longCandleAtrPeriod = tbEditBody.querySelector("#editLongCandleAtrPeriod").value || null;
    body.longCandleAtrMult = tbEditBody.querySelector("#editLongCandleAtrMult").value || null;
    body.longCandleCooldownCandles = tbEditBody.querySelector("#editLongCandleCooldown").value || null;
    body.htfGateEnabled = tbEditBody.querySelector("#editHtfGate").checked;
    body.htfChopPeriod = tbEditBody.querySelector("#editHtfChopPeriod").value || null;
    body.htfChopMax = tbEditBody.querySelector("#editHtfChopMax").value || null;
    body.htfBandBlockEnabled = tbEditBody.querySelector("#editHtfBandBlock").checked;
    body.dailyHaGateEnabled = tbEditBody.querySelector("#editDailyHaGate").checked;

    try {
      const res = await fetch("/api/toolbox/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        errBox.textContent = data.error || "Failed to save";
        submitBtn.disabled = false;
        submitBtn.textContent = "Save changes (restarts the process)";
        return;
      }
      tbEditModal.classList.remove("open");
      loadToolboxList();
    } catch (err) {
      errBox.textContent = err.message;
      submitBtn.disabled = false;
      submitBtn.textContent = "Save changes (restarts the process)";
    }
  });
}
tbEditClose.addEventListener("click", () => tbEditModal.classList.remove("open"));
tbEditModal.addEventListener("click", e => { if (e.target === tbEditModal) tbEditModal.classList.remove("open"); });

async function openLogsModal(name) {
  tbLogsTitle.textContent = `${name} — logs`;
  tbLogsBody.innerHTML = "Loading...";
  tbLogsModal.classList.add("open");
  try {
    const data = await (await fetch(`/api/toolbox/logs/${encodeURIComponent(name)}`)).json();
    if (data.error) { tbLogsBody.textContent = data.error; return; }
    let html = `<div class="tb-log-section-title">stdout — ${data.outLogPath || "Unknown path"}</div>`;
    html += `<pre>${(data.out.join("\n") || "(empty)").replace(/</g, "&lt;")}</pre>`;
    if (data.err && data.err.length) {
      html += `<div class="tb-log-section-title">stderr — ${data.errLogPath || "Unknown path"}</div>`;
      html += `<pre class="err-line">${data.err.join("\n").replace(/</g, "&lt;")}</pre>`;
    }
    tbLogsBody.innerHTML = html;
  } catch (err) {
    tbLogsBody.textContent = `failed to load logs: ${err.message}`;
  }
}
tbLogsClose.addEventListener("click", () => tbLogsModal.classList.remove("open"));
tbLogsModal.addEventListener("click", e => { if (e.target === tbLogsModal) tbLogsModal.classList.remove("open"); });

// ── mode-switch modal ────────────────────────────────────────────────────
let modeTargetLive = null;

tbMode.addEventListener("click", () => {
  const names = getSelectedNames();
  if (names.length === 0) return;
  openModeModal(names);
});

function openModeModal(names) {
  modeTargetLive = null;
  tbModeBody.innerHTML = `
    <div class="tb-mode-row">
      <div class="tb-mode-target">${names.length} instrument(s) selected</div>
      <div class="tb-mode-choice">
        <button data-mode="paper">Paper</button>
        <button data-mode="live">Live</button>
      </div>
      <label class="tb-carry-row">
        <input type="checkbox" id="tbCarryCheck">
        <span>Carry position overnight (NRML, not MIS)</span>
      </label>
      <div class="tb-confirm-live" id="tbConfirmLive">
        <div class="tb-confirm-live-warn">⚠ switching to LIVE places real orders. type LIVE to confirm:</div>
        <input type="text" id="tbConfirmLiveInput" placeholder="type LIVE">
      </div>
      <button class="tb-mode-submit" id="tbModeSubmit" disabled>Apply</button>
    </div>
  `;
  tbModeModal.classList.add("open");

  const choiceBtns = tbModeBody.querySelectorAll(".tb-mode-choice button");
  const confirmLiveBox = tbModeBody.querySelector("#tbConfirmLive");
  const confirmLiveInput = tbModeBody.querySelector("#tbConfirmLiveInput");
  const submitBtn = tbModeBody.querySelector("#tbModeSubmit");
  const carryCheck = tbModeBody.querySelector("#tbCarryCheck");

  function updateSubmitState() {
    if (modeTargetLive === null) { submitBtn.disabled = true; return; }
    submitBtn.disabled = modeTargetLive && confirmLiveInput.value !== "LIVE";
  }

  choiceBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      choiceBtns.forEach(b => b.classList.remove("picked", "paper", "live"));
      modeTargetLive = btn.dataset.mode === "live";
      btn.classList.add("picked", btn.dataset.mode);
      confirmLiveBox.classList.toggle("show", modeTargetLive);
      updateSubmitState();
    });
  });
  confirmLiveInput.addEventListener("input", updateSubmitState);

  submitBtn.addEventListener("click", async () => {
    submitBtn.disabled = true;
    submitBtn.textContent = "...";
    for (const name of names) {
      try {
        await fetch("/api/toolbox/mode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            live: modeTargetLive,
            carryOvernight: carryCheck.checked,
            confirmLive: modeTargetLive ? confirmLiveInput.value : undefined,
          }),
        });
      } catch { /* best-effort, report via list refresh */ }
    }
    tbModeModal.classList.remove("open");
    loadToolboxList();
  });
}
tbModeClose.addEventListener("click", () => tbModeModal.classList.remove("open"));
tbModeModal.addEventListener("click", e => { if (e.target === tbModeModal) tbModeModal.classList.remove("open"); });

// ── add instrument modal ─────────────────────────────────────────────────
const tbAddModal = document.getElementById("tbAddModal");
const tbAddBody = document.getElementById("tbAddBody");
const tbAddClose = document.getElementById("tbAddClose");
document.getElementById("tbOpenAddInstrument").addEventListener("click", openAddInstrumentModal);
tbAddClose.addEventListener("click", () => tbAddModal.classList.remove("open"));
tbAddModal.addEventListener("click", e => { if (e.target === tbAddModal) tbAddModal.classList.remove("open"); });

let addState = {};

function openAddInstrumentModal() {
  addState = { exchange: "MCX" };
  renderAddSearchStep();
  tbAddModal.classList.add("open");
}

function renderAddSearchStep() {
  tbAddBody.innerHTML = `
    <div class="tb-form-row">
      <div class="tb-form-label">Exchange</div>
      <div class="tb-mode-choice" id="addExchangeChoice">
        <button data-ex="MCX" class="picked paper">MCX Futures</button>
        <button data-ex="NSE">NSE Stocks</button>
      </div>
    </div>
    <div class="tb-form-row">
      <div class="tb-form-label">Search underlying</div>
      <div class="tb-search-row">
        <input type="text" id="addSearchInput" placeholder="e.g. ZINC, NATGAS...">
        <button id="addSearchBtn">Search</button>
      </div>
    </div>
    <div class="tb-pick-list" id="addPickList"></div>
    <div class="tb-form-hint" id="addSearchHint"></div>
  `;
  const exBtns = tbAddBody.querySelectorAll("#addExchangeChoice button");
  exBtns.forEach(btn => btn.addEventListener("click", () => {
    exBtns.forEach(b => b.classList.remove("picked", "paper", "live"));
    btn.classList.add("picked", btn.dataset.ex === "MCX" ? "paper" : "live");
    addState.exchange = btn.dataset.ex;
  }));
  const searchInput = tbAddBody.querySelector("#addSearchInput");
  const pickList = tbAddBody.querySelector("#addPickList");
  const hint = tbAddBody.querySelector("#addSearchHint");
  async function runSearch() {
    hint.textContent = "Searching...";
    pickList.innerHTML = "";
    try {
      const q = searchInput.value.trim();
      const data = await (await fetch(`/api/toolbox/instruments?exchange=${addState.exchange}&q=${encodeURIComponent(q)}`)).json();
      if (data.error) { hint.textContent = data.error; return; }
      if (data.matches.length === 0) { hint.textContent = "No matches"; return; }
      hint.textContent = data.truncated ? `showing 50 of ${data.total} — narrow your search` : `${data.matches.length} match(es)`;
      data.matches.forEach(u => {
        const btn = document.createElement("button");
        btn.className = "tb-pick-item";
        btn.textContent = u;
        btn.addEventListener("click", () => selectAddUnderlying(u));
        pickList.appendChild(btn);
      });
    } catch (err) {
      hint.textContent = `search failed: ${err.message}`;
    }
  }
  tbAddBody.querySelector("#addSearchBtn").addEventListener("click", runSearch);
  searchInput.addEventListener("keydown", e => { if (e.key === "Enter") runSearch(); });
  runSearch();
}

async function selectAddUnderlying(underlying) {
  addState.underlying = underlying;
  tbAddBody.innerHTML = `<div class="tb-form-hint">resolving ${underlying}...</div>`;
  try {
    const preview = await (await fetch(`/api/toolbox/instruments/${encodeURIComponent(underlying)}/preview?exchange=${addState.exchange}`)).json();
    if (preview.error) {
      tbAddBody.innerHTML = `<div class="tb-err-box">${preview.error}</div><button class="tb-back-link" id="addBackErr">‹ Back to search</button>`;
      tbAddBody.querySelector("#addBackErr").addEventListener("click", renderAddSearchStep);
      return;
    }
    addState.preview = preview;
    const stratData = await (await fetch("/api/toolbox/strategies")).json();
    addState.strategies = stratData.strategies;
    addState.defaultStrategy = stratData.default;
    addState.allTimeframes = stratData.timeframes;
    renderAddConfigStep();
  } catch (err) {
    tbAddBody.innerHTML = `<div class="tb-err-box">failed: ${err.message}</div>`;
  }
}

function renderAddConfigStep() {
  const p = addState.preview;
  const strategies = addState.strategies;
  const defaultStrat = addState.defaultStrategy;
  tbAddBody.innerHTML = `
    <button class="tb-back-link" id="addBack">‹ Back to search</button>
    <div class="tb-resolved-box">
      <div>Would resolve to <span class="sym">${p.symbol}</span></div>
      <div>expiry: ${p.expiry || "N/a (equity, no roll)"} — broker lot_size ${p.brokerLotSize}</div>
    </div>
    ${p.lotMultRequired ? `
    <div class="tb-warn-box">⚠ lot multiplier required — the broker's lot_size is a contract COUNT, not the real price multiplier (this exact gap caused a real PnL bug once, on NatGas Mini). Look up the actual contract spec before entering this.</div>
    <div class="tb-form-row"><div class="tb-form-label">lot multiplier (required)</div><input type="number" id="addLotMult" placeholder="e.g. 250" min="0" step="any"></div>
    ` : ""}
    <div class="tb-form-row">
      <div class="tb-form-label">Strategy</div>
      <div id="addStrategyList"></div>
    </div>
    <div class="tb-form-row">
      <div class="tb-form-label">Timeframe</div>
      <select id="addTimeframe"></select>
    </div>
    <div class="tb-form-row">
      <div class="tb-form-label">Lots</div>
      <input type="number" id="addLots" value="1" min="1" step="1">
    </div>
    <div class="tb-form-row">
      <div class="tb-form-label">Mode</div>
      <div class="tb-mode-choice" id="addModeChoice">
        <button data-mode="paper" class="picked paper">Paper</button>
        <button data-mode="live">Live</button>
      </div>
      <div class="tb-confirm-live" id="addConfirmLive">
        <div class="tb-confirm-live-warn">⚠ this will place REAL orders. type LIVE to confirm:</div>
        <input type="text" id="addConfirmLiveInput" placeholder="type LIVE">
      </div>
    </div>
    <label class="tb-form-row-inline"><input type="checkbox" id="addCarry"><span>Carry position overnight instead of EOD close</span></label>
    <div class="tb-form-row">
      <div class="tb-form-label">Profit target in points (tick-monitored, blank = none)</div>
      <input type="number" id="addTarget" min="0" step="any">
    </div>
    <div class="tb-form-row" id="addAlmaBandRow" style="display:none">
      <label class="tb-form-row-inline"><input type="checkbox" id="addAlmaBand" checked><span>Use ALMA band gate (ALMA_PRO_FAST only, default: ON)</span></label>
    </div>
    <div class="tb-form-row" id="addAlmaFastLenRow" style="display:none">
      <div class="tb-form-label">Fast ALMA length (ALMA_PRO_FAST only, blank = default)</div>
      <input type="number" id="addAlmaFastLen" min="1" step="1">
    </div>
    <div class="tb-form-row" id="addAlmaBandLenRow" style="display:none">
      <div class="tb-form-label">Band ALMA length (ALMA_PRO_FAST only, blank = default)</div>
      <input type="number" id="addAlmaBandLen" min="1" step="1">
    </div>
    <div class="tb-form-row" id="addAlmaChopRow" style="display:none">
      <label class="tb-form-row-inline"><input type="checkbox" id="addAlmaChop" checked><span>Use Choppiness Index entry filter (ALMA_PRO_FAST/ALMA_PRO_SLOW only, default: ON)</span></label>
    </div>
    <div class="tb-form-row" id="addBandStepRow" style="display:none">
      <div class="tb-form-label">Band step in price points (DYNAMIC_BAND only, blank = default)</div>
      <input type="number" id="addBandStep" min="0" step="any">
    </div>
    <div class="tb-form-row" id="addGreyExitRow" style="display:none">
      <label class="tb-form-row-inline"><input type="checkbox" id="addGreyExit"><span>Exit on grey state instead of holding through it (ALMA_TRI_BAND only, default: hold)</span></label>
    </div>
    <div class="tb-form-row">
      <label class="tb-form-row-inline"><input type="checkbox" id="addDisableDouble"><span>Disable double orders (blocks reversal re-entries only, default: allowed)</span></label>
      <div class="tb-form-hint">Reversal re-entries stay gated only by the Choppiness Index check every entry already gets, whether checked or not</div>
    </div>
    <div class="tb-form-row">
      <div class="tb-form-label">ATR stop-loss multiplier (blank = default)</div>
      <input type="number" id="addAtrSlMult" min="0" step="any">
    </div>
    <div class="tb-form-row" id="addFlipConfirmRow" style="display:none">
      <div class="tb-form-label">Reversal candles required to flip, anti-whipsaw (blank = 1, immediate)</div>
      <input type="number" id="addFlipConfirm" min="1" step="1">
    </div>
    <div class="tb-form-row" id="addDhabEntryRow" style="display:none">
      <div class="tb-form-label">Trade entry time IST \u2014 the first candle (15m by default) at/after it takes the previous daily HA candle's side (blank = 10:00)</div>
      <input type="time" id="addDhabEntry">
      <div class="tb-form-label" style="margin-top:8px">Daily candle used \u2014 previous = yesterday's completed daily HA candle; present = today's forming daily HA candle at entry time</div>
      <select id="addDhabCandle">
        <option value="">Previous day (default)</option>
        <option value="PREVIOUS">Previous day (explicit)</option>
        <option value="CURRENT">Present day (forming)</option>
      </select>
    </div>
    <div class="tb-form-row">
      <label class="tb-form-row-inline"><input type="checkbox" id="addVolumeFilter"><span>Only enter when volume is above its SMA</span></label>
      <div class="tb-form-hint">Period below only applies while this is checked</div>
      <input type="number" id="addVolumeSmaPeriod" min="1" step="1" placeholder="SMA period, blank = default">
    </div>
    <div class="tb-form-row">
      <label class="tb-form-row-inline"><input type="checkbox" id="addLongCandleFilter" checked><span>Block new entries after an abnormally large candle</span></label>
      <div class="tb-form-hint">On by default — Sep 2 NATGASMINI/DYNAMIC_BAND fix. Existing SL/target/exit are never affected.</div>
      <input type="number" id="addLongCandleAtrPeriod" min="1" step="1" placeholder="ATR period, blank = default (14)">
      <input type="number" id="addLongCandleAtrMult" min="0" step="any" placeholder="ATR multiplier, blank = default (1.5)">
      <input type="number" id="addLongCandleCooldown" min="0" step="1" placeholder="cooldown candles, blank = default (2)">
    </div>
    <div class="tb-form-row">
      <div class="tb-form-label">Max daily loss in rupees, quits for the day if breached (blank = no floor)</div>
      <input type="number" id="addMaxDailyLoss" min="0" step="any">
    </div>
    <div class="tb-form-row">
      <label class="tb-form-row-inline"><input type="checkbox" id="addHtfGate" checked><span>Block entries when a higher timeframe is trending but price hasn't broken its band yet (default: ON)</span></label>
      <div class="tb-form-hint">Checks the 1h timeframe; period/max tune its Choppiness Index reading.</div>
      <input type="number" id="addHtfChopPeriod" min="1" step="1" placeholder="chop period, blank = default (9)">
      <input type="number" id="addHtfChopMax" min="0" step="any" placeholder="chop max, blank = default (58)">
      <label class="tb-form-row-inline"><input type="checkbox" id="addHtfBandBlock" checked><span>Also require price still inside its own ALMA band (uncheck = block on low chop alone)</span></label>
    </div>
    <div class="tb-form-row">
      <label class="tb-form-row-inline"><input type="checkbox" id="addDailyHaGate" checked><span>Only allow entries matching the previous daily HA candle's color (green=long only, red=short only)</span></label>
      <div class="tb-form-hint">On by default, applies universally regardless of strategy.</div>
    </div>
    <div id="addErrBox"></div>
    <button class="tb-submit-btn" id="addSubmit">Start instrument</button>
  `;
  tbAddBody.querySelector("#addBack").addEventListener("click", renderAddSearchStep);

  let pickedStrategy = defaultStrat;
  const stratList = tbAddBody.querySelector("#addStrategyList");
  const almaBandRow = tbAddBody.querySelector("#addAlmaBandRow");
  const almaFastLenRow = tbAddBody.querySelector("#addAlmaFastLenRow");
  const almaBandLenRow = tbAddBody.querySelector("#addAlmaBandLenRow");
  const almaChopRow = tbAddBody.querySelector("#addAlmaChopRow");
  const bandStepRow = tbAddBody.querySelector("#addBandStepRow");
  const greyExitRow = tbAddBody.querySelector("#addGreyExitRow");
  const flipConfirmRow = tbAddBody.querySelector("#addFlipConfirmRow");
  const dhabEntryRow = tbAddBody.querySelector("#addDhabEntryRow");
  strategies.forEach(s => {
    const div = document.createElement("div");
    div.className = "tb-strategy-item" + (s.key === defaultStrat ? " picked" : "");
    div.innerHTML = `<div class="tb-strategy-item-label">${s.label}${s.key === defaultStrat ? " (default)" : ""}</div><div class="tb-strategy-item-desc">${s.description}</div>`;
    div.addEventListener("click", () => {
      pickedStrategy = s.key;
      stratList.querySelectorAll(".tb-strategy-item").forEach(el => el.classList.remove("picked"));
      div.classList.add("picked");
      updateTimeframeOptions(s.timeframe);
      almaBandRow.style.display = s.key === "ALMA_PRO_FAST" ? "" : "none";
      almaFastLenRow.style.display = s.key === "ALMA_PRO_FAST" ? "" : "none";
      almaBandLenRow.style.display = (s.key === "ALMA_PRO_FAST" && tbAddBody.querySelector("#addAlmaBand").checked) ? "" : "none";
      almaChopRow.style.display = (s.key === "ALMA_PRO_FAST" || s.key === "ALMA_PRO_SLOW") ? "" : "none";
      bandStepRow.style.display = (s.key === "DYNAMIC_BAND" || s.key === "DYNAMIC_MID_COLOR" || s.key === "DYNAMIC_MID_COLOR_HL") ? "" : "none";
      greyExitRow.style.display = s.key === "ALMA_TRI_BAND" ? "" : "none";
      flipConfirmRow.style.display = s.key === "PURE_HA" ? "" : "none";
      dhabEntryRow.style.display = s.key === "DAILY_HA_BIAS" ? "" : "none";
    });
    stratList.appendChild(div);
  });
  // Band length row also depends on the band-gate checkbox itself (only
  // meaningful while the gate is on) — separate listener, not just the
  // per-strategy click handler above, so toggling the checkbox alone
  // (without changing strategy) updates its visibility too.
  tbAddBody.querySelector("#addAlmaBand").addEventListener("change", e => {
    almaBandLenRow.style.display = (pickedStrategy === "ALMA_PRO_FAST" && e.target.checked) ? "" : "none";
  });

  const tfSelect = tbAddBody.querySelector("#addTimeframe");
  function updateTimeframeOptions(defaultTf) {
    tfSelect.innerHTML = "";
    (addState.allTimeframes || ["5m", "15m", "30m", "1h"]).forEach(tf => {
      const opt = document.createElement("option");
      opt.value = tf;
      opt.textContent = tf + (tf === defaultTf ? " (default)" : "");
      if (tf === defaultTf) opt.selected = true;
      tfSelect.appendChild(opt);
    });
  }
  const defStratInfo = strategies.find(s => s.key === defaultStrat);
  updateTimeframeOptions(defStratInfo ? defStratInfo.timeframe : "15m");
  almaBandRow.style.display = defaultStrat === "ALMA_PRO_FAST" ? "" : "none";
  almaFastLenRow.style.display = defaultStrat === "ALMA_PRO_FAST" ? "" : "none";
  almaBandLenRow.style.display = defaultStrat === "ALMA_PRO_FAST" ? "" : "none";
  almaChopRow.style.display = (defaultStrat === "ALMA_PRO_FAST" || defaultStrat === "ALMA_PRO_SLOW") ? "" : "none";

  const modeBtns = tbAddBody.querySelectorAll("#addModeChoice button");
  const confirmLiveBox = tbAddBody.querySelector("#addConfirmLive");
  let isLive = false;
  modeBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      modeBtns.forEach(b => b.classList.remove("picked", "paper", "live"));
      isLive = btn.dataset.mode === "live";
      btn.classList.add("picked", btn.dataset.mode);
      confirmLiveBox.classList.toggle("show", isLive);
    });
  });

  tbAddBody.querySelector("#addSubmit").addEventListener("click", async () => {
    const errBox = tbAddBody.querySelector("#addErrBox");
    errBox.innerHTML = "";
    const submitBtn = tbAddBody.querySelector("#addSubmit");
    const lotMultInput = tbAddBody.querySelector("#addLotMult");
    if (p.lotMultRequired && (!lotMultInput.value || Number(lotMultInput.value) <= 0)) {
      errBox.innerHTML = `<div class="tb-err-box">Lot multiplier is required</div>`;
      return;
    }
    if (isLive && tbAddBody.querySelector("#addConfirmLiveInput").value !== "LIVE") {
      errBox.innerHTML = `<div class="tb-err-box">Type LIVE to confirm live mode</div>`;
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = "Starting...";
    try {
      const body = {
        underlying: addState.underlying,
        exchange: addState.exchange,
        lots: tbAddBody.querySelector("#addLots").value,
        lotMultOverride: p.lotMultRequired ? lotMultInput.value : undefined,
        live: isLive,
        confirmLive: isLive ? tbAddBody.querySelector("#addConfirmLiveInput").value : undefined,
        carryOvernight: tbAddBody.querySelector("#addCarry").checked,
        strategy: pickedStrategy,
        timeframe: tfSelect.value,
        targetPoints: tbAddBody.querySelector("#addTarget").value || undefined,
        almaBandEnabled: pickedStrategy === "ALMA_PRO_FAST" ? tbAddBody.querySelector("#addAlmaBand").checked : undefined,
        almaFastLen: pickedStrategy === "ALMA_PRO_FAST" ? (tbAddBody.querySelector("#addAlmaFastLen").value || undefined) : undefined,
        almaBandLen: pickedStrategy === "ALMA_PRO_FAST" ? (tbAddBody.querySelector("#addAlmaBandLen").value || undefined) : undefined,
        almaChopFilterEnabled: (pickedStrategy === "ALMA_PRO_FAST" || pickedStrategy === "ALMA_PRO_SLOW") ? tbAddBody.querySelector("#addAlmaChop").checked : undefined,
        maxDailyLoss: tbAddBody.querySelector("#addMaxDailyLoss").value || undefined,
        bandStep: (pickedStrategy === "DYNAMIC_BAND" || pickedStrategy === "DYNAMIC_MID_COLOR" || pickedStrategy === "DYNAMIC_MID_COLOR_HL") ? (tbAddBody.querySelector("#addBandStep").value || undefined) : undefined,
        greyExitEnabled: pickedStrategy === "ALMA_TRI_BAND" ? tbAddBody.querySelector("#addGreyExit").checked : undefined,
        disableDoubleOrders: tbAddBody.querySelector("#addDisableDouble").checked,
        atrSlMult: tbAddBody.querySelector("#addAtrSlMult").value || undefined,
        flipConfirmCandles: pickedStrategy === "PURE_HA" ? (tbAddBody.querySelector("#addFlipConfirm").value || undefined) : undefined,
        dailyBiasEntryTime: pickedStrategy === "DAILY_HA_BIAS" ? (tbAddBody.querySelector("#addDhabEntry").value || undefined) : undefined,
        dailyBiasCandle: pickedStrategy === "DAILY_HA_BIAS" ? (tbAddBody.querySelector("#addDhabCandle").value || undefined) : undefined,
        volumeFilterEnabled: tbAddBody.querySelector("#addVolumeFilter").checked,
        volumeSmaPeriod: tbAddBody.querySelector("#addVolumeSmaPeriod").value || undefined,
        longCandleFilterEnabled: tbAddBody.querySelector("#addLongCandleFilter").checked,
        longCandleAtrPeriod: tbAddBody.querySelector("#addLongCandleAtrPeriod").value || undefined,
        longCandleAtrMult: tbAddBody.querySelector("#addLongCandleAtrMult").value || undefined,
        longCandleCooldownCandles: tbAddBody.querySelector("#addLongCandleCooldown").value || undefined,
        htfGateEnabled: tbAddBody.querySelector("#addHtfGate").checked,
        htfChopPeriod: tbAddBody.querySelector("#addHtfChopPeriod").value || undefined,
        htfChopMax: tbAddBody.querySelector("#addHtfChopMax").value || undefined,
        htfBandBlockEnabled: tbAddBody.querySelector("#addHtfBandBlock").checked,
        dailyHaGateEnabled: tbAddBody.querySelector("#addDailyHaGate").checked,
      };
      const res = await fetch("/api/toolbox/instrument", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) {
        errBox.innerHTML = `<div class="tb-err-box">${data.error || "Failed"}</div>`;
        submitBtn.disabled = false;
        submitBtn.textContent = "Start instrument";
        return;
      }
      tbAddModal.classList.remove("open");
      appendLog({ type: "SYS", text: `started ${data.name} — ${isLive ? "LIVE" : "PAPER"} — ${pickedStrategy} @ ${data.timeframe}` });
      loadToolboxList();
    } catch (err) {
      errBox.innerHTML = `<div class="tb-err-box">${err.message}</div>`;
      submitBtn.disabled = false;
      submitBtn.textContent = "Start instrument";
    }
  });
}

// ── backtest modal ───────────────────────────────────────────────────────
const tbBacktestModal = document.getElementById("tbBacktestModal");
const tbBacktestBody = document.getElementById("tbBacktestBody");
const tbBacktestClose = document.getElementById("tbBacktestClose");
document.getElementById("tbOpenBacktest").addEventListener("click", openBacktestModal);
tbBacktestClose.addEventListener("click", () => tbBacktestModal.classList.remove("open"));
tbBacktestModal.addEventListener("click", e => { if (e.target === tbBacktestModal) tbBacktestModal.classList.remove("open"); });

let btState = {};

async function openBacktestModal() {
  btState = { exchange: "MCX" };
  tbBacktestBody.innerHTML = `<div class="tb-form-hint">Loading strategies...</div>`;
  tbBacktestModal.classList.add("open");
  try {
    const stratData = await (await fetch("/api/toolbox/strategies")).json();
    btState.strategies = stratData.strategies;
    btState.timeframes = stratData.timeframes;
    renderBacktestStrategyStep();
  } catch (err) {
    tbBacktestBody.innerHTML = `<div class="tb-err-box">failed to load: ${err.message}</div>`;
  }
}

function renderBacktestStrategyStep() {
  tbBacktestBody.innerHTML = `<div class="tb-form-row"><div class="tb-form-label">Step 1/3 — strategy</div><div id="btStrategyList"></div></div>`;
  const list = tbBacktestBody.querySelector("#btStrategyList");
  btState.strategies.forEach(s => {
    const div = document.createElement("div");
    div.className = "tb-strategy-item";
    div.innerHTML = `<div class="tb-strategy-item-label">${s.label}</div><div class="tb-strategy-item-desc">${s.description}</div>`;
    div.addEventListener("click", () => {
      btState.strategy = s.key;
      btState.defaultTimeframe = s.timeframe;
      renderBacktestInstrumentStep();
    });
    list.appendChild(div);
  });
}

function renderBacktestInstrumentStep() {
  tbBacktestBody.innerHTML = `
    <button class="tb-back-link" id="btBack1">‹ Back to strategy</button>
    <div class="tb-form-row">
      <div class="tb-form-label">Step 2/3 — instrument</div>
      <div class="tb-mode-choice" id="btExchangeChoice">
        <button data-ex="MCX" class="picked paper">MCX Futures</button>
        <button data-ex="NSE">NSE Stocks</button>
      </div>
    </div>
    <div class="tb-search-row">
      <input type="text" id="btSearchInput" placeholder="search underlying...">
      <button id="btSearchBtn">Search</button>
    </div>
    <div class="tb-pick-list" id="btPickList"></div>
    <div class="tb-form-hint" id="btSearchHint"></div>
  `;
  tbBacktestBody.querySelector("#btBack1").addEventListener("click", renderBacktestStrategyStep);
  const exBtns = tbBacktestBody.querySelectorAll("#btExchangeChoice button");
  exBtns.forEach(btn => btn.addEventListener("click", () => {
    exBtns.forEach(b => b.classList.remove("picked", "paper", "live"));
    btn.classList.add("picked", btn.dataset.ex === "MCX" ? "paper" : "live");
    btState.exchange = btn.dataset.ex;
  }));
  const searchInput = tbBacktestBody.querySelector("#btSearchInput");
  const pickList = tbBacktestBody.querySelector("#btPickList");
  const hint = tbBacktestBody.querySelector("#btSearchHint");
  async function runSearch() {
    hint.textContent = "Searching...";
    pickList.innerHTML = "";
    try {
      const q = searchInput.value.trim();
      const data = await (await fetch(`/api/toolbox/instruments?exchange=${btState.exchange}&q=${encodeURIComponent(q)}`)).json();
      if (data.error) { hint.textContent = data.error; return; }
      if (data.matches.length === 0) { hint.textContent = "No matches"; return; }
      hint.textContent = data.truncated ? `showing 50 of ${data.total} — narrow your search` : `${data.matches.length} match(es)`;
      data.matches.forEach(u => {
        const btn = document.createElement("button");
        btn.className = "tb-pick-item";
        btn.textContent = u;
        btn.addEventListener("click", () => { btState.underlying = u; renderBacktestParamsStep(); });
        pickList.appendChild(btn);
      });
    } catch (err) {
      hint.textContent = `search failed: ${err.message}`;
    }
  }
  tbBacktestBody.querySelector("#btSearchBtn").addEventListener("click", runSearch);
  searchInput.addEventListener("keydown", e => { if (e.key === "Enter") runSearch(); });
  runSearch();
}

async function renderBacktestParamsStep() {
  tbBacktestBody.innerHTML = `<div class="tb-form-hint">Loading...</div>`;
  let paramDefs = [];
  let preview = null;
  try {
    const [paramsRes, previewRes] = await Promise.all([
      fetch(`/api/toolbox/backtest/params/${btState.strategy}`),
      fetch(`/api/toolbox/instruments/${encodeURIComponent(btState.underlying)}/preview?exchange=${btState.exchange}`),
    ]);
    paramDefs = await paramsRes.json();
    if (!Array.isArray(paramDefs)) paramDefs = [];
    preview = await previewRes.json();
    if (preview.error) preview = null; // resolution can still fail here; submit will surface the real error
  } catch { /* proceed with defaults-only form; submit-time validation still catches a missing multiplier */ }

  tbBacktestBody.innerHTML = `
    <button class="tb-back-link" id="btBack2">‹ Back to instrument</button>
    <div class="tb-form-row">
      <div class="tb-form-label">Step 3/3 — range & params</div>
      <div class="tb-form-hint">${btState.underlying} — ${(btState.strategies.find(s => s.key === btState.strategy) || {}).label || btState.strategy}</div>
    </div>
    <div class="tb-form-row"><div class="tb-form-label">Timeframe</div><select id="btTimeframe"></select></div>
    <div class="tb-form-row"><div class="tb-form-label">Days back (default 30)</div><input type="number" id="btDays" placeholder="30" min="1"></div>
    <div class="tb-form-row" id="btLotMultRow" style="display:${preview && preview.lotMultRequired ? "" : "none"}">
      <div class="tb-form-label">Lot multiplier (required for this instrument)</div>
      <input type="number" id="btLotMult" min="0" step="any">
    </div>
    <div id="btParamsBox"></div>
    <div class="tb-form-row">
      <div class="tb-form-label">Risk (same as toolbox's backtest wizard)</div>
    </div>
    <div class="tb-form-row">
      <label class="tb-form-row-inline"><input type="checkbox" id="btChopEnabled" checked><span>Choppiness Index filter on every entry (default Y)</span></label>
      <input type="number" id="btChopPeriod" placeholder="period, default 9" min="1" step="1">
      <input type="number" id="btChopMax" placeholder="max threshold, default 58" min="0" step="any">
    </div>
    <div class="tb-form-row">
      <label class="tb-form-row-inline"><input type="checkbox" id="btLcEnabled" checked><span>Block entries after an abnormally large candle (default Y)</span></label>
      <input type="number" id="btLcPeriod" placeholder="ATR period, default 14" min="1" step="1">
      <input type="number" id="btLcMult" placeholder="ATR multiplier, default 1.5" min="0" step="any">
      <input type="number" id="btLcCooldown" placeholder="cooldown candles, default 2" min="0" step="1">
    </div>
    <div class="tb-form-row">
      <label class="tb-form-row-inline"><input type="checkbox" id="btDoubleDisabled"><span>Disable double orders, blocks reversal re-entries only (default N)</span></label>
    </div>
    <div class="tb-form-row" id="btAtrRow">
      <div class="tb-form-label">ATR stop-loss multiplier (blank = default)</div>
      <input type="number" id="btAtrMult" min="0" step="any">
    </div>
    <div class="tb-form-row" id="btDhabEntryRow" style="display:none">
      <div class="tb-form-label">Trade entry time IST \u2014 the first candle at/after it takes the previous daily HA candle's side (blank = 10:00)</div>
      <input type="time" id="btDhabEntry">
      <div class="tb-form-label" style="margin-top:8px">Daily candle used \u2014 previous = yesterday's completed daily HA candle; present = today's forming daily HA candle at entry time</div>
      <select id="btDhabCandle">
        <option value="">Previous day (default)</option>
        <option value="PREVIOUS">Previous day (explicit)</option>
        <option value="CURRENT">Present day (forming)</option>
      </select>
    </div>
    <div class="tb-form-row">
      <label class="tb-form-row-inline"><input type="checkbox" id="btVolEnabled"><span>Only enter when volume is above its SMA (default N)</span></label>
      <input type="number" id="btVolPeriod" placeholder="SMA period, default 20" min="1" step="1">
    </div>
    <div class="tb-form-row">
      <label class="tb-form-row-inline"><input type="checkbox" id="btCarry"><span>Carry positions overnight past EOD, NRML-style (default N)</span></label>
    </div>
    <div class="tb-form-row">
      <div class="tb-form-label">Max daily loss in rupees, quits for the day if breached (blank = no floor)</div>
      <input type="number" id="btMaxLoss" min="0" step="any">
    </div>
    <div class="tb-form-row">
      <div class="tb-form-label">Session target in rupees, quits for the day once reached (blank = no ceiling)</div>
      <input type="number" id="btSessionTarget" min="0" step="any">
    </div>
    <div class="tb-form-row">
      <label class="tb-form-row-inline"><input type="checkbox" id="btDailyHaGate" checked><span>Only allow entries matching the previous daily HA candle's color (green=long only, red=short only) (default Y)</span></label>
      <div class="tb-form-hint">Htf gate isn't offered here — its backtest replay is a live-only stub that always passes through, so a toggle for it would do nothing.</div>
    </div>
    <div id="btErrBox"></div>
    <div id="btResultBox"></div>
    <button class="tb-submit-btn" id="btSubmit">Run backtest</button>
  `;
  tbBacktestBody.querySelector("#btBack2").addEventListener("click", renderBacktestInstrumentStep);

  // ALMA_BAND's stop is the opposite band line, not ATR-based (Sep 2026) —
  // hide the ATR field entirely rather than show a control that does
  // nothing, same reasoning as the CLI skipping this prompt for it.
  if (btState.strategy === "ALMA_BAND") {
    tbBacktestBody.querySelector("#btAtrRow").style.display = "none";
  }
  if (btState.strategy === "DAILY_HA_BIAS") {
    tbBacktestBody.querySelector("#btDhabEntryRow").style.display = "";
  }

  const tfSelect = tbBacktestBody.querySelector("#btTimeframe");
  (btState.timeframes || ["5m", "15m", "30m", "1h"]).forEach(tf => {
    const opt = document.createElement("option");
    opt.value = tf;
    opt.textContent = tf + (tf === btState.defaultTimeframe ? " (default)" : "");
    if (tf === btState.defaultTimeframe) opt.selected = true;
    tfSelect.appendChild(opt);
  });

  const paramsBox = tbBacktestBody.querySelector("#btParamsBox");
  paramDefs.forEach(pd => {
    const row = document.createElement("div");
    row.className = "tb-form-row";
    row.innerHTML = `<div class="tb-form-label">${pd.label} (default ${pd.default})</div><input type="number" step="any" data-param="${pd.key}" placeholder="${pd.default}">`;
    paramsBox.appendChild(row);
  });

  tbBacktestBody.querySelector("#btSubmit").addEventListener("click", async () => {
    const errBox = tbBacktestBody.querySelector("#btErrBox");
    const resultBox = tbBacktestBody.querySelector("#btResultBox");
    errBox.innerHTML = "";
    resultBox.innerHTML = "";
    const submitBtn = tbBacktestBody.querySelector("#btSubmit");
    submitBtn.disabled = true;
    submitBtn.textContent = "Running... (fetching history + replaying)";
    const params = {};
    paramsBox.querySelectorAll("input[data-param]").forEach(inp => { if (inp.value) params[inp.dataset.param] = inp.value; });
    const body = {
      underlying: btState.underlying,
      exchange: btState.exchange,
      strategy: btState.strategy,
      timeframe: tfSelect.value,
      days: tbBacktestBody.querySelector("#btDays").value || undefined,
      params,
      lotMultOverride: tbBacktestBody.querySelector("#btLotMult").value || undefined,
      chopFilterEnabled: tbBacktestBody.querySelector("#btChopEnabled").checked,
      chopPeriod: tbBacktestBody.querySelector("#btChopPeriod").value || undefined,
      chopMax: tbBacktestBody.querySelector("#btChopMax").value || undefined,
      longCandleFilterEnabled: tbBacktestBody.querySelector("#btLcEnabled").checked,
      longCandleAtrPeriod: tbBacktestBody.querySelector("#btLcPeriod").value || undefined,
      longCandleAtrMult: tbBacktestBody.querySelector("#btLcMult").value || undefined,
      longCandleCooldownCandles: tbBacktestBody.querySelector("#btLcCooldown").value || undefined,
      disableDoubleOrders: tbBacktestBody.querySelector("#btDoubleDisabled").checked,
      atrSlMult: btState.strategy === "ALMA_BAND" ? undefined : (tbBacktestBody.querySelector("#btAtrMult").value || undefined),
      dailyBiasEntryTime: btState.strategy === "DAILY_HA_BIAS" ? (tbBacktestBody.querySelector("#btDhabEntry").value || undefined) : undefined,
      dailyBiasCandle: btState.strategy === "DAILY_HA_BIAS" ? (tbBacktestBody.querySelector("#btDhabCandle").value || undefined) : undefined,
      volumeFilterEnabled: tbBacktestBody.querySelector("#btVolEnabled").checked,
      volumeSmaPeriod: tbBacktestBody.querySelector("#btVolPeriod").value || undefined,
      carryOvernight: tbBacktestBody.querySelector("#btCarry").checked,
      maxDailyLoss: tbBacktestBody.querySelector("#btMaxLoss").value || undefined,
      sessionTargetRupees: tbBacktestBody.querySelector("#btSessionTarget").value || undefined,
      dailyHaGateEnabled: tbBacktestBody.querySelector("#btDailyHaGate").checked,
    };
    try {
      const res = await fetch("/api/toolbox/backtest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) {
        if (/lot multiplier/i.test(data.error || "")) tbBacktestBody.querySelector("#btLotMultRow").style.display = "";
        errBox.innerHTML = `<div class="tb-err-box">${data.error || "Backtest failed"}</div>`;
        submitBtn.disabled = false;
        submitBtn.textContent = "Run backtest";
        return;
      }
      const m = data.summary;
      const fmtMoney = v => (v >= 0 ? "+" : "") + Math.round(v).toLocaleString();
      const logText = (data.logLines || []).join("\n");
      resultBox.innerHTML = `
        <div class="tb-summary-grid">
          <div class="tb-summary-cell"><div class="k">Trades</div><div class="v">${m.trades}</div></div>
          <div class="tb-summary-cell"><div class="k">Win rate</div><div class="v">${(m.winRate * 100).toFixed(1)}%</div></div>
          <div class="tb-summary-cell"><div class="k">Profit factor</div><div class="v">${m.profitFactor === null ? "-" : m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2)}</div></div>
          <div class="tb-summary-cell"><div class="k">Net pnl</div><div class="v">${fmtMoney(m.netPnL)}</div></div>
          <div class="tb-summary-cell"><div class="k">Max drawdown</div><div class="v">${fmtMoney(m.maxDrawdown)}</div></div>
          <div class="tb-summary-cell"><div class="k">Avg trade</div><div class="v">${fmtMoney(m.avgTrade)}</div></div>
        </div>
        <a class="tb-report-link" href="${data.reportUrl}" target="_blank" rel="noopener">Open full report ↗</a>
        <div class="tb-bt-log-wrap">
          <button type="button" class="tb-bt-log-toggle" id="btLogToggle">▸ show full backtest log (${(data.logLines || []).length} lines)</button>
          <pre class="tb-bt-log" id="btLogBody" hidden></pre>
        </div>
      `;
      const logToggle = resultBox.querySelector("#btLogToggle");
      const logBody = resultBox.querySelector("#btLogBody");
      logToggle.addEventListener("click", () => {
        const showing = !logBody.hidden;
        logBody.hidden = showing;
        if (!showing && !logBody.textContent) logBody.textContent = logText; // fill lazily on first open
        logToggle.textContent = `${showing ? "▸ show" : "▾ hide"} full backtest log (${(data.logLines || []).length} lines)`;
      });
      submitBtn.disabled = false;
      submitBtn.textContent = "Run backtest";
    } catch (err) {
      errBox.innerHTML = `<div class="tb-err-box">${err.message}</div>`;
      submitBtn.disabled = false;
      submitBtn.textContent = "Run backtest";
    }
  });
}

// ── credentials modal ────────────────────────────────────────────────────
const tbCredsModal = document.getElementById("tbCredsModal");
const tbCredsBody = document.getElementById("tbCredsBody");
const tbCredsClose = document.getElementById("tbCredsClose");
document.getElementById("tbOpenCredentials").addEventListener("click", openCredentialsModal);
tbCredsClose.addEventListener("click", () => tbCredsModal.classList.remove("open"));
tbCredsModal.addEventListener("click", e => { if (e.target === tbCredsModal) tbCredsModal.classList.remove("open"); });

async function openCredentialsModal() {
  tbCredsBody.innerHTML = `<div class="tb-form-hint">Loading...</div>`;
  tbCredsModal.classList.add("open");
  try {
    const fields = await (await fetch("/api/toolbox/credentials")).json();
    tbCredsBody.innerHTML = `
      <div class="tb-form-hint" style="margin-bottom:14px">Blank = keep current value</div>
      ${fields.map(f => `
        <div class="tb-form-row">
          <div class="tb-form-label">${f.key}${f.set ? "" : " (not set)"}</div>
          <input type="text" data-cred="${f.key}" placeholder="${f.masked || "New value"}">
        </div>
      `).join("")}
      <div id="credsErrBox"></div>
      <div id="credsMsgBox"></div>
      <button class="tb-submit-btn" id="credsSubmit">Save</button>
    `;
    tbCredsBody.querySelector("#credsSubmit").addEventListener("click", async () => {
      const errBox = tbCredsBody.querySelector("#credsErrBox");
      const msgBox = tbCredsBody.querySelector("#credsMsgBox");
      errBox.innerHTML = "";
      msgBox.innerHTML = "";
      const body = {};
      tbCredsBody.querySelectorAll("input[data-cred]").forEach(inp => { if (inp.value) body[inp.dataset.cred] = inp.value; });
      const submitBtn = tbCredsBody.querySelector("#credsSubmit");
      submitBtn.disabled = true;
      submitBtn.textContent = "Saving...";
      try {
        const res = await fetch("/api/toolbox/credentials", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok) {
          errBox.innerHTML = `<div class="tb-err-box">${data.error || "Failed"}</div>`;
          submitBtn.disabled = false;
          submitBtn.textContent = "Save";
          return;
        }
        msgBox.innerHTML = data.changed > 0
          ? `<div class="tb-form-hint">saved ${data.changed} value(s) — ${data.note}</div>`
          : `<div class="tb-form-hint">Nothing changed</div>`;
        submitBtn.disabled = false;
        submitBtn.textContent = "Save";
      } catch (err) {
        errBox.innerHTML = `<div class="tb-err-box">${err.message}</div>`;
        submitBtn.disabled = false;
        submitBtn.textContent = "Save";
      }
    });
  } catch (err) {
    tbCredsBody.innerHTML = `<div class="tb-err-box">failed to load: ${err.message}</div>`;
  }
}

// ── trending instruments modal ───────────────────────────────────────────
const tbTrendingModal = document.getElementById("tbTrendingModal");
const tbTrendingBody = document.getElementById("tbTrendingBody");
const tbTrendingClose = document.getElementById("tbTrendingClose");
document.getElementById("tbOpenTrending").addEventListener("click", openTrendingModal);
tbTrendingClose.addEventListener("click", () => tbTrendingModal.classList.remove("open"));
tbTrendingModal.addEventListener("click", e => { if (e.target === tbTrendingModal) tbTrendingModal.classList.remove("open"); });

let trendState = {};

function openTrendingModal() {
  trendState = { exchange: "MCX" };
  renderTrendingSetupStep();
  tbTrendingModal.classList.add("open");
}

function renderTrendingSetupStep(confirmAllNotice) {
  tbTrendingBody.innerHTML = `
    <div class="tb-form-row">
      <div class="tb-form-label">Exchange</div>
      <div class="tb-mode-choice" id="trendExchangeChoice">
        <button data-ex="MCX" class="picked paper">MCX Futures</button>
        <button data-ex="NSE">NSE Stocks</button>
      </div>
    </div>
    <div class="tb-form-row">
      <div class="tb-form-label">Filter (blank = scan all)</div>
      <input type="text" id="trendQuery" placeholder="e.g. ZINC, NATGAS...">
    </div>
    <div class="tb-form-hint">ADX(${14}) on daily candles, ${90}d lookback, ≥25 = trending. Rate-limited — a full scan can take a while.</div>
    ${confirmAllNotice ? `<div class="tb-warn-box">${confirmAllNotice}</div>` : ""}
    <div id="trendErrBox"></div>
    <button class="tb-submit-btn" id="trendScanBtn">Scan</button>
  `;
  const exBtns = tbTrendingBody.querySelectorAll("#trendExchangeChoice button");
  exBtns.forEach(btn => btn.addEventListener("click", () => {
    exBtns.forEach(b => b.classList.remove("picked", "paper", "live"));
    btn.classList.add("picked", btn.dataset.ex === "MCX" ? "paper" : "live");
    trendState.exchange = btn.dataset.ex;
  }));
  tbTrendingBody.querySelector("#trendScanBtn").addEventListener("click", () => runTrendingScan(false));
}

async function runTrendingScan(confirmAll) {
  const errBox = tbTrendingBody.querySelector("#trendErrBox");
  const scanBtn = tbTrendingBody.querySelector("#trendScanBtn");
  if (errBox) errBox.innerHTML = "";
  if (scanBtn) { scanBtn.disabled = true; scanBtn.textContent = "Scanning..."; }
  const q = (tbTrendingBody.querySelector("#trendQuery") || {}).value || "";
  try {
    const res = await fetch("/api/toolbox/trending/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exchange: trendState.exchange, q, confirmAll }),
    });
    if (!res.body || !res.body.getReader) {
      // Fallback for a browser without streaming reader support — same
      // NDJSON body, just read it all at once and split by hand.
      const text = await res.text();
      handleTrendingStreamEnd(parseNdjsonLines(text), scanBtn);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalData = null;
    let errorData = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        if (evt.type === "progress") {
          if (scanBtn) scanBtn.textContent = `scanning... ${evt.done}/${evt.total} (${evt.underlying})`;
        } else if (evt.type === "result") {
          finalData = evt;
        } else if (evt.type === "error") {
          errorData = evt;
        }
      }
    }
    handleTrendingStreamResult(finalData, errorData, scanBtn);
  } catch (err) {
    if (errBox) errBox.innerHTML = `<div class="tb-err-box">${err.message}</div>`;
    if (scanBtn) { scanBtn.disabled = false; scanBtn.textContent = "Scan"; }
  }
}

function parseNdjsonLines(text) {
  let finalData = null, errorData = null;
  text.split("\n").forEach(line => {
    line = line.trim();
    if (!line) return;
    let evt;
    try { evt = JSON.parse(line); } catch { return; }
    if (evt.type === "result") finalData = evt;
    else if (evt.type === "error") errorData = evt;
  });
  return { finalData, errorData };
}

function handleTrendingStreamEnd({ finalData, errorData }, scanBtn) {
  handleTrendingStreamResult(finalData, errorData, scanBtn);
}

function handleTrendingStreamResult(finalData, errorData, scanBtn) {
  if (errorData) {
    if (errorData.requiresConfirmAll) {
      renderTrendingSetupStep(`${errorData.error} — hit scan again to confirm scanning all ${errorData.total}.`);
      // Clone-and-replace strips the default "scan" listener
      // renderTrendingSetupStep just bound, so only the confirm-all
      // handler below fires — otherwise both would run on click.
      const oldBtn = tbTrendingBody.querySelector("#trendScanBtn");
      const freshBtn = oldBtn.cloneNode(true);
      oldBtn.replaceWith(freshBtn);
      freshBtn.textContent = "Scan all anyway";
      freshBtn.addEventListener("click", () => runTrendingScan(true));
      return;
    }
    const errBox = tbTrendingBody.querySelector("#trendErrBox");
    if (errBox) errBox.innerHTML = `<div class="tb-err-box">${errorData.error}</div>`;
    if (scanBtn) { scanBtn.disabled = false; scanBtn.textContent = "Scan"; }
    return;
  }
  if (finalData) {
    renderTrendingResults(finalData);
  } else {
    const errBox = tbTrendingBody.querySelector("#trendErrBox");
    if (errBox) errBox.innerHTML = `<div class="tb-err-box">Scan ended without a result — check the server log</div>`;
    if (scanBtn) { scanBtn.disabled = false; scanBtn.textContent = "Scan"; }
  }
}

function renderTrendingResults(data) {
  const { scanned, exchange, trending, alreadyRunning } = data;
  let html = `<button class="tb-back-link" id="trendBack">‹ New scan</button>`;
  html += `<div class="tb-form-hint" style="margin-bottom:10px">${scanned} scanned</div>`;

  if (trending.length === 0 && alreadyRunning.length === 0) {
    html += `<div class="tb-form-hint">Nothing trending right now (ADX < 25)</div>`;
  }

  // Split by category (recommended = ADX 25–30, exhausted = ADX > 30) —
  // both groups are still trending and still deployable, this is a
  // caution label on the upper part of that band, not a second filter.
  const recommended = trending.filter(r => r.category === "recommended");
  const exhausted    = trending.filter(r => r.category === "exhausted");

  function renderRow(r) {
    const idx = trending.indexOf(r);
    return `
      <div class="tb-trend-row">
        <div class="info">${r.underlying} <span class="adx">ADX ${r.adxVal.toFixed(1)}</span><br><span style="color:var(--dim);font-size:10px">${r.symbol}</span></div>
        <button class="tb-trend-deploy-btn" data-deploy-idx="${idx}">Deploy</button>
      </div>`;
  }

  if (recommended.length > 0) {
    html += `<div class="tb-trend-group-label">Recommended (ADX 25\u201330) \u2014 not already running</div>`;
    recommended.forEach(r => { html += renderRow(r); });
  }
  if (exhausted.length > 0) {
    html += `<div class="tb-trend-group-label" style="color:var(--yellow,#ffcc4d)">Might be exhausted (ADX &gt; 30) \u2014 not already running</div>`;
    exhausted.forEach(r => { html += renderRow(r); });
  }
  if (alreadyRunning.length > 0) {
    html += `<div class="tb-trend-group-label">Trending but already running</div>`;
    alreadyRunning.forEach(r => {
      const tag = r.category === "exhausted" ? ` <span style="color:var(--yellow,#ffcc4d);font-size:9.5px">(might be exhausted)</span>` : "";
      html += `
        <div class="tb-trend-row dimmed">
          <div class="info">${r.underlying} <span class="adx">ADX ${r.adxVal.toFixed(1)}</span>${tag}<br><span style="color:var(--dim);font-size:10px">${(r.runningAs || []).join(", ")}</span></div>
        </div>`;
    });
  }

  tbTrendingBody.innerHTML = html;
  tbTrendingBody.querySelector("#trendBack").addEventListener("click", renderTrendingSetupStep);
  tbTrendingBody.querySelectorAll("[data-deploy-idx]").forEach(btn => {
    btn.addEventListener("click", () => {
      const pick = trending[Number(btn.dataset.deployIdx)];
      tbTrendingModal.classList.remove("open");
      // Reuses the Add Instrument flow, pre-filled — same start path
      // (POST /api/toolbox/instrument), not a second implementation.
      addState = { exchange };
      tbAddModal.classList.add("open");
      selectAddUnderlying(pick.underlying);
    });
  });
}

// ── market status modal ──────────────────────────────────────────────────
const tbMarketModal = document.getElementById("tbMarketModal");
const tbMarketBody = document.getElementById("tbMarketBody");
const tbMarketClose = document.getElementById("tbMarketClose");
document.getElementById("tbOpenMarketStatus").addEventListener("click", openMarketModal);
tbMarketClose.addEventListener("click", () => tbMarketModal.classList.remove("open"));
tbMarketModal.addEventListener("click", e => { if (e.target === tbMarketModal) tbMarketModal.classList.remove("open"); });

function stateClass(state) {
  if (state === "TRENDING" || state === "BREAKOUT") return "trend";
  if (state === "RANGING") return "range";
  if (state === "HIGH_VOLATILITY") return "vol";
  return "unk";
}

async function openMarketModal() {
  tbMarketBody.innerHTML = `<div class="tb-form-hint">Loading...</div>`;
  tbMarketModal.classList.add("open");
  await loadMarketStatus();
}

async function loadMarketStatus() {
  try {
    const [entries, scannerStatus] = await Promise.all([
      (await fetch("/api/toolbox/watchlist")).json(),
      (await fetch("/api/toolbox/scanner/status")).json(),
    ]);

    let html = `
      <div class="tb-scanner-bar">
        <span><span class="dot ${scannerStatus.running ? "on" : "off"}"></span>scanner ${scannerStatus.running ? "running" : "stopped"}</span>
        <span>
          <button id="marketScannerToggle">${scannerStatus.running ? "stop" : "start"} scanner</button>
        </span>
      </div>
      <div class="tb-search-row" style="margin-bottom:10px">
        <input type="text" id="marketAddInput" placeholder="add underlying to watchlist...">
        <button id="marketAddBtn">Add</button>
      </div>
      <div id="marketAddHint" class="tb-form-hint"></div>
      <div id="marketAddPickList" class="tb-pick-list"></div>
    `;

    if (entries.length === 0) {
      html += `<div class="tb-form-hint">Watchlist is empty — add an instrument above</div>`;
    } else {
      entries.forEach(e => {
        const p = e.profile;
        const cls = stateClass(p.structure.state);
        const updated = p.updatedAt ? new Date(p.updatedAt).toLocaleTimeString([], { hour12: false }) : (p.unavailableReason || "No data");
        html += `
          <div class="tb-watch-row">
            <div class="tb-watch-main">
              <div class="tb-watch-inst">${e.underlying} <span style="color:var(--dim);font-size:10px">(${e.exchange})</span></div>
              <div class="tb-watch-meta">conf ${p.confidence != null ? p.confidence + "%" : "-"} · trend ${p.trend.direction}${p.trend.score != null ? " " + p.trend.score : ""} · vol ${p.volatility.state}${p.volatility.score != null ? " " + p.volatility.score : ""} · ${updated}</div>
            </div>
            <span class="tb-watch-state ${cls}">${p.structure.state}</span>
            <button class="tb-watch-remove" data-remove="${e.underlying}" title="remove">✕</button>
          </div>`;
      });
    }

    tbMarketBody.innerHTML = html;

    tbMarketBody.querySelector("#marketScannerToggle").addEventListener("click", async () => {
      const btn = tbMarketBody.querySelector("#marketScannerToggle");
      btn.disabled = true;
      try {
        await fetch(`/api/toolbox/scanner/${scannerStatus.running ? "stop" : "start"}`, { method: "POST" });
        await loadMarketStatus();
      } catch (err) {
        btn.disabled = false;
      }
    });

    tbMarketBody.querySelectorAll("[data-remove]").forEach(btn => {
      btn.addEventListener("click", async () => {
        await fetch(`/api/toolbox/watchlist/${encodeURIComponent(btn.dataset.remove)}`, { method: "DELETE" });
        loadMarketStatus();
      });
    });

    const addInput = tbMarketBody.querySelector("#marketAddInput");
    const addHint = tbMarketBody.querySelector("#marketAddHint");
    const addPickList = tbMarketBody.querySelector("#marketAddPickList");
    async function runMarketSearch() {
      addHint.textContent = "Searching...";
      addPickList.innerHTML = "";
      try {
        const q = addInput.value.trim();
        if (!q) { addHint.textContent = ""; return; }
        const data = await (await fetch(`/api/toolbox/instruments?exchange=MCX&q=${encodeURIComponent(q)}`)).json();
        const nse = await (await fetch(`/api/toolbox/instruments?exchange=NSE&q=${encodeURIComponent(q)}`)).json();
        const combined = [
          ...(data.matches || []).map(u => ({ underlying: u, exchange: "MCX" })),
          ...(nse.matches || []).map(u => ({ underlying: u, exchange: "NSE" })),
        ];
        if (combined.length === 0) { addHint.textContent = "No matches"; return; }
        addHint.textContent = `${combined.length} match(es)`;
        combined.slice(0, 30).forEach(m => {
          const btn = document.createElement("button");
          btn.className = "tb-pick-item";
          btn.textContent = `${m.underlying} (${m.exchange})`;
          btn.addEventListener("click", async () => {
            await fetch("/api/toolbox/watchlist", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ underlying: m.underlying, exchange: m.exchange }),
            });
            loadMarketStatus();
          });
          addPickList.appendChild(btn);
        });
      } catch (err) {
        addHint.textContent = `search failed: ${err.message}`;
      }
    }
    tbMarketBody.querySelector("#marketAddBtn").addEventListener("click", runMarketSearch);
    addInput.addEventListener("keydown", e => { if (e.key === "Enter") runMarketSearch(); });
  } catch (err) {
    tbMarketBody.innerHTML = `<div class="tb-err-box">failed to load: ${err.message}</div>`;
  }
}

// ── roll contract modal ──────────────────────────────────────────────────
const tbRollModal = document.getElementById("tbRollModal");
const tbRollBody = document.getElementById("tbRollBody");
const tbRollClose = document.getElementById("tbRollClose");
document.getElementById("tbOpenRoll").addEventListener("click", openRollModal);
tbRollClose.addEventListener("click", () => tbRollModal.classList.remove("open"));
tbRollModal.addEventListener("click", e => { if (e.target === tbRollModal) tbRollModal.classList.remove("open"); });

async function openRollModal() {
  tbRollBody.innerHTML = `<div class="tb-form-hint">Loading...</div>`;
  tbRollModal.classList.add("open");
  await renderRollPickStep();
}

let rollPickFilter = "all"; // persists across re-renders within one modal open (e.g. after a manual-entry back-navigation)

// Categorizes a candidate purely from its `labels` strings (no extra
// server round trip needed — /api/toolbox/roll/candidates already tags
// each label with "(core leg)"/"(hedge leg)" for hedge pairs and
// "(dual hedge)"/"(gap capture)" for the two dual-account engines, see
// that route's own comment for why). Dual Hedge and Gap Capture share one
// tab ("dual hedge") since they're the same "two Kite logins, same
// underlying" shape — just a different entry trigger — rather than
// splitting into a 3rd tab for an engine that has no deploy UI here yet.
function rollCandidateCategory(c) {
  const isPair = c.labels.some(l => /\(core leg\)|\(hedge leg\)/.test(l));
  const isDual = c.labels.some(l => /\(dual hedge\)/.test(l));
  if (isPair) return "hedgepair";
  if (isDual) return "dualhedge";
  return "engine";
}

async function renderRollPickStep() {
  tbRollBody.innerHTML = `<div class="tb-form-hint">Loading...</div>`;
  try {
    const candidates = await (await fetch("/api/toolbox/roll/candidates")).json();
    const categorized = candidates.map(c => ({ ...c, category: rollCandidateCategory(c) }));
    const counts = {
      all: categorized.length,
      engine: categorized.filter(c => c.category === "engine").length,
      hedgepair: categorized.filter(c => c.category === "hedgepair").length,
      dualhedge: categorized.filter(c => c.category === "dualhedge").length,
    };
    const tabs = [["all", "all"], ["engine", "engines"], ["hedgepair", "hedge pairs"], ["dualhedge", "dual hedge"]];

    let html = `<div class="tb-warn-box">⚠ roll contract only applies to MCX futures — NSE equities don't expire, so they're left out of this list.</div>`;
    html += `<div class="tb-roll-tabbar">`;
    tabs.forEach(([key, label]) => {
      html += `<button class="tb-roll-tab${rollPickFilter === key ? " active" : ""}" data-roll-filter="${key}">${label} (${counts[key]})</button>`;
    });
    html += `</div>`;

    const shown = categorized.filter(c => rollPickFilter === "all" || c.category === rollPickFilter);
    if (shown.length === 0) {
      html += `<div class="tb-form-hint">${candidates.length === 0 ? "no running MCX instruments to roll" : "none in this category"}</div>`;
    } else {
      html += `<div class="tb-form-label" style="margin-bottom:8px">Select underlying to roll</div>`;
      shown.forEach(c => {
        html += `<button class="tb-pick-item" data-roll-underlying="${c.underlying}" style="width:100%;text-align:left;margin-bottom:6px">${c.underlying} <span style="color:var(--dim);font-size:10px">— used by: ${c.labels.join(", ")}</span></button>`;
      });
    }
    tbRollBody.innerHTML = html;
    tbRollBody.querySelectorAll("[data-roll-filter]").forEach(btn => {
      btn.addEventListener("click", () => { rollPickFilter = btn.dataset.rollFilter; renderRollPickStep(); });
    });
    tbRollBody.querySelectorAll("[data-roll-underlying]").forEach(btn => {
      btn.addEventListener("click", () => renderRollPreviewStep(btn.dataset.rollUnderlying));
    });
  } catch (err) {
    tbRollBody.innerHTML = `<div class="tb-err-box">${err.message}</div>`;
  }
}

async function renderRollPreviewStep(underlying) {
  tbRollBody.innerHTML = `<div class="tb-form-hint">Resolving...</div>`;
  try {
    const preview = await (await fetch(`/api/toolbox/roll/preview/${encodeURIComponent(underlying)}`)).json();
    if (preview.error) {
      tbRollBody.innerHTML = `
        <button class="tb-back-link" id="rollBackErr">‹ Back</button>
        <div class="tb-err-box">${preview.error}</div>`;
      tbRollBody.querySelector("#rollBackErr").addEventListener("click", renderRollPickStep);
      return;
    }
    renderRollConfirmStep(preview);
  } catch (err) {
    tbRollBody.innerHTML = `<div class="tb-err-box">${err.message}</div>`;
  }
}

function renderRollConfirmStep(preview) {
  const { underlying, current, next, manualEntryNeeded, siblings } = preview;
  let html = `
    <button class="tb-back-link" id="rollBack2">‹ Back to instrument list</button>
    <div class="tb-warn-box">⚠ MCX futures only — this instrument is confirmed MCX.</div>
    <div class="tb-resolved-box">
      <div>Instrument: <span class="sym">${underlying}</span></div>
      <div>current: ${current.symbol} (token ${current.token}, lot ${current.lotSize})</div>
      <div>next: ${manualEntryNeeded ? '<span style="color:var(--yellow,#ffcc4d)">Not found in instrument dump</span>' : `${next.symbol} (token ${next.token}, lot ${next.lotSize})`}</div>
    </div>
  `;

  if (manualEntryNeeded) {
    html += `
      <div class="tb-warn-box">⚠ next contract not found in the local instrument dump — enter it manually.</div>
      <div class="tb-form-row"><div class="tb-form-label">New symbol</div><input type="text" id="rollManualSymbol"></div>
      <div class="tb-form-row"><div class="tb-form-label">New token</div><input type="number" id="rollManualToken"></div>
      <div class="tb-form-row"><div class="tb-form-label">new lot size (blank = same as current, ${current.lotSize})</div><input type="number" id="rollManualLot" placeholder="${current.lotSize}"></div>
    `;
  }

  if (siblings.length > 1) {
    html += `<div class="tb-warn-box">⚠ ${siblings.length} processes run ${underlying} (${siblings.map(s => s.strategy).join(", ")}) — all of them need to restart together, or they'll end up split across two different contracts. This applies to all of them, not just the one you picked.</div>`;
  }

  html += `
    <label class="tb-form-row-inline" style="margin-bottom:14px"><input type="checkbox" id="rollRestartNow" checked><span>restart engine${siblings.length > 1 ? "s" : ""} immediately after saving the pin</span></label>
    <div id="rollErrBox"></div>
    <div id="rollResultBox"></div>
    <button class="tb-submit-btn" id="rollApplyBtn">Apply roll</button>
  `;

  tbRollBody.innerHTML = html;
  tbRollBody.querySelector("#rollBack2").addEventListener("click", renderRollPickStep);

  tbRollBody.querySelector("#rollApplyBtn").addEventListener("click", async () => {
    const errBox = tbRollBody.querySelector("#rollErrBox");
    const resultBox = tbRollBody.querySelector("#rollResultBox");
    errBox.innerHTML = "";
    resultBox.innerHTML = "";
    const btn = tbRollBody.querySelector("#rollApplyBtn");

    let manualEntry;
    if (manualEntryNeeded) {
      const symbol = tbRollBody.querySelector("#rollManualSymbol").value.trim();
      const token = tbRollBody.querySelector("#rollManualToken").value;
      const lotSize = tbRollBody.querySelector("#rollManualLot").value;
      if (!symbol || !token) {
        errBox.innerHTML = `<div class="tb-err-box">Symbol and token are required for a manual entry</div>`;
        return;
      }
      manualEntry = { symbol, token, lotSize: lotSize || undefined };
    }

    btn.disabled = true;
    btn.textContent = "Applying...";
    try {
      const res = await fetch("/api/toolbox/roll/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          underlying,
          manualEntry,
          restart: tbRollBody.querySelector("#rollRestartNow").checked,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        errBox.innerHTML = `<div class="tb-err-box">${data.error || "Roll failed"}</div>`;
        btn.disabled = false;
        btn.textContent = "Apply roll";
        return;
      }
      let resultHtml = `<div class="tb-form-hint">rolled ${data.oldSymbol} → ${data.newSymbol}${data.manual ? " (manual pin)" : ""}</div>`;
      if (data.restarted && data.restarted.length) resultHtml += `<div class="tb-form-hint">restarted: ${data.restarted.join(", ")}</div>`;
      if (data.restartFailed && data.restartFailed.length) resultHtml += `<div class="tb-err-box">restart failed: ${data.restartFailed.map(f => `${f.name} (${f.error})`).join(", ")}</div>`;
      if (data.note) resultHtml += `<div class="tb-warn-box">${data.note}</div>`;
      resultBox.innerHTML = resultHtml;
      btn.style.display = "none";
      loadToolboxList();
    } catch (err) {
      errBox.innerHTML = `<div class="tb-err-box">${err.message}</div>`;
      btn.disabled = false;
      btn.textContent = "Apply roll";
    }
  });
}

// ── hedge pairs modal ─────────────────────────────────────────────────────
const tbHedgePairsModal = document.getElementById("tbHedgePairsModal");
const tbHedgePairsBody  = document.getElementById("tbHedgePairsBody");
const tbHedgePairsClose = document.getElementById("tbHedgePairsClose");
document.getElementById("tbOpenHedgePairs").addEventListener("click", openHedgePairsModal);
tbHedgePairsClose.addEventListener("click", () => tbHedgePairsModal.classList.remove("open"));
tbHedgePairsModal.addEventListener("click", e => { if (e.target === tbHedgePairsModal) tbHedgePairsModal.classList.remove("open"); });

let hpAddState = null; // null = showing the list; {} once "add" is opened, accumulates core/hedge picks

async function openHedgePairsModal() {
  hpAddState = null;
  tbHedgePairsBody.innerHTML = `<div class="tb-form-hint">Loading...</div>`;
  tbHedgePairsModal.classList.add("open");
  await loadHedgePairsList();
}

async function loadHedgePairsList() {
  try {
    const { pairs } = await (await fetch("/api/toolbox/hedgepairs")).json();

    let html = `<div style="display:flex;gap:8px;margin-bottom:10px"><button class="tb-cli-action" id="hpAddBtn">+ Add hedge pair</button><button class="tb-cli-action" id="hpBacktestBtn">Backtest</button></div>`;

    if (pairs.length === 0) {
      html += `<div class="tb-form-hint">None running yet</div>`;
    } else {
      pairs.forEach(p => {
        const modeTag = p.live ? `<span style="color:var(--red,#f0616d)">LIVE</span>` : `<span style="color:var(--dim)">PAPER</span>`;
        html += `
          <div class="tb-watch-row">
            <div class="tb-watch-main">
              <div class="tb-watch-inst">${p.name}</div>
              <div class="tb-watch-meta">core ${p.coreUnderlying} (${p.coreLots} lot) \u00b7 hedge ${p.hedgeUnderlying} (${p.hedgeLots} lots) \u00b7 unwind:${p.unwindMode} \u00b7 ${modeTag} \u00b7 [${p.status}]</div>
            </div>
            <button class="tb-cli-action" data-hp-logs="${p.name}" style="padding:4px 8px;font-size:11px">Logs</button>
            <button class="tb-cli-action" data-hp-toggle="${p.name}" data-hp-status="${p.status}" style="padding:4px 8px;font-size:11px">${p.status === "online" ? "stop" : "start"}</button>
            <button class="tb-watch-remove" data-hp-remove="${p.name}" title="remove">\u2715</button>
          </div>`;
      });
    }

    tbHedgePairsBody.innerHTML = html;
    tbHedgePairsBody.querySelector("#hpAddBtn").addEventListener("click", () => { hpAddState = { mode: "deploy" }; renderHedgePairAddCorePicker(); });
    tbHedgePairsBody.querySelector("#hpBacktestBtn").addEventListener("click", () => { hpAddState = { mode: "backtest" }; renderHedgePairAddCorePicker(); });

    tbHedgePairsBody.querySelectorAll("[data-hp-toggle]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const name = btn.dataset.hpToggle;
        const startingNow = btn.dataset.hpStatus !== "online";
        btn.disabled = true;
        try {
          await fetch(`/api/toolbox/hedgepairs/${startingNow ? "start" : "stop"}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
          });
          loadHedgePairsList();
        } catch (err) { btn.disabled = false; }
      });
    });
    tbHedgePairsBody.querySelectorAll("[data-hp-remove]").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm(`Remove ${btn.dataset.hpRemove}? This stops and deletes the PM2 process.`)) return;
        await fetch(`/api/toolbox/hedgepairs/${encodeURIComponent(btn.dataset.hpRemove)}`, { method: "DELETE" });
        loadHedgePairsList();
      });
    });
    tbHedgePairsBody.querySelectorAll("[data-hp-logs]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const data = await (await fetch(`/api/toolbox/hedgepairs/logs/${encodeURIComponent(btn.dataset.hpLogs)}`)).json();
        tbLogsTitle.textContent = btn.dataset.hpLogs;
        tbLogsBody.innerHTML = `<div class="tb-log-pane"><div class="tb-log-label">Stdout</div><pre>${(data.out || []).join("\n") || "(empty)"}</pre></div><div class="tb-log-pane"><div class="tb-log-label">Stderr</div><pre>${(data.err || []).join("\n") || "(empty)"}</pre></div>`;
        tbLogsModal.classList.add("open");
      });
    });
  } catch (err) {
    tbHedgePairsBody.innerHTML = `<div class="tb-err-box">failed to load: ${err.message}</div>`;
  }
}

// Reuses the SAME search endpoint Add Instrument/Market Status use
// (/api/toolbox/instruments?exchange=MCX&q=) — no new search endpoint,
// core and hedge are both just MCX underlyings picked from the real dump.
function renderHedgePairSearchStep(label, onPick) {
  tbHedgePairsBody.innerHTML = `
    <button class="tb-back-link" id="hpBack">\u2039 back</button>
    <div class="tb-form-hint" style="margin:8px 0">${label}</div>
    <div class="tb-search-row">
      <input type="text" id="hpSearchInput" placeholder="search underlying...">
      <button id="hpSearchBtn">Search</button>
    </div>
    <div id="hpSearchHint" class="tb-form-hint"></div>
    <div id="hpSearchPickList" class="tb-pick-list"></div>
  `;
  tbHedgePairsBody.querySelector("#hpBack").addEventListener("click", () => {
    if (hpAddState.core) { hpAddState = { mode: hpAddState.mode }; renderHedgePairAddCorePicker(); }
    else { hpAddState = null; loadHedgePairsList(); }
  });
  const input = tbHedgePairsBody.querySelector("#hpSearchInput");
  const hint  = tbHedgePairsBody.querySelector("#hpSearchHint");
  const list  = tbHedgePairsBody.querySelector("#hpSearchPickList");
  async function runSearch() {
    const q = input.value.trim();
    hint.textContent = "Searching...";
    list.innerHTML = "";
    try {
      const data = await (await fetch(`/api/toolbox/instruments?exchange=MCX&q=${encodeURIComponent(q)}`)).json();
      const matches = data.matches || [];
      if (matches.length === 0) { hint.textContent = "No matches"; return; }
      hint.textContent = `${matches.length} match(es)`;
      matches.slice(0, 30).forEach(u => {
        const btn = document.createElement("button");
        btn.className = "tb-pick-item";
        btn.textContent = u;
        btn.addEventListener("click", () => onPick(u));
        list.appendChild(btn);
      });
    } catch (err) {
      hint.textContent = `search failed: ${err.message}`;
    }
  }
  tbHedgePairsBody.querySelector("#hpSearchBtn").addEventListener("click", runSearch);
  input.addEventListener("keydown", e => { if (e.key === "Enter") runSearch(); });
}

function renderHedgePairAddCorePicker() {
  renderHedgePairSearchStep("core underlying (full-size contract, e.g. NATURALGAS, ZINC)", u => {
    hpAddState.core = u;
    renderHedgePairAddHedgePicker();
  });
}
function renderHedgePairAddHedgePicker() {
  renderHedgePairSearchStep("hedge underlying (mini contract, e.g. NATGASMINI, ZINCMINI)", u => {
    hpAddState.hedge = u;
    (hpAddState.mode === "backtest" ? renderHedgePairBacktestForm : renderHedgePairAddForm)();
  });
}

async function renderHedgePairAddForm() {
  const [coreLm, hedgeLm] = await Promise.all([
    (await fetch(`/api/toolbox/hedgepairs/lotmult/${encodeURIComponent(hpAddState.core)}`)).json().catch(() => ({})),
    (await fetch(`/api/toolbox/hedgepairs/lotmult/${encodeURIComponent(hpAddState.hedge)}`)).json().catch(() => ({})),
  ]);

  tbHedgePairsBody.innerHTML = `
    <button class="tb-back-link" id="hpBack">\u2039 back</button>
    <div class="tb-form-hint" style="margin:8px 0">Core: <b>${hpAddState.core}</b> (1 lot NRML, daily-HA bias, EOD-only exit)<br>Hedge: <b>${hpAddState.hedge}</b> (opens on adverse 1h HA against the core)</div>

    <div class="tb-form-row">
      <div class="tb-form-label">Core lots (default 1)</div>
      <input type="number" id="hpCoreLots" min="1" step="1" value="1">
    </div>
    <div class="tb-form-row">
      <div class="tb-form-label">Hedge lots (default 5 \u2014 the real 5:1 contract ratio for both supported pairs)</div>
      <input type="number" id="hpHedgeLots" min="1" step="1" value="5">
    </div>
    <div class="tb-form-row" style="display:${coreLm.lotMultRequired ? "" : "none"}">
      <div class="tb-form-label">core lot multiplier \u2014 REQUIRED, no context.js override on file for ${hpAddState.core}. Real contract multiplier, not broker lot_size.</div>
      <input type="number" id="hpCoreLotMult" min="1" step="any">
    </div>
    <div class="tb-form-row" style="display:${hedgeLm.lotMultRequired ? "" : "none"}">
      <div class="tb-form-label">hedge lot multiplier \u2014 REQUIRED, no context.js override on file for ${hpAddState.hedge}. Real contract multiplier, not broker lot_size.</div>
      <input type="number" id="hpHedgeLotMult" min="1" step="any">
    </div>
    <div class="tb-form-row">
      <div class="tb-form-label">Unwind mode</div>
      <select id="hpUnwindMode">
        <option value="HA_FLIP" selected>HA_FLIP \u2014 hedge closes when 1h HA flips back in the core's favor</option>
        <option value="EOD_ONLY">EOD_ONLY \u2014 hedge stays on till EOD regardless of 1h HA</option>
      </select>
    </div>
    <div class="tb-form-row">
      <label class="tb-form-row-inline"><input type="checkbox" id="hpLive"><span>Go LIVE (real orders on both legs) \u2014 unchecked = paper</span></label>
    </div>
    <div id="hpAddErrBox"></div>
    <button class="tb-submit-btn" id="hpAddSubmit">Start hedge pair</button>
  `;

  tbHedgePairsBody.querySelector("#hpBack").addEventListener("click", renderHedgePairAddHedgePicker);

  tbHedgePairsBody.querySelector("#hpAddSubmit").addEventListener("click", async () => {
    const errBox = tbHedgePairsBody.querySelector("#hpAddErrBox");
    const live = tbHedgePairsBody.querySelector("#hpLive").checked;
    let confirmLive;
    if (live) {
      confirmLive = prompt('This starts REAL orders on BOTH legs. Type "LIVE" to confirm:');
      if (confirmLive !== "LIVE") { errBox.innerHTML = `<div class="tb-err-box">Not confirmed \u2014 not started</div>`; return; }
    }
    const body = {
      coreUnderlying: hpAddState.core, hedgeUnderlying: hpAddState.hedge,
      coreLots: tbHedgePairsBody.querySelector("#hpCoreLots").value || 1,
      hedgeLots: tbHedgePairsBody.querySelector("#hpHedgeLots").value || 5,
      coreLotMultOverride: tbHedgePairsBody.querySelector("#hpCoreLotMult")?.value || undefined,
      hedgeLotMultOverride: tbHedgePairsBody.querySelector("#hpHedgeLotMult")?.value || undefined,
      unwindMode: tbHedgePairsBody.querySelector("#hpUnwindMode").value,
      live, confirmLive,
    };
    const btn = tbHedgePairsBody.querySelector("#hpAddSubmit");
    btn.disabled = true; btn.textContent = "Starting...";
    try {
      const res = await fetch("/api/toolbox/hedgepairs", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        errBox.innerHTML = `<div class="tb-err-box">${data.error || "Failed to start"}</div>`;
        btn.disabled = false; btn.textContent = "Start hedge pair";
        return;
      }
      hpAddState = null;
      loadHedgePairsList();
    } catch (err) {
      errBox.innerHTML = `<div class="tb-err-box">${err.message}</div>`;
      btn.disabled = false; btn.textContent = "Start hedge pair";
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════
// DUAL HEDGE — two SEPARATE Kite accounts, one LONG-only, one SHORT-only,
// same instrument/band signal. NOT the same as Hedge Pairs above (one
// account, two instruments) — see dualHedgeEngine.js's own header. Mirrors
// the Hedge Pairs modal's shape (list / add flow / logs), with one real
// difference: hedge pairs picks core+hedge UNDERLYINGS via live search;
// dual hedge picks ONE underlying that way, but LONG/SHORT are picked from
// a short, bounded list of pre-configured accounts (dropdowns, not
// search) — plus its own Users sub-view for managing those accounts.
const tbDualHedgeModal = document.getElementById("tbDualHedgeModal");
const tbDualHedgeBody  = document.getElementById("tbDualHedgeBody");
const tbDualHedgeClose = document.getElementById("tbDualHedgeClose");
document.getElementById("tbOpenDualHedge").addEventListener("click", openDualHedgeModal);
tbDualHedgeClose.addEventListener("click", () => tbDualHedgeModal.classList.remove("open"));
tbDualHedgeModal.addEventListener("click", e => { if (e.target === tbDualHedgeModal) tbDualHedgeModal.classList.remove("open"); });

let dhAddState = null; // null = showing the list; {} once "add" is opened, accumulates {underlying}

async function openDualHedgeModal() {
  dhAddState = null;
  tbDualHedgeBody.innerHTML = `<div class="tb-form-hint">Loading...</div>`;
  tbDualHedgeModal.classList.add("open");
  await loadDualHedgeList();
}

async function loadDualHedgeList() {
  try {
    const { deployments } = await (await fetch("/api/toolbox/dualhedge")).json();

    let html = `<div style="display:flex;gap:8px;margin-bottom:10px">
      <button class="tb-cli-action" id="dhAddBtn">+ Add deployment</button>
      <button class="tb-cli-action" id="dhBacktestBtn">Backtest</button>
      <button class="tb-cli-action" id="dhUsersBtn">Manage users</button>
    </div>`;

    if (deployments.length === 0) {
      html += `<div class="tb-form-hint">None running yet \u2014 add accounts under "manage users" first, then a deployment</div>`;
    } else {
      deployments.forEach(d => {
        const modeTag = d.live ? `<span style="color:var(--red,#f0616d)">LIVE</span>` : `<span style="color:var(--dim)">PAPER</span>`;
        html += `
          <div class="tb-watch-row">
            <div class="tb-watch-main">
              <div class="tb-watch-inst">${d.name}</div>
              <div class="tb-watch-meta">${d.underlying} \u00b7 LONG:${d.longUser} \u00b7 SHORT:${d.shortUser} \u00b7 ${d.lots} lot \u00b7 ${dualHedgeStrategyText(d)} \u00b7 ${modeTag} \u00b7 [${d.status}]</div>
            </div>
            <button class="tb-cli-action" data-dh-logs="${d.name}" style="padding:4px 8px;font-size:11px">Logs</button>
            <button class="tb-cli-action" data-dh-toggle="${d.name}" data-dh-status="${d.status}" style="padding:4px 8px;font-size:11px">${d.status === "online" ? "stop" : "start"}</button>
            <button class="tb-watch-remove" data-dh-remove="${d.name}" title="remove">\u2715</button>
          </div>`;
      });
    }

    tbDualHedgeBody.innerHTML = html;
    tbDualHedgeBody.querySelector("#dhAddBtn").addEventListener("click", () => { dhAddState = { mode: "deploy" }; renderDualHedgeAddUnderlyingPicker(); });
    tbDualHedgeBody.querySelector("#dhBacktestBtn").addEventListener("click", () => { dhAddState = { mode: "backtest" }; renderDualHedgeAddUnderlyingPicker(); });
    tbDualHedgeBody.querySelector("#dhUsersBtn").addEventListener("click", renderDualHedgeUsers);

    tbDualHedgeBody.querySelectorAll("[data-dh-toggle]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const name = btn.dataset.dhToggle;
        const startingNow = btn.dataset.dhStatus !== "online";
        btn.disabled = true;
        try {
          await fetch(`/api/toolbox/dualhedge/${startingNow ? "start" : "stop"}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
          });
          loadDualHedgeList();
        } catch (err) { btn.disabled = false; }
      });
    });
    tbDualHedgeBody.querySelectorAll("[data-dh-remove]").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm(`Remove ${btn.dataset.dhRemove}? This stops and deletes the PM2 process.`)) return;
        await fetch(`/api/toolbox/dualhedge/${encodeURIComponent(btn.dataset.dhRemove)}`, { method: "DELETE" });
        loadDualHedgeList();
      });
    });
    tbDualHedgeBody.querySelectorAll("[data-dh-logs]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const data = await (await fetch(`/api/toolbox/dualhedge/logs/${encodeURIComponent(btn.dataset.dhLogs)}`)).json();
        tbLogsTitle.textContent = btn.dataset.dhLogs;
        tbLogsBody.innerHTML = `<div class="tb-log-pane"><div class="tb-log-label">Stdout</div><pre>${(data.out || []).join("\n") || "(empty)"}</pre></div><div class="tb-log-pane"><div class="tb-log-label">Stderr</div><pre>${(data.err || []).join("\n") || "(empty)"}</pre></div>`;
        tbLogsModal.classList.add("open");
      });
    });
  } catch (err) {
    tbDualHedgeBody.innerHTML = `<div class="tb-err-box">failed to load: ${err.message}</div>`;
  }
}

// ─── Users sub-view — named Kite accounts (dualHedgeUsers.js), separate
// from the app's own single global account under "setup credentials".
// Token generation itself now also lives in the header's unified token
// panel (see app.js's refreshTokenStatus()/tokenAccountDescriptor()) —
// this view is still the place to ADD/REMOVE accounts and stays usable
// for generating a token too (same underlying endpoints), just not the
// only place anymore.
async function renderDualHedgeUsers() {
  tbDualHedgeBody.innerHTML = `<div class="tb-form-hint">Loading...</div>`;
  try {
    const { users } = await (await fetch("/api/toolbox/dualhedge/users")).json();
    let html = `<button class="tb-back-link" id="dhUsersBack">\u2039 back</button>
      <div class="tb-form-hint" style="margin:8px 0">Each account here is a SEPARATE Kite login \u2014 not the same as this app's own "setup credentials" account. Tokens can also be generated from the header's token panel.</div>`;

    if (users.length === 0) {
      html += `<div class="tb-form-hint">None yet</div>`;
    } else {
      users.forEach(u => {
        // "generate token" is a real <a> link (href set right after render,
        // below) so tapping it is a normal link tap \u2014 works on mobile,
        // no popup-blocker issues \u2014 same pattern as the header's own
        // unified token panel (see app.js's refreshTokenStatus()). The
        // paste-back panel underneath is the fallback/second half of that
        // same flow: Kite redirects back with a request_token this
        // account's OWN Kite app may or may not be registered to capture
        // automatically, so pasting it (or the whole redirect URL) always
        // works regardless of that registration.
        const tokenStatus = !u.hasAccessToken ? "none" : (u.tokenFresh ? "fresh" : `stale (${u.accessTokenDate || "?"})`);
        html += `
          <div class="tb-watch-row">
            <div class="tb-watch-main">
              <div class="tb-watch-inst">${u.name}</div>
              <div class="tb-watch-meta">key:${u.hasApiKey ? "set" : "MISSING"} \u00b7 secret:${u.hasApiSecret ? "set" : "MISSING"} \u00b7 token:${tokenStatus}</div>
            </div>
            <a class="tb-cli-action" id="dhTokenLink-${u.name}" data-dh-token-toggle="${u.name}" href="#" target="_blank" rel="noopener" style="padding:4px 8px;font-size:11px;text-decoration:none">Generate token</a>
            <button class="tb-watch-remove" data-dh-user-remove="${u.name}" title="remove">\u2715</button>
          </div>
          <div class="tb-form-hint" id="dhTokenPanel-${u.name}" style="display:none;margin:4px 0 12px 4px">
            <div style="margin-bottom:4px">after logging in as ${u.name}, paste the request_token (or the full redirect URL) here:</div>
            <div class="tb-search-row">
              <input type="text" id="dhTokenInput-${u.name}" placeholder="request_token or redirect URL">
              <button data-dh-token-exchange="${u.name}">Exchange</button>
            </div>
            <div id="dhTokenErr-${u.name}"></div>
          </div>`;
      });
    }

    html += `
      <div class="tb-form-hint" style="margin:14px 0 6px"><b>Add a user</b></div>
      <div class="tb-form-row"><div class="tb-form-label">Name (a label, e.g. a family member's name)</div><input type="text" id="dhUserName"></div>
      <div class="tb-form-row"><div class="tb-form-label">Kite API key</div><input type="text" id="dhUserApiKey"></div>
      <div class="tb-form-row"><div class="tb-form-label">Kite API secret</div><input type="password" id="dhUserApiSecret"></div>
      <div id="dhUserAddErrBox"></div>
      <button class="tb-submit-btn" id="dhUserAddSubmit">Save user</button>
    `;

    tbDualHedgeBody.innerHTML = html;
    tbDualHedgeBody.querySelector("#dhUsersBack").addEventListener("click", loadDualHedgeList);

    // Pre-fetch each configured user's login URL and set it as the link's
    // href BEFORE any click happens (getLoginURL() is a pure local string
    // build server-side, no Kite network call, so this is cheap to do for
    // everyone up front) \u2014 exactly why the header's own unified token
    // panel does the same in refreshTokenStatus() rather than fetching on
    // click: the href has to already be real by the time the browser
    // evaluates the anchor click, or the popup-blocker-safe "just a normal
    // link" property is lost.
    users.filter(u => u.hasApiKey).forEach(async u => {
      try {
        const data = await (await fetch(`/api/toolbox/dualhedge/users/${encodeURIComponent(u.name)}/login-url`)).json();
        const link = tbDualHedgeBody.querySelector(`#dhTokenLink-${CSS.escape(u.name)}`);
        if (data.url && link) link.href = data.url;
      } catch { /* leave href as "#" \u2014 click will just toggle the paste panel, still usable */ }
    });

    tbDualHedgeBody.querySelectorAll("[data-dh-token-toggle]").forEach(link => {
      link.addEventListener("click", () => {
        // Real navigation to Kite's login page happens via the href itself
        // (target="_blank") \u2014 this handler's only job is to also reveal
        // the paste-back panel for when they come back with a token.
        const panel = tbDualHedgeBody.querySelector(`#dhTokenPanel-${CSS.escape(link.dataset.dhTokenToggle)}`);
        if (panel) panel.style.display = panel.style.display === "none" ? "" : "none";
      });
    });
    tbDualHedgeBody.querySelectorAll("[data-dh-token-exchange]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const name = btn.dataset.dhTokenExchange;
        const input = tbDualHedgeBody.querySelector(`#dhTokenInput-${CSS.escape(name)}`);
        const errBox = tbDualHedgeBody.querySelector(`#dhTokenErr-${CSS.escape(name)}`);
        const val = input.value.trim();
        if (!val) return;
        btn.disabled = true; btn.textContent = "...";
        try {
          const res = await fetch("/api/toolbox/dualhedge/users/token", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, requestToken: val }),
          });
          const data = await res.json();
          if (!res.ok) { errBox.innerHTML = `<div class="tb-err-box">${data.error || "Failed"}</div>`; btn.disabled = false; btn.textContent = "Exchange"; return; }
          renderDualHedgeUsers();
        } catch (err) {
          errBox.innerHTML = `<div class="tb-err-box">${err.message}</div>`;
          btn.disabled = false; btn.textContent = "Exchange";
        }
      });
    });
    tbDualHedgeBody.querySelectorAll("[data-dh-user-remove]").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm(`Remove ${btn.dataset.dhUserRemove} from the dual-hedge user registry? (credentials stay in .env, unused)`)) return;
        await fetch(`/api/toolbox/dualhedge/users/${encodeURIComponent(btn.dataset.dhUserRemove)}`, { method: "DELETE" });
        renderDualHedgeUsers();
      });
    });
    tbDualHedgeBody.querySelector("#dhUserAddSubmit").addEventListener("click", async () => {
      const errBox = tbDualHedgeBody.querySelector("#dhUserAddErrBox");
      const body = {
        name: tbDualHedgeBody.querySelector("#dhUserName").value.trim(),
        apiKey: tbDualHedgeBody.querySelector("#dhUserApiKey").value.trim(),
        apiSecret: tbDualHedgeBody.querySelector("#dhUserApiSecret").value.trim(),
      };
      if (!body.name || !body.apiKey || !body.apiSecret) {
        errBox.innerHTML = `<div class="tb-err-box">Name, API key and API secret are all required</div>`;
        return;
      }
      const btn = tbDualHedgeBody.querySelector("#dhUserAddSubmit");
      btn.disabled = true; btn.textContent = "Saving...";
      try {
        const res = await fetch("/api/toolbox/dualhedge/users", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) { errBox.innerHTML = `<div class="tb-err-box">${data.error || "Failed"}</div>`; btn.disabled = false; btn.textContent = "Save user"; return; }
        renderDualHedgeUsers();
      } catch (err) {
        errBox.innerHTML = `<div class="tb-err-box">${err.message}</div>`;
        btn.disabled = false; btn.textContent = "Save user";
      }
    });
  } catch (err) {
    tbDualHedgeBody.innerHTML = `<div class="tb-err-box">failed to load: ${err.message}</div>`;
  }
}

// ─── Add-deployment flow: underlying via the same live search Hedge
// Pairs/Add Instrument use, then LONG/SHORT accounts via dropdowns
// (bounded, pre-configured list \u2014 no search needed there).
function renderDualHedgeAddUnderlyingPicker() {
  tbDualHedgeBody.innerHTML = `
    <button class="tb-back-link" id="dhBack">\u2039 back</button>
    <div class="tb-form-hint" style="margin:8px 0">Underlying (both accounts trade this same instrument, opposite directions)</div>
    <div class="tb-search-row">
      <input type="text" id="dhSearchInput" placeholder="search underlying...">
      <button id="dhSearchBtn">Search</button>
    </div>
    <div id="dhSearchHint" class="tb-form-hint"></div>
    <div id="dhSearchPickList" class="tb-pick-list"></div>
  `;
  tbDualHedgeBody.querySelector("#dhBack").addEventListener("click", () => { dhAddState = null; loadDualHedgeList(); });
  const input = tbDualHedgeBody.querySelector("#dhSearchInput");
  const hint  = tbDualHedgeBody.querySelector("#dhSearchHint");
  const list  = tbDualHedgeBody.querySelector("#dhSearchPickList");
  async function runSearch() {
    const q = input.value.trim();
    hint.textContent = "Searching...";
    list.innerHTML = "";
    try {
      const data = await (await fetch(`/api/toolbox/instruments?exchange=MCX&q=${encodeURIComponent(q)}`)).json();
      const matches = data.matches || [];
      if (matches.length === 0) { hint.textContent = "No matches"; return; }
      hint.textContent = `${matches.length} match(es)`;
      matches.slice(0, 30).forEach(u => {
        const btn = document.createElement("button");
        btn.className = "tb-pick-item";
        btn.textContent = u;
        btn.addEventListener("click", () => { dhAddState.underlying = u; (dhAddState.mode === "backtest" ? renderDualHedgeBacktestForm : renderDualHedgeAddForm)(); });
        list.appendChild(btn);
      });
    } catch (err) {
      hint.textContent = `search failed: ${err.message}`;
    }
  }
  tbDualHedgeBody.querySelector("#dhSearchBtn").addEventListener("click", runSearch);
  input.addEventListener("keydown", e => { if (e.key === "Enter") runSearch(); });
}

async function renderDualHedgeAddForm() {
  const [lm, usersData] = await Promise.all([
    (await fetch(`/api/toolbox/dualhedge/lotmult/${encodeURIComponent(dhAddState.underlying)}`)).json().catch(() => ({})),
    (await fetch("/api/toolbox/dualhedge/users")).json().catch(() => ({ users: [] })),
  ]);
  const readyUsers = (usersData.users || []).filter(u => u.hasApiKey && u.hasAccessToken);

  if (readyUsers.length < 2) {
    tbDualHedgeBody.innerHTML = `
      <button class="tb-back-link" id="dhBack">\u2039 back</button>
      <div class="tb-err-box" style="margin-top:8px">need at least 2 fully-configured users (API key + access token) \u2014 currently ${readyUsers.length}. Use "manage users" first.</div>
    `;
    tbDualHedgeBody.querySelector("#dhBack").addEventListener("click", () => { dhAddState = null; loadDualHedgeList(); });
    return;
  }

  const userOptions = readyUsers.map(u => `<option value="${u.name}">${u.name}</option>`).join("");

  tbDualHedgeBody.innerHTML = `
    <button class="tb-back-link" id="dhBack">\u2039 back</button>
    <div class="tb-form-hint" style="margin:8px 0">Underlying: <b>${dhAddState.underlying}</b></div>
    <div class="tb-form-row"><div class="tb-form-label">Strategy</div><select id="dhStrategy"><option value="DUAL">Dual hedge (band-following)</option><option value="BIAS">Bias hedge (daily HA core + band hedge)</option></select></div>
    <div class="tb-form-hint" id="dhStrategyHint" style="margin-bottom:8px"></div>

    <div class="tb-form-row"><div class="tb-form-label">LONG account</div><select id="dhLongUser">${userOptions}</select></div>
    <div class="tb-form-row"><div class="tb-form-label">SHORT account (must differ from LONG)</div><select id="dhShortUser">${userOptions}</select></div>
    <div class="tb-form-row"><div class="tb-form-label">Lots per leg (default 1)</div><input type="number" id="dhLots" min="1" step="1" value="1"></div>
    <div id="dhBiasOnly" style="display:none">
      <div class="tb-form-row"><div class="tb-form-label">Hedge unwind</div><select id="dhUnwind"><option value="BAND_FLIP">Band back in the core's favour closes the hedge</option><option value="EOD_ONLY">Hold the hedge to EOD</option></select></div>
      <div class="tb-form-row"><div class="tb-form-label">Dynamic Band timeframe</div><select id="dhBandTf"><option value="5m">5m</option><option value="15m" selected>15m</option><option value="30m">30m</option><option value="1h">1h</option></select></div>
      <div class="tb-form-row"><div class="tb-form-label">Core entry time IST (previous daily HA candle decides, once a day)</div><input type="time" id="dhEntryTime" value="10:00"></div>
    </div>
    <div id="dhDualOnly">
    <div class="tb-form-row"><div class="tb-form-label">Stop type</div><select id="dhSlMode"><option value="RUPEES">Rupees (loss on the leg)</option><option value="ATR">ATR multiple from entry</option></select></div>
    <div id="dhAtrRows" style="display:none">
      <div class="tb-form-row"><div class="tb-form-label">ATR stop multiplier (blank = default)</div><input type="number" id="dhAtrMult" min="0" step="any" placeholder="default"></div>
      <div class="tb-form-row"><div class="tb-form-label">ATR timeframe</div><select id="dhAtrTf"><option>5m</option><option selected>15m</option><option>30m</option><option>1h</option></select></div>
      <div class="tb-form-hint">A flipped leg exits once price moves this many ATRs against its entry (ATR taken at entry, fixed after). The rupee figure below is then only a backstop while ATR isn't available yet.</div>
    </div>
    <div class="tb-form-row"><div class="tb-form-label" id="dhMaxLossLabel">Stop: exit a flipped leg when loss exceeds \u20b9 (default 3000)</div><input type="number" id="dhMaxLoss" min="1" step="1" value="3000"></div>
    <div class="tb-form-row"><div class="tb-form-label">Take profit: exit a flipped leg when profit exceeds \u20b9 (default 3000)</div><input type="number" id="dhTakeProfit" min="1" step="1" value="3000"></div>
    </div>
    <div class="tb-form-row" style="display:${lm.lotMultRequired ? "" : "none"}">
      <div class="tb-form-label">lot multiplier \u2014 REQUIRED, no context.js override on file for ${dhAddState.underlying}. Real contract multiplier, not broker lot_size.</div>
      <input type="number" id="dhLotMult" min="1" step="any">
    </div>
    <div class="tb-form-row"><div class="tb-form-label">Band step override (blank = engine default)</div><input type="number" id="dhBandStep" min="0" step="any"></div>
    <div id="dhDualOnly2">
    <div class="tb-form-row"><div class="tb-form-label">Range bar size in price points (blank = same as the band step)</div><input type="number" id="dhRangeSize" min="0" step="any"></div>
    <div class="tb-form-row">
      <label class="tb-form-row-inline"><input type="checkbox" id="dhGap"><span>Enable gap capture \u2014 at the gap time today's trades are closed (realized), then LONG on the long account + SHORT on the short account, carried overnight; the engine quits afterwards with positions left open</span></label>
    </div>
    <div id="dhGapTimes" style="display:none">
      <div class="tb-form-row"><div class="tb-form-label">Gap capture time IST (realize + enter)</div><input type="time" id="dhGapEntry" value="23:20"></div>
      <div class="tb-form-row"><div class="tb-form-label">Quit time IST (must be after gap time; positions stay open)</div><input type="time" id="dhGapExit" value="23:25"></div>
    </div>
    </div>
    <div class="tb-form-row">
      <label class="tb-form-row-inline"><input type="checkbox" id="dhLive"><span>Go LIVE (real orders on BOTH accounts) \u2014 unchecked = paper</span></label>
    </div>
    <div id="dhAddErrBox"></div>
    <button class="tb-submit-btn" id="dhAddSubmit">Start dual hedge</button>
  `;

  tbDualHedgeBody.querySelector("#dhBack").addEventListener("click", renderDualHedgeAddUnderlyingPicker);
  const dhHints = {
    DUAL: "LONG account enters LONG only, SHORT account enters SHORT only \u2014 both carry overnight, SL only arms after that leg's own first adverse flip.",
    BIAS: "Previous daily HA candle sets the core (green = LONG account, red = SHORT account). The OTHER account hedges when the Dynamic Band turns against the core. Both accounts are flat at EOD (no overnight carry, no gap capture).",
  };
  const dhSyncStrategy = () => {
    const st = tbDualHedgeBody.querySelector("#dhStrategy").value;
    tbDualHedgeBody.querySelector("#dhStrategyHint").textContent = dhHints[st];
    tbDualHedgeBody.querySelector("#dhDualOnly").style.display = st === "DUAL" ? "" : "none";
    tbDualHedgeBody.querySelector("#dhDualOnly2").style.display = st === "DUAL" ? "" : "none";
    tbDualHedgeBody.querySelector("#dhBiasOnly").style.display = st === "BIAS" ? "" : "none";
    tbDualHedgeBody.querySelector("#dhSubmitLabelHolder")?.remove();
    tbDualHedgeBody.querySelector("#dhAddSubmit").textContent = st === "BIAS" ? "Start bias hedge" : "Start dual hedge";
  };
  tbDualHedgeBody.querySelector("#dhStrategy").addEventListener("change", dhSyncStrategy);
  dhSyncStrategy();
  const dhSyncSl = () => {
    const atrMode = tbDualHedgeBody.querySelector("#dhSlMode").value === "ATR";
    tbDualHedgeBody.querySelector("#dhAtrRows").style.display = atrMode ? "" : "none";
    tbDualHedgeBody.querySelector("#dhMaxLossLabel").textContent = atrMode
      ? "Rupee backstop, used only while ATR isn't available yet (\u20b9, default 3000)"
      : "Stop: exit a flipped leg when loss exceeds \u20b9 (default 3000)";
  };
  tbDualHedgeBody.querySelector("#dhSlMode").addEventListener("change", dhSyncSl);
  dhSyncSl();
  tbDualHedgeBody.querySelector("#dhGap").addEventListener("change", e => {
    tbDualHedgeBody.querySelector("#dhGapTimes").style.display = e.target.checked ? "" : "none";
  });

  tbDualHedgeBody.querySelector("#dhAddSubmit").addEventListener("click", async () => {
    const errBox = tbDualHedgeBody.querySelector("#dhAddErrBox");
    const longUser  = tbDualHedgeBody.querySelector("#dhLongUser").value;
    const shortUser = tbDualHedgeBody.querySelector("#dhShortUser").value;
    if (longUser === shortUser) {
      errBox.innerHTML = `<div class="tb-err-box">LONG and SHORT must be different accounts</div>`;
      return;
    }
    const live = tbDualHedgeBody.querySelector("#dhLive").checked;
    let confirmLive;
    if (live) {
      confirmLive = prompt('This starts REAL orders on BOTH accounts. Type "LIVE" to confirm:');
      if (confirmLive !== "LIVE") { errBox.innerHTML = `<div class="tb-err-box">Not confirmed \u2014 not started</div>`; return; }
    }
    const body = {
      underlying: dhAddState.underlying, longUser, shortUser,
      lots: tbDualHedgeBody.querySelector("#dhLots").value || 1,
      maxLossRupees: tbDualHedgeBody.querySelector("#dhMaxLoss").value || 3000,
      slMode: tbDualHedgeBody.querySelector("#dhSlMode").value,
      atrSlMult: tbDualHedgeBody.querySelector("#dhAtrMult").value || undefined,
      atrTimeframe: tbDualHedgeBody.querySelector("#dhAtrTf").value,
      takeProfitRupees: tbDualHedgeBody.querySelector("#dhTakeProfit").value || 3000,
      rangeSize: tbDualHedgeBody.querySelector("#dhRangeSize")?.value || undefined,
      lotMultOverride: tbDualHedgeBody.querySelector("#dhLotMult")?.value || undefined,
      bandStepOverride: tbDualHedgeBody.querySelector("#dhBandStep")?.value || undefined,
      live, confirmLive,
      strategy: tbDualHedgeBody.querySelector("#dhStrategy").value,
      unwindMode: tbDualHedgeBody.querySelector("#dhUnwind").value,
      bandTimeframe: tbDualHedgeBody.querySelector("#dhBandTf").value,
      entryTime: tbDualHedgeBody.querySelector("#dhEntryTime").value || "10:00",
      gapCapture: tbDualHedgeBody.querySelector("#dhStrategy").value === "DUAL" && tbDualHedgeBody.querySelector("#dhGap").checked,
      gcEntry: tbDualHedgeBody.querySelector("#dhGapEntry").value || "23:20",
      gcExit:  tbDualHedgeBody.querySelector("#dhGapExit").value || "23:25",
    };
    const btn = tbDualHedgeBody.querySelector("#dhAddSubmit");
    btn.disabled = true; btn.textContent = "Starting...";
    try {
      const res = await fetch("/api/toolbox/dualhedge", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        errBox.innerHTML = `<div class="tb-err-box">${data.error || "Failed to start"}</div>`;
        btn.disabled = false; btn.textContent = tbDualHedgeBody.querySelector("#dhStrategy").value === "BIAS" ? "Start bias hedge" : "Start dual hedge";
        return;
      }
      dhAddState = null;
      loadDualHedgeList();
    } catch (err) {
      errBox.innerHTML = `<div class="tb-err-box">${err.message}</div>`;
      btn.disabled = false; btn.textContent = tbDualHedgeBody.querySelector("#dhStrategy").value === "BIAS" ? "Start bias hedge" : "Start dual hedge";
    }
  });
}


// ─── Hedge pair backtest — POST /api/toolbox/hedgepairs/backtest (backtestHedgePair.js).
async function renderHedgePairBacktestForm() {
  const [coreLm, hedgeLm] = await Promise.all([
    (await fetch(`/api/toolbox/hedgepairs/lotmult/${encodeURIComponent(hpAddState.core)}`)).json().catch(() => ({})),
    (await fetch(`/api/toolbox/hedgepairs/lotmult/${encodeURIComponent(hpAddState.hedge)}`)).json().catch(() => ({})),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const B = tbHedgePairsBody;
  B.innerHTML = `
    <button class="tb-back-link" id="hbBack">\u2039 back</button>
    <div class="tb-form-hint" style="margin:8px 0">Backtest \u2014 core <b>${escHtml(hpAddState.core)}</b> (daily-HA bias, EOD exit) \u00b7 hedge <b>${escHtml(hpAddState.hedge)}</b> (adverse 1h HA)</div>
    <div class="tb-form-row"><div class="tb-form-label">Core lots</div><input type="number" id="hbCoreLots" min="1" value="1"></div>
    <div class="tb-form-row"><div class="tb-form-label">Hedge lots (5:1 default)</div><input type="number" id="hbHedgeLots" min="1" value="5"></div>
    <div class="tb-form-row" style="display:${coreLm.lotMultRequired ? "" : "none"}"><div class="tb-form-label">core lot multiplier \u2014 REQUIRED</div><input type="number" id="hbCoreLotMult" min="1" step="any"></div>
    <div class="tb-form-row" style="display:${hedgeLm.lotMultRequired ? "" : "none"}"><div class="tb-form-label">hedge lot multiplier \u2014 REQUIRED</div><input type="number" id="hbHedgeLotMult" min="1" step="any"></div>
    <div class="tb-form-row"><div class="tb-form-label">Unwind mode</div><select id="hbUnwind"><option value="HA_FLIP">HA_FLIP \u2014 hedge closes when 1h HA flips back</option><option value="EOD_ONLY">EOD_ONLY \u2014 hold to EOD</option></select></div>
    <div class="tb-form-row"><div class="tb-form-label">From</div><input type="date" id="hbFrom"></div>
    <div class="tb-form-row"><div class="tb-form-label">To</div><input type="date" id="hbTo" value="${today}"></div>
    <div id="hbErrBox"></div>
    <button class="tb-submit-btn" id="hbSubmit">Run backtest</button>
    <div id="hbResult"></div>`;
  const q = id => B.querySelector(id);
  q("#hbBack").addEventListener("click", renderHedgePairAddHedgePicker);
  q("#hbSubmit").addEventListener("click", async () => {
    q("#hbErrBox").innerHTML = ""; q("#hbResult").innerHTML = "";
    if (!q("#hbFrom").value || !q("#hbTo").value) { q("#hbErrBox").innerHTML = `<div class="tb-err-box">pick a from and to date</div>`; return; }
    const btn = q("#hbSubmit"); btn.disabled = true; btn.textContent = "Running...";
    try {
      const res = await fetch("/api/toolbox/hedgepairs/backtest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        coreUnderlying: hpAddState.core, hedgeUnderlying: hpAddState.hedge,
        coreLots: q("#hbCoreLots").value || 1, hedgeLots: q("#hbHedgeLots").value || 5,
        coreLotMultOverride: q("#hbCoreLotMult").value || undefined, hedgeLotMultOverride: q("#hbHedgeLotMult").value || undefined,
        unwindMode: q("#hbUnwind").value, from: q("#hbFrom").value, to: q("#hbTo").value,
      }) });
      const data = await res.json();
      if (!res.ok) q("#hbErrBox").innerHTML = `<div class="tb-err-box">${escHtml(data.error || "backtest failed")}</div>`;
      else {
        const m = data.summary || {};
        const row = (l, x) => x ? `<tr><td>${l}</td><td>${x.trades}</td><td>${(x.winRate * 100).toFixed(1)}%</td><td>${Number(x.netPnL).toFixed(2)}</td></tr>` : "";
        q("#hbResult").innerHTML = `
          <table class="tb-table" style="width:100%;margin-top:10px"><tr><th></th><th>Trades</th><th>Win</th><th>Net \u20b9</th></tr>
          ${row("Combined", m.combined)}${row("Core " + escHtml(data.core?.symbol || ""), m.core)}${row("Hedge " + escHtml(data.hedge?.symbol || ""), m.hedge)}</table>
          <div style="margin:8px 0"><a href="${data.reportUrl}" target="_blank">Open report</a> \u00b7 <a href="${data.jsonUrl}" target="_blank">JSON</a> \u00b7 <a href="#" id="hbLogToggle">Show log</a></div>
          <pre id="hbLogBody" style="display:none;max-height:300px;overflow:auto">${escHtml((data.logLines || []).join("\n"))}</pre>`;
        const t = q("#hbLogToggle"), lb = q("#hbLogBody");
        t.addEventListener("click", e => { e.preventDefault(); const o = lb.style.display === "none"; lb.style.display = o ? "" : "none"; t.textContent = o ? "Hide log" : "Show log"; });
      }
    } catch (err) { q("#hbErrBox").innerHTML = `<div class="tb-err-box">${escHtml(err.message)}</div>`; }
    btn.disabled = false; btn.textContent = "Run backtest";
  });
}

// ─── Backtest sub-view — POST /api/toolbox/dualhedge/backtest (backtestDualHedge.js).
function renderDualHedgeBacktestForm() {
  const today = new Date().toISOString().slice(0, 10);
  tbDualHedgeBody.innerHTML = `
    <button class="tb-back-link" id="dbBack">\u2039 back</button>
    <div class="tb-form-hint" style="margin:8px 0">Backtest \u2014 <b>${escHtml(dhAddState.underlying)}</b> (market data only, no accounts needed)</div>
    <div class="tb-form-row"><div class="tb-form-label">Strategy</div><select id="dbStrategy"><option value="DUAL">Dual hedge (band-following)</option><option value="BIAS">Bias hedge (daily HA core + band hedge)</option></select></div>
    <div class="tb-form-row"><div class="tb-form-label">Lots per leg</div><input type="number" id="dbLots" min="1" step="1" value="1"></div>
    <div class="tb-form-row"><div class="tb-form-label">lot multiplier (blank = context.js override)</div><input type="number" id="dbLotMult" min="0" step="any"></div>
    <div class="tb-form-row"><div class="tb-form-label">Band step override (blank = engine default)</div><input type="number" id="dbBandStep" min="0" step="any"></div>
    <div id="dbDual">
      <div class="tb-form-row"><div class="tb-form-label">Signal</div><select id="dbSignal"><option value="RANGE">Range bars + Dynamic Step Band (live engine)</option><option value="HA">Heikin-Ashi from Kite's own bars</option></select></div>
      <div class="tb-form-row" id="dbHaRow" style="display:none"><div class="tb-form-label">HA timeframe</div><select id="dbHaTf"><option>5m</option><option>15m</option><option>30m</option><option selected>1h</option><option>1d</option></select></div>
      <div class="tb-form-row"><div class="tb-form-label">Stop type</div><select id="dbSlMode"><option value="RUPEES">Rupees (loss on the leg)</option><option value="ATR">ATR multiple from entry</option></select></div>
      <div id="dbAtrRows" style="display:none">
        <div class="tb-form-row"><div class="tb-form-label">ATR stop multiplier (blank = default)</div><input type="number" id="dbAtrMult" min="0" step="any" placeholder="default"></div>
        <div class="tb-form-row"><div class="tb-form-label">ATR timeframe</div><select id="dbAtrTf"><option>5m</option><option selected>15m</option><option>30m</option><option>1h</option></select></div>
      </div>
      <div class="tb-form-row"><div class="tb-form-label" id="dbMaxLossLabel">Stop \u20b9</div><input type="number" id="dbMaxLoss" min="1" value="3000"></div>
      <div class="tb-form-row"><div class="tb-form-label">Take profit \u20b9</div><input type="number" id="dbTakeProfit" min="1" value="3000"></div>
    </div>
    <div id="dbBias" style="display:none">
      <div class="tb-form-row"><div class="tb-form-label">Hedge unwind</div><select id="dbUnwind"><option value="BAND_FLIP">Band flip closes the hedge</option><option value="EOD_ONLY">Hold to EOD</option></select></div>
      <div class="tb-form-row"><div class="tb-form-label">Dynamic Band timeframe</div><select id="dbBandTf"><option>5m</option><option selected>15m</option><option>30m</option><option>1h</option></select></div>
      <div class="tb-form-row"><div class="tb-form-label">Core entry time IST</div><input type="time" id="dbEntryTime" value="10:00"></div>
    </div>
    <div class="tb-form-row"><div class="tb-form-label">Slippage per order (price points)</div><input type="number" id="dbSlip" min="0" step="any" value="0"></div>
    <div class="tb-form-row"><div class="tb-form-label">From</div><input type="date" id="dbFrom"></div>
    <div class="tb-form-row"><div class="tb-form-label">To</div><input type="date" id="dbTo" value="${today}"></div>
    <div id="dbErrBox"></div>
    <button class="tb-submit-btn" id="dbSubmit">Run backtest</button>
    <div id="dbResult"></div>
  `;
  const q = id => tbDualHedgeBody.querySelector(id);
  q("#dbBack").addEventListener("click", () => { dhAddState = null; loadDualHedgeList(); });
  const sync = () => {
    const bias = q("#dbStrategy").value === "BIAS";
    q("#dbDual").style.display = bias ? "none" : "";
    q("#dbBias").style.display = bias ? "" : "none";
    q("#dbHaRow").style.display = !bias && q("#dbSignal").value === "HA" ? "" : "none";
    const atrMode = q("#dbSlMode").value === "ATR";
    q("#dbAtrRows").style.display = atrMode ? "" : "none";
    q("#dbMaxLossLabel").textContent = atrMode ? "Rupee backstop while ATR isn't available yet \u20b9" : "Stop \u20b9";
  };
  q("#dbStrategy").addEventListener("change", sync);
  q("#dbSignal").addEventListener("change", sync);
  q("#dbSlMode").addEventListener("change", sync);
  q("#dbSubmit").addEventListener("click", async () => {
    const errBox = q("#dbErrBox");
    errBox.innerHTML = ""; q("#dbResult").innerHTML = "";
    if (!q("#dbFrom").value || !q("#dbTo").value) { errBox.innerHTML = `<div class="tb-err-box">pick a from and to date</div>`; return; }
    const body = {
      underlying: dhAddState.underlying, strategy: q("#dbStrategy").value,
      lots: q("#dbLots").value || 1, lotMultOverride: q("#dbLotMult").value || undefined,
      bandStepOverride: q("#dbBandStep").value || undefined, slippagePoints: q("#dbSlip").value || 0,
      from: q("#dbFrom").value, to: q("#dbTo").value,
      signalSource: q("#dbSignal").value, haTimeframe: q("#dbHaTf").value,
      maxLoss: q("#dbMaxLoss").value, takeProfit: q("#dbTakeProfit").value,
      slMode: q("#dbSlMode").value, atrSlMult: q("#dbAtrMult").value || undefined, atrTimeframe: q("#dbAtrTf").value,
      unwindMode: q("#dbUnwind").value, bandTimeframe: q("#dbBandTf").value, entryTime: q("#dbEntryTime").value || "10:00",
    };
    const btn = q("#dbSubmit");
    btn.disabled = true; btn.textContent = "Running...";
    try {
      const res = await fetch("/api/toolbox/dualhedge/backtest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) errBox.innerHTML = `<div class="tb-err-box">${escHtml(data.error || "backtest failed")}</div>`;
      else renderDualHedgeBacktestResult(data);
    } catch (err) {
      errBox.innerHTML = `<div class="tb-err-box">${escHtml(err.message)}</div>`;
    }
    btn.disabled = false; btn.textContent = "Run backtest";
  });
}

function renderDualHedgeBacktestResult(data) {
  const m = data.summary || {};
  const num = n => (n === undefined || n === null || Number.isNaN(n)) ? "\u2014" : Number(n).toFixed(2);
  const row = (label, x) => x ? `<tr><td>${label}</td><td>${x.trades}</td><td>${(x.winRate * 100).toFixed(1)}%</td><td>${num(x.netPnL)}</td></tr>` : "";
  const dd = data.mtm ? num(data.mtm.maxDrawdown) : "\u2014";
  tbDualHedgeBody.querySelector("#dbResult").innerHTML = `
    <div class="tb-form-hint" style="margin:10px 0 4px"><b>${escHtml(data.strategy)}</b> \u2014 MTM max drawdown ${dd}</div>
    <table class="tb-table" style="width:100%"><tr><th></th><th>Trades</th><th>Win</th><th>Net \u20b9</th></tr>
      ${row("Combined", m.combined)}${row("LONG acct", m.long)}${row("SHORT acct", m.short)}</table>
    <div style="margin:8px 0"><a href="${data.reportUrl}" target="_blank">Open report</a> \u00b7 <a href="${data.jsonUrl}" target="_blank">JSON</a> \u00b7 <a href="#" id="dbLogToggle">Show log</a></div>
    <pre id="dbLogBody" style="display:none;max-height:300px;overflow:auto">${escHtml((data.logLines || []).join("\n"))}</pre>`;
  const t = tbDualHedgeBody.querySelector("#dbLogToggle"), body = tbDualHedgeBody.querySelector("#dbLogBody");
  t.addEventListener("click", e => { e.preventDefault(); const open = body.style.display === "none"; body.style.display = open ? "" : "none"; t.textContent = open ? "Hide log" : "Show log"; });
}

initAuth();
