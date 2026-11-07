// riskState.js — persists the live stop-loss trail and profit target so a restart with a position open resumes
// with the trailed stop it had, not a fresh one from the entry price (previously a known gap: restarts reset both).
//
//   attachRiskPersistence(...)  wraps the stores' setters; writes are debounced (one DB write per second at most)
//   restoreRiskState(...)       after the strategy has resumed a position, re-applies the saved trail/target —
//                               only if they belong to THIS position (same side and entry price) and, for the
//                               trail, only if they are tighter than what the strategy just rebuilt.
"use strict";

const SAVE_EVERY_MS = 1000;

function attachRiskPersistence({ slStore, targetStore, db, context, state }) {
    if (!db || typeof db.saveRiskState !== "function") return { flush() {} };
    let timer = null, dirty = false;

    function snapshot() {
        const { trail, dir } = slStore.getTrail();
        const t = targetStore.getTarget();
        return {
            position: state.position || null, entryPrice: state.entryPrice || 0,
            trail: trail ?? null, trailDir: dir || 0, target: t.target ?? null, targetDir: t.dir || 0,
        };
    }
    function flush() {
        if (timer) { clearTimeout(timer); timer = null; }
        if (!dirty) return;
        dirty = false;
        db.saveRiskState(context.tgPrefix, context.token, snapshot());
    }
    function touch(immediate) {
        dirty = true;
        if (immediate) return flush();
        if (!timer) timer = setTimeout(() => { timer = null; flush(); }, SAVE_EVERY_MS);
    }
    for (const [store, setters] of [[slStore, ["setTrail", "clearTrail"]], [targetStore, ["setTarget", "clearTarget"]]]) {
        for (const name of setters) {
            const orig = store[name].bind(store), immediate = name.startsWith("clear");
            store[name] = (...a) => { const r = orig(...a); touch(immediate); return r; };
        }
    }
    return { flush };
}

async function restoreRiskState({ slStore, targetStore, db, context, state }) {
    if (!state.position || !db || typeof db.loadRiskState !== "function") return null;
    const row = await db.loadRiskState(context.tgPrefix, context.token);
    if (!row || row.position !== state.position || !Number.isFinite(row.entry_price)
        || Math.abs(row.entry_price - (state.entryPrice || 0)) > 1e-6) return null;
    const dir = state.position === "LONG" ? 1 : -1, restored = {};
    if (Number.isFinite(row.trail) && row.trail_dir === dir) {
        const cur = slStore.getTrail();
        const tighter = cur.trail == null || (dir === 1 ? row.trail > cur.trail : row.trail < cur.trail);
        if (tighter) { slStore.setTrail(row.trail, dir); restored.trail = row.trail; }
    }
    if (Number.isFinite(row.target) && row.target_dir === dir && targetStore.getTarget().target == null) {
        targetStore.setTarget(row.target, dir); restored.target = row.target;
    }
    return restored;
}

module.exports = { attachRiskPersistence, restoreRiskState };
