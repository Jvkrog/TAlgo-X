// rollPolicies.js — pluggable rules for "which contract counts as active."
//
// Interface: { name, select(sortedContracts, asOfDate) -> contract | null }
// `sortedContracts` is every future for one underlying, sorted by expiry asc.
//
// Add a new policy by writing another function with this shape and passing
// it into a context definition's `rollPolicy` field — contractResolver.js
// and csvRepository.js never need to change.
"use strict";

// Roll to the next contract once within N days of the current one's expiry.
function daysBeforeExpiryPolicy(days) {
    return {
        name: `daysBeforeExpiry(${days})`,
        select(sorted, asOf) {
            const future = sorted.filter(c => c.expiry >= asOf);
            if (future.length === 0) return null;

            const nearest         = future[0];
            const daysUntilExpiry = (nearest.expiry - asOf) / (24 * 60 * 60 * 1000);

            if (daysUntilExpiry <= days && future.length > 1) {
                return future[1];   // close enough to expiry — use next month's contract
            }
            return nearest;
        },
    };
}

// Roll to the next contract on/after a fixed day of the month (e.g. 20th).
function calendarDayPolicy(dayOfMonth) {
    return {
        name: `calendarDay(${dayOfMonth})`,
        select(sorted, asOf) {
            const future = sorted.filter(c => c.expiry >= asOf);
            if (future.length === 0) return null;

            const nearest = future[0];
            if (asOf.getDate() >= dayOfMonth && future.length > 1) {
                return future[1];
            }
            return nearest;
        },
    };
}

module.exports = { daysBeforeExpiryPolicy, calendarDayPolicy };
