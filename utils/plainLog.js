// plainLog.js — keep PM2's .log files free of ANSI colour codes while terminal and dashboard keep their colours.
// Under PM2 stdout/stderr are files (not a TTY). install() makes every write go to PM2's file stripped of colour
// codes, and tees the coloured original to a sidecar "<name>-out-color.log" (same for stderr) that the WebDash Logs
// view and the toolbox's log viewer read. A TTY (engine run by hand) is untouched. LOG_PLAIN=0 disables it.
"use strict";
const fs = require("fs");

const ANSI = /\x1b\[[0-9;]*m/g;
const strip = s => s.replace(ANSI, "");
const colorPathFor = p => (p ? String(p).replace(/\.log$/, "") + "-color.log" : null);
const MAX_SIDECAR_BYTES = 20 * 1024 * 1024;

function tee(stream, logPath) {
    const sidecar = colorPathFor(logPath);
    if (!sidecar) return;
    try { if (fs.existsSync(sidecar) && fs.statSync(sidecar).size > MAX_SIDECAR_BYTES) fs.truncateSync(sidecar, 0); } catch { /* best effort */ }
    let fd;
    try { fd = fs.openSync(sidecar, "a"); } catch { return; }   // can't write the sidecar: leave the stream alone
    const orig = stream.write.bind(stream);
    stream.write = (chunk, enc, cb) => {
        if (typeof enc === "function") { cb = enc; enc = undefined; }
        try {
            const str = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
            try { fs.writeSync(fd, str); } catch { /* sidecar is best effort */ }
            return orig(strip(str), enc, cb);
        } catch {
            return orig(chunk, enc, cb);
        }
    };
}

let installed = false;
function install() {
    if (installed) return;   // dualHedgeEngine.js installs it, then hands over to dualBiasHedgeEngine.js which installs it again: a second wrap would copy the stripped text into the colour sidecar too (every line twice)
    installed = true;
    if (process.env.LOG_PLAIN === "0" || process.stdout.isTTY) return;
    tee(process.stdout, process.env.pm_out_log_path);
    tee(process.stderr, process.env.pm_err_log_path);
}

module.exports = { install, strip, colorPathFor };
