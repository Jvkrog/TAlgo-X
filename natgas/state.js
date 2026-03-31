// state.js
const SLOW = {
    position: null,
    entryPrice: 0,
    slPrice: 0,
    pnl: 0,
    trades: 0,
};

const FAST = {
    position: null,
    entryPrice: 0,
    slPrice: 0,
    pnl: 0,
    trades: 0,
    color: null,
};

module.exports = { SLOW, FAST };