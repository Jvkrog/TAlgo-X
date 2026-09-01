// strategyBuilder.js — "Create Your Own Strategy" wizard modal. Same
// custom_strategies.db and same flat-AND/flat-OR condition model as the
// toolbox "U" CLI wizard (toolbox.js) — a strategy built in one place is
// deployable from the other, since both write through customStrategyDb and
// both /api/toolbox/strategies (deploy list) and /api/toolbox/instrument
// (deploy) resolve custom names the same way.
//
// Loaded before app.js (see index.html) — self-wires its own button/modal
// the same top-level-script way app.js wires tbOpenAddInstrument, no
// dependency on app.js internals.

const tbCustomModal = document.getElementById("tbCustomModal");
const tbCustomBody  = document.getElementById("tbCustomBody");
const tbCustomClose = document.getElementById("tbCustomClose");

tbCustomClose.addEventListener("click", () => tbCustomModal.classList.remove("open"));
tbCustomModal.addEventListener("click", e => { if (e.target === tbCustomModal) tbCustomModal.classList.remove("open"); });
document.getElementById("tbOpenCustomStrategy").addEventListener("click", openCustomStrategyModal);

let csbState = {};       // wizard-in-progress state
let csbIndicatorCatalog = null;

const CSB_TIMEFRAMES = ["5m", "15m", "30m", "1h"]; // tick mode intentionally excluded — see chat
const CSB_OPERATORS = [">", "<", ">=", "<=", "==", "crosses_above", "crosses_below", "state_flips_to"];
// Human-readable labels for the operator <select> — the raw strings above
// are still what gets saved (matches conditionEvaluator.js exactly), this
// is display-only so "state_flips_to" isn't just another unlabeled
// technical string buried at the bottom of the list.
const CSB_OPERATOR_LABELS = {
    ">": ">", "<": "<", ">=": ">=", "<=": "<=", "==": "== (equals)",
    crosses_above: "crosses above",
    crosses_below: "crosses below",
    state_flips_to: "state flips to \u2014 slope/regime change",
};

async function openCustomStrategyModal() {
    csbState = { candleType: null, timeframe: null, indicators: [], entryLong: [], entryShort: [], exitConfig: {} };
    tbCustomBody.innerHTML = `<div class="tb-form-hint">loading indicator catalog...</div>`;
    tbCustomModal.classList.add("open");
    try {
        if (!csbIndicatorCatalog) {
            const data = await (await fetch("/api/strategy-builder/indicators")).json();
            csbIndicatorCatalog = data.indicators;
        }
        renderCsbStep1();
    } catch (err) {
        tbCustomBody.innerHTML = `<div class="tb-err-box">failed to load indicators: ${err.message}</div>`;
    }
}

function csbStepHeader(n, label) {
    return `<div class="tb-form-hint">step ${n} of 7 — ${label}</div>`;
}

// ─── Step 1 — Candle Type ───────────────────────────────────────────────
function renderCsbStep1() {
    tbCustomBody.innerHTML = `
        ${csbStepHeader(1, "candle type")}
        <div class="tb-form-row">
            <div class="tb-mode-choice" id="csbCandleChoice">
                <button data-val="raw">Raw</button>
                <button data-val="ha">Heikin-Ashi</button>
            </div>
        </div>
        <button class="btn" id="csbNext1">Next \u2192</button>
    `;
    const btns = tbCustomBody.querySelectorAll("#csbCandleChoice button");
    btns.forEach(b => b.addEventListener("click", () => {
        btns.forEach(x => x.classList.remove("picked"));
        b.classList.add("picked");
        csbState.candleType = b.dataset.val;
    }));
    tbCustomBody.querySelector("#csbNext1").addEventListener("click", () => {
        if (!csbState.candleType) return;
        renderCsbStep2();
    });
}

