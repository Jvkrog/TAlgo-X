// Deploying from a backtest must carry the tuned ATR multiplier / DSB 2 step (plumbing check on app.js).
"use strict";
const assert = require("assert"), src = require("fs").readFileSync(__dirname + "/../webdash/public/app.js", "utf8");
const a = src.indexOf("function renderBtDeployView"); assert.ok(a > 0, "deploy view found");
const seg = src.slice(a, a + 9000);
assert.ok(/atrSlMultDeploy\s*=\s*bt\.atrSlMult \|\| P\.ATR_SL_MULT/.test(seg), "ATR mult derived from tuned param");
assert.ok(/atrSlMult:\s*atrSlMultDeploy/.test(seg), "deploy body sends it");
assert.ok(/bandStep2:\s*bandStep2Deploy/.test(seg), "deploy body sends DSB 2 step");
assert.ok(/"ATR_SL_MULT", "ALMA_PRO_FAST_LEN"/.test(seg), "no longer listed as 'not applied'");
assert.ok(/payload\.atrSlMult = tp\.ATR_SL_MULT/.test(src), "apply-to-instrument carries it too");
assert.ok(/pd\.key === "ATR_SL_MULT" && btState\.strategy !== "ALMA_BAND"\) return/.test(src), "duplicate ATR SL tunable hidden");
console.log("all passed");
