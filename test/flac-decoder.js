/**
 * Minimal FLAC decoder for tests: fixed predictors, CONSTANT, VERBATIM, Rice/Rice2 residuals and
 * all stereo modes, with CRC-8/CRC-16 checks. Enough to prove the encoder's output decodes bit-exact
 * without depending on an external tool.
 */
import { crc8, crc16 } from '../src/core/codecs/flac.js';

class BitReader {
  constructor(bytes, pos = 0) { this.b = bytes; this.pos = pos; this.bit = 0; }
  read(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = v * 2 + ((this.b[this.pos] >> (7 - this.bit)) & 1);
      if (++this.bit === 8) { this.bit = 0; this.pos++; }
    }
    return v;
  }
  signed(n) { const v = this.read(n); return v >= 2 ** (n - 1) ? v - 2 ** n : v; }
  unary() { let q = 0; while (this.read(1) === 0) q++; return q; }
  align() { if (this.bit) { this.bit = 0; this.pos++; } }
}

const RATES = [0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000];

export function decodeFlac(bytes) {
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'fLaC') throw new Error('not FLAC');
  const r = new BitReader(bytes, 4);
  let info = null;
  const tags = {};
  for (let last = 0; !last;) {
    last = r.read(1);
    const type = r.read(7);
    const length = r.read(24);
    const start = r.pos;
    if (type === 0) {
      info = { minBlock: r.read(16), maxBlock: r.read(16), minFrame: r.read(24), maxFrame: r.read(24), sampleRate: r.read(20), channels: r.read(3) + 1, bps: r.read(5) + 1, total: r.read(36), md5: [...bytes.subarray(r.pos, r.pos + 16)].map((b) => b.toString(16).padStart(2, '0')).join('') };
    } else if (type === 4) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + start);
      const vendorLength = view.getUint32(0, true);
      let o = 4 + vendorLength;
      tags.vendor = new TextDecoder().decode(bytes.subarray(start + 4, start + o));
      const count = view.getUint32(o, true);
      o += 4;
      for (let i = 0; i < count; i++) {
        const len = view.getUint32(o, true);
        const [k, ...v] = new TextDecoder().decode(bytes.subarray(start + o + 4, start + o + 4 + len)).split('=');
        tags[k] = v.join('=');
        o += 4 + len;
      }
    }
    r.pos = start + length;
    r.bit = 0;
  }

  const out = Array.from({ length: info.channels }, () => new Int32Array(info.total));
  let written = 0;
  let frames = 0;
  while (r.pos < bytes.length) {
    const start = r.pos;
    if (r.read(15) !== 0x7ffc) throw new Error(`lost sync at byte ${start}`);
    r.read(1);
    const sizeCode = r.read(4);
    const rateCode = r.read(4);
    const assignment = r.read(4);
    const depthCode = r.read(3);
    r.read(1);
    // frame number (UTF-8 style)
    let first = r.read(8);
    let extra = 0;
    while (first & (0x80 >> extra)) extra++;
    for (let i = 1; i < extra; i++) r.read(8);
    let n;
    if (sizeCode === 1) n = 192;
    else if (sizeCode <= 5) n = 576 * 2 ** (sizeCode - 2);
    else if (sizeCode === 6) n = r.read(8) + 1;
    else if (sizeCode === 7) n = r.read(16) + 1;
    else n = 256 * 2 ** (sizeCode - 8);
    if (rateCode === 12) r.read(8); else if (rateCode >= 13 && rateCode <= 14) r.read(16);
    const headerCrc = crc8(bytes.subarray(start, r.pos));
    if (r.read(8) !== headerCrc) throw new Error(`header CRC mismatch in frame ${frames}`);
    if (RATES[rateCode] && RATES[rateCode] !== info.sampleRate) throw new Error('sample rate code mismatch');
    if (depthCode !== { 16: 4, 24: 6 }[info.bps]) throw new Error('bit depth code mismatch');

    const sideIndex = assignment === 8 ? 1 : assignment === 9 ? 0 : assignment === 10 ? 1 : -1;
    const subs = [];
    for (let c = 0; c < info.channels; c++) {
      const bps = info.bps + (c === sideIndex ? 1 : 0);
      if (r.read(1)) throw new Error('padding bit set');
      const type = r.read(6);
      if (r.read(1)) throw new Error('wasted bits not supported');
      const x = new Int32Array(n);
      if (type === 0) x.fill(r.signed(bps));
      else if (type === 1) for (let i = 0; i < n; i++) x[i] = r.signed(bps);
      else if (type >= 8 && type <= 12) {
        const order = type - 8;
        for (let i = 0; i < order; i++) x[i] = r.signed(bps);
        const method = r.read(2);
        const paramBits = method === 0 ? 4 : 5;
        const partOrder = r.read(4);
        const parts = 1 << partOrder;
        let i = order;
        for (let p = 0; p < parts; p++) {
          const k = r.read(paramBits);
          if (k === (1 << paramBits) - 1) throw new Error('escaped partition not supported');
          const count = (n >> partOrder) - (p === 0 ? order : 0);
          for (let j = 0; j < count; j++) {
            const u = r.unary() * 2 ** k + r.read(k);
            x[i++] = u % 2 ? -(u + 1) / 2 : u / 2;
          }
        }
        for (let j = order; j < n; j++) {
          if (order === 1) x[j] += x[j - 1];
          else if (order === 2) x[j] += 2 * x[j - 1] - x[j - 2];
          else if (order === 3) x[j] += 3 * x[j - 1] - 3 * x[j - 2] + x[j - 3];
          else if (order === 4) x[j] += 4 * x[j - 1] - 6 * x[j - 2] + 4 * x[j - 3] - x[j - 4];
        }
      } else throw new Error(`subframe type ${type} not supported`);
      subs.push(x);
    }
    r.align();
    const frameCrc = crc16(bytes.subarray(start, r.pos));
    if (r.read(16) !== frameCrc) throw new Error(`frame CRC mismatch in frame ${frames}`);

    let [a, b] = subs;
    if (assignment === 8) b = Int32Array.from(a, (l, i) => l - b[i]);
    else if (assignment === 9) a = Int32Array.from(b, (rr, i) => a[i] + rr);
    else if (assignment === 10) {
      const L = new Int32Array(n), R = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        const mid = (a[i] * 2) | (b[i] & 1);
        L[i] = (mid + b[i]) >> 1;
        R[i] = (mid - b[i]) >> 1;
      }
      a = L; b = R;
    }
    out[0].set(a, written);
    if (info.channels > 1) out[1].set(b, written);
    written += n;
    frames++;
  }
  if (written !== info.total) throw new Error(`decoded ${written} samples, STREAMINFO says ${info.total}`);
  return { ...info, tags, frames, channels: out };
}
