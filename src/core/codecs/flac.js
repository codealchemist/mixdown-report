/**
 * FLAC encoder (RFC 9639), lossless, dependency-free.
 *
 * Uses the format's fixed polynomial predictors (orders 0–4) with Rice-coded residuals and
 * per-partition parameters, CONSTANT and VERBATIM subframes, and picks the cheapest stereo
 * decorrelation (independent, left/side, side/right or mid/side) per frame. Compression lands
 * within a few percent of `flac -5` on typical music; the output is bit-exact by design.
 */
import { Md5 } from './md5.js';

const BLOCK_SIZE = 4096;
const MAX_PARTITION_ORDER = 8;
const MAX_FIXED_ORDER = 4;

/* ---------- checksums ---------- */

const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  CRC8[i] = c;
  let d = i << 8;
  for (let k = 0; k < 8; k++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff;
  CRC16[i] = d;
}
export const crc8 = (bytes) => bytes.reduce((c, b) => CRC8[c ^ b], 0);
export const crc16 = (bytes) => bytes.reduce((c, b) => ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ b], 0);

/* ---------- bit writer ---------- */

class BitWriter {
  constructor(size = 1 << 20) {
    this.buf = new Uint8Array(size);
    this.pos = 0; // bytes written
    this.acc = 0; // pending bits (fewer than 8 between calls)
    this.n = 0;
  }

  #ensure(extra) {
    if (this.pos + extra <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.pos + extra));
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }

  /** Writes the low `bits` bits of `value` (unsigned), bits ≤ 32. */
  write(value, bits) {
    if (bits > 24) {
      this.write(Math.floor(value / 2 ** 24) & ((1 << (bits - 24)) - 1), bits - 24);
      this.write(value & 0xffffff, 24);
      return;
    }
    this.#ensure(4);
    this.acc = (this.acc << bits) | (value & ((1 << bits) - 1));
    this.n += bits;
    while (this.n >= 8) {
      this.n -= 8;
      this.buf[this.pos++] = (this.acc >>> this.n) & 0xff;
    }
    this.acc &= (1 << this.n) - 1;
  }

  /** Two's complement signed value in `bits` bits. */
  writeSigned(value, bits) {
    this.write(bits === 32 ? value >>> 0 : value & ((1 << bits) - 1), bits);
  }

  /** `q` zero bits followed by a one. */
  writeUnary(q) {
    while (q >= 24) {
      this.write(0, 24);
      q -= 24;
    }
    this.write(1, q + 1);
  }

  align() {
    if (this.n) this.write(0, 8 - this.n);
  }

  bytes(from = 0, to = this.pos) {
    return this.buf.subarray(from, to);
  }
}

/* ---------- prediction and residual coding ---------- */

/** Fixed-predictor residuals of the given order (RFC 9639 §9.2.5). */
function fixedResidual(x, order, out) {
  const n = x.length;
  for (let i = 0; i < order; i++) out[i] = 0;
  switch (order) {
    case 0: for (let i = 0; i < n; i++) out[i] = x[i]; break;
    case 1: for (let i = 1; i < n; i++) out[i] = x[i] - x[i - 1]; break;
    case 2: for (let i = 2; i < n; i++) out[i] = x[i] - 2 * x[i - 1] + x[i - 2]; break;
    case 3: for (let i = 3; i < n; i++) out[i] = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break;
    default: for (let i = 4; i < n; i++) out[i] = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
  }
  return out;
}

const zigzag = (r) => (r >= 0 ? 2 * r : -2 * r - 1);

/**
 * Sum of absolute residuals for fixed orders 0–4 in one pass (as the reference encoder does),
 * used to pick the predictor order and the stereo mode without computing every residual.
 */
function fixedOrderCosts(x) {
  const n = x.length;
  if (n < 5) return [Infinity, Infinity, Infinity, Infinity, Infinity].map((v, i) => (i === 0 ? x.reduce((a, b) => a + Math.abs(b), 0) : v));
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
  let p1 = x[3] - x[2];
  let p2 = p1 - (x[2] - x[1]);
  let p3 = p2 - ((x[2] - x[1]) - (x[1] - x[0]));
  for (let i = 4; i < n; i++) {
    const e0 = x[i];
    const e1 = e0 - x[i - 1];
    const e2 = e1 - p1;
    const e3 = e2 - p2;
    const e4 = e3 - p3;
    s0 += Math.abs(e0); s1 += Math.abs(e1); s2 += Math.abs(e2); s3 += Math.abs(e3); s4 += Math.abs(e4);
    p1 = e1; p2 = e2; p3 = e3;
  }
  return [s0, s1, s2, s3, s4];
}

