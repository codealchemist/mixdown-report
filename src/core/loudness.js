/**
 * Loudness per ITU-R BS.1770-4 and EBU Tech 3341/3342:
 * K-weighting, 400 ms gated integrated loudness, 3 s short-term loudness and loudness range.
 */

const SEGMENT_SECONDS = 0.1;
const BLOCK_SEGMENTS = 4; // 400 ms momentary block
const SHORT_TERM_SEGMENTS = 30; // 3 s short-term window
const ABSOLUTE_GATE = -70;

/** K-weighting biquad coefficients for any sample rate (pre-filter shelf + RLB high-pass). */
export function kWeightingCoefficients(fs) {
  let f0 = 1681.974450955533;
  let q = 0.7071752369554196;
  let k = Math.tan((Math.PI * f0) / fs);
  const vh = 10 ** (3.999843853973347 / 20);
  const vb = vh ** 0.4996667741545416;
  const a0 = 1 + k / q + k * k;
  const shelf = {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
  f0 = 38.13547087602444;
  q = 0.5003270373238773;
  k = Math.tan((Math.PI * f0) / fs);
  const d = 1 + k / q + k * k;
  const highPass = { b0: 1, b1: -2, b2: 1, a1: (2 * (k * k - 1)) / d, a2: (1 - k / q + k * k) / d };
  return { shelf, highPass };
}

/** Mean-square power to LUFS. */
export const powerToLufs = (p) => (p > 0 ? -0.691 + 10 * Math.log10(p) : -Infinity);

/**
 * Applies absolute (−70 LUFS) and relative gating to block powers.
 * @returns {{ loudness: number, kept: number[] }} gated loudness and the loudness of each kept block
 */
export function gate(powers, relativeGateLu) {
  let sum = 0;
  let n = 0;
  for (const p of powers) if (powerToLufs(p) > ABSOLUTE_GATE) { sum += p; n++; }
  if (!n) return { loudness: -Infinity, kept: [] };
  const relative = powerToLufs(sum / n) - relativeGateLu;
  sum = 0;
  n = 0;
  const kept = [];
  for (const p of powers) {
    const l = powerToLufs(p);
    if (l > ABSOLUTE_GATE && l > relative) { sum += p; n++; kept.push(l); }
  }
  return { loudness: n ? powerToLufs(sum / n) : -Infinity, kept };
}

/** Adds each 100 ms segment's K-weighted mean square of one channel into `acc`. */
function accumulateSegments(x, fs, segment, count, acc) {
  const { shelf: s, highPass: h } = kWeightingCoefficients(fs);
  const { b0, b1, b2, a1, a2 } = s;
  const c1 = h.a1;
  const c2 = h.a2;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, z1 = 0, z2 = 0;
  let sum = 0, filled = 0, index = 0;
  const end = count * segment;
  for (let i = 0; i < end; i++) {
    const xi = x[i];
    const y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = y;
    const z = y - 2 * u1 + u2 - c1 * z1 - c2 * z2;
    u2 = u1; u1 = y; z2 = z1; z1 = z;
    sum += z * z;
    if (++filled === segment) {
      acc[index++] += sum / segment;
      sum = 0;
      filled = 0;
    }
  }
}

const percentile = (sorted, p) => sorted[Math.round((sorted.length - 1) * p)];

/**
 * @param {Float32Array[]} channels left/right (or a single mono channel)
 * @param {number} fs sample rate
 */
export function measureLoudness(channels, fs) {
  const segment = Math.round(fs * SEGMENT_SECONDS);
  const count = Math.floor(channels[0].length / segment);
  const segments = new Float64Array(count);
  for (const x of channels) accumulateSegments(x, fs, segment, count, segments);

  const blocks = [];
  let momentaryMax = -Infinity;
  for (let i = 0; i + BLOCK_SEGMENTS <= count; i++) {
    let p = 0;
    for (let j = 0; j < BLOCK_SEGMENTS; j++) p += segments[i + j];
    p /= BLOCK_SEGMENTS;
    blocks.push(p);
    momentaryMax = Math.max(momentaryMax, powerToLufs(p));
  }

  const shortTermPowers = [];
  const shortTerm = [];
  let running = 0;
  for (let i = 0; i < count; i++) {
    running += segments[i];
    if (i >= SHORT_TERM_SEGMENTS) running -= segments[i - SHORT_TERM_SEGMENTS];
    if (i >= SHORT_TERM_SEGMENTS - 1) {
      const p = Math.max(running / SHORT_TERM_SEGMENTS, 0);
      shortTermPowers.push(p);
      shortTerm.push(powerToLufs(p));
    }
  }

  const lraBlocks = gate(shortTermPowers, 20).kept.sort((a, b) => a - b);
  const shortTermMax = shortTerm.reduce((m, v) => (v > m ? v : m), -Infinity);

  return {
    integrated: gate(blocks, 10).loudness,
    momentaryMax,
    shortTerm,
    shortTermStart: SHORT_TERM_SEGMENTS * SEGMENT_SECONDS,
    shortTermStep: SEGMENT_SECONDS,
    shortTermMax,
    loudnessRange: lraBlocks.length > 1 ? percentile(lraBlocks, 0.95) - percentile(lraBlocks, 0.1) : 0,
  };
}
