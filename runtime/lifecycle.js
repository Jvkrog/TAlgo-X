// lifecycle.js — EOD shutdown
"use strict";

const { tg } = require("./telegram");
const { closeSlow, closeFast, pnlStr } = require("./positions");
const { SLOW, FAST } = require("./state");
const { getLivePrice } = require("./candleBuilder");
const { clearSlowSL, clearFastSL } = require("./sl");

let eodDone      = false;
let shutdownDone = false;
const sessionStart = Date.now();

function startLifecycle() {
    const interval = setInterval(() => {
        const now   = new Date();
        const price = getLivePrice();

        // 23:00 — force close all positions
        if (now.getHours() === 23 && now.getMinutes() >= 0 && !eodDone) {
            eodDone = true;
            const dateStr = now.toLocaleString("en-IN", { hour12: false });
            console.log();
            console.log(`EOD  ${dateStr}`);

            if (!price) {
                console.error("EOD  no live price — force close skipped");
                tg("⚠ EOD: no live price — force close skipped");
            } else {
                if (SLOW.position) { closeSlow(price, "EOD_FORCE"); clearSlowSL(); }
                if (FAST.position) { closeFast(price, "EOD_FORCE"); clearFastSL(); }
            }
        }

        // 23:15 — summary and exit
        if (now.getHours() === 23 && now.getMinutes() >= 15 && !shutdownDone) {
            shutdownDone = true;
            const mins  = Math.round((Date.now() - sessionStart) / 60000);
            const total = (SLOW.pnl || 0) + (FAST.pnl || 0);

            console.log();
            console.log(`session  ${mins}m`);
            console.log(`  slow : ${pnlStr(SLOW.pnl || 0)}`);
            console.log(`  fast : ${pnlStr(FAST.pnl || 0)}`);
            console.log(`  total: ${pnlStr(total)}`);
            console.log();
            console.log("*** SHUTDOWN ***");
            console.log();

            tg(`EOD ${mins}m\nSlow:  ${pnlStr(SLOW.pnl||0)}\nFast:  ${pnlStr(FAST.pnl||0)}\nTotal: ${pnlStr(total)}`);
            clearInterval(interval);
            setTimeout(() => process.exit(0), 2000);
        }
    }, 30000);
}

module.exports = { startLifecycle };
