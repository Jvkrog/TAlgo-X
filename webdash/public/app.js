"use strict";

// NOTE on identity: live events from eventBridge.js carry `engine` = the
// underlying's tgPrefix (e.g. "ZINCMINI") — not the PM2 process name, and
// not strategy-specific. If the same underlying is ever run under two
// strategies at once, a tick is applied to every card for that underlying
// — the same ambiguity the existing Telegram alerts already have (they key
// off tgPrefix too). Not a regression introduced here.

const grid       = document.getElementById("instrumentGrid");
const logStream  = document.getElementById("logStream");
const connStatus = document.getElementById("connStatus");
const totalPnlEl = document.getElementById("totalSessionPnl");
const engineCountEl = document.getElementById("engineCount");
const autoscrollToggle = document.getElementById("autoscrollToggle");
const refreshBtn = document.getElementById("refreshBtn");
const tokenBtn = document.getElementById("tokenBtn");
const tokenDot = document.getElementById("tokenDot");
const tokenLabel = document.getElementById("tokenLabel");
const tokenPanel = document.getElementById("tokenPanel");
const tokenInput = document.getElementById("tokenInput");
const tokenExchangeBtn = document.getElementById("tokenExchangeBtn");
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
        <span class="pnl-label">unrealized</span>
        <span class="pnl-value flat" data-role="upnl">+0</span>
      </div>
      <div class="pnl-box">
        <span class="pnl-label">session</span>
        <span class="pnl-value flat" data-role="session">+0</span>
      </div>
    </div>
    <div class="card-controls">
      <button class="btn btn-start" data-action="start">start</button>
      <button class="btn btn-stop" data-action="stop">stop</button>
      <button class="btn btn-restart" data-action="restart">restart</button>
    </div>
  `;
  el.querySelectorAll("[data-action]").forEach(btn => {
    btn.addEventListener("click", () => control(inst.name, btn.dataset.action, el));
  });
  return el;
}

function renderInstruments() {
  if (instruments.length === 0) {
    grid.innerHTML = `<div class="empty-state">no engines detected — waiting on PM2...</div>`;
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

refreshBtn.addEventListener("click", loadInstruments);

// ── kite access token ───────────────────────────────────────────────────
// Primary path: the token button's href is set to Kite's real login URL, so
// tapping it is a normal link tap (works on mobile without popup-blocker
// issues). If your Kite app's Redirect URL points at this server's
// /api/token/callback, the token is captured and exchanged automatically —
// you'll land back here with ?token=ok. Otherwise, the panel below the
// button is a manual fallback: paste the request_token (or the full
// redirect URL Kite sent you to) and exchange it by hand, same as the CLI.
async function refreshTokenStatus() {
  try {
    const status = await (await fetch("/api/token/status")).json();
    tokenDot.className = `token-dot ${status.set ? "set" : "unset"}`;
    tokenLabel.textContent = status.set ? "token set" : "generate token";
  } catch {
    tokenDot.className = "token-dot";
    tokenLabel.textContent = "generate token";
  }
}

async function loadLoginUrl() {
  try {
    const data = await (await fetch("/api/token/login-url")).json();
    if (data.url) tokenBtn.href = data.url;
  } catch { /* leave href as-is; click will just 404 harmlessly */ }
}

tokenBtn.addEventListener("click", () => {
  tokenPanel.classList.toggle("open");
});

tokenExchangeBtn.addEventListener("click", async () => {
  const input = tokenInput.value.trim();
  if (!input) return;
  tokenExchangeBtn.textContent = "...";
  try {
    const res = await fetch("/api/token/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
    });
    const data = await res.json();
    if (res.ok) {
      appendLog({ type: "SYS", text: "[token] access token updated — restart engines to pick it up" });
      tokenInput.value = "";
      tokenPanel.classList.remove("open");
      refreshTokenStatus();
    } else {
      appendLog({ type: "ERROR", text: `[token] exchange failed: ${data.error}` });
    }
  } catch (err) {
    appendLog({ type: "ERROR", text: `[token] exchange failed: ${err.message}` });
  } finally {
    tokenExchangeBtn.textContent = "exchange";
  }
});

function handleTokenRedirectParams() {
  const params = new URLSearchParams(location.search);
  if (!params.has("token")) return;
  if (params.get("token") === "ok") {
    appendLog({ type: "SYS", text: "[token] access token captured and updated automatically — restart engines to pick it up" });
  } else {
    appendLog({ type: "ERROR", text: `[token] auto-capture failed: ${params.get("msg") || "unknown error"}` });
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
    connStatus.querySelector(".conn-label").textContent = "live";
  } else if (state === "down") {
    connStatus.classList.add("down");
    connStatus.querySelector(".conn-label").textContent = "disconnected";
  } else {
    connStatus.querySelector(".conn-label").textContent = "connecting";
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
    // DYNAMIC_BAND_COLOR (and any future strategy that sets `color`) tags
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
    appendLog({
      type: "ENTRY",
      instant: isReplay,
      segments: [
        ["lf-engine", msg.engine],
        ["lf-time", time],
        ["lf-tag", `${msg.side} ENTRY`],
        ["lf-price", `@ ${Number(msg.price).toFixed(2)}`],
        ["lf-meta", `Tr:${msg.trail != null ? Number(msg.trail).toFixed(2) : "-"}`],
      ],
    });
    return;
  }

  if (msg.type === "EXIT") {
    if (!isReplay) flashCards(msg.engine, msg.pnl >= 0 ? 1 : -1);
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
          if (statusEl) { statusEl.textContent = "offline"; statusEl.className = "status-pill offline"; }
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

// ── boot (behind the PIN lock) ──────────────────────────────────────────
let appStarted = false;
function startApp() {
  if (appStarted) return; // re-locking doesn't tear down the live WS/polling — just re-covers the UI
  appStarted = true;
  appendLog({ type: "SYS", text: `[dashboard] booting...` });
  loadInstruments();
  connect();
  refreshTokenStatus();
  loadLoginUrl();
  handleTokenRedirectParams();
  setInterval(loadInstruments, 30000); // periodic resync in case PM2 state changed outside the dashboard
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
  lockSubtitle.textContent = "session timed out — enter pin to continue";
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
    lockSubtitle.textContent = "could not reach server — retrying...";
    setTimeout(initAuth, 3000);
  }
}

// ── toolbox tab ──────────────────────────────────────────────────────────
const tabDashboard = document.getElementById("tabDashboard");
const tabToolbox = document.getElementById("tabToolbox");
const dashboardView = document.getElementById("dashboardView");
const toolboxView = document.getElementById("toolboxView");
const tbBoot = document.getElementById("tbBoot");
const tbBanner = document.getElementById("tbBanner");
const tbChecklist = document.getElementById("tbChecklist");
const toolboxList = document.getElementById("toolboxList");
const toolboxRefreshBtn = document.getElementById("toolboxRefreshBtn");
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

function switchTab(tab) {
  if (tab === "dashboard") {
    tabDashboard.classList.add("active");
    tabToolbox.classList.remove("active");
    dashboardView.style.display = "";
    toolboxView.style.display = "none";
    return;
  }
  tabToolbox.classList.add("active");
  tabDashboard.classList.remove("active");
  dashboardView.style.display = "none";

  if (toolboxBootPlayed) {
    toolboxView.style.display = "";
    loadToolboxList();
  } else {
    playToolboxBoot();
  }
}

tabDashboard.addEventListener("click", () => switchTab("dashboard"));
tabToolbox.addEventListener("click", () => switchTab("toolbox"));

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
    toolboxList.innerHTML = `<div class="empty-state">no engines detected</div>`;
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
      <button class="tb-row-logs" data-name="${inst.name}">logs</button>
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

async function openLogsModal(name) {
  tbLogsTitle.textContent = `${name} — logs`;
  tbLogsBody.innerHTML = "loading...";
  tbLogsModal.classList.add("open");
  try {
    const data = await (await fetch(`/api/toolbox/logs/${encodeURIComponent(name)}`)).json();
    if (data.error) { tbLogsBody.textContent = data.error; return; }
    let html = `<div class="tb-log-section-title">stdout — ${data.outLogPath || "unknown path"}</div>`;
    html += `<pre>${(data.out.join("\n") || "(empty)").replace(/</g, "&lt;")}</pre>`;
    if (data.err && data.err.length) {
      html += `<div class="tb-log-section-title">stderr — ${data.errLogPath || "unknown path"}</div>`;
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
        <button data-mode="paper">paper</button>
        <button data-mode="live">live</button>
      </div>
      <label class="tb-carry-row">
        <input type="checkbox" id="tbCarryCheck">
        <span>carry position overnight (NRML, not MIS)</span>
      </label>
      <div class="tb-confirm-live" id="tbConfirmLive">
        <div class="tb-confirm-live-warn">⚠ switching to LIVE places real orders. type LIVE to confirm:</div>
        <input type="text" id="tbConfirmLiveInput" placeholder="type LIVE">
      </div>
      <button class="tb-mode-submit" id="tbModeSubmit" disabled>apply</button>
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
      <div class="tb-form-label">exchange</div>
      <div class="tb-mode-choice" id="addExchangeChoice">
        <button data-ex="MCX" class="picked paper">MCX Futures</button>
        <button data-ex="NSE">NSE Stocks</button>
      </div>
    </div>
    <div class="tb-form-row">
      <div class="tb-form-label">search underlying</div>
      <div class="tb-search-row">
        <input type="text" id="addSearchInput" placeholder="e.g. ZINC, NATGAS...">
        <button id="addSearchBtn">search</button>
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
    hint.textContent = "searching...";
    pickList.innerHTML = "";
    try {
      const q = searchInput.value.trim();
      const data = await (await fetch(`/api/toolbox/instruments?exchange=${addState.exchange}&q=${encodeURIComponent(q)}`)).json();
      if (data.error) { hint.textContent = data.error; return; }
      if (data.matches.length === 0) { hint.textContent = "no matches"; return; }
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
      tbAddBody.innerHTML = `<div class="tb-err-box">${preview.error}</div><button class="tb-back-link" id="addBackErr">‹ back to search</button>`;
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
    <button class="tb-back-link" id="addBack">‹ back to search</button>
    <div class="tb-resolved-box">
      <div>would resolve to <span class="sym">${p.symbol}</span></div>
      <div>expiry: ${p.expiry || "n/a (equity, no roll)"} — broker lot_size ${p.brokerLotSize}</div>
    </div>
    ${p.lotMultRequired ? `
    <div class="tb-warn-box">⚠ lot multiplier required — the broker's lot_size is a contract COUNT, not the real price multiplier (this exact gap caused a real PnL bug once, on NatGas Mini). Look up the actual contract spec before entering this.</div>
    <div class="tb-form-row"><div class="tb-form-label">lot multiplier (required)</div><input type="number" id="addLotMult" placeholder="e.g. 250" min="0" step="any"></div>
    ` : ""}
    <div class="tb-form-row">
      <div class="tb-form-label">strategy</div>
      <div id="addStrategyList"></div>
    </div>
    <div class="tb-form-row">
      <div class="tb-form-label">timeframe</div>
      <select id="addTimeframe"></select>
    </div>
    <div class="tb-form-row">
      <div class="tb-form-label">lots</div>
      <input type="number" id="addLots" value="1" min="1" step="1">
    </div>
    <div class="tb-form-row">
      <div class="tb-form-label">mode</div>
      <div class="tb-mode-choice" id="addModeChoice">
        <button data-mode="paper" class="picked paper">paper</button>
        <button data-mode="live">live</button>
      </div>
      <div class="tb-confirm-live" id="addConfirmLive">
        <div class="tb-confirm-live-warn">⚠ this will place REAL orders. type LIVE to confirm:</div>
        <input type="text" id="addConfirmLiveInput" placeholder="type LIVE">
      </div>
    </div>
    <label class="tb-form-row-inline"><input type="checkbox" id="addCarry"><span>carry position overnight instead of EOD close</span></label>
    <div class="tb-form-row">
      <div class="tb-form-label">profit target in points (tick-monitored, blank = none)</div>
      <input type="number" id="addTarget" min="0" step="any">
    </div>
    <div class="tb-form-row" id="addSmaExitRow" style="display:none">
      <label class="tb-form-row-inline"><input type="checkbox" id="addSmaExit" checked><span>enable SMA9 reversal exit (MA_SLOPE_PURE only)</span></label>
    </div>
    <div class="tb-form-row" id="addBandStepRow" style="display:none">
      <div class="tb-form-label">band step in price points (DYNAMIC_BAND only, blank = default)</div>
      <input type="number" id="addBandStep" min="0" step="any">
    </div>
    <div class="tb-form-row" id="addGreyExitRow" style="display:none">
      <label class="tb-form-row-inline"><input type="checkbox" id="addGreyExit"><span>exit on grey state instead of holding through it (ALMA_TRI_BAND only, default: hold)</span></label>
    </div>
    <div id="addErrBox"></div>
    <button class="tb-submit-btn" id="addSubmit">start instrument</button>
  `;
  tbAddBody.querySelector("#addBack").addEventListener("click", renderAddSearchStep);

  let pickedStrategy = defaultStrat;
  const stratList = tbAddBody.querySelector("#addStrategyList");
  const smaExitRow = tbAddBody.querySelector("#addSmaExitRow");
  const bandStepRow = tbAddBody.querySelector("#addBandStepRow");
  const greyExitRow = tbAddBody.querySelector("#addGreyExitRow");
  strategies.forEach(s => {
    const div = document.createElement("div");
    div.className = "tb-strategy-item" + (s.key === defaultStrat ? " picked" : "");
    div.innerHTML = `<div class="tb-strategy-item-label">${s.label}${s.key === defaultStrat ? " (default)" : ""}</div><div class="tb-strategy-item-desc">${s.description}</div>`;
    div.addEventListener("click", () => {
      pickedStrategy = s.key;
      stratList.querySelectorAll(".tb-strategy-item").forEach(el => el.classList.remove("picked"));
      div.classList.add("picked");
      updateTimeframeOptions(s.timeframe);
      smaExitRow.style.display = s.key === "MA_SLOPE_PURE" ? "" : "none";
      bandStepRow.style.display = (s.key === "DYNAMIC_BAND" || s.key === "DYNAMIC_BAND_COLOR") ? "" : "none";
      greyExitRow.style.display = s.key === "ALMA_TRI_BAND" ? "" : "none";
    });
    stratList.appendChild(div);
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
  smaExitRow.style.display = defaultStrat === "MA_SLOPE_PURE" ? "" : "none";

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
      errBox.innerHTML = `<div class="tb-err-box">lot multiplier is required</div>`;
      return;
    }
    if (isLive && tbAddBody.querySelector("#addConfirmLiveInput").value !== "LIVE") {
      errBox.innerHTML = `<div class="tb-err-box">type LIVE to confirm live mode</div>`;
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = "starting...";
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
        smaExitEnabled: pickedStrategy === "MA_SLOPE_PURE" ? tbAddBody.querySelector("#addSmaExit").checked : undefined,
        bandStep: (pickedStrategy === "DYNAMIC_BAND" || pickedStrategy === "DYNAMIC_BAND_COLOR") ? (tbAddBody.querySelector("#addBandStep").value || undefined) : undefined,
        greyExitEnabled: pickedStrategy === "ALMA_TRI_BAND" ? tbAddBody.querySelector("#addGreyExit").checked : undefined,
      };
      const res = await fetch("/api/toolbox/instrument", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) {
        errBox.innerHTML = `<div class="tb-err-box">${data.error || "failed"}</div>`;
        submitBtn.disabled = false;
        submitBtn.textContent = "start instrument";
        return;
      }
      tbAddModal.classList.remove("open");
      appendLog({ type: "SYS", text: `started ${data.name} — ${isLive ? "LIVE" : "PAPER"} — ${pickedStrategy} @ ${data.timeframe}` });
      loadToolboxList();
    } catch (err) {
      errBox.innerHTML = `<div class="tb-err-box">${err.message}</div>`;
      submitBtn.disabled = false;
      submitBtn.textContent = "start instrument";
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
  tbBacktestBody.innerHTML = `<div class="tb-form-hint">loading strategies...</div>`;
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
  tbBacktestBody.innerHTML = `<div class="tb-form-row"><div class="tb-form-label">step 1/3 — strategy</div><div id="btStrategyList"></div></div>`;
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
    <button class="tb-back-link" id="btBack1">‹ back to strategy</button>
    <div class="tb-form-row">
      <div class="tb-form-label">step 2/3 — instrument</div>
      <div class="tb-mode-choice" id="btExchangeChoice">
        <button data-ex="MCX" class="picked paper">MCX Futures</button>
        <button data-ex="NSE">NSE Stocks</button>
      </div>
    </div>
    <div class="tb-search-row">
      <input type="text" id="btSearchInput" placeholder="search underlying...">
      <button id="btSearchBtn">search</button>
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
    hint.textContent = "searching...";
    pickList.innerHTML = "";
    try {
      const q = searchInput.value.trim();
      const data = await (await fetch(`/api/toolbox/instruments?exchange=${btState.exchange}&q=${encodeURIComponent(q)}`)).json();
      if (data.error) { hint.textContent = data.error; return; }
      if (data.matches.length === 0) { hint.textContent = "no matches"; return; }
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
  tbBacktestBody.innerHTML = `<div class="tb-form-hint">loading...</div>`;
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
    <button class="tb-back-link" id="btBack2">‹ back to instrument</button>
    <div class="tb-form-row">
      <div class="tb-form-label">step 3/3 — range & params</div>
      <div class="tb-form-hint">${btState.underlying} — ${(btState.strategies.find(s => s.key === btState.strategy) || {}).label || btState.strategy}</div>
    </div>
    <div class="tb-form-row"><div class="tb-form-label">timeframe</div><select id="btTimeframe"></select></div>
    <div class="tb-form-row"><div class="tb-form-label">days back (default 30)</div><input type="number" id="btDays" placeholder="30" min="1"></div>
    <div class="tb-form-row" id="btLotMultRow" style="display:${preview && preview.lotMultRequired ? "" : "none"}">
      <div class="tb-form-label">lot multiplier (required for this instrument)</div>
      <input type="number" id="btLotMult" min="0" step="any">
    </div>
    <div id="btParamsBox"></div>
    <div id="btErrBox"></div>
    <div id="btResultBox"></div>
    <button class="tb-submit-btn" id="btSubmit">run backtest</button>
  `;
  tbBacktestBody.querySelector("#btBack2").addEventListener("click", renderBacktestInstrumentStep);

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
    submitBtn.textContent = "running... (fetching history + replaying)";
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
    };
    try {
      const res = await fetch("/api/toolbox/backtest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) {
        if (/lot multiplier/i.test(data.error || "")) tbBacktestBody.querySelector("#btLotMultRow").style.display = "";
        errBox.innerHTML = `<div class="tb-err-box">${data.error || "backtest failed"}</div>`;
        submitBtn.disabled = false;
        submitBtn.textContent = "run backtest";
        return;
      }
      const m = data.summary;
      const fmtMoney = v => (v >= 0 ? "+" : "") + Math.round(v).toLocaleString();
      const logText = (data.logLines || []).join("\n");
      resultBox.innerHTML = `
        <div class="tb-summary-grid">
          <div class="tb-summary-cell"><div class="k">trades</div><div class="v">${m.trades}</div></div>
          <div class="tb-summary-cell"><div class="k">win rate</div><div class="v">${(m.winRate * 100).toFixed(1)}%</div></div>
          <div class="tb-summary-cell"><div class="k">profit factor</div><div class="v">${m.profitFactor === null ? "-" : m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2)}</div></div>
          <div class="tb-summary-cell"><div class="k">net pnl</div><div class="v">${fmtMoney(m.netPnL)}</div></div>
          <div class="tb-summary-cell"><div class="k">max drawdown</div><div class="v">${fmtMoney(m.maxDrawdown)}</div></div>
          <div class="tb-summary-cell"><div class="k">avg trade</div><div class="v">${fmtMoney(m.avgTrade)}</div></div>
        </div>
        <a class="tb-report-link" href="${data.reportUrl}" target="_blank" rel="noopener">open full report ↗</a>
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
      submitBtn.textContent = "run backtest";
    } catch (err) {
      errBox.innerHTML = `<div class="tb-err-box">${err.message}</div>`;
      submitBtn.disabled = false;
      submitBtn.textContent = "run backtest";
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
  tbCredsBody.innerHTML = `<div class="tb-form-hint">loading...</div>`;
  tbCredsModal.classList.add("open");
  try {
    const fields = await (await fetch("/api/toolbox/credentials")).json();
    tbCredsBody.innerHTML = `
      <div class="tb-form-hint" style="margin-bottom:14px">blank = keep current value</div>
      ${fields.map(f => `
        <div class="tb-form-row">
          <div class="tb-form-label">${f.key}${f.set ? "" : " (not set)"}</div>
          <input type="text" data-cred="${f.key}" placeholder="${f.masked || "new value"}">
        </div>
      `).join("")}
      <div id="credsErrBox"></div>
      <div id="credsMsgBox"></div>
      <button class="tb-submit-btn" id="credsSubmit">save</button>
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
      submitBtn.textContent = "saving...";
      try {
        const res = await fetch("/api/toolbox/credentials", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok) {
          errBox.innerHTML = `<div class="tb-err-box">${data.error || "failed"}</div>`;
          submitBtn.disabled = false;
          submitBtn.textContent = "save";
          return;
        }
        msgBox.innerHTML = data.changed > 0
          ? `<div class="tb-form-hint">saved ${data.changed} value(s) — ${data.note}</div>`
          : `<div class="tb-form-hint">nothing changed</div>`;
        submitBtn.disabled = false;
        submitBtn.textContent = "save";
      } catch (err) {
        errBox.innerHTML = `<div class="tb-err-box">${err.message}</div>`;
        submitBtn.disabled = false;
        submitBtn.textContent = "save";
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
      <div class="tb-form-label">exchange</div>
      <div class="tb-mode-choice" id="trendExchangeChoice">
        <button data-ex="MCX" class="picked paper">MCX Futures</button>
        <button data-ex="NSE">NSE Stocks</button>
      </div>
    </div>
    <div class="tb-form-row">
      <div class="tb-form-label">filter (blank = scan all)</div>
      <input type="text" id="trendQuery" placeholder="e.g. ZINC, NATGAS...">
    </div>
    <div class="tb-form-hint">ADX(${14}) on daily candles, ${90}d lookback, ≥25 = trending. Rate-limited — a full scan can take a while.</div>
    ${confirmAllNotice ? `<div class="tb-warn-box">${confirmAllNotice}</div>` : ""}
    <div id="trendErrBox"></div>
    <button class="tb-submit-btn" id="trendScanBtn">scan</button>
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
  if (scanBtn) { scanBtn.disabled = true; scanBtn.textContent = "scanning..."; }
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
    if (scanBtn) { scanBtn.disabled = false; scanBtn.textContent = "scan"; }
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
      freshBtn.textContent = "scan all anyway";
      freshBtn.addEventListener("click", () => runTrendingScan(true));
      return;
    }
    const errBox = tbTrendingBody.querySelector("#trendErrBox");
    if (errBox) errBox.innerHTML = `<div class="tb-err-box">${errorData.error}</div>`;
    if (scanBtn) { scanBtn.disabled = false; scanBtn.textContent = "scan"; }
    return;
  }
  if (finalData) {
    renderTrendingResults(finalData);
  } else {
    const errBox = tbTrendingBody.querySelector("#trendErrBox");
    if (errBox) errBox.innerHTML = `<div class="tb-err-box">scan ended without a result — check the server log</div>`;
    if (scanBtn) { scanBtn.disabled = false; scanBtn.textContent = "scan"; }
  }
}

function renderTrendingResults(data) {
  const { scanned, exchange, trending, alreadyRunning } = data;
  let html = `<button class="tb-back-link" id="trendBack">‹ new scan</button>`;
  html += `<div class="tb-form-hint" style="margin-bottom:10px">${scanned} scanned</div>`;

  if (trending.length === 0 && alreadyRunning.length === 0) {
    html += `<div class="tb-form-hint">nothing trending right now (ADX < 25)</div>`;
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
        <button class="tb-trend-deploy-btn" data-deploy-idx="${idx}">deploy</button>
      </div>`;
  }

  if (recommended.length > 0) {
    html += `<div class="tb-trend-group-label">recommended (ADX 25\u201330) \u2014 not already running</div>`;
    recommended.forEach(r => { html += renderRow(r); });
  }
  if (exhausted.length > 0) {
    html += `<div class="tb-trend-group-label" style="color:var(--yellow,#ffcc4d)">might be exhausted (ADX &gt; 30) \u2014 not already running</div>`;
    exhausted.forEach(r => { html += renderRow(r); });
  }
  if (alreadyRunning.length > 0) {
    html += `<div class="tb-trend-group-label">trending but already running</div>`;
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
  tbMarketBody.innerHTML = `<div class="tb-form-hint">loading...</div>`;
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
        <button id="marketAddBtn">add</button>
      </div>
      <div id="marketAddHint" class="tb-form-hint"></div>
      <div id="marketAddPickList" class="tb-pick-list"></div>
    `;

    if (entries.length === 0) {
      html += `<div class="tb-form-hint">watchlist is empty — add an instrument above</div>`;
    } else {
      entries.forEach(e => {
        const p = e.profile;
        const cls = stateClass(p.structure.state);
        const updated = p.updatedAt ? new Date(p.updatedAt).toLocaleTimeString([], { hour12: false }) : (p.unavailableReason || "no data");
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
      addHint.textContent = "searching...";
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
        if (combined.length === 0) { addHint.textContent = "no matches"; return; }
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
  tbRollBody.innerHTML = `<div class="tb-form-hint">loading...</div>`;
  tbRollModal.classList.add("open");
  await renderRollPickStep();
}

async function renderRollPickStep() {
  tbRollBody.innerHTML = `<div class="tb-form-hint">loading...</div>`;
  try {
    const candidates = await (await fetch("/api/toolbox/roll/candidates")).json();
    let html = `<div class="tb-warn-box">⚠ roll contract only applies to MCX futures — NSE equities don't expire, so they're left out of this list.</div>`;
    if (candidates.length === 0) {
      html += `<div class="tb-form-hint">no running MCX instruments to roll</div>`;
    } else {
      html += `<div class="tb-form-label" style="margin-bottom:8px">select instrument to roll</div>`;
      candidates.forEach(c => {
        html += `<button class="tb-pick-item" data-roll-name="${c.name}" style="width:100%;text-align:left;margin-bottom:6px">${c.underlying} <span style="color:var(--dim);font-size:10px">— ${c.strategyLabel}</span></button>`;
      });
    }
    tbRollBody.innerHTML = html;
    tbRollBody.querySelectorAll("[data-roll-name]").forEach(btn => {
      btn.addEventListener("click", () => renderRollPreviewStep(btn.dataset.rollName));
    });
  } catch (err) {
    tbRollBody.innerHTML = `<div class="tb-err-box">${err.message}</div>`;
  }
}

async function renderRollPreviewStep(name) {
  tbRollBody.innerHTML = `<div class="tb-form-hint">resolving...</div>`;
  try {
    const preview = await (await fetch(`/api/toolbox/roll/preview/${encodeURIComponent(name)}`)).json();
    if (preview.error) {
      tbRollBody.innerHTML = `
        <button class="tb-back-link" id="rollBackErr">‹ back</button>
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
    <button class="tb-back-link" id="rollBack2">‹ back to instrument list</button>
    <div class="tb-warn-box">⚠ MCX futures only — this instrument is confirmed MCX.</div>
    <div class="tb-resolved-box">
      <div>instrument: <span class="sym">${underlying}</span></div>
      <div>current: ${current.symbol} (token ${current.token}, lot ${current.lotSize})</div>
      <div>next: ${manualEntryNeeded ? '<span style="color:var(--yellow,#ffcc4d)">not found in instrument dump</span>' : `${next.symbol} (token ${next.token}, lot ${next.lotSize})`}</div>
    </div>
  `;

  if (manualEntryNeeded) {
    html += `
      <div class="tb-warn-box">⚠ next contract not found in the local instrument dump — enter it manually.</div>
      <div class="tb-form-row"><div class="tb-form-label">new symbol</div><input type="text" id="rollManualSymbol"></div>
      <div class="tb-form-row"><div class="tb-form-label">new token</div><input type="number" id="rollManualToken"></div>
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
    <button class="tb-submit-btn" id="rollApplyBtn">apply roll</button>
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
        errBox.innerHTML = `<div class="tb-err-box">symbol and token are required for a manual entry</div>`;
        return;
      }
      manualEntry = { symbol, token, lotSize: lotSize || undefined };
    }

    btn.disabled = true;
    btn.textContent = "applying...";
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
        errBox.innerHTML = `<div class="tb-err-box">${data.error || "roll failed"}</div>`;
        btn.disabled = false;
        btn.textContent = "apply roll";
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
      btn.textContent = "apply roll";
    }
  });
}

initAuth();
