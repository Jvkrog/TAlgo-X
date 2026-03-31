// lifecycle.js
const { tg } = require("./telegram");
const { closeFast } = require("./positions");
const { FAST } = require("./state");
const config = require("./config");
const { getRawCandles } = require("./candleBuilder");

let eodDone = false;
let shutdownDone = false;
const sessionStart = Date.now();

function startLifecycle() {
    setInterval(() => {
        const now = new Date();
        const price = getRawCandles().at(-1)?.close || 0;

        // 23:00 Force Close (optional)
        if (now.getHours() === 23 && now.getMinutes() === 0 && !eodDone) {
            eodDone = true;
            console.log("23:00 — Forcing close of position (EOD)");
            closeFast(price, "EOD_FORCE");
        }

        // 23:15 Shutdown + Summary
        if (now.getHours() === 23 && now.getMinutes() === 15 && !shutdownDone) {
            shutdownDone = true;
            const duration = Math.round((Date.now() - sessionStart) / 60000);
            const totalPnL = FAST.pnl || 0;
            const msg = `SESSION SUMMARY\nDuration: ${duration}m\nPnL: ${totalPnL.toFixed(0)}\nPositions saved to DB.`;
            console.log(msg);
            tg(msg);
            tg(`Zinc engine shutdown. Positions persisted.`);
            setTimeout(() => process.exit(0), 3000);
        }
    }, 30000);
}

module.exports = { startLifecycle };