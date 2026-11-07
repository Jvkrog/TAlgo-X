// SL trail / target persistence across a restart (core/riskState.js + db risk_state table).
"use strict";
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path");
process.env.TALGO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "talgo-rs-"));
const { createDb } = require("../data/db"), { createSLStore } = require("../core/sl"), { createTargetStore } = require("../core/target");
const { attachRiskPersistence, restoreRiskState } = require("../core/riskState");
const ctx = { name: "T", strategy: "X", tgPrefix: "T", candleType: "raw", token: 7, symbol: "S" };
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
    const db = createDb(ctx); db.initDB(); await sleep(300);
    // session 1: LONG@100, stop trails up to 104, target 110
    let state = { position: "LONG", entryPrice: 100 }, sl = createSLStore(), tg = createTargetStore();
    attachRiskPersistence({ slStore: sl, targetStore: tg, db, context: ctx, state });
    sl.setTrail(98, 1); sl.setTrail(104, 1); tg.setTarget(110, 1);
    await sleep(1300);                                              // debounce window
    // session 2 (restart): strategy rebuilt a fresh stop from entry (98) — saved, tighter 104 wins; target restored
    state = { position: "LONG", entryPrice: 100 }; sl = createSLStore(); tg = createTargetStore(); sl.setTrail(98, 1);
    let r = await restoreRiskState({ slStore: sl, targetStore: tg, db, context: ctx, state });
    assert.deepStrictEqual(sl.getTrail(), { trail: 104, dir: 1 }); assert.strictEqual(tg.getTarget().target, 110); assert.strictEqual(r.trail, 104);
    // a looser saved trail never loosens a tighter fresh one
    sl = createSLStore(); sl.setTrail(106, 1); tg = createTargetStore();
    await restoreRiskState({ slStore: sl, targetStore: tg, db, context: ctx, state }); assert.strictEqual(sl.getTrail().trail, 106);
    // different trade (other entry price / side) -> nothing restored
    sl = createSLStore(); tg = createTargetStore();
    assert.strictEqual(await restoreRiskState({ slStore: sl, targetStore: tg, db, context: ctx, state: { position: "LONG", entryPrice: 120 } }), null);
    assert.strictEqual(await restoreRiskState({ slStore: sl, targetStore: tg, db, context: ctx, state: { position: "SHORT", entryPrice: 100 } }), null);
    assert.strictEqual(sl.getTrail().trail, null);
    // exit clears immediately -> a later restart restores nothing
    state = { position: null, entryPrice: 0 }; sl = createSLStore(); tg = createTargetStore();
    attachRiskPersistence({ slStore: sl, targetStore: tg, db, context: ctx, state }); sl.clearTrail(); tg.clearTarget(); await sleep(200);
    sl = createSLStore(); tg = createTargetStore();
    assert.strictEqual(await restoreRiskState({ slStore: sl, targetStore: tg, db, context: ctx, state: { position: "LONG", entryPrice: 100 } }), null);
    console.log("PASS risk state persisted and restored (5 checks)"); process.exit(0);
})().catch(e => { console.error("FAIL", e); process.exit(1); });
