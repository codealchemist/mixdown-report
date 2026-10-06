/** Sample peak, true peak, RMS, clipping, DC offset and left/right relationships. */
import { toDb, powerToDb } from './format.js';

const TAPS = 12; // interpolation taps per output sample
const HALF_SPAN = 6.5; // window half-width in samples

/**
 * Windowed-sinc weights for the three in-between points of 4x oversampling,
 * normalised to unity DC gain. Index k covers input samples i-5 … i+6.
 */
const OVERSAMPLE_WEIGHTS = [0.25, 0.5, 0.75].map((frac) => {
  const w = [];
  for (let k = -5; k <= 6; k++) {
    const d = frac - k;
    const sinc = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
    w.push(sinc * (0.5 + 0.5 * Math.cos((Math.PI * d) / HALF_SPAN)));
  }
  const sum = w.reduce((a, b) => a + b, 0);
  return Float64Array.from(w, (v) => v / sum);
});

/**
 * Estimates the true (inter-sample) peak with 4x oversampling.
 * Only neighbourhoods of samples above half the sample peak are interpolated,
 * because an inter-sample peak can't exceed the sample peak by more than ~6 dB in practice.
 */
export function truePeak(x, samplePeak) {
  let peak = samplePeak;
  const threshold = samplePeak * 0.5;
  for (let i = 5; i < x.length - 7; i++) {
    if (Math.abs(x[i]) < threshold && Math.abs(x[i + 1]) < threshold) continue;
    for (const w of OVERSAMPLE_WEIGHTS) {
      let v = 0;
      for (let k = 0; k < TAPS; k++) v += x[i - 5 + k] * w[k];
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

/** Counts runs of 3+ consecutive samples pinned at the peak level (flat-topped clipping). */
export function countClippedRuns(channels, peak) {
  if (peak <= 0.89) return 0; // below about −1 dBFS nothing is pinned against full scale
  const threshold = peak * 0.9995;
  let runs = 0;
  for (const x of channels) {
    let run = 0;
    for (let i = 0; i < x.length; i++) {
      if (Math.abs(x[i]) >= threshold) run++;
      else {
        if (run >= 3) runs++;
        run = 0;
      }
    }
    if (run >= 3) runs++;
  }
  return runs;
}

/** @param {Float32Array[]} channels */
export function measureLevels(channels) {
  const n = channels[0].length;
  const peaks = [];
  const meanSquares = [];
  let dc = 0;
  for (const x of channels) {
    let pk = 0, ss = 0, s = 0;
    for (let i = 0; i < n; i++) {
      const v = x[i];
      const a = v < 0 ? -v : v;
      if (a > pk) pk = a;
      ss += v * v;
      s += v;
    }
    peaks.push(pk);
    meanSquares.push(ss / n);
    dc += s / n / channels.length;
  }
  const peak = Math.max(...peaks);
  const tp = Math.max(...channels.map((x, c) => truePeak(x, peaks[c])));
  const meanSquare = meanSquares.reduce((a, b) => a + b, 0) / channels.length;

  const result = {
    samplePeakDb: toDb(peak),
    truePeakDb: toDb(tp),
    rmsDb: powerToDb(meanSquare),
    crestDb: toDb(peak) - powerToDb(meanSquare),
    dcOffset: dc,
    clippedRuns: countClippedRuns(channels, peak),
    correlation: null,
    balanceDb: null,
  };

  if (channels.length === 2) {
    const [L, R] = channels;
    let lr = 0, ll = 0, rr = 0;
    for (let i = 0; i < n; i++) {
      lr += L[i] * R[i];
      ll += L[i] * L[i];
      rr += R[i] * R[i];
    }
    result.correlation = ll && rr ? lr / Math.sqrt(ll * rr) : 1;
    result.balanceDb = 10 * Math.log10((ll || 1e-20) / (rr || 1e-20));
  }
  return result;
}
