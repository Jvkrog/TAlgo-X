// lifecycle.js
const { tg } = require("./telegram");
const { closeSlow, closeFast } = require("./positions");
const { SLOW, FAST } = require("./state");
const config = require("./config");
const { getRawCandles } = require("./candleBuilder");
const db = require("./db");

let eodDone = false;
let shutdownDone = false;
let marketOpenFired = false;
const sessionStart = Date.now();

function startLifecycle() {
    setInterval(() => {
        const now = new Date();
        const price = getRawCandles().at(-1)?.close || 0;

        // 9:00 Market Open Boot Check (can be expanded later)
        if (now.getHours() === 9 && now.getMinutes() === 0 && !marketOpenFired) {
            marketOpenFired = true;
            console.log("Market Open 9:00 - Resuming from DB");
        }

        // 23:00 Force Close (optional - you can disable if you want overnight holds)
        if (now.getHours() === 23 && now.getMinutes() === 0 && !eodDone) {
            eodDone = true;
            console.log("23:00 — Forcing close of all positions (EOD risk control)");
            closeFast(price, "EOD_FORCE");
            closeSlow(price, "EOD_FORCE");
        }

        // 23:15 Shutdown + Summary (NO CLEAR)
        if (now.getHours() === 23 && now.getMinutes() === 15 && !shutdownDone) {
            shutdownDone = true;
            const duration = Math.round((Date.now() - sessionStart) / 60000);
            const totalPnL = SLOW.pnl + FAST.pnl;
            const msg = `SESSION SUMMARY\nDuration: ${duration}m\nFAST: ${totalPnL.toFixed(0)} | SLOW: ${SLOW.pnl.toFixed(0)}\nTOTAL: ${totalPnL.toFixed(0)}\nPositions saved to DB for next session.`;
            console.log(msg);
            tg(msg);
            tg(`TAlgo-X shutdown. Positions persisted in database.`);
            setTimeout(() => process.exit(0), 3000);
        }
    }, 30000);
}

module.exports = { startLifecycle };