// ─── Step 2 — Time Frame ────────────────────────────────────────────────
function renderCsbStep2() {
    tbCustomBody.innerHTML = `
        ${csbStepHeader(2, "time frame")}
        <div class="tb-form-row">
            <div class="tb-mode-choice" id="csbTfChoice">
                ${CSB_TIMEFRAMES.map(tf => `<button data-val="${tf}">${tf}</button>`).join("")}
            </div>
        </div>
        <button class="tb-back-link" id="csbBack2">\u2039 back</button>
        <button class="btn" id="csbNext2">Next \u2192</button>
    `;
    const btns = tbCustomBody.querySelectorAll("#csbTfChoice button");
    btns.forEach(b => b.addEventListener("click", () => {
        btns.forEach(x => x.classList.remove("picked"));
        b.classList.add("picked");
        csbState.timeframe = b.dataset.val;
    }));
    tbCustomBody.querySelector("#csbBack2").addEventListener("click", renderCsbStep1);
    tbCustomBody.querySelector("#csbNext2").addEventListener("click", () => {
        if (!csbState.timeframe) return;
        renderCsbStep3();
    });
}

// ─── Step 3 — Indicators (multi-select checkboxes) ──────────────────────
// requiresCandles filter is a no-op today (everything requires candles
// until tick mode exists) — kept so this already reads from the right
// gate instead of a second pass being needed later.
function renderCsbStep3() {
    const keys = Object.keys(csbIndicatorCatalog).filter(k => csbIndicatorCatalog[k].requiresCandles);
    tbCustomBody.innerHTML = `
        ${csbStepHeader(3, "indicators — pick building blocks")}
        <div class="tb-pick-list" id="csbIndicatorList">
            ${keys.map(k => `
                <label class="tb-form-row" style="cursor:pointer">
                    <input type="checkbox" value="${k}" class="csbIndicatorCheck">
                    ${csbIndicatorCatalog[k].label}
                </label>
            `).join("")}
        </div>
        <div class="tb-form-hint" id="csbIndicatorHint"></div>
        <button class="tb-back-link" id="csbBack3">\u2039 back</button>
        <button class="btn" id="csbNext3">Next \u2192</button>
    `;
    tbCustomBody.querySelector("#csbBack3").addEventListener("click", renderCsbStep2);
    tbCustomBody.querySelector("#csbNext3").addEventListener("click", () => {
        const checked = Array.from(tbCustomBody.querySelectorAll(".csbIndicatorCheck:checked")).map(cb => cb.value);
        if (checked.length === 0) {
            tbCustomBody.querySelector("#csbIndicatorHint").textContent = "pick at least one indicator";
            return;
        }
        csbState.pendingIndicatorTypes = checked;
        renderCsbStep4();
    });
}

// ─── Step 4 — Configure each selected indicator ─────────────────────────
function renderCsbStep4() {
    const types = csbState.pendingIndicatorTypes;
    tbCustomBody.innerHTML = `
        ${csbStepHeader(4, "configure indicators")}
        <div id="csbConfigList"></div>
        <div class="tb-form-hint" id="csbConfigHint"></div>
        <button class="tb-back-link" id="csbBack4">\u2039 back</button>
        <button class="btn" id="csbNext4">Next \u2192</button>
    `;
    const list = tbCustomBody.querySelector("#csbConfigList");
    types.forEach((type, i) => {
        const def = csbIndicatorCatalog[type];
        const row = document.createElement("div");
        row.className = "tb-form-row";
        row.innerHTML = `
            <div class="tb-form-label">${def.label}</div>
            <label>id <input type="text" class="csbIndId" data-type="${type}" placeholder="${type.toLowerCase()}_1" style="width:110px"></label>
            ${def.params.map(p => `<label>${p.label} <input type="number" class="csbIndParam" data-type="${type}" data-key="${p.key}" value="${p.default}" step="any" style="width:90px"></label>`).join("")}
        `;
        list.appendChild(row);
    });
    tbCustomBody.querySelector("#csbBack4").addEventListener("click", renderCsbStep3);
    tbCustomBody.querySelector("#csbNext4").addEventListener("click", () => {
        const indicators = [];
        const idInputs = tbCustomBody.querySelectorAll(".csbIndId");
        const usedIds = new Set();
        for (const idInput of idInputs) {
            const type = idInput.dataset.type;
            const id = idInput.value.trim() || `${type.toLowerCase()}_1`;
            if (usedIds.has(id)) {
                tbCustomBody.querySelector("#csbConfigHint").textContent = `duplicate id "${id}" — ids must be unique`;
                return;
            }
            usedIds.add(id);
            const params = {};
            tbCustomBody.querySelectorAll(`.csbIndParam[data-type="${type}"]`).forEach(inp => {
                params[inp.dataset.key] = Number(inp.value);
            });
            indicators.push({ id, type, params });
        }
        csbState.indicators = indicators;
        renderCsbStep5("entryLong", "ENTRY \u2014 LONG", renderCsbStep5Short);
    });
}

