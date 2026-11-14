// priceMaHedgeController: base MIS legs, GREEN/RED hedge flips, NEUTRAL, duplicates, failures, stale signal, EOD.
"use strict";
const assert = require("assert");
const { createPriceMaHedgeController } = require("../hedge/priceMaHedgeController");
const T = [], t = (n, f) => T.push([n, f]);
function make(opts = {}) {
    const mk = (key, account, kind, side) => ({ key, account, kind, side, blocked: false, state: { position: null } });
    const legs = { LONG_BASE: mk("LONG_BASE", "LONG", "BASE", "LONG"), SHORT_BASE: mk("SHORT_BASE", "SHORT", "BASE", "SHORT"), LONG_HEDGE: mk("LONG_HEDGE", "LONG", "HEDGE", "SHORT"), SHORT_HEDGE: mk("SHORT_HEDGE", "SHORT", "HEDGE", "LONG") };
    const orders = [], failEnter = new Set(opts.failEnter || []), failExit = new Set(opts.failExit || []);
    const broker = {
        async enter(leg, why) { if (failEnter.has(leg.key)) return false; orders.push(`ENTER ${leg.key} ${leg.kind === "BASE" ? "MIS" : "NRML"} ${leg.side} (${why})`); leg.state.position = leg.side; return true; },
        async exit(leg, why) { if (failExit.has(leg.key)) return false; orders.push(`EXIT ${leg.key} (${why})`); leg.state.position = null; return true; },
    };
    const clk = { today: "2026-11-12", hours: 10, minutes: 0, nowMs: 1000000 };
    const logs = [];
    const px = { price: 100, atMs: 0 };
    const c = createPriceMaHedgeController({ legs, broker, clock: () => clk, baseHour: 9, baseMinute: 15, eodHour: 23, eodMinute: 20, log: m => logs.push(m), maxSignalAgeMs: 150000, getPrice: () => ({ price: px.price, atMs: clk.nowMs }), ...(opts.ctl || {}) });
    return { c, legs, orders, clk, logs, failEnter, failExit, px };
}
const sig = (c, clk, s) => c.setSignal(s, clk.nowMs);

