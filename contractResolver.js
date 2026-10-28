// contractResolver.js — underlying + roll policy -> current active contract.
//
// Pure lookup, no side effects. Takes the CSV Repository (already loaded)
// and hands back whichever contract row a given roll policy says is
// "current" as of a date. Doesn't know about PM2, engine.js, or the Brain —
// just: name in, contract out.
"use strict";

function createContractResolver({ csvRepo }) {
    function resolve(underlying, policy, asOf = new Date()) {
        const contracts = csvRepo.findFuturesFor(underlying);

        if (contracts.length === 0) {
            throw new Error(
                `ContractResolver: no futures found for underlying "${underlying}" — ` +
                `check the CSV repository is loaded and the name matches the broker's ` +
                `instrument dump exactly (case-sensitive)`
            );
        }

        const picked = policy.select(contracts, asOf);

        if (!picked) {
            throw new Error(
                `ContractResolver: no unexpired contract found for "${underlying}" ` +
                `as of ${asOf.toISOString()} — all ${contracts.length} known contracts have expired`
            );
        }

        return picked;
    }

    return { resolve };
}

module.exports = { createContractResolver };
