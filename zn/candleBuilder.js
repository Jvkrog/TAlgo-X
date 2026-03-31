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
        if (currentCandle) {
            currentCandle.close = price;
            rawCandles.push(currentCandle);
            if (rawCandles.length > 200) rawCandles.shift();

            console.log(`\n-- ${new Date(currentSlotMs).toLocaleTimeString("en-IN")} --`);
            if (processCandleFn) processCandleFn(currentCandle);
        }

        currentSlotMs = slotMs;
        currentCandle = { open: price, high: price, low: price, close: price };
    } else if (currentCandle) {
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