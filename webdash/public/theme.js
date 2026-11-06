// theme.js — WebDash theme: dark / light + custom RGB colours. Loaded in <head> (applies instantly, no flash) on every page;
// the Theme panel is built on DOMContentLoaded when the page has #themeBtn. Saved per browser (localStorage); defaults = original terminal look.
(function () {
  "use strict";
  var KEY = "talgox.theme.v1", root = document.documentElement;
  var BASE = {
    dark:  { bg: "#050806", text: "#eafff2", accent: "#33ff88", red: "#ff5266", cyan: "#4de3ff" },
    light: { bg: "#f2f6f3", text: "#10231a", accent: "#0b8a4a", red: "#d4283f", cyan: "#0a7fa0" },
  };
  var PRESETS = [
    ["Terminal", { accent: "#33ff88", red: "#ff5266", cyan: "#4de3ff" }, { accent: "#0b8a4a", red: "#d4283f", cyan: "#0a7fa0" }],
    ["Amber",    { accent: "#ffb000", red: "#ff5a4d", cyan: "#5ad1ff" }, { accent: "#b36b00", red: "#cc3328", cyan: "#0a7fa0" }],
    ["Ice",      { accent: "#4dc3ff", red: "#ff6b81", cyan: "#7be0ff" }, { accent: "#0b6fb8", red: "#d4283f", cyan: "#0a7fa0" }],
    ["Violet",   { accent: "#b388ff", red: "#ff5c7a", cyan: "#58e0ff" }, { accent: "#6a3fc9", red: "#d4283f", cyan: "#0a7fa0" }],
    ["Mono",     { accent: "#e6e6e6", red: "#ff6b6b", cyan: "#9ad0ff" }, { accent: "#222222", red: "#c62828", cyan: "#0a7fa0" }],
  ];
  var FIELDS = [["bg", "Background"], ["text", "Text"], ["accent", "Accent"], ["red", "Negative"], ["cyan", "Info"]];

  var HEX = /^#[0-9a-f]{6}$/i;
  function rgb(h) { var n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
  function hex(a) { return "#" + a.map(function (v) { v = Math.max(0, Math.min(255, Math.round(v))); return (v < 16 ? "0" : "") + v.toString(16); }).join(""); }
  function mix(a, b, t) { var x = rgb(a), y = rgb(b); return hex([0, 1, 2].map(function (i) { return x[i] + (y[i] - x[i]) * t; })); }
  function lum(h) { return rgb(h).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }).reduce(function (s, v, i) { return s + v * [0.2126, 0.7152, 0.0722][i]; }, 0); }
  function contrast(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  function trio(h) { return rgb(h).join(", "); }

  function defaults() { return { mode: "dark", colors: Object.assign({}, BASE.dark), edited: {} }; }
  function load() {
    try {
      var t = JSON.parse(localStorage.getItem(KEY) || "null");
      if (t && (t.mode === "dark" || t.mode === "light") && t.colors && FIELDS.every(function (f) { return HEX.test(t.colors[f[0]] || ""); })) { t.edited = t.edited || {}; return t; }
    } catch (e) {}
    return defaults();
  }
  function save(t) { try { localStorage.setItem(KEY, JSON.stringify(t)); } catch (e) {} }

  function apply(t) {
    var c = t.colors, light = t.mode === "light", white = "#ffffff", black = "#000000", s = root.style, set = function (k, v) { s.setProperty(k, v); };
    var panel = light ? mix(c.bg, white, 0.55) : mix(c.bg, c.accent, 0.07), bright = light ? mix(c.accent, black, 0.18) : mix(c.accent, white, 0.35);
    var dim = mix(c.text, c.bg, light ? 0.42 : 0.55), yellow = light ? "#a86b00" : "#ffcc4d";
    root.setAttribute("data-theme", t.mode); root.style.colorScheme = t.mode;
    set("--bg", c.bg); set("--bg-2", mix(c.bg, c.accent, light ? 0.05 : 0.05)); set("--bg-rgb", trio(c.bg));
    set("--panel-solid", panel); set("--panel-rgb", trio(panel));
    set("--white", c.text); set("--text", c.text); set("--dim", dim); set("--dim-rgb", trio(dim));
    set("--green", c.accent); set("--accent-rgb", trio(c.accent)); set("--green-bright", bright); set("--green-bright-rgb", trio(bright));
    set("--green-dim", mix(c.accent, c.bg, 0.45)); set("--green-soft", light ? mix(c.accent, black, 0.1) : mix(c.accent, white, 0.3));
    set("--red", c.red); set("--red-rgb", trio(c.red)); set("--red-soft", light ? mix(c.red, black, 0.1) : mix(c.red, white, 0.3));
    set("--cyan", c.cyan); set("--cyan-rgb", trio(c.cyan));
    set("--yellow", yellow); set("--yellow-rgb", trio(yellow)); set("--orange", light ? "#b45309" : "#ffb347");
    set("--overlay", light ? black : white); set("--overlay-rgb", light ? "0, 0, 0" : "255, 255, 255");
    try { window.dispatchEvent(new CustomEvent("talgox-theme", { detail: { mode: t.mode } })); } catch (e) {}
  }

  var state = load(); apply(state);
  window.TalgoTheme = { isLight: function () { return state.mode === "light"; }, get: function () { return JSON.parse(JSON.stringify(state)); } };

  function build() {
    var btn = document.getElementById("themeBtn"); if (!btn) return;
    var modal = document.createElement("div"); modal.className = "tb-modal"; modal.id = "themeModal";
    modal.innerHTML = '<div class="tb-modal-content"><div class="tb-modal-head"><span>Theme</span><button class="btn btn-ghost" id="themeClose">Close</button></div><div class="tb-modal-body">' +
      '<div class="theme-seg"><button class="btn btn-ghost" data-mode="dark">◑ Dark</button><button class="btn btn-ghost" data-mode="light">◐ Light</button></div>' +
      '<div class="tb-log-section-title">Presets</div><div class="theme-presets" id="themePresets"></div>' +
      '<div class="tb-log-section-title">Custom colours (R G B, 0–255)</div><div id="themeRows"></div><div class="theme-warn" id="themeWarn"></div>' +
      '<div class="theme-sample"><span style="color:var(--green)">● accent</span> · <span style="color:var(--red)">● negative</span> · <span style="color:var(--cyan)">● info</span> · <span style="color:var(--dim)">dim text</span> · normal text</div>' +
      '<div style="display:flex;gap:8px;margin-top:14px"><button class="btn btn-ghost" id="themeReset">Reset to default</button></div></div></div>';
    document.body.appendChild(modal);
    var rows = modal.querySelector("#themeRows"), inputs = {};
    FIELDS.forEach(function (f) {
      var k = f[0], r = document.createElement("div"); r.className = "theme-row";
      r.innerHTML = '<label>' + f[1] + '</label><input type="color" data-k="' + k + '"><input type="number" min="0" max="255" data-k="' + k + '" data-c="0" aria-label="' + f[1] + ' red"><input type="number" min="0" max="255" data-k="' + k + '" data-c="1" aria-label="' + f[1] + ' green"><input type="number" min="0" max="255" data-k="' + k + '" data-c="2" aria-label="' + f[1] + ' blue"><span class="theme-hex"></span>';
      rows.appendChild(r); inputs[k] = r;
    });
    function paint() {
      modal.querySelectorAll("[data-mode]").forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-mode") === state.mode); });
      FIELDS.forEach(function (f) { var k = f[0], r = inputs[k], v = state.colors[k], a = rgb(v);
        r.querySelector('input[type=color]').value = v; r.querySelectorAll("input[type=number]").forEach(function (n) { if (document.activeElement !== n) n.value = a[+n.getAttribute("data-c")]; }); r.querySelector(".theme-hex").textContent = v; });
      var w = [], cr = contrast(state.colors.text, state.colors.bg), ca = contrast(state.colors.accent, state.colors.bg);
      if (cr < 4.5) w.push("Text on background is hard to read (contrast " + cr.toFixed(1) + ":1)."); if (ca < 3) w.push("Accent is faint on this background (" + ca.toFixed(1) + ":1).");
      modal.querySelector("#themeWarn").textContent = w.join(" ");
    }
    function commit() { apply(state); save(state); paint(); }
    function setMode(m) {
      if (m === state.mode) return; state.mode = m;
      FIELDS.forEach(function (f) { var k = f[0]; if (k === "bg" || k === "text" || !state.edited[k]) state.colors[k] = BASE[m][k]; }); state.edited.bg = state.edited.text = false; commit();
    }
    modal.querySelectorAll("[data-mode]").forEach(function (b) { b.addEventListener("click", function () { setMode(b.getAttribute("data-mode")); }); });
    var pr = modal.querySelector("#themePresets");
    PRESETS.forEach(function (p) { var b = document.createElement("button"); b.className = "theme-swatch"; b.innerHTML = '<i style="background:' + p[1].accent + '"></i>' + p[0];
      b.addEventListener("click", function () { var src = state.mode === "light" ? p[2] : p[1]; ["accent", "red", "cyan"].forEach(function (k) { state.colors[k] = src[k]; state.edited[k] = p[0] !== "Terminal"; }); commit(); }); pr.appendChild(b); });
    rows.addEventListener("input", function (e) {
      var el = e.target, k = el.getAttribute("data-k"); if (!k) return;
      if (el.type === "color") state.colors[k] = el.value.toLowerCase();
      else { var a = rgb(state.colors[k]), c = +el.getAttribute("data-c"), v = parseInt(el.value, 10); if (isNaN(v)) return; a[c] = Math.max(0, Math.min(255, v)); state.colors[k] = hex(a); }
      state.edited[k] = true; apply(state); save(state); paint();
    });
    modal.querySelector("#themeReset").addEventListener("click", function () { state = defaults(); try { localStorage.removeItem(KEY); } catch (e) {} apply(state); paint(); });
    function close() { modal.classList.remove("open"); }
    modal.querySelector("#themeClose").addEventListener("click", close); modal.addEventListener("click", function (e) { if (e.target === modal) close(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
    btn.addEventListener("click", function () { paint(); modal.classList.add("open"); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build); else build();
})();
