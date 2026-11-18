// priceMaHedgeController: base legs, base-loss (P&L) hedge, duplicates, failures, stale price, EOD, carry.
"use strict";
const assert = require("assert");
const { createPriceMaHedgeController } = require("../hedge/priceMaHedgeController");
const T = [], t = (n, f) => T.push([n, f]);
function make(opts = {}) {
    const mk = (key, account, kind, side) => ({ key, account, kind, side, blocked: false, state: { position: null } });
    const legs = { LONG_BASE: mk("LONG_BASE", "LONG", "BASE", "LONG"), SHORT_BASE: mk("SHORT_BASE", "SHORT", "BASE", "SHORT"), LONG_HEDGE: mk("LONG_HEDGE", "LONG", "HEDGE", "SHORT"), SHORT_HEDGE: mk("SHORT_HEDGE", "SHORT", "HEDGE", "LONG") };
    const orders = [], failEnter = new Set(opts.failEnter || []), failExit = new Set(opts.failExit || []);
    const broker = {
        async enter(leg, why) { if (failEnter.has(leg.key)) return false; orders.push(`ENTER ${leg.key} ${leg.kind === "BASE" ? "MIS" : "NRML"} ${leg.side} (${why})`); leg.state.position = leg.side; leg.state.entryPrice = px.price; return true; },
        async exit(leg, why) { if (failExit.has(leg.key)) return false; orders.push(`EXIT ${leg.key} (${why})`); leg.state.position = null; return true; },
    };
    const clk = { today: "2026-11-12", hours: 10, minutes: 0, nowMs: 1000000 };
    const logs = [];
    const px = { price: 100 };
    const c = createPriceMaHedgeController({ legs, broker, clock: () => clk, baseHour: 9, baseMinute: 15, eodHour: 23, eodMinute: 20, log: m => logs.push(m), maxPriceAgeMs: 150000, getPrice: () => ({ price: px.price, atMs: px.atMs === undefined ? clk.nowMs : px.atMs }), ...(opts.ctl || {}) });
    return { c, legs, orders, clk, logs, failEnter, failExit, px };
}

