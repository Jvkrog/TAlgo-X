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
const tag = (f, i) => `\x1b[${PAL[i % PAL.length]}m${f.replace(/-(out|error)-color\.log$/, "")}\x1b[0m\x1b[2m|\x1b[0m `;
const state = files.map((f, i) => ({ p: path.join(dir, f), t: tag(f, i), pos: 0, rest: "" }));

function emit(s, text) {
    const lines = (s.rest + text).split("\n");
    s.rest = lines.pop();
    for (const l of lines) if (l.trim()) process.stdout.write(s.t + l + "\n");
}
for (const s of state) {
    try {
        const size = fs.statSync(s.p).size, from = Math.max(0, size - 256 * 1024);
        const fd = fs.openSync(s.p, "r"), buf = Buffer.alloc(size - from);
        fs.readSync(fd, buf, 0, buf.length, from); fs.closeSync(fd);
        const lines = buf.toString("utf8").split("\n").filter(l => l.trim()).slice(-n);
        process.stdout.write(`\x1b[2m${s.p} last ${lines.length} lines\x1b[0m\n`);
        lines.forEach(l => process.stdout.write(s.t + l + "\n"));
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
