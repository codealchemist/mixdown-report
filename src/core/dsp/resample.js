/**
 * Sample-rate conversion with a Kaiser-windowed sinc filter.
 *
 * For rational ratios with a small numerator (48 → 44.1 kHz is 147/160) every output sample
 * falls on one of L fixed phases, so the filter table is exact. Other ratios use a finely
 * sampled table with linear interpolation between phases.
 */

const ZERO_CROSSINGS = 32; // filter half-length in zero crossings of the cut-off: higher = sharper
const KAISER_BETA = 9; // ≈ 90 dB stopband
const PASSBAND = 0.955; // cut-off as a fraction of the lower Nyquist (≈ 21.05 kHz at 44.1 kHz)
const MAX_EXACT_PHASES = 4096;
const INTERP_PHASES = 2048;

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

function besselI0(x) {
  let sum = 1, term = 1;
  for (let k = 1; k < 50; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

/**
 * Filter value at distance `t` input samples from the output point.
 * @param {number} cutoff cut-off relative to the input sample rate (0.5 = input Nyquist)
 * @param {number} halfWidth half the filter length in input samples
 */
function kernel(t, cutoff, halfWidth) {
  if (Math.abs(t) >= halfWidth) return 0;
  const x = 2 * cutoff * t;
  const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
  const r = t / halfWidth;
  return 2 * cutoff * sinc * (besselI0(KAISER_BETA * Math.sqrt(1 - r * r)) / besselI0(KAISER_BETA));
}

/**
 * Builds the polyphase table: row p holds the taps for an output point p/phases of the way between two input samples.
 * @returns {{ table: Float64Array[], taps: number, offset: number }}
 */
function buildTable(cutoff, phases) {
  const halfWidth = ZERO_CROSSINGS / (2 * cutoff);
  const offset = Math.ceil(halfWidth); // first tap is `offset - 1` samples before the base sample
  const taps = 2 * offset;
  const table = [];
  for (let p = 0; p <= phases; p++) {
    const frac = p / phases;
    const row = new Float64Array(taps);
    for (let k = 0; k < taps; k++) row[k] = kernel(frac - (k - offset + 1), cutoff, halfWidth);
    table.push(row);
  }
  return { table, taps, offset };
}

/**
 * Resamples one channel.
 * @param {Float32Array} input
 * @param {number} fromRate
 * @param {number} toRate
 * @param {(fraction: number) => void} [onProgress]
 * @returns {Float32Array}
 */
export function resample(input, fromRate, toRate, onProgress = () => {}) {
  if (fromRate === toRate) return Float32Array.from(input);
  const g = gcd(fromRate, toRate);
  const up = toRate / g; // output samples per `down` input samples
  const down = fromRate / g;
  const cutoff = 0.5 * Math.min(1, toRate / fromRate) * PASSBAND;
  const exact = up <= MAX_EXACT_PHASES;
  const phases = exact ? up : INTERP_PHASES;
  const { table, taps, offset } = buildTable(cutoff, phases);

  const outLength = Math.floor((input.length * up) / down);
  const out = new Float32Array(outLength);
  const n = input.length;
  const step = Math.max(1, Math.floor(outLength / 50));

  for (let j = 0; j < outLength; j++) {
    // Output sample j sits at input position j·down/up = base + frac
    let base, row, row2, mix;
    if (exact) {
      const pos = j * down;
      base = Math.floor(pos / up);
      row = table[pos - base * up];
    } else {
      const pos = (j * down) / up;
      base = Math.floor(pos);
      const f = (pos - base) * phases;
      const p = Math.floor(f);
      row = table[p];
      row2 = table[p + 1];
      mix = f - p;
    }
    const start = base - offset + 1;
    let acc = 0;
    if (start >= 0 && start + taps <= n) {
      if (exact) for (let k = 0; k < taps; k++) acc += input[start + k] * row[k];
      else for (let k = 0; k < taps; k++) acc += input[start + k] * (row[k] + mix * (row2[k] - row[k]));
    } else {
      for (let k = 0; k < taps; k++) {
        const idx = start + k;
        if (idx < 0 || idx >= n) continue;
        acc += input[idx] * (exact ? row[k] : row[k] + mix * (row2[k] - row[k]));
      }
    }
    out[j] = acc;
    if (j % step === 0) onProgress(j / outLength);
  }
  onProgress(1);
  return out;
}