/** Estimated subframe size in bits from a residual magnitude sum, for comparing stereo modes. */
const estimateBits = (costs, n) => {
  const sum = Math.min(...costs);
  return n * (1 + Math.max(0, Math.log2((2 * sum) / n || 1)));
};

/** Best Rice parameter for `count` values summing to `sum` (zig-zagged), and its estimated cost in bits. */
function riceParam(sum, count, maxParam) {
  if (count === 0) return { k: 0, bits: 0 };
  let k = 0;
  while (k < maxParam && count * 2 ** (k + 1) < sum) k++;
  // check neighbours: the estimate below is exact up to rounding of the low bits
  let best = { k, bits: Infinity };
  for (const c of [k - 1, k, k + 1]) {
    if (c < 0 || c > maxParam) continue;
    const bits = count * (c + 1) + Math.floor(sum / 2 ** c);
    if (bits < best.bits) best = { k: c, bits };
  }
  return best;
}

/**
 * Chooses the partition order and parameters for a residual block.
 * @returns {{ order: number, params: number[], bits: number, wide: boolean }}
 */
function planResidual(res, predictorOrder, blockSize) {
  // Sums of zig-zagged residuals per partition at the finest usable order; coarser orders merge pairs.
  let maxOrder = 0;
  while (maxOrder < MAX_PARTITION_ORDER && blockSize % (1 << (maxOrder + 1)) === 0 && blockSize >> (maxOrder + 1) > predictorOrder) maxOrder++;
  const finest = 1 << maxOrder;
  const finestSize = blockSize / finest;
  let sums = new Float64Array(finest);
  for (let p = 0; p < finest; p++) {
    let sum = 0;
    for (let i = p === 0 ? predictorOrder : p * finestSize; i < (p + 1) * finestSize; i++) sum += zigzag(res[i]);
    sums[p] = sum;
  }
  const levels = [];
  for (let order = maxOrder; order >= 0; order--) {
    levels[order] = sums;
    if (order) sums = Float64Array.from({ length: sums.length / 2 }, (_, i) => sums[2 * i] + sums[2 * i + 1]);
  }

  let best = null;
  for (let order = 0; order <= maxOrder; order++) {
    const parts = 1 << order;
    const size = blockSize / parts;
    let bits = 6; // method + partition order
    const params = [];
    let wide = false;
    for (let p = 0; p < parts; p++) {
      const start = p === 0 ? predictorOrder : p * size;
      const sum = levels[order][p];
      const { k, bits: b } = riceParam(sum, (p + 1) * size - start, 30);
      params.push(k);
      if (k > 14) wide = true;
      bits += b;
    }
    bits += parts * (wide ? 5 : 4);
    if (!best || bits < best.bits) best = { order, params, bits, wide };
  }
  return best;
}

function writeResidual(w, res, predictorOrder, plan, blockSize) {
  w.write(plan.wide ? 1 : 0, 2); // 0 = Rice (4-bit params), 1 = Rice2 (5-bit)
  w.write(plan.order, 4);
  const parts = 1 << plan.order;
  const size = blockSize / parts;
  const paramBits = plan.wide ? 5 : 4;
  for (let p = 0; p < parts; p++) {
    const k = plan.params[p];
    w.write(k, paramBits);
    const mask = (1 << k) - 1;
    const unit = 2 ** k;
    for (let i = p === 0 ? predictorOrder : p * size; i < (p + 1) * size; i++) {
      const v = zigzag(res[i]);
      const q = Math.floor(v / unit);
      // q zeros, a one, then k low bits; written in one call when it fits
      if (q + 1 + k <= 24) w.write(unit | (v & mask), q + 1 + k);
      else {
        w.writeUnary(q);
        if (k) w.write(v & mask, k);
      }
    }
  }
}

