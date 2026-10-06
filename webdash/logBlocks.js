// Backfill chart "Filters" markers from an engine's PM2 stdout log, for blocks that happened
// before the engine emitted BLOCK events. Each log line carries no date, so a block is
// attributed to the most recent timestamped tick line ("[NAME] HH:MM:SS ...") above it, and
// dates are assigned walking backwards from the file's last-modified day (time-of-day
// jumping up while going backwards = previous day).
const fs = require("fs");

const IST_MS = 5.5 * 3600 * 1000;
const PM2_PREFIX = /^\d+\|[^|]*\|\s*/;
const ISO_PREFIX = /^(\d{4}-\d\d-\d\d)[ T][\d:.+\-Z]+:?\s*/;
const TICK = /^\[[^\]]+\]\s+(\d\d):(\d\d):(\d\d)\b/;
const SIDE_BREAKOUT = /\b(LONG|SHORT)\s+BREAKOUT\b/;

function istDay(ms) { return new Date(ms + IST_MS).toISOString().split("T")[0]; }

function parseBlocksFromText(text, mtimeMs) {
    const events = []; // { sod, isoDay|null, side, reasons, idx }
    let sod = null, isoDay = null, lastSide = null, pending = null;
    const flush = () => { if (pending && pending.reasons.length) events.push(pending); pending = null; };
    const lines = text.split(/\r?\n/);
    for (let raw of lines) {
        if (!raw) continue;
        let line = raw.replace(PM2_PREFIX, "");
        let dayHere = null;
        const iso = line.match(ISO_PREFIX);
        if (iso) { dayHere = iso[1]; line = line.slice(iso[0].length); }
        const t = line.match(TICK);
        if (t) {
            flush();
            sod = (+t[1]) * 3600 + (+t[2]) * 60 + (+t[3]);
            isoDay = dayHere;
            lastSide = null;
            continue;
        }
        if (sod === null) continue;
        if (dayHere) isoDay = dayHere;
        const br = line.match(SIDE_BREAKOUT);
        if (br) { flush(); lastSide = br[1]; pending = { sod, isoDay, side: lastSide, reasons: [] }; continue; }
        if (!pending) pending = { sod, isoDay, side: lastSide, reasons: [] };
        const add = r => { if (!pending.reasons.includes(r)) pending.reasons.push(r); };
        let m;
        if ((m = line.match(/\b(LONG|SHORT) entry blocked by DAILY HA gate/))) { pending.side = m[1]; add("DAILY_HA"); }
        else if ((m = line.match(/\b(LONG|SHORT) entry blocked by ENTRY-TIME gate/))) { pending.side = m[1]; add("ENTRY_TIME"); }
        else if (/\[ENTRY_BLOCKED_LONG_CANDLE\]/.test(line)) {
            add("LONG_CANDLE");
            if ((m = line.match(/direction=(LONG|SHORT)/))) pending.side = m[1];
        }
        else if (/entry blocked by Choppiness Index/.test(line)) add("CHOP");
        else if (/entry blocked — volume not above/.test(line)) add("VOLUME");
        else if (/higher timeframe trending but still inside/.test(line)) add("HTF");
        else if (/entry blocked — double orders disabled/.test(line)) add("DOUBLE_ORDER");
    }
    flush();
    if (!events.length) return [];

    // Assign dates: walk the tick-time sequence backwards from the file's last-modified day.
    let day = istDay(mtimeMs);
    let prevSod = null;
    for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (e.isoDay) { day = e.isoDay; }
        else if (prevSod !== null && e.sod > prevSod) {
            day = istDay(Date.parse(day + "T00:00:00Z") - 86400000 + IST_MS);
        }
        prevSod = e.sod;
        e.day = day;
    }
    return events.filter(e => e.side).map(e => ({
        ts: Date.parse(e.day + "T00:00:00Z") - IST_MS + e.sod * 1000,
        side: e.side, price: null, reasons: e.reasons, fromLog: true,
    }));
}

function parseBlocksFromLog(logPath, day) {
    try {
        if (!logPath || !fs.existsSync(logPath)) return [];
        const st = fs.statSync(logPath);
        // Only the tail: a few MB comfortably covers several sessions.
        const MAX = 6 * 1024 * 1024;
        const fd = fs.openSync(logPath, "r");
        const len = Math.min(st.size, MAX);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, st.size - len);
        fs.closeSync(fd);
        return parseBlocksFromText(buf.toString("utf8"), st.mtimeMs).filter(b => istDay(b.ts) === day);
    } catch { return []; }
}

module.exports = { parseBlocksFromLog, parseBlocksFromText };
