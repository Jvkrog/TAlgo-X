// Chart overlay for DSB_GREY: per-candle green/red/grey mid line + direction-change markers.
"use strict";
const assert = require("assert");
const { computeOverlay } = require("../indicators/chartOverlay");
const engineConfig = require("../core/engineConfig");
const bars = Array.from({ length: 400 }, (_, i) => { const p = 100 + 14 * Math.sin(i / 25) + 0.5 * Math.sin(i), o = 100 + 14 * Math.sin((i - 1) / 25); return { t: 1e12 + i * 3600e3, open: o, high: Math.max(o, p) + 0.3, low: Math.min(o, p) - 0.3, close: p }; });
const ov = computeOverlay("DSB_GREY", bars, { bandStep: 1, candleType: "RAW" }, engineConfig);
assert.ok(ov.lines && ov.lines.length === 1 && ov.keepColors, "one coloured line, journal recolouring disabled");
const pts = ov.lines[0].points; assert.strictEqual(pts.length, bars.length);
const cols = new Set(pts.map(p => p[2])); assert.ok(cols.has("#33ff88") && cols.has("#ff5266") && cols.has("#8a949c"), "green, red and grey all present: " + [...cols]);
assert.ok(ov.markers.length >= 2 && ov.markers.every(m => m.dir === 1 || m.dir === -1), "direction-change markers");
// every marker sits on a bar where the colour just became green/red
for (const m of ov.markers) { const i = bars.findIndex(b => b.t === m.t); assert.strictEqual(pts[i][2], m.dir === 1 ? "#33ff88" : "#ff5266"); assert.ok(i === 0 || pts[i - 1][2] !== pts[i][2]); }
const src = require("fs").readFileSync(__dirname + "/../webdash/public/chart.js", "utf8");
assert.ok(/overlayMarks/.test(src) && /text: m\.dir === 1 \? "UP" : "DOWN"/.test(src), "chart draws UP/DOWN markers");
console.log("all passed");
