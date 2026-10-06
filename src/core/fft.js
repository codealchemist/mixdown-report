/**
 * Creates an in-place radix-2 complex FFT for a fixed power-of-two size.
 * Tables are computed once so repeated transforms stay cheap.
 * @param {number} n
 * @returns {(re: Float64Array, im: Float64Array) => void}
 */
export function createFFT(n) {
  if (!Number.isInteger(Math.log2(n)) || n < 2) throw new RangeError(`FFT size must be a power of two, got ${n}`);
  const bits = Math.log2(n);
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }

  return (re, im) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tr = re[l] * cos[k] + im[l] * sin[k];
          const ti = im[l] * cos[k] - re[l] * sin[k];
          re[l] = re[j] - tr;
          im[l] = im[j] - ti;
          re[j] += tr;
          im[j] += ti;
        }
      }
    }
  };
}