/** Plans the cheapest subframe for one channel. */
function planSubframe(x, bps) {
  const n = x.length;
  let constant = true;
  for (let i = 1; i < n && constant; i++) if (x[i] !== x[0]) constant = false;
  if (constant) return { type: 'constant', bits: 8 + bps };

  const costs = fixedOrderCosts(x);
  let bestOrder = 0;
  for (let order = 1; order <= Math.min(MAX_FIXED_ORDER, n - 1); order++) if (costs[order] < costs[bestOrder]) bestOrder = order;
  const res = fixedResidual(x, bestOrder, new Int32Array(n));
  const plan = planResidual(res, bestOrder, n);
  const fixedBits = 8 + bestOrder * bps + plan.bits;
  const verbatimBits = 8 + n * bps;
  if (verbatimBits <= fixedBits) return { type: 'verbatim', bits: verbatimBits };
  return { type: 'fixed', order: bestOrder, res, plan, bits: fixedBits };
}

function writeSubframe(w, x, bps, plan) {
  if (plan.type === 'constant') {
    w.write(0b00000000, 8);
    w.writeSigned(x[0], bps);
  } else if (plan.type === 'verbatim') {
    w.write(0b00000010, 8);
    for (let i = 0; i < x.length; i++) w.writeSigned(x[i], bps);
  } else {
    w.write((0b001000 | plan.order) << 1, 8);
    for (let i = 0; i < plan.order; i++) w.writeSigned(x[i], bps);
    writeResidual(w, plan.res, plan.order, plan.plan, x.length);
  }
}

/* ---------- frames ---------- */

const RATE_CODES = { 88200: 1, 176400: 2, 192000: 3, 8000: 4, 16000: 5, 22050: 6, 24000: 7, 32000: 8, 44100: 9, 48000: 10, 96000: 11 };
const DEPTH_CODES = { 8: 1, 12: 2, 16: 4, 20: 5, 24: 6, 32: 7 };

/** Frame number in FLAC's UTF-8-like coding: n bytes carry 5n + 1 payload bits (up to 36). */
function utf8Number(value) {
  if (value < 0x80) return [value];
  let count = 2;
  while (value >= 2 ** (5 * count + 1)) count++;
  const bytes = new Array(count);
  for (let i = count - 1; i > 0; i--) {
    bytes[i] = 0x80 | (value & 0x3f);
    value = Math.floor(value / 64);
  }
  bytes[0] = ((0xff << (8 - count)) & 0xff) | value;
  return bytes;
}

function writeFrame(w, index, blocks, sampleRate, bps) {
  const n = blocks[0].length;
  const start = w.pos;

  // Stereo decorrelation: pick the channel pair with the smallest estimated size
  let assignment = blocks.length - 1;
  let subframes = blocks.map((x) => ({ x, bps }));
  if (blocks.length === 2) {
    const [L, R] = blocks;
    const S = new Int32Array(n);
    const M = new Int32Array(n);
    for (let i = 0; i < n; i++) { S[i] = L[i] - R[i]; M[i] = (L[i] + R[i]) >> 1; }
    const e = { L: estimateBits(fixedOrderCosts(L), n), R: estimateBits(fixedOrderCosts(R), n), S: estimateBits(fixedOrderCosts(S), n), M: estimateBits(fixedOrderCosts(M), n) };
    const options = [
      { code: 1, bits: e.L + e.R, subs: [{ x: L, bps }, { x: R, bps }] },
      { code: 8, bits: e.L + e.S, subs: [{ x: L, bps }, { x: S, bps: bps + 1 }] },
      { code: 9, bits: e.S + e.R, subs: [{ x: S, bps: bps + 1 }, { x: R, bps }] },
      { code: 10, bits: e.M + e.S, subs: [{ x: M, bps }, { x: S, bps: bps + 1 }] },
    ];
    const best = options.reduce((a, b) => (b.bits < a.bits ? b : a));
    assignment = best.code;
    subframes = best.subs.map((sub) => ({ ...sub, plan: planSubframe(sub.x, sub.bps) }));
  } else {
    subframes = subframes.map((s) => ({ ...s, plan: planSubframe(s.x, s.bps) }));
  }

  // Header
  const sizeCode = n === BLOCK_SIZE ? 12 : 7; // 12 = 4096; 7 = 16-bit size follows
  const rateCode = RATE_CODES[sampleRate] ?? 0;
  w.write(0xfff8, 16); // sync + reserved + fixed block size
  w.write(sizeCode, 4);
  w.write(rateCode, 4);
  w.write(assignment, 4);
  w.write(DEPTH_CODES[bps] ?? 0, 3);
  w.write(0, 1);
  for (const b of utf8Number(index)) w.write(b, 8);
  if (sizeCode === 7) w.write(n - 1, 16);
  w.write(crc8(w.bytes(start)), 8);

  for (const s of subframes) writeSubframe(w, s.x, s.bps, s.plan);
  w.align();
  w.write(crc16(w.bytes(start)), 16);
  return w.pos - start;
}

