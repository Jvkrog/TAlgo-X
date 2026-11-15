// priceMaSignal: 1-minute average of websocket LTPs -> slope -> GREEN / RED / NEUTRAL.
"use strict";
const assert = require("assert");
const { createPriceMaSignal } = require("../hedge/priceMaSignal");
const M = 60000, T0 = Date.UTC(2026, 10, 12, 4, 0, 0);   // any minute boundary
const feed = (s, minute, prices) => { let out = []; prices.forEach((p, i) => out = out.concat(s.addTick(p, T0 + minute * M + i * 1000))); return out; };
const T = [], t = (n, f) => T.push([n, f]);

t("average of the minute's ticks (spec example) and variable tick counts", () => {
    const s = createPriceMaSignal();
    feed(s, 0, [300.00, 300.10, 300.20, 300.15, 300.30]);
    const ev = s.addTick(300, T0 + M)[0];
    assert.strictEqual(ev.ma, 300.15); assert.strictEqual(ev.n, 5); assert.strictEqual(ev.prevMa, null); assert.strictEqual(ev.signal, null);
    feed(s, 1, [300.1, 300.2]);                                  // 3 ticks incl. the one above
    const ev2 = s.flush(T0 + 2 * M)[0];
    assert.strictEqual(ev2.n, 3);
});
t("slope sign -> GREEN / RED, equal -> NEUTRAL keeps the standing signal", () => {
    const s = createPriceMaSignal(); const got = [];
    const closeMin = (m, p) => { feed(s, m, [p]); const e = s.flush(T0 + (m + 1) * M)[0]; got.push(e); return e; };
    closeMin(0, 100);                                              // baseline
    assert.strictEqual(closeMin(1, 100.5).signal, "GREEN");
    const n = closeMin(2, 100.5); assert.strictEqual(n.raw, "NEUTRAL"); assert.strictEqual(n.signal, "GREEN", "NEUTRAL keeps GREEN"); assert.ok(!n.transition);
    const r = closeMin(3, 100.2); assert.strictEqual(r.signal, "RED"); assert.ok(r.transition && r.from === "GREEN"); assert.strictEqual(r.slope, -0.3);
});
t("empty minute produces no MA; ws gap discards the stale MA (no signal from stale prices)", () => {
    const s = createPriceMaSignal({ maxGapMinutes: 2 });
    feed(s, 0, [100]); s.flush(T0 + M);
    assert.deepStrictEqual(s.flush(T0 + 5 * M), [], "nothing to close, no 0/0");
    feed(s, 6, [105]);                                             // 6 minutes later: more than the allowed gap
    const ev = s.flush(T0 + 7 * M)[0];
    assert.strictEqual(ev.prevMa, null); assert.strictEqual(ev.signal, null, "baseline only, no GREEN from a stale comparison");
    feed(s, 7, [106]); assert.strictEqual(s.flush(T0 + 8 * M)[0].signal, "GREEN", "next minute compares normally");
});
t("invalid ticks ignored", () => {
    const s = createPriceMaSignal();
    for (const bad of [0, -1, NaN, null, undefined, "300", Infinity]) assert.deepStrictEqual(s.addTick(bad, T0), []);
    feed(s, 0, [200]); const ev = s.flush(T0 + M)[0]; assert.strictEqual(ev.n, 1); assert.strictEqual(ev.ma, 200);
});
t("late tick for a closed minute is ignored", () => {
    const s = createPriceMaSignal(); feed(s, 0, [100]); s.addTick(101, T0 + M);   // closes minute 0, opens minute 1
    assert.deepStrictEqual(s.addTick(500, T0 + 10), []); assert.strictEqual(s.flush(T0 + 2 * M)[0].ma, 101);
});
t("optional guards: minSlope makes small moves NEUTRAL; confirmMinutes delays the switch", () => {
    const a = createPriceMaSignal({ minSlope: 0.05 });
    feed(a, 0, [100]); a.flush(T0 + M); feed(a, 1, [100.03]); assert.strictEqual(a.flush(T0 + 2 * M)[0].raw, "NEUTRAL");
    const b = createPriceMaSignal({ confirmMinutes: 2 });
    const step = (m, p) => { feed(b, m, [p]); return b.flush(T0 + (m + 1) * M)[0]; };
    step(0, 100); assert.strictEqual(step(1, 101).signal, null, "first green not yet confirmed"); assert.strictEqual(step(2, 102).signal, "GREEN");
    assert.strictEqual(step(3, 101.5).signal, "GREEN", "one red minute is not enough"); assert.strictEqual(step(4, 101).signal, "RED");
});
t("restore keeps the previous MA and signal", () => {
    const a = createPriceMaSignal(); feed(a, 0, [100]); a.flush(T0 + M); feed(a, 1, [101]); a.flush(T0 + 2 * M);
    const b = createPriceMaSignal(); b.restore(JSON.parse(JSON.stringify(a.getState())));
    feed(b, 2, [100]); assert.strictEqual(b.flush(T0 + 3 * M)[0].signal, "RED");
});
(async () => { let f = 0; for (const [n, fn] of T) { try { await fn(); console.log("  ok  ", n); } catch (e) { f++; console.log("  FAIL", n, "\n", e.stack); } } console.log(f ? f + " failed" : "all passed"); process.exit(f ? 1 : 0); })();