// ─── Step 5 — Entry Conditions (flat AND list, long then short) ─────────
function csbOperandOptions() {
    const opts = [];
    csbState.indicators.forEach(ind => {
        csbIndicatorCatalog[ind.type].exposes.forEach(field => opts.push(`${ind.id}.${field}`));
    });
    opts.push("price.close", "price.high", "price.low");
    return opts;
}

// Colors condition-builder state values by slope direction, using the same
// green/red/dim vocabulary as the rest of the dashboard (up=green,
// down=red, flat/neutral=dim) — see indicatorCatalog.js's `states` field.
const CSB_STATE_COLOR_VAR = { green: "var(--green)", red: "var(--red)", dim: "var(--dim)" };

// Given "indicatorId.field", finds that block's catalog entry and returns
// its `states` list if the field is "state" and the catalog defines one —
// null otherwise (indicator not selected, wrong field, or no states defined
// yet, e.g. ADX/ALMA/EMA which only expose "value").
function csbLookupStates(operandRef) {
    if (!operandRef || operandRef.startsWith("price.")) return null;
    const [id, field] = operandRef.split(".");
    if (field !== "state") return null;
    const block = csbState.indicators.find(ind => ind.id === id);
    if (!block) return null;
    return csbIndicatorCatalog[block.type].states || null;
}

function csbConditionRowHTML(idx) {
    const operands = csbOperandOptions();
    return `
        <div class="tb-form-row csbConditionRow" data-idx="${idx}">
            <select class="csbLeft">${operands.map(o => `<option value="${o}">${o}</option>`).join("")}</select>
            <select class="csbOp">${CSB_OPERATORS.map(o => `<option value="${o}">${CSB_OPERATOR_LABELS[o]}</option>`).join("")}</select>
            <select class="csbRight csbRightOperand">${operands.map(o => `<option value="${o}">${o}</option>`).join("")}<option value="__const__">constant...</option></select>
            <input type="number" class="csbRightConst" placeholder="value" style="display:none;width:80px">
            <select class="csbRightState" style="display:none"></select>
            <input type="text" class="csbRightStateCustom" placeholder="state label" style="display:none;width:120px">
            <span class="csbAutoStateBadge" style="display:none;font-family:var(--font-mono);font-size:11px;padding:4px 8px;border-radius:6px;border:1px solid var(--border)"></span>
            <button class="tb-back-link csbRemoveRow" type="button">remove</button>
        </div>
    `;
}

