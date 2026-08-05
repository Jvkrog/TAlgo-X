// ecosystem.config.js — PM2's standard declarative process file.
//
// Deliberately lists ONLY the Market Scanner here — no per-instrument
// engine.js process. Every engine.js instance's configuration (UNDERLYING,
// STRATEGY_OVERRIDE, LOTS_OVERRIDE, LIVE_ORDERS_OVERRIDE, TIMEFRAME_OVERRIDE,
// EXCHANGE_OVERRIDE, ...) is chosen at runtime through toolbox.js's Add
// Instrument / Roll Contract / Live-Paper toggle flows, via pm2Start() calls
// the toolbox makes programmatically. THAT is the real source of truth for
// which instruments are running and how they're configured — a static entry
// here for a specific instrument would drift out of sync the moment someone
// changes it through the toolbox, and running `pm2 start ecosystem.config.js`
// would silently fight with whatever the toolbox already set up.
//
// The Scanner is different in kind, which is exactly why it belongs here
// and engine.js instances don't: it's a SINGLETON, always-on process with
// no per-instance configuration to lose sync with. WHICH instruments it
// watches lives in marketWatchlist.json (edited via the toolbox's Market
// Status screen — press K, then A/R), read fresh at the Scanner's own boot
// — not baked into this file. So there's nothing here that can go stale.
//
// USAGE
//   pm2 start ecosystem.config.js      # starts the Scanner
//   pm2 save                           # snapshot the process list, so...
//   pm2 startup                        # ...(one-time, per server) wires PM2
//                                         into systemd/init so a server
//                                         reboot brings PM2 itself back —
//                                         `pm2 startup` prints an OS-specific
//                                         command to run once, as root
//   pm2 resurrect                      # after a reboot, restores whatever
//                                         was running when you last `pm2 save`d
//                                         (both the Scanner from this file AND
//                                         whatever engine.js instances the
//                                         toolbox had running — pm2 save/
//                                         resurrect doesn't care which of the
//                                         two ways a process was originally
//                                         started)
//
// Engine instances are still started/stopped/rolled entirely through the
// toolbox (`npx talgox`, or however it's invoked) — this file has no
// opinion about them and never will.
"use strict";

module.exports = {
    apps: [
        {
            name:            "MarketScanner",
            script:          "scannerService.js",
            cwd:             __dirname,
            // Matches toolbox.js's PM2_BASE_OPTS — a clean exit(0) (e.g.
            // the boot-time "watchlist is empty, refusing to start" guard
            // in scannerService.js) should NOT trigger PM2's autorestart;
            // a crash (any other exit code, or an uncaught exception PM2
            // sees kill the process) should.
            stop_exit_codes: [0],
            autorestart:     true,
            max_restarts:    10,
            // ms — backs a crash-loop off instead of hammering Kite's
            // historical-data API immediately on every failed restart.
            restart_delay:   5000,
            env: {
                // Nothing instrument-specific belongs here — see the file
                // header. Only process-level knobs the Scanner itself would
                // read directly from process.env at boot would go here;
                // there are none today (engineConfig.js already covers
                // API_KEY/ACCESS_TOKEN_FILE/etc. the same way it does for
                // every engine.js instance).
            },
        },
    ],
};
