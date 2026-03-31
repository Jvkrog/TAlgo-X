// candleBuilder.js
let rawCandles = [];
let currentCandle = null;
let currentSlotMs = 0;

function onTick(price, processCandleFn) {
    const now = new Date();
    const slotMs = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        now.getHours(), 
        0, 0, 0
    ).getTime();

    if (slotMs !== currentSlotMs) {
        // Close previous candle
        const closingCandle = currentCandle || rawCandles.at(-1);
        if (closingCandle) {
            closingCandle.close = price;
            rawCandles.push(closingCandle);
            if (rawCandles.length > 200) rawCandles.shift();

            console.log(`\n-- ${new Date(currentSlotMs || slotMs).toLocaleTimeString("en-IN")} --`);
            if (processCandleFn) processCandleFn(closingCandle);
        }

        currentSlotMs = slotMs;
        currentCandle = { open: price, high: price, low: price, close: price };
    } else {
        currentCandle.high = Math.max(currentCandle.high, price);
        currentCandle.low = Math.min(currentCandle.low, price);
        currentCandle.close = price;
    }
}

function getRawCandles() {
    return rawCandles;
}

function setRawCandles(candles) {
    rawCandles = candles;
}

module.exports = { onTick, getRawCandles, setRawCandles };