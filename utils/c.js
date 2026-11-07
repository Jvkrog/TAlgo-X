// c.js — ANSI color helpers (no deps)
"use strict";

const c = {
    green:  s => `\x1b[32m${s}\x1b[0m`,
    yellow: s => `\x1b[33m${s}\x1b[0m`,
    red:    s => `\x1b[31m${s}\x1b[0m`,
    cyan:   s => `\x1b[36m${s}\x1b[0m`,
    dim:    s => `\x1b[2m${s}\x1b[0m`,
    bold:   s => `\x1b[1m${s}\x1b[0m`,
    white:  s => `\x1b[97m${s}\x1b[0m`,
};

module.exports = c;
