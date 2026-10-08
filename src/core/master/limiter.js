/**
 * True-peak look-ahead limiter (offline).
 *
 * 1. Peak envelope: the largest of the sample and three 4x-oversampled points to the next sample, across channels.
 * 2. Required gain: ceiling ÷ envelope wherever the envelope is above the ceiling.
 * 3. Look-ahead: minimum of the required gain over the next L samples (L = look-ahead time).
 * 4. Attack: moving average over the previous L samples. Every value averaged already covers the peak,
 *    so the gain is low enough exactly when the peak arrives, with no overshoot and a smooth fade-in.
 * 5. Release: the gain may only rise as fast as an exponential recovery, which avoids pumping and distortion.
 * Offline there is no latency: the gain curve simply looks ahead in the buffer.
 */

const LOOKAHEAD_MS = 2;
const RELEASE_MS = 80;

// Same 12-tap windowed-sinc interpolator as levels.js true-peak measurement
const WEIGHTS = [0.25, 0.5, 0.75].map((frac) => {
  const w = [];
  for (let k = -5; k <= 6; k++) {
    const d = frac - k;
    const sinc = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
    w.push(sinc * (0.5 + 0.5 * Math.cos((Math.PI * d) / 6.5)));
  }
  const s = w.reduce((a, b) => a + b, 0);
  return Float64Array.from(w, (v) => v / s);
});

function peakEnvelope(channels, ceiling) {
  const n = channels[0].length;
  const env = new Float32Array(n);
  const near = ceiling * 0.5; // inter-sample peaks rarely exceed sample peaks by more than 6 dB
  for (const x of channels) {
    for (let i = 0; i < n; i++) {
      let p = Math.abs(x[i]);
      if (i >= 5 && i < n - 7 && (p > near || Math.abs(x[i + 1]) > near)) {
        for (const w of WEIGHTS) {
          let v = 0;
          for (let k = 0; k < 12; k++) v += x[i - 5 + k] * w[k];
          if (Math.abs(v) > p) p = Math.abs(v);
        }
      }
      if (p > env[i]) env[i] = p;
    }
  }
  return env;
}

/** Sliding minimum of `values[i … i + width − 1]` (monotonic deque). */
function forwardMin(values, width) {
  const n = values.length;
  const out = new Float32Array(n);
  const deque = new Int32Array(n);
  let head = 0, tail = 0;
  let next = 0;
  for (let i = 0; i < n; i++) {
    while (next < Math.min(n, i + width)) {
      while (tail > head && values[deque[tail - 1]] >= values[next]) tail--;
      deque[tail++] = next++;
    }
    while (deque[head] < i) head++;
    out[i] = values[deque[head]];
  }
  return out;
}

/**
 * @param {Float32Array[]} channels processed in place
 * @param {number} fs
 * @param {{ ceilingDb?: number, inputGainDb?: number }} options
 * @returns {{ averageReductionDb: number, maxReductionDb: number, limitedPercent: number }}
 */
export function limit(channels, fs, { ceilingDb = -1, inputGainDb = 0 } = {}) {
  const n = channels[0].length;
  const ceiling = 10 ** (ceilingDb / 20);
  const inputGain = 10 ** (inputGainDb / 20);
  if (inputGain !== 1) for (const c of channels) for (let i = 0; i < n; i++) c[i] *= inputGain;

  const L = Math.max(1, Math.round((LOOKAHEAD_MS / 1000) * fs));
  const env = peakEnvelope(channels, ceiling);
  const required = new Float32Array(n);
  for (let i = 0; i < n; i++) required[i] = env[i] > ceiling ? ceiling / env[i] : 1;
  const ahead = forwardMin(required, L + 1);

  const recover = 1 - Math.exp(-1 / ((RELEASE_MS / 1000) * fs));
  // Running sum of the last L look-ahead gains. Before the start they count as the first one,
  // so a peak in the first milliseconds is still fully covered.
  const first = n ? ahead[0] : 1;
  let window = L * first;
  let gain = first;
  let sumDb = 0, maxDb = 0, limited = 0;
  for (let i = 0; i < n; i++) {
    window += ahead[i] - (i >= L ? ahead[i - L] : first);
    const smoothed = Math.min(1, window / L);
    gain = Math.min(smoothed, gain + (1 - gain) * recover);
    for (const c of channels) c[i] *= gain;
    if (gain < 0.9886) { // counts reductions above 0.1 dB
      const db = -20 * Math.log10(gain);
      sumDb += db;
      if (db > maxDb) maxDb = db;
      limited++;
    }
  }
  return { averageReductionDb: sumDb / n, maxReductionDb: maxDb, limitedPercent: (100 * limited) / n };
}