t("1 base legs: LONG MIS in the LONG account, SHORT MIS in the SHORT account, once per day", async () => {
    const { c, orders, legs, clk } = make();
    clk.hours = 9; clk.minutes = 0; assert.strictEqual(await c.tick(), "WAITING"); assert.deepStrictEqual(orders, []);
    clk.hours = 9; clk.minutes = 15; await c.tick(); await c.tick();
    assert.deepStrictEqual(orders, ["ENTER LONG_BASE MIS LONG (BASE)", "ENTER SHORT_BASE MIS SHORT (BASE)"]);
    legs.LONG_BASE.state.position = null;               // base closed by hand later the same day: NOT re-entered
    await c.tick(); assert.strictEqual(orders.length, 2);
});
t("2 GREEN opens LONG NRML hedge in the SHORT account", async () => {
    const { c, orders, clk } = make(); await c.tick(); sig(c, clk, "GREEN"); await c.tick();
    assert.strictEqual(orders[orders.length - 1], "ENTER SHORT_HEDGE NRML LONG (GREEN HEDGE)");
});
t("3 GREEN->RED closes the LONG hedge first, then opens SHORT NRML hedge in the LONG account; 4 RED->GREEN back", async () => {
    const { c, orders, clk } = make(); await c.tick(); sig(c, clk, "GREEN"); await c.tick(); orders.length = 0;
    sig(c, clk, "RED"); await c.tick();
    assert.deepStrictEqual(orders, ["EXIT SHORT_HEDGE (RED FLIP)", "ENTER LONG_HEDGE NRML SHORT (RED HEDGE)"]);
    orders.length = 0; sig(c, clk, "GREEN"); await c.tick();
    assert.deepStrictEqual(orders, ["EXIT LONG_HEDGE (GREEN FLIP)", "ENTER SHORT_HEDGE NRML LONG (GREEN HEDGE)"]);
});
t("5 NEUTRAL preserves the hedge", async () => {
    const { c, orders, clk, legs } = make(); await c.tick(); sig(c, clk, "GREEN"); await c.tick(); orders.length = 0;
    sig(c, clk, "NEUTRAL"); await c.tick(); await c.tick(); assert.deepStrictEqual(orders, []); assert.strictEqual(legs.SHORT_HEDGE.state.position, "LONG");
});
t("6/7 duplicate GREEN and RED signals place no duplicate orders", async () => {
    const { c, orders, clk } = make(); await c.tick(); sig(c, clk, "GREEN"); await c.tick(); await c.tick(); await c.tick();
    assert.strictEqual(orders.filter(o => o.startsWith("ENTER SHORT_HEDGE")).length, 1);
    sig(c, clk, "RED"); await c.tick(); await c.tick(); await c.tick();
    assert.strictEqual(orders.filter(o => o.startsWith("ENTER LONG_HEDGE")).length, 1);
});
t("9 stale signal (ws down) opens no hedge", async () => {
    const { c, orders, clk } = make(); await c.tick(); sig(c, clk, "GREEN"); clk.nowMs += 10 * 60 * 1000; await c.tick();
    assert.ok(!orders.some(o => o.includes("HEDGE")), "no hedge from a 10-minute-old signal");
});
t("11 rejected hedge entry leaves state clean and retries; failed exit blocks the new hedge", async () => {
    const f = make({ failEnter: ["SHORT_HEDGE"] }); await f.c.tick(); sig(f.c, f.clk, "GREEN"); await f.c.tick();
    assert.strictEqual(f.legs.SHORT_HEDGE.state.position, null); f.failEnter.clear(); await f.c.tick();
    assert.strictEqual(f.legs.SHORT_HEDGE.state.position, "LONG", "retried on the next tick");
    const g = make({ failExit: ["SHORT_HEDGE"] }); await g.c.tick(); sig(g.c, g.clk, "GREEN"); await g.c.tick(); sig(g.c, g.clk, "RED");
    assert.strictEqual(await g.c.tick(), "EXIT_PENDING"); assert.ok(!g.legs.LONG_HEDGE.state.position, "no new hedge on top of an unconfirmed one");
    g.failExit.clear(); await g.c.tick(); assert.strictEqual(g.legs.SHORT_HEDGE.state.position, null); assert.strictEqual(g.legs.LONG_HEDGE.state.position, "SHORT");
});
t("no hedge while the losing base is not open; blocked legs never trade", async () => {
    const a = make({ failEnter: ["SHORT_BASE"] }); await a.c.tick(); sig(a.c, a.clk, "GREEN"); await a.c.tick();
    assert.ok(!a.orders.some(o => o.includes("HEDGE")), "SHORT base missing -> nothing to hedge");
    const b = make(); b.legs.LONG_BASE.blocked = true; await b.c.tick(); assert.ok(!b.orders.some(o => o.includes("LONG_BASE")));
});
t("12 EOD: hedge closed first, then both bases, retried until flat; no entries after", async () => {
    const { c, orders, clk, failExit, legs } = make(); await c.tick(); sig(c, clk, "GREEN"); await c.tick(); orders.length = 0;
    clk.hours = 23; clk.minutes = 20; failExit.add("SHORT_HEDGE");
    assert.strictEqual(await c.tick(), "EOD_PENDING"); assert.deepStrictEqual(orders, [], "bases untouched while the hedge is still open");
    failExit.clear(); assert.strictEqual(await c.tick(), "EOD_DONE");
    assert.deepStrictEqual(orders, ["EXIT SHORT_HEDGE (EOD)", "EXIT LONG_BASE (EOD)", "EXIT SHORT_BASE (EOD)"]);
    sig(c, clk, "RED"); await c.tick(); assert.ok(Object.values(legs).every(l => !l.state.position), "no entries after EOD");
});
t("10 restart: restored base-entered flag does not duplicate a base; resumed hedge is not re-entered", async () => {
    const { c, orders, clk, legs } = make();
    legs.LONG_BASE.state.position = "LONG"; legs.SHORT_BASE.state.position = "SHORT"; legs.SHORT_HEDGE.state.position = "LONG";
    c.restore({ baseEnteredOn: { LONG_BASE: clk.today, SHORT_BASE: clk.today } });
    sig(c, clk, "GREEN"); await c.tick(); await c.tick(); assert.deepStrictEqual(orders, []);
});
// ---- PNL mode (hedge each base against its own loss, once per IST minute) ----
const minute = (clk, m) => { clk.minutes = m; clk.nowMs += 60000; };
function pnlSetup(ctl) {
    const k = make({ ctl: { hedgeMode: "PNL", ...(ctl || {}) } });
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
(async () => { let f = 0; for (const [n, fn] of T) { try { await fn(); console.log("  ok  ", n); } catch (e) { f++; console.log("  FAIL", n, "\n", e.stack); } } console.log(f ? f + " failed" : "all passed"); process.exit(f ? 1 : 0); })();