// side: "long" | "short" | null. For entry condition lists, side is fixed
// by which tab the row belongs to — a slope/regime "state flips to"
// condition on a LONG entry only ever makes sense as "flips to a bullish
// (green) state", and on SHORT only as "flips to a bearish (red) state".
// Per request: don't ask the user to pick a color/label at all here — it's
// implied by the tab, and there's nothing to disable because nothing is
// shown to pick. Exit conditions (side === null) aren't long/short-scoped,
// so they keep the full state picker.
function wireCsbConditionRow(row, side = null) {
    const leftSel = row.querySelector(".csbLeft");
    const opSel = row.querySelector(".csbOp");
    const rightSel = row.querySelector(".csbRight");
    const rightConst = row.querySelector(".csbRightConst");
    const rightState = row.querySelector(".csbRightState");
    const rightStateCustom = row.querySelector(".csbRightStateCustom");
    const autoBadge = row.querySelector(".csbAutoStateBadge");

    // Colors the left/right operand <select> text itself when it points at
    // a .state field — a quick visual cue in the condition list, not just
    // in the state-picker dropdown below.
    function colorOperandSelect(sel) {
        const states = csbLookupStates(sel.value);
        sel.style.color = states ? "var(--green)" : "";
        sel.title = states ? "state-based operand" : "";
    }

    function populateStateOptions() {
        const states = csbLookupStates(leftSel.value);
        const impliedColor = side === "long" ? "green" : side === "short" ? "red" : null;
        const autoMatches = states && impliedColor ? states.filter(s => s.color === impliedColor) : [];

        if (states && autoMatches.length > 0) {
            // Auto mode — no picker shown, resolved states stored on the
            // row for parseConditionRows to read directly.
            row.dataset.autoStates = JSON.stringify(autoMatches.map(s => s.value));
            autoBadge.textContent = `auto: ${impliedColor.toUpperCase()} (${side} entry)`;
            autoBadge.style.display = "";
            autoBadge.style.color = CSB_STATE_COLOR_VAR[impliedColor];
            autoBadge.style.borderColor = CSB_STATE_COLOR_VAR[impliedColor];
            rightState.style.display = "none";
            rightStateCustom.style.display = "none";
        } else if (states) {
            // Known states, but no side context (exit conditions) or no
            // state of the implied color exists for this indicator — fall
            // back to the full manual picker.
            delete row.dataset.autoStates;
            autoBadge.style.display = "none";
            rightState.innerHTML = states.map(s =>
                `<option value="${s.value}" style="color:${CSB_STATE_COLOR_VAR[s.color] || "inherit"}">${s.value}</option>`
            ).join("") + `<option value="__custom__">custom...</option>`;
            rightState.style.display = "";
            rightStateCustom.style.display = "none";
        } else {
            // Left operand isn't a known .state field at all — free text.
            delete row.dataset.autoStates;
            autoBadge.style.display = "none";
            rightState.style.display = "none";
            rightStateCustom.style.display = "";
        }
    }

    function syncRightField() {
        const isStateFlip = opSel.value === "state_flips_to";
        rightSel.style.display = isStateFlip ? "none" : "";
        rightConst.style.display = (!isStateFlip && rightSel.value === "__const__") ? "" : "none";
        if (isStateFlip) populateStateOptions();
        else {
            delete row.dataset.autoStates;
            autoBadge.style.display = "none";
            rightState.style.display = "none";
            rightStateCustom.style.display = "none";
        }
        colorOperandSelect(leftSel);
    }

    rightState.addEventListener("change", () => {
        rightStateCustom.style.display = rightState.value === "__custom__" ? "" : "none";
    });
    leftSel.addEventListener("change", syncRightField);
    opSel.addEventListener("change", syncRightField);
    rightSel.addEventListener("change", syncRightField);
    row.querySelector(".csbRemoveRow").addEventListener("click", () => row.remove());
    syncRightField();
}

function parseConditionRows(container) {
    const conditions = [];
    for (const row of container.querySelectorAll(".csbConditionRow")) {
        const left = row.querySelector(".csbLeft").value;
        const operator = row.querySelector(".csbOp").value;

        if (operator === "state_flips_to" && row.dataset.autoStates) {
            // Auto (tab-implied) color mode — one or more catalog states
            // share that color (e.g. DPI has both STRONG_BULL and
            // BULL_LOW_EFF as "green"), so this expands into a single leaf
            // when there's only one match, or a nested OR sub-condition
            // when there's more than one. evaluateNode already handles a
            // mix of leaves and sub-trees inside an AND list, so this needs
            // no conditionEvaluator.js changes.
            const values = JSON.parse(row.dataset.autoStates);
            if (values.length === 1) {
                conditions.push({ left, operator, right: values[0] });
            } else if (values.length > 1) {
                conditions.push({
                    op: "OR",
                    conditions: values.map(v => ({ left, operator, right: v })),
                });
            }
            continue;
        }

        let right;
        if (operator === "state_flips_to") {
            const stateSel = row.querySelector(".csbRightState");
            right = (stateSel.style.display !== "none" && stateSel.value !== "__custom__")
                ? stateSel.value
                : row.querySelector(".csbRightStateCustom").value.trim();
        }
        else if (row.querySelector(".csbRight").value === "__const__") right = Number(row.querySelector(".csbRightConst").value);
        else right = row.querySelector(".csbRight").value;
        if (right === "" || right === null || (typeof right === "number" && Number.isNaN(right))) continue;
        conditions.push({ left, operator, right });
    }
    return conditions;
}

