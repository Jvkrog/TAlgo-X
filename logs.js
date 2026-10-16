#!/usr/bin/env node
// logs.js — coloured live logs in the terminal (a coloured `pm2 logs`).
// `pm2 logs` tails PM2's .log files, which are plain text on purpose (plainLog.js); the coloured copy of each log is the
// "-color.log" sidecar beside it. This tails those sidecars.
//   node logs.js              all instruments, last 15 lines each, then follow
//   node logs.js zinc natgas  only processes whose log name contains any of the words
//   node logs.js -n 40        last 40 lines each     --err  include stderr     --no-follow  print and exit
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const args = process.argv.slice(2);
let n = 15, withErr = false, follow = true;
const words = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === "-n") n = Number(args[++i]) || 15;
    else if (args[i] === "--err") withErr = true;
    else if (args[i] === "--no-follow") follow = false;
    else words.push(args[i].toLowerCase());
}
const dir = path.join(process.env.PM2_HOME || path.join(os.homedir(), ".pm2"), "logs");
let files = [];
try { files = fs.readdirSync(dir).filter(f => /-(out|error)-color\.log$/.test(f)); } catch { /* handled below */ }
files = files.filter(f => (withErr || /-out-color\.log$/.test(f)) && (!words.length || words.some(w => f.toLowerCase().includes(w))));
if (!files.length) { console.error(`no coloured logs found in ${dir}${words.length ? " matching " + words.join(", ") : ""} (they appear once an engine has run with the current version)`); process.exit(1); }

const PAL = [36, 35, 33, 32, 34, 96, 95, 93];
const strip = t => t.replace(/\x1b\[[0-9;]*m/g, "");
// Width is read on every line, so rotating a phone / resizing a window applies immediately.
const cols = () => Math.max(30, (process.stdout.columns || 80) - 1);
// On a narrow screen the process tag is shortened so the log text keeps most of the width.
const names = files.map(f => f.replace(/-(out|error)-color\.log$/, ""));
const tagFor = (i, narrow) => {
    let nm = names[i];
    const max = narrow ? 8 : 28;
    if (nm.length > max) nm = nm.slice(0, max - 1) + "…";
    return { text: `\x1b[${PAL[i % PAL.length]}m${nm}\x1b[0m\x1b[2m|\x1b[0m `, w: nm.length + 2 };
};
const state = files.map((f, i) => ({ p: path.join(dir, f), i, pos: 0, rest: "" }));

// Wraps one coloured line: first row gets w1 visible chars, later rows w2 (colour is re-applied
// after each break so wrapped text keeps its colour).
function wrapAnsi(line, w1, w2) {
    const out = []; let cur = "", vis = 0, lim = w1, sgr = "", i = 0;
    while (i < line.length) {
        const m = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
        if (m) { cur += m[0]; sgr = m[0] === "\x1b[0m" ? "" : sgr + m[0]; i += m[0].length; continue; }
        if (vis >= lim) { out.push(cur + "\x1b[0m"); cur = sgr; vis = 0; lim = w2; }
        cur += line[i]; vis++; i++;
    }
    out.push(cur);
    return out;
}
function write(s, l) {
    const c = cols(), narrow = c < 80, t = tagFor(s.i, narrow);
    // wide: wrapped rows hang under the log text; narrow: they use nearly the full width
    const hang = narrow ? 2 : t.w;
    const rows = wrapAnsi(l, Math.max(10, c - t.w), Math.max(10, c - hang));
    process.stdout.write(t.text + rows[0] + "\n");
    for (let k = 1; k < rows.length; k++) process.stdout.write(" ".repeat(hang) + rows[k] + "\n");
}
function emit(s, text) {
    const lines = (s.rest + text).split("\n");
    s.rest = lines.pop();
    for (const l of lines) if (l.trim()) write(s, l);
}
for (const s of state) {
    try {
        const size = fs.statSync(s.p).size, from = Math.max(0, size - 256 * 1024);
        const fd = fs.openSync(s.p, "r"), buf = Buffer.alloc(size - from);
        fs.readSync(fd, buf, 0, buf.length, from); fs.closeSync(fd);
        const lines = buf.toString("utf8").split("\n").filter(l => l.trim()).slice(-n);
        process.stdout.write(`\x1b[2m${names[s.i]} · last ${lines.length} lines\x1b[0m\n`);
        lines.forEach(l => write(s, l));
        s.pos = size;
    } catch { /* file vanished */ }
}
if (follow) setInterval(() => {
    for (const s of state) {
        try {
            const size = fs.statSync(s.p).size;
            if (size < s.pos) s.pos = 0;   // truncated / rotated
            if (size === s.pos) continue;
            const fd = fs.openSync(s.p, "r"), buf = Buffer.alloc(size - s.pos);
            fs.readSync(fd, buf, 0, buf.length, s.pos); fs.closeSync(fd);
            s.pos = size;
            emit(s, buf.toString("utf8"));
        } catch { /* keep polling */ }
    }
}, 500);
