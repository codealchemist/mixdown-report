/** Incremental MD5 (RFC 1321). FLAC stores the MD5 of the decoded audio so decoders can verify files. */

const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = Uint32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32));

export class Md5 {
  #h = Uint32Array.from([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
  #block = new Uint8Array(64);
  #fill = 0;
  #length = 0; // bytes
  #w = new Uint32Array(16);

  /** @param {Uint8Array} bytes */
  update(bytes) {
    this.#length += bytes.length;
    let i = 0;
    while (i < bytes.length) {
      const n = Math.min(64 - this.#fill, bytes.length - i);
      this.#block.set(bytes.subarray(i, i + n), this.#fill);
      this.#fill += n;
      i += n;
      if (this.#fill === 64) {
        this.#compress();
        this.#fill = 0;
      }
    }
    return this;
  }

  /** @returns {Uint8Array} 16-byte digest */
  digest() {
    const bitLength = this.#length * 8;
    const pad = new Uint8Array(((this.#fill < 56 ? 56 : 120) - this.#fill) + 8);
    pad[0] = 0x80;
    const view = new DataView(pad.buffer);
    view.setUint32(pad.length - 8, bitLength >>> 0, true);
    view.setUint32(pad.length - 4, Math.floor(bitLength / 2 ** 32), true);
    const length = this.#length;
    this.update(pad);
    this.#length = length;
    const out = new Uint8Array(16);
    const ov = new DataView(out.buffer);
    this.#h.forEach((v, i) => ov.setUint32(i * 4, v, true));
    return out;
  }

  #compress() {
    const w = this.#w;
    const b = this.#block;
    for (let i = 0; i < 16; i++) w[i] = b[i * 4] | (b[i * 4 + 1] << 8) | (b[i * 4 + 2] << 16) | (b[i * 4 + 3] << 24);
    let [A, B, C, D] = this.#h;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (B & C) | (~B & D); g = i; }
      else if (i < 32) { f = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { f = C ^ (B | ~D); g = (7 * i) % 16; }
      const t = (A + f + K[i] + w[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((t << S[i]) | (t >>> (32 - S[i])))) >>> 0;
    }
    this.#h[0] += A; this.#h[1] += B; this.#h[2] += C; this.#h[3] += D;
  }
}

export const md5Hex = (bytes) => [...new Md5().update(bytes).digest()].map((b) => b.toString(16).padStart(2, '0')).join('');
