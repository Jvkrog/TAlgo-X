// NSE index spot in the BACKTEST picker only: csvRepository exposes it separately; resolveCurrent resolves it; trading maps stay clean.
"use strict";
const assert = require("assert");
const { createCsvRepository } = require("../data/csvRepository");
const { resolveCurrent } = require("../data/instrumentResolution");
const { getDefinition } = require("../core/context");
const rows = [
    { instrument_token: 256265, tradingsymbol: "NIFTY 50", name: "NIFTY 50", segment: "INDICES", exchange: "NSE", instrument_type: "EQ", tick_size: "0", lot_size: "0" },
    { instrument_token: 260105, tradingsymbol: "NIFTY BANK", name: "NIFTY BANK", segment: "INDICES", exchange: "NSE", instrument_type: "EQ", tick_size: "0", lot_size: "0" },
    { instrument_token: 999, tradingsymbol: "NIFTY NEXT 50", name: "NIFTY NEXT 50", segment: "INDICES", exchange: "NSE", instrument_type: "EQ", tick_size: "0", lot_size: "0" },
    { instrument_token: 738561, tradingsymbol: "RELIANCE", name: "RELIANCE", segment: "NSE", exchange: "NSE", instrument_type: "EQ", tick_size: "0.1", lot_size: "1" },
];
(async () => {
    const repo = createCsvRepository({ fetchRows: async () => rows }); await repo.load();
    assert.deepStrictEqual(repo.listIndexSymbols(), ["NIFTY 50", "NIFTY BANK"], "only the whitelisted indices");
    assert.ok(!repo.listEquitySymbols().some(x => /NIFTY/.test(x)), "indices never in the tradable equity list");
    assert.strictEqual(repo.findByToken(256265), null, "index not in the token map used by trading flows");
    assert.strictEqual(repo.findBySymbol("NIFTY 50"), null);
    assert.ok(repo.listEquitySymbols().length >= 0);
    const def = getDefinition("NIFTY BANK", "NSE");
    const { contract } = resolveCurrent("NIFTY BANK", def, repo, null);
    assert.strictEqual(contract.token, 260105); assert.strictEqual(contract.isIndex, true);
    assert.throws(() => resolveCurrent("NIFTY NEXT 50", getDefinition("NIFTY NEXT 50", "NSE"), repo, null), /no equity found/);
    // wiring
    const fs = require("fs"), srv = fs.readFileSync(__dirname + "/../webdash/server.js", "utf8"), app = fs.readFileSync(__dirname + "/../webdash/public/app.js", "utf8");
    assert.ok(/req\.query\.indices === "1"/.test(srv)); assert.ok(app.includes("&indices=1&q="), "backtest picker asks for indices");
    const i = app.indexOf('btState.exchange = btn.dataset.ex;'); assert.ok(app.slice(i, i + 400).includes("runSearch()"), "switching exchange re-runs the search");
    assert.ok(srv.includes("is an index (spot) — backtest only, it cannot be deployed"), "server refuses to deploy an index"); assert.ok(app.includes("isIndexSpot"), "UI hides Deploy for index spot");
    console.log("PASS index backtest picker"); process.exit(0);
})().catch(e => { console.error("FAIL", e.message); process.exit(1); });