function renderCsbStep5(field, label, nextFn) {
    tbCustomBody.innerHTML = `
        ${csbStepHeader(5, label)}
        <div id="csbConditionList"></div>
        <button class="tb-back-link" id="csbAddCondition" type="button">+ add condition</button>
        <br><br>
        <button class="tb-back-link" id="csbBack5">\u2039 back</button>
        <button class="btn" id="csbNext5">Next \u2192</button>
    `;
    const list = tbCustomBody.querySelector("#csbConditionList");
    const side = field === "entryLong" ? "long" : field === "entryShort" ? "short" : null;
    let rowIdx = 0;
    function addRow() {
        const wrapper = document.createElement("div");
        wrapper.innerHTML = csbConditionRowHTML(rowIdx++);
        const row = wrapper.firstElementChild;
        list.appendChild(row);
        wireCsbConditionRow(row, side);
    }
    tbCustomBody.querySelector("#csbAddCondition").addEventListener("click", addRow);
    addRow(); // start with one row — matches toolbox CLI defaulting to prompting for condition #1 immediately

    tbCustomBody.querySelector("#csbBack5").addEventListener("click", field === "entryLong" ? renderCsbStep4 : () => renderCsbStep5("entryLong", "ENTRY \u2014 LONG", renderCsbStep5Short));
    tbCustomBody.querySelector("#csbNext5").addEventListener("click", () => {
        const conditions = parseConditionRows(list);
        csbState[field] = conditions.length ? { op: "AND", conditions } : null;
        nextFn();
    });
}
function renderCsbStep5Short() {
    renderCsbStep5("entryShort", "ENTRY \u2014 SHORT", renderCsbStep6);
}

// ─── Step 6 — Exit / Target / Risk ──────────────────────────────────────
function renderCsbStep6() {
    if (!csbState.entryLong && !csbState.entryShort) {
        tbCustomBody.innerHTML = `<div class="tb-err-box">need at least one entry side (long or short)</div>
            <button class="btn" id="csbBackToStep5">\u2039 back to entry conditions</button>`;
        tbCustomBody.querySelector("#csbBackToStep5").addEventListener("click", () => renderCsbStep5("entryLong", "ENTRY \u2014 LONG", renderCsbStep5Short));
        return;
    }
    const atrBlocks = csbState.indicators.filter(i => i.type === "ATR");
    tbCustomBody.innerHTML = `
        ${csbStepHeader(6, "exit / target / risk")}
        <div class="tb-form-row"><label><input type="checkbox" id="csbReversalExit" checked> exit on opposite entry signal</label></div>
        <div class="tb-form-row"><label><input type="checkbox" id="csbWantCondExit"> add an explicit exit condition too</label></div>
        <div id="csbCondExitBlock" style="display:none">
            <div id="csbCondExitList"></div>
            <button class="tb-back-link" id="csbAddCondExitRow" type="button">+ add exit condition (any true = exit)</button>
        </div>
        <div class="tb-form-row">
            <div class="tb-form-label">target</div>
            <select id="csbTargetType"><option value="none">none</option><option value="points">points</option></select>
            <input type="number" id="csbTargetValue" placeholder="points" style="display:none;width:90px">
        </div>
        <div class="tb-form-row">
            <div class="tb-form-label">stop-loss</div>
            <select id="csbSlType">
                <option value="none">none</option>
                <option value="atr" ${atrBlocks.length ? "" : "disabled"}>ATR ${atrBlocks.length ? "" : "(add an ATR indicator first)"}</option>
                <option value="points">points</option>
            </select>
            <input type="number" id="csbSlValue" placeholder="mult / points" style="display:none;width:90px">
            <select id="csbSlAtrRef" style="display:none">${atrBlocks.map(b => `<option value="${b.id}.value">${b.id}</option>`).join("")}</select>
        </div>
        <button class="tb-back-link" id="csbBack6">\u2039 back</button>
        <button class="btn" id="csbNext6">Preview \u2192</button>
    `;
    const condExitBlock = tbCustomBody.querySelector("#csbCondExitBlock");
    const condExitList = tbCustomBody.querySelector("#csbCondExitList");
    tbCustomBody.querySelector("#csbWantCondExit").addEventListener("change", e => {
        condExitBlock.style.display = e.target.checked ? "" : "none";
    });
    function addCondExitRow() {
        const wrapper = document.createElement("div");
        wrapper.innerHTML = csbConditionRowHTML(condExitList.children.length);
        const row = wrapper.firstElementChild;
        condExitList.appendChild(row);
        wireCsbConditionRow(row);
    }
    tbCustomBody.querySelector("#csbAddCondExitRow").addEventListener("click", addCondExitRow);
    addCondExitRow();

    const targetType = tbCustomBody.querySelector("#csbTargetType");
    const targetValue = tbCustomBody.querySelector("#csbTargetValue");
    targetType.addEventListener("change", () => targetValue.style.display = targetType.value === "points" ? "" : "none");

    const slType = tbCustomBody.querySelector("#csbSlType");
    const slValue = tbCustomBody.querySelector("#csbSlValue");
    const slAtrRef = tbCustomBody.querySelector("#csbSlAtrRef");
    slType.addEventListener("change", () => {
        slValue.style.display = slType.value === "none" ? "none" : "";
        slAtrRef.style.display = slType.value === "atr" ? "" : "none";
    });

    tbCustomBody.querySelector("#csbBack6").addEventListener("click", renderCsbStep5Short);
    tbCustomBody.querySelector("#csbNext6").addEventListener("click", () => {
        const wantCondExit = tbCustomBody.querySelector("#csbWantCondExit").checked;
        const condConditions = wantCondExit ? parseConditionRows(condExitList) : [];
        const exitConfig = {
            reversalExit: tbCustomBody.querySelector("#csbReversalExit").checked,
            conditionExit: condConditions.length ? { op: "OR", conditions: condConditions } : null,
            target: targetType.value === "points" && Number(targetValue.value) > 0 ? { type: "points", value: Number(targetValue.value) } : null,
            stopLoss: null,
        };
        if (slType.value === "atr" && Number(slValue.value) > 0) {
            exitConfig.stopLoss = { type: "atr", mult: Number(slValue.value), atrRef: slAtrRef.value };
        } else if (slType.value === "points" && Number(slValue.value) > 0) {
            exitConfig.stopLoss = { type: "points", value: Number(slValue.value) };
        }
        csbState.exitConfig = exitConfig;
        renderCsbStep7();
    });
}

