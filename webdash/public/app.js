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
      appendLog({ type: "SYS", text: `control failed (${name} ${action}): ${err.error || res.statusText}` });
    } else {
      appendLog({ type: "SYS", text: `${name} — ${action} sent` });
      setTimeout(loadInstruments, 1500);
    }
  } catch (err) {
    appendLog({ type: "SYS", text: `control failed (${name} ${action}): ${err.message}` });
  } finally {
    cardEl.style.opacity = "1";
  }
}

async function loadInstruments() {
  try {
    instruments = await (await fetch("/api/instruments")).json();
    renderInstruments();
  } catch (err) {
    appendLog({ type: "SYS", text: `failed to load instrument list: ${err.message}` });
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
      appendLog({ type: "SYS", text: `[token] exchange failed: ${data.error}` });
    }
  } catch (err) {
    appendLog({ type: "SYS", text: `[token] exchange failed: ${err.message}` });
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
    appendLog({ type: "SYS", text: `[token] auto-capture failed: ${params.get("msg") || "unknown error"}` });
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

function appendLog({ type, cssClass, text, instant, segments }) {
  const line = document.createElement("div");
  line.className = `log-line ${type.toLowerCase()} ${cssClass || ""}`.trim();
  if (instant) line.style.animation = "none", line.style.opacity = "1";
  if (segments) line.innerHTML = logRowHtml(segments);
  else line.textContent = text;
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
    const marker = msg.position ? (msg.uPnl > 0 ? "▲" : msg.uPnl < 0 ? "▼" : "●") : "●";
    const cardsForEngine = instruments.filter(i => i.underlying === msg.engine);
    cardsForEngine.forEach(i => {
      const el = document.getElementById(cardId(i));
      if (!el) return;
      el.querySelector('[data-role="price"]').textContent = Number(msg.price).toFixed(2);
      const mEl = el.querySelector('[data-role="marker"]');
      mEl.textContent = marker;
      mEl.className = `state-marker ${marker === "▲" ? "up" : marker === "▼" ? "down" : "flat"}`;
    });
    updateCardPnl(msg.engine, msg.uPnl, msg.session);
    sessionPnlByUnderlying.set(msg.engine, msg.session);
    updateTotalPnl();

    const pnlCls = msg.position ? cls(msg.uPnl) : "flat";
    appendLog({
      type: "TICK",
      cssClass: pnlCls,
      instant: isReplay,
      segments: [
        ["lf-engine", msg.engine],
        ["lf-time", time],
        [`lf-marker lf-marker-${marker === "▲" ? "up" : marker === "▼" ? "down" : "flat"}`, marker],
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

initAuth();
