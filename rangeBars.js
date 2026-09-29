// rangeBars.js
// Range bar: every bar has high - low === range (except the still-forming last bar).
// A new bar opens at the previous bar's close.

function makeRangeBars(points, range) {
  // points: [{ price, time, volume? }]
  const bars = [];
  let bar = null;

  for (const { price: p, time, volume = 0 } of points) {
    if (!bar) bar = { time, open: p, high: p, low: p, close: p, volume: 0 };

    // while loop handles gaps that span several bars
    let volLeft = volume;   // this tick's volume is booked exactly once
    let done = false;
    while (!done) {
      bar.high = Math.max(bar.high, p);
      bar.low = Math.min(bar.low, p);
      bar.close = p;

      if (bar.high - bar.low >= range - 1e-9) {
        const up = p >= bar.low + range - 1e-9;   // new high broke the range
        if (up) { bar.high = bar.low + range; bar.close = bar.high; }
        else    { bar.low = bar.high - range; bar.close = bar.low; }

        bars.push({ ...bar, volume: bar.volume + volLeft });
        volLeft = 0;

        // next bar opens at the closed bar's close
        const o = bar.close;
        bar = { time, open: o, high: o, low: o, close: o, volume: 0 };
        // always loop again: p must be applied to the NEW bar too (else its
        // high/low miss the tick that closed the previous bar and it completes
        // late), and a gap may span several bars
      } else {
        bar.volume += volLeft;
        volLeft = 0;
        done = true;
      }
    }
  }
  return { bars, forming: bar };
}

module.exports = { makeRangeBars };