// ─── Step 7 — Preview + Deploy ──────────────────────────────────────────
function renderCsbStep7() {
    tbCustomBody.innerHTML = `
        ${csbStepHeader(7, "preview + save")}
        <pre class="tb-preview-box">${JSON.stringify({
            candleType: csbState.candleType, timeframe: csbState.timeframe,
            indicators: csbState.indicators, entryLong: csbState.entryLong,
            entryShort: csbState.entryShort, exitConfig: csbState.exitConfig,
        }, null, 2)}</pre>
        <div class="tb-form-row">
            <div class="tb-form-label">strategy name</div>
            <input type="text" id="csbName" placeholder="e.g. dpi_adx_chop_breakout">
        </div>
        <div class="tb-form-hint" id="csbSaveHint"></div>
        <button class="tb-back-link" id="csbBack7">\u2039 back</button>
        <button class="btn" id="csbSave">Save</button>
    `;
    tbCustomBody.querySelector("#csbBack7").addEventListener("click", renderCsbStep6);
    tbCustomBody.querySelector("#csbSave").addEventListener("click", async () => {
        const name = tbCustomBody.querySelector("#csbName").value.trim();
        const hint = tbCustomBody.querySelector("#csbSaveHint");
        if (!name) { hint.textContent = "name required"; return; }
        hint.textContent = "saving...";
        try {
            const res = await fetch("/api/strategy-builder/custom-strategies", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name, candleType: csbState.candleType, timeframe: csbState.timeframe,
                    indicators: csbState.indicators, entryLong: csbState.entryLong,
                    entryShort: csbState.entryShort, exitConfig: csbState.exitConfig,
                }),
            });
            const data = await res.json();
            if (data.error) { hint.textContent = data.error; return; }
            hint.textContent = `saved "${data.name}" \u2014 deploy it via "add instrument", it now shows alongside the prebuilt list.`;
            setTimeout(() => tbCustomModal.classList.remove("open"), 1500);
        } catch (err) {
            hint.textContent = `save failed: ${err.message}`;
        }
    });
}
