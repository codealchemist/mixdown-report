/** Applies second-order sections (from eq/response.js) to a buffer, in place, in double precision. */

/**
 * @param {Float32Array} x
 * @param {{ b: number[], a: number[] }[]} sections normalised so a[0] = 1
 */
export function applySections(x, sections) {
  for (const { b, a } of sections) {
    const [b0, b1, b2] = b;
    const [, a1, a2] = a;
    let z1 = 0, z2 = 0; // transposed direct form II state
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      const y = b0 * v + z1;
      z1 = b1 * v - a1 * y + z2;
      z2 = b2 * v - a2 * y;
      x[i] = y;
    }
  }
  return x;
}
