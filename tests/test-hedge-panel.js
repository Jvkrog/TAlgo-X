// Linked hedge-pair legs must appear in the Hedge Pairs panel (with Edit/Logs per leg), not in the normal engine list.
const assert = require("assert"), fs = require("fs"), vm = require("vm");
const ui = fs.readFileSync(__dirname + "/../webdash/public/app.js", "utf8");
const a = ui.indexOf("function renderToolboxList"), b = ui.indexOf("toolboxRefreshBtn.addEventListener");
assert(a > 0 && b > a, "render block not found");
function render(instruments, extra = []) {
    const mkBox = () => ({ html: "", children: [], set innerHTML(v) { this.html = v; if (v === "") this.children = []; }, get innerHTML() { return this.html; }, appendChild(c) { this.children.push(c); } });
    const toolboxList = mkBox(), hpList = mkBox(), dhList = mkBox();
    const ctx = { toolboxInstruments: instruments, toolboxExtra: extra, toolboxList, escHtml: s => String(s), candleTag: () => "",
        document: { createElement: () => ({ style: {}, set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h; } }), getElementById: id => (id === "hpList" ? hpList : dhList) }, Array, Set, String };
    vm.createContext(ctx); vm.runInContext(ui.slice(a, b) + "\nrenderToolboxList();", ctx);
    const text = box => box.html + box.children.map(c => (c._h || "") + (c.textContent || "")).join("\n");
    return { engines: text(toolboxList), hedge: text(hpList) };
}
const inst = (name, extra = {}) => ({ name, underlying: "NATGASMINI", strategy: "DSB_DUAL", status: "online", live: true, product: "MIS", ...extra });
let n = 0; const t = (m, f) => { f(); n++; console.log("  ok   " + m); };
t("linked legs are not listed as normal engines but appear in the hedge pairs panel with Edit and Logs", () => {
    const r = render([inst("plain1", { underlying: "GOLDM" }), inst("legA", { hedgeGroup: "P", hedgeRole: "A" }), inst("legB", { hedgeGroup: "P", hedgeRole: "B", strategy: "DAILY_HA_BIAS", product: "NRML" })]);
    assert.ok(r.engines.includes('data-name="plain1"')); assert.ok(!r.engines.includes("legA") && !r.engines.includes("legB"));
    for (const n of ["legA", "legB"]) { assert.ok(r.hedge.includes(`class="tb-check" data-name="${n}"`), n + " checkbox"); assert.ok(r.hedge.includes(`tb-row-edit" data-name="${n}"`)); assert.ok(r.hedge.includes(`tb-row-logs" data-name="${n}"`)); }
    assert.ok(r.hedge.includes("LINKED HEDGE PAIR") && r.hedge.includes("leg A") && r.hedge.includes("leg B"));
});
t("only linked legs deployed: engine list shows the empty state, hedge panel is not empty", () => {
    const r = render([inst("legA", { hedgeGroup: "P", hedgeRole: "A" })]); assert.ok(r.engines.includes("No engines detected")); assert.ok(!r.hedge.includes("None deployed"));
});
t("no linked legs: unchanged (hedge panel 'None deployed', engines all listed)", () => {
    const r = render([inst("x")]); assert.ok(r.hedge.includes("None deployed")); assert.ok(r.engines.includes('data-name="x"'));
});
t("old-style hedge pair rows still render; a pair with a linked group renders both", () => {
    const r = render([inst("legA", { hedgeGroup: "P", hedgeRole: "A" })], [{ kind: "hedgepair", name: "pp", label: "A / B", tag: "HEDGE PAIR", status: "online", live: false }]);
    assert.ok(r.hedge.includes('data-name="pp"') && r.hedge.includes('data-name="legA"'));
});
t("Edit handler is bound to the hedge pairs list too", () => assert.ok(/\[toolboxList, hpList\]\.forEach\(box => box\.addEventListener\("click", e => \{\s*const btn = e\.target\.closest\("\.tb-row-edit"\)/.test(ui)));


// ── home page: instrument cards vs Hedge Pairs panel ──
{
    const a2 = ui.indexOf("let linkedLegCount"), b2 = ui.indexOf("// ── hedge pair cards — main dashboard visibility"); assert(a2 > 0 && b2 > a2, "home render block not found");
    function home(instruments, hedgePairs = []) {
        const box = () => ({ html: "", kids: [], set innerHTML(v) { this.html = v; this.kids = []; }, get innerHTML() { return this.html; }, appendChild(c) { this.kids.push(c); } });
        const grid = box(), linkedPairsGrid = box(), hedgePairsPanel = { style: { display: "none" } }, engineCountEl = { textContent: "" };
        const ctx = { instruments, hedgePairs, grid, linkedPairsGrid, hedgePairsPanel, engineCountEl, renderedInstrumentNames: null, loaded: [],
            buildCard: i => ({ card: i.name }), loadEngineState: i => ctx.loaded.push(i.name), cardId: i => "card-" + i.name, document: { createElement: () => ({ style: {} }), getElementById: () => null }, Array, Set, String };
        vm.createContext(ctx); vm.runInContext(ui.slice(a2, b2) + "\nrenderInstruments();", ctx);
        return { grid, linkedPairsGrid, hedgePairsPanel, engineCountEl, loaded: ctx.loaded };
    }
    const I = (name, x = {}) => ({ name, underlying: "U", strategy: "S", status: "online", live: true, ...x });
    t("home: linked legs render in the Hedge Pairs panel (grouped, with header), not under Instruments", () => {
        const r = home([I("plain"), I("legA", { hedgeGroup: "P", hedgeRole: "A" }), I("legB", { hedgeGroup: "P", hedgeRole: "B" })]);
        assert.deepStrictEqual(r.grid.kids.map(k => k.card), ["plain"]);
        assert.deepStrictEqual(r.linkedPairsGrid.kids.filter(k => k.card).map(k => k.card), ["legA", "legB"]); assert.ok(r.linkedPairsGrid.kids[0].textContent.includes("LINKED HEDGE PAIR"));
        assert.strictEqual(r.hedgePairsPanel.style.display, ""); assert.strictEqual(r.engineCountEl.textContent, "1"); assert.deepStrictEqual(r.loaded.sort(), ["legA", "legB", "plain"]);
    });
    t("home: only legs deployed -> Instruments shows an empty note, panel visible; nothing linked -> panel hidden", () => {
        const r = home([I("legA", { hedgeGroup: "P", hedgeRole: "A" })]); assert.ok(r.grid.html.includes("No standalone engines")); assert.strictEqual(r.hedgePairsPanel.style.display, "");
        const q = home([I("plain")]); assert.strictEqual(q.hedgePairsPanel.style.display, "none"); assert.strictEqual(q.linkedPairsGrid.kids.length, 0);
    });
    t("home: loadHedgePairs keeps the panel visible while linked legs exist", () => assert.ok(/stays visible while linked-pair legs exist/.test(ui) && !/hedgePairsPanel\.style\.display = "none";\s*\n\s*return;/.test(ui)));
}
console.log("home page checks done");
console.log(`\nall ${n} passed`);
