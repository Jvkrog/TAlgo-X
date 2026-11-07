// instrumentResolution.js — "what contract is currently in effect."
//
// One function, used by both engine.js (at boot) and toolbox.js (to show
// what a Roll Contract screen is rolling FROM), so the two never disagree
// about what "current" means. Pin takes priority over the roll policy —
// that's the whole point of a manual pin.
//
// Two pin shapes (see contractPins.js):
//   manual pin  -> trusted as-is, no CSV lookup (that's why it's manual —
//                  the contract isn't in the CSV yet).
//   normal pin  -> re-validated against the CSV every boot; a pin pointing
//                  at something missing or expired self-heals back to the
//                  roll policy rather than silently trading a dead contract.
"use strict";

const { createContractResolver } = require("./contractResolver");

function resolveCurrent(underlying, def, csvRepo, pinStore) {
    // Equities: no expiry, nothing to roll, nothing to pin. `underlying`
    // for an equity IS its tradingsymbol (see csvRepository.js) — resolve
    // straight to it, skip the pin store and roll policy entirely, both of
    // which only make sense where a contract can go stale or need picking
    // between expiries.
    if (def.noRoll) {
        const contract = csvRepo.findEquity(underlying);
        if (!contract) {
            throw new Error(
                `resolveCurrent: no equity found for "${underlying}" on ${def.exchange} — ` +
                `check the CSV repository is loaded and the tradingsymbol matches the broker's ` +
                `instrument dump exactly (case-sensitive)`
            );
        }
        return { contract, source: "equity (no roll)" };
    }

    const pin = pinStore.getPin(underlying);

    if (pin) {
        if (pin.manual) {
            return {
                contract: {
                    token:      pin.token,
                    symbol:     pin.symbol,
                    underlying,
                    exchange:   def.exchange,
                    expiry:     pin.expiry ? new Date(pin.expiry) : null,
                    lotSize:    pin.lotSize,
                    tickSize:   pin.tickSize ?? null,
                },
                source: "manual pin",
            };
        }

        const row = csvRepo.findBySymbol(pin.symbol);
        if (row && row.expiry >= new Date()) {
            return { contract: row, source: "pin" };
        }
        // Pin points at something missing or expired — don't trade a dead
        // contract just because it was pinned once. Clear it and fall through.
        pinStore.clearPin(underlying);
    }

    const resolver = createContractResolver({ csvRepo });
    const contract = resolver.resolve(underlying, def.rollPolicy);
    return { contract, source: "policy" };
}

module.exports = { resolveCurrent };
