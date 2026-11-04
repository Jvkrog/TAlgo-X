// Linked hedge-pair legs must appear in the Hedge Pairs panel (with Edit/Logs per leg), not in the normal engine list.
const assert = require("assert"), fs = require("fs"), vm = require("vm");
const ui = fs.readFileSync(__dirname + "/webdash/public/app.js", "utf8");
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
console.log(`\nall ${n} passed`);