// ---- hedge each base against its own loss, once per IST minute ----
const minute = (clk, m) => { clk.minutes = m; clk.nowMs += 60000; };
function pnlSetup(ctl) {
    const k = make({ ctl: { ...(ctl || {}) } });
    k.legs.LONG_BASE.state.entryPrice = 100; k.legs.SHORT_BASE.state.entryPrice = 100;
    return k;
}
t("P1 PNL: LONG base under water opens the SHORT NRML hedge in the LONG account; back in profit closes it", async () => {
    const { c, orders, clk, legs, px } = pnlSetup(); clk.minutes = 0;
    await c.tick(); legs.LONG_BASE.state.entryPrice = 100; legs.SHORT_BASE.state.entryPrice = 100; orders.length = 0;   // bases entered
    minute(clk, 1); px.price = 99; await c.tick();
    assert.deepStrictEqual(orders, ["ENTER LONG_HEDGE NRML SHORT (BASE LOSS HEDGE)"], "short base is in profit at 99 -> no hedge for it");
    minute(clk, 2); px.price = 98.5; await c.tick(); assert.deepStrictEqual(orders.length, 1, "no duplicate");
    minute(clk, 3); px.price = 101; await c.tick();
    assert.deepStrictEqual(orders.slice(1), ["EXIT LONG_HEDGE (BASE BACK IN PROFIT)", "ENTER SHORT_HEDGE NRML LONG (BASE LOSS HEDGE)"], "price up: long hedge off, the SHORT base is now the loser");
});
t("P2 PNL: evaluated once per minute; between minutes nothing changes", async () => {
    const { c, orders, clk, legs, px } = pnlSetup(); await c.tick(); legs.LONG_BASE.state.entryPrice = 100; legs.SHORT_BASE.state.entryPrice = 100; orders.length = 0;
    minute(clk, 1); px.price = 99; await c.tick(); const n = orders.length; px.price = 101; await c.tick(); await c.tick();
    assert.strictEqual(orders.length, n, "same minute -> no second decision");
});
t("P3 PNL: band keeps the hedge off for small losses; exactly flat does nothing", async () => {
    const { c, orders, clk, legs, px } = pnlSetup({ pnlBand: 1 }); await c.tick(); legs.LONG_BASE.state.entryPrice = 100; legs.SHORT_BASE.state.entryPrice = 100; orders.length = 0;
    minute(clk, 1); px.price = 99.5; await c.tick(); assert.deepStrictEqual(orders, []);
    minute(clk, 2); px.price = 100; await c.tick(); assert.deepStrictEqual(orders, []);
    minute(clk, 3); px.price = 98.9; await c.tick(); assert.strictEqual(orders.length, 1);
});
t("P4 PNL: a failed hedge exit is retried within the same minute; stale price skips; EOD still flattens", async () => {
    const { c, orders, clk, legs, px, failExit } = pnlSetup(); await c.tick(); legs.LONG_BASE.state.entryPrice = 100; legs.SHORT_BASE.state.entryPrice = 100; orders.length = 0;
    minute(clk, 1); px.price = 99; await c.tick();
    failExit.add("LONG_HEDGE"); minute(clk, 2); px.price = 100.5; assert.strictEqual(await c.tick(), "EXIT_PENDING");
    failExit.clear(); assert.strictEqual(await c.tick(), "OK"); assert.ok(orders.includes("EXIT LONG_HEDGE (BASE BACK IN PROFIT)"));
    clk.hours = 23; clk.minutes = 20; await c.tick(); await c.tick(); assert.ok(Object.values(legs).every(l => !l.state.position), "flat at EOD");
});
t("P5 PNL smoothing averages the last N samples", async () => {
    const { c, orders, clk, legs, px } = pnlSetup({ pnlSmooth: 3 }); await c.tick(); legs.LONG_BASE.state.entryPrice = 100; legs.SHORT_BASE.state.entryPrice = 100; orders.length = 0;
    minute(clk, 1); px.price = 101; await c.tick(); minute(clk, 2); px.price = 101; await c.tick();
    minute(clk, 3); px.price = 99; await c.tick();        // pnl samples 1,1,-1 -> mean 0.33 > 0 -> still no long hedge
    assert.ok(!orders.some(o => /LONG_HEDGE/.test(o)));
});
t("C1 carry: at EOD only the MIS hedge closes, the NRML bases stay; next day bases are not entered again and the hedge is managed normally", async () => {
    const { c, orders, clk, legs, px } = make({ ctl: { carry: true } });
    await c.tick(); minute(clk, 1); px.price = 99; await c.tick(); assert.ok(legs.LONG_HEDGE.state.position); orders.length = 0;
    clk.hours = 23; clk.minutes = 20; assert.strictEqual(await c.tick(), "EOD_DONE");
    assert.deepStrictEqual(orders, ["EXIT LONG_HEDGE (EOD)"], "only the hedge is closed");
    assert.ok(legs.LONG_BASE.state.position && legs.SHORT_BASE.state.position && !legs.LONG_HEDGE.state.position, "bases held");
    orders.length = 0; minute(clk, 21); px.price = 98; await c.tick(); assert.deepStrictEqual(orders, [], "no hedge after EOD");
    clk.today = "2026-11-13"; clk.hours = 9; clk.minutes = 15; clk.nowMs += 86400000; c.restore({ baseEnteredOn: {} }); px.price = 100;   // next morning
    await c.tick(); assert.deepStrictEqual(orders, [], "held bases are not entered again");
    minute(clk, 16); px.price = 97; await c.tick(); assert.ok(orders.some(o => /ENTER LONG_HEDGE/.test(o)), "hedge opens again while the base loses");
});
t("1 base legs entered once per day at the base time, never re-entered", async () => {
    const { c, orders, legs, clk } = make();
    clk.hours = 9; clk.minutes = 0; assert.strictEqual(await c.tick(), "WAITING"); assert.deepStrictEqual(orders, []);
    clk.hours = 9; clk.minutes = 15; await c.tick(); await c.tick();
    assert.deepStrictEqual(orders, ["ENTER LONG_BASE MIS LONG (BASE)", "ENTER SHORT_BASE MIS SHORT (BASE)"]);
    legs.LONG_BASE.state.position = null; await c.tick(); assert.strictEqual(orders.length, 2);
});
// ---- daily Heikin-Ashi base rule: ONE NRML base by colour, closed at EOD with its hedge; P&L checked every N minutes ----
function haSetup(bias, extra) { const b = { v: bias, n: 0 }; const k = make({ ctl: { carry: true, checkMinutes: 5, getDailyBias: async () => { b.n++; return b.v; }, ...(extra || {}) } }); k.b = b; return k; }
t("HA1 green daily candle: only the LONG account takes an NRML base; losing -> MIS short hedge on the 5-min check; profit -> off; EOD closes hedge + base", async () => {
    const { c, orders, clk, legs, px } = haSetup("LONG"); clk.minutes = 0;
    await c.tick(); assert.deepStrictEqual(orders, ["ENTER LONG_BASE MIS LONG (BASE)"], "only the LONG base (the fake labels every base MIS)");
    assert.ok(!legs.SHORT_BASE.state.position, "no SHORT base on a green day");
    px.price = 99; for (const m of [1, 2, 3, 4]) { minute(clk, m); await c.tick(); }
    assert.strictEqual(orders.length, 1, "minutes 1-4: no check");
    minute(clk, 5); await c.tick(); assert.strictEqual(orders[1], "ENTER LONG_HEDGE NRML SHORT (BASE LOSS HEDGE)", "5th minute: base < 0 -> hedge");
    px.price = 101; for (const m of [6, 7, 8, 9]) { minute(clk, m); await c.tick(); } assert.strictEqual(orders.length, 2, "hedge stays until the next check");
    minute(clk, 10); await c.tick(); assert.strictEqual(orders[2], "EXIT LONG_HEDGE (BASE BACK IN PROFIT)");
    px.price = 99; minute(clk, 15); await c.tick(); assert.strictEqual(orders[3], "ENTER LONG_HEDGE NRML SHORT (BASE LOSS HEDGE)", "loses again -> hedge again");
    clk.hours = 23; clk.minutes = 20; clk.nowMs += 3600000; px.atMs = undefined; const r = await c.tick();
    assert.strictEqual(r, "EOD_DONE"); assert.deepStrictEqual(orders.slice(4), ["EXIT LONG_HEDGE (EOD)", "EXIT LONG_BASE (EOD)"], "hedge first, then the NRML base");
    assert.ok(!legs.LONG_BASE.state.position && !legs.LONG_HEDGE.state.position);
});
t("HA2 red daily candle: only the SHORT account takes the base; the LONG account stays idle", async () => {
    const { c, orders, clk, legs, px } = haSetup("SHORT"); clk.minutes = 0;
    await c.tick(); assert.deepStrictEqual(orders, ["ENTER SHORT_BASE MIS SHORT (BASE)"]);
    px.price = 101; minute(clk, 5); await c.tick(); assert.strictEqual(orders[1], "ENTER SHORT_HEDGE NRML LONG (BASE LOSS HEDGE)");
    assert.ok(!legs.LONG_BASE.state.position && !legs.LONG_HEDGE.state.position, "LONG account never trades");
});
t("HA3 no colour yet (doji / no data): waits, places nothing, then enters once a colour arrives", async () => {
    const k = haSetup(null); k.clk.minutes = 0;
    assert.strictEqual(await k.c.tick(), "WAITING"); assert.strictEqual(k.orders.length, 0);
    k.b.v = "LONG"; minute(k.clk, 1); await k.c.tick(); assert.deepStrictEqual(k.orders, ["ENTER LONG_BASE MIS LONG (BASE)"]);
    const n = k.b.n; minute(k.clk, 2); await k.c.tick(); assert.strictEqual(k.b.n, n, "colour is read once per day once known");
});
t("HA4 a new IST day re-reads the colour (green yesterday, red today -> the SHORT base)", async () => {
    const k = haSetup("LONG"); k.clk.minutes = 0; await k.c.tick();
    k.clk.hours = 23; k.clk.minutes = 20; await k.c.tick();                       // EOD flat
    k.clk.today = "2026-11-13"; k.clk.hours = 10; k.clk.minutes = 0; k.clk.nowMs += 86400000; k.b.v = "SHORT"; k.orders.length = 0;
    await k.c.tick(); assert.deepStrictEqual(k.orders, ["ENTER SHORT_BASE MIS SHORT (BASE)"]);
});
t("P2b checkMinutes=5: only clock-aligned minutes (:00,:05,...) decide; other minutes never hedge", async () => {
    const { c, orders, clk, legs, px } = pnlSetup({ checkMinutes: 5 }); clk.minutes = 0; await c.tick(); legs.LONG_BASE.state.entryPrice = 100; legs.SHORT_BASE.state.entryPrice = 100; orders.length = 0;
    px.price = 99; for (const m of [1, 2, 3, 4]) { minute(clk, m); await c.tick(); }
    assert.strictEqual(orders.length, 0, "minutes 1-4 are not check minutes");
    minute(clk, 5); await c.tick();
    assert.deepStrictEqual(orders, ["ENTER LONG_HEDGE NRML SHORT (BASE LOSS HEDGE)"]);
    px.price = 101; for (const m of [6, 7, 8, 9]) { minute(clk, m); await c.tick(); }
    assert.strictEqual(orders.length, 1, "hedge stays on until the next check minute");
    minute(clk, 10); await c.tick();
    assert.strictEqual(orders[1], "EXIT LONG_HEDGE (BASE BACK IN PROFIT)");
});
t("P2c checkMinutes must be 1-60", () => { assert.throws(() => make({ ctl: { checkMinutes: 0.5 } }).c || (() => { throw new Error("x"); })()); });
t("P6 a rejected hedge entry leaves state clean and retries", async () => {
    const k = pnlSetup({}); k.failEnter.add("LONG_HEDGE"); await k.c.tick(); minute(k.clk, 1); k.px.price = 99; await k.c.tick();
    assert.strictEqual(k.legs.LONG_HEDGE.state.position, null); k.failEnter.clear(); await k.c.tick();
    assert.strictEqual(k.legs.LONG_HEDGE.state.position, "SHORT", "retried");
});
t("P7 no hedge while the losing base is not open; blocked legs never trade; stale price decides nothing", async () => {
    const a = pnlSetup({}); a.failEnter.add("LONG_BASE"); await a.c.tick(); minute(a.clk, 1); a.px.price = 99; await a.c.tick();
    assert.ok(!a.orders.some(o => o.includes("HEDGE")), "LONG base missing -> nothing to hedge");
    const b = pnlSetup({}); b.legs.LONG_BASE.blocked = true; await b.c.tick(); assert.ok(!b.orders.some(o => o.includes("LONG_BASE")));
    const s = pnlSetup({}); await s.c.tick(); minute(s.clk, 1); s.px.price = 99; s.px.atMs = -1e9; s.orders.length = 0; await s.c.tick();
    assert.deepStrictEqual(s.orders, [], "stale price");
});
t("P8 day mode EOD: hedge closed first, then both bases, retried until flat", async () => {
    const { c, orders, clk, failExit, px } = pnlSetup({}); await c.tick(); minute(clk, 1); px.price = 99; await c.tick(); orders.length = 0;
    clk.hours = 23; clk.minutes = 20; failExit.add("LONG_HEDGE");
    assert.strictEqual(await c.tick(), "EOD_PENDING"); assert.deepStrictEqual(orders, [], "bases untouched while the hedge is open");
    failExit.clear(); assert.strictEqual(await c.tick(), "EOD_DONE");
    assert.deepStrictEqual(orders, ["EXIT LONG_HEDGE (EOD)", "EXIT LONG_BASE (EOD)", "EXIT SHORT_BASE (EOD)"]);
});
t("P9 restart: restored state does not duplicate bases or the resumed hedge", async () => {
    const { c, orders, clk, legs, px } = pnlSetup({});
    legs.LONG_BASE.state.position = "LONG"; legs.SHORT_BASE.state.position = "SHORT"; legs.LONG_BASE.state.entryPrice = 100; legs.SHORT_BASE.state.entryPrice = 100; legs.LONG_HEDGE.state.position = "SHORT";
    c.restore({ baseEnteredOn: { LONG_BASE: clk.today, SHORT_BASE: clk.today } });
    minute(clk, 1); px.price = 99; await c.tick(); await c.tick(); assert.deepStrictEqual(orders, []);
});
(async () => { let f = 0; for (const [n, fn] of T) { try { await fn(); console.log("  ok  ", n); } catch (e) { f++; console.log("  FAIL", n, "\n", e.stack); } } console.log(f ? f + " failed" : "all passed"); process.exit(f ? 1 : 0); })();
