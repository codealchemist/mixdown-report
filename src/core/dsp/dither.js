/**
 * Converts float audio to signed integers with TPDF dither.
 * Dither turns the error of cutting to 16 bits into a constant, inaudible noise floor
 * (about −96 dBFS) instead of distortion on fades and quiet passages.
 */

/** Small, fast PRNG (xorshift32) so exports are reproducible. */
function rng(seed) {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** True when every sample is already exactly on the `bits` grid, so dither would only add noise. */
export function isOnGrid(channels, bits) {
  const scale = 2 ** (bits - 1);
  for (const x of channels) {
    for (let i = 0; i < x.length; i++) {
      const v = x[i] * scale;
      if (v !== Math.round(v)) return false;
    }
  }
  return true;
}

/**
 * @param {Float32Array[]} channels
 * @param {number} bits 16 or 24
 * @param {{ dither?: boolean, seed?: number }} [options] dither defaults to true unless the audio is already on the grid
 * @returns {{ channels: Int32Array[], clipped: number, dithered: boolean }}
 */
export function quantize(channels, bits = 16, { dither, seed = 1 } = {}) {
  const scale = 2 ** (bits - 1);
  const max = scale - 1;
  const min = -scale;
  const useDither = dither ?? !isOnGrid(channels, bits);
  const random = rng(seed);
  let clipped = 0;
  const out = channels.map((x) => {
    const q = new Int32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      let v = x[i] * scale;
      if (useDither) v += random() - random(); // triangular, ±1 LSB
      let r = Math.round(v);
      if (r > max) { r = max; clipped++; } else if (r < min) { r = min; clipped++; }
      q[i] = r;
    }
    return q;
  });
  return { channels: out, clipped, dithered: useDither };
}