/* ---------- stream ---------- */

function metadataHeader(w, last, type, length) {
  w.write(last ? 1 : 0, 1);
  w.write(type, 7);
  w.write(length, 24);
}

/**
 * Encodes integer PCM as a FLAC file.
 * @param {Int32Array[]} channels 1–8 channels of equal length, values within `bitsPerSample`
 * @param {{ sampleRate: number, bitsPerSample?: 16|24, vendor?: string, tags?: Record<string, string>, onProgress?: (f: number) => void }} options
 * @returns {Uint8Array}
 */
export function encodeFlac(channels, { sampleRate, bitsPerSample = 16, vendor = 'Mixdown Report', tags = {}, onProgress = () => {} }) {
  const total = channels[0].length;
  const bps = bitsPerSample;
  const bytesPerSample = bps / 8;

  // MD5 of the interleaved little-endian samples, as the format defines it
  const md5 = new Md5();
  const chunk = new Uint8Array(BLOCK_SIZE * channels.length * bytesPerSample);
  const view = new DataView(chunk.buffer);

  const frames = new BitWriter(Math.max(1 << 16, total * channels.length * bytesPerSample * 0.7));
  let minFrame = Infinity;
  let maxFrame = 0;
  const frameCount = Math.ceil(total / BLOCK_SIZE);
  for (let f = 0; f < frameCount; f++) {
    const start = f * BLOCK_SIZE;
    const end = Math.min(total, start + BLOCK_SIZE);
    const blocks = channels.map((c) => c.subarray(start, end));
    let o = 0;
    for (let i = 0; i < end - start; i++) {
      for (const b of blocks) {
        if (bps === 16) view.setInt16(o, b[i], true);
        else { view.setUint16(o, b[i] & 0xffff, true); view.setInt8(o + 2, b[i] >> 16); }
        o += bytesPerSample;
      }
    }
    md5.update(chunk.subarray(0, o));
    const size = writeFrame(frames, f, blocks, sampleRate, bps);
    minFrame = Math.min(minFrame, size);
    maxFrame = Math.max(maxFrame, size);
    if (f % 64 === 0) onProgress(f / frameCount);
  }

  const head = new BitWriter(1024);
  for (const c of 'fLaC') head.write(c.charCodeAt(0), 8);
  metadataHeader(head, false, 0, 34);
  head.write(Math.min(BLOCK_SIZE, total) || 16, 16);
  head.write(Math.min(BLOCK_SIZE, total) || 16, 16);
  head.write(frameCount ? minFrame : 0, 24);
  head.write(maxFrame, 24);
  head.write(sampleRate, 20);
  head.write(channels.length - 1, 3);
  head.write(bps - 1, 5);
  head.write(Math.floor(total / 2 ** 32), 4);
  head.write(total >>> 0, 32);
  for (const b of md5.digest()) head.write(b, 8);

  const encoder = new TextEncoder();
  const vendorBytes = encoder.encode(vendor);
  const comments = Object.entries(tags).filter(([, v]) => v).map(([k, v]) => encoder.encode(`${k.toUpperCase()}=${v}`));
  const commentLength = 8 + vendorBytes.length + comments.reduce((s, c) => s + 4 + c.length, 0);
  metadataHeader(head, true, 4, commentLength);
  const le32 = (v) => { for (let i = 0; i < 4; i++) head.write((v >>> (8 * i)) & 0xff, 8); };
  le32(vendorBytes.length);
  for (const b of vendorBytes) head.write(b, 8);
  le32(comments.length);
  for (const c of comments) { le32(c.length); for (const b of c) head.write(b, 8); }

  const out = new Uint8Array(head.pos + frames.pos);
  out.set(head.bytes(), 0);
  out.set(frames.bytes(), head.pos);
  onProgress(1);
  return out;
}
