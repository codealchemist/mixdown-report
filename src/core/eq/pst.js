/**
 * Reads and writes Logic Pro Channel EQ presets (.pst).
 *
 * The format is undocumented. It was mapped from Logic's own factory presets and user presets
 * (see docs/pst-format.md):
 *
 *   header (28 bytes, little-endian)
 *     u32  file size in bytes
 *     u32  1 (format version)
 *     u32  parameter count + 1
 *     8 B  "GAMETSPP"
 *     u32  236 (Channel EQ plugin id)
 *     u32  0
 *   float32 × (count − 1) parameters
 *     p0–p31  eight bands × [on, frequency Hz, gain dB (or slope ÷ 6 for cuts), Q]
 *     p32     output gain dB
 *     p33+    analyzer and display settings
 *   trailer (8 bytes): "xP8L", u32 8
 *
 * The slope encoding (value × 6 = dB/Oct) is confirmed in Logic 11's display. How Logic's filters respond to Q and gain can be measured
 * with the calibration in the app (src/core/eq/calibration.js); exports then apply the measured correction.
 * Which of p33+ is the Mid/Side Processing menu is unknown, so exports always use stereo processing.
 */
import { BAND_KEYS, BAND_INFO, flatEq, normalizeEq } from './channel-eq.js';
import { IDENTITY, SLOPE_ENCODINGS, toLogicParams } from './calibration.js';

export const PLUGIN_ID = 236;
const MAGIC = 'GAMETSPP';
const HEADER_BYTES = 28;
const TRAILER = Uint8Array.from([0x78, 0x38, 0x50, 0x4c, 0x08, 0x00, 0x00, 0x00]);
const EQ_PARAMS = 33; // 8 bands × 4 + output gain

/** p33–p50 as Logic's current default preset stores them (analyzer on, pre/post, range, etc.). */
const DEFAULT_EXTRAS = Object.freeze([1, 12.2, 0, 2, 0, 2, 0, 10, 1, -1, 0, 1, 0, 1, 30, 0, 60, 1]);
export const PARAM_COUNT = EQ_PARAMS + DEFAULT_EXTRAS.length; // 51, as written by current Logic versions

export class PstError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PstError';
  }
}

const SLOPE_UNIT = 6; // stored slope value × 6 = dB/Oct

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
/**
 * The float32 closest to v that is not smaller in magnitude. Logic truncates when it displays values,
 * so 0.9 stored as 0.89999998 would show as "0.89"; the next float up shows "0.90".
 */
function storable(v) {
  f32[0] = v;
  if (Math.abs(f32[0]) < Math.abs(v)) u32[0] += 1; // one step away from zero (sign-magnitude format)
  return f32[0];
}

/** Distinctive values for checking the preset format: load it in Logic and compare with these (docs/pst-format.md). */
export const CALIBRATION_EQ = Object.freeze({
  outputGain: -1.5,
  bands: {
    lowCut: { on: true, freq: 37, slope: 18, q: 0.71 },
    lowShelf: { on: true, freq: 61, gain: 2.5, q: 0.9 },
    peak1: { on: true, freq: 123, gain: -3.5, q: 1.7 },
    peak2: { on: true, freq: 456, gain: 4.5, q: 2.3 },
    peak3: { on: true, freq: 1789, gain: -5.5, q: 0.8 },
    peak4: { on: true, freq: 3456, gain: 6, q: 1.2 },
    highShelf: { on: true, freq: 9876, gain: -1, q: 0.6 },
    highCut: { on: true, freq: 15432, slope: 36, q: 0.71 },
  },
});


/**
 * Encodes a Channel EQ model as a .pst file.
 * @param {ReturnType<typeof flatEq>} model the EQ as it should sound
 * @param {{ calibration?: typeof IDENTITY }} [options] measured Logic behaviour; values are converted so Logic reproduces `model`
 * @returns {Uint8Array}
 */
export function encodeChannelEq(model, { calibration = IDENTITY } = {}) {
  const eq = toLogicParams(normalizeEq(model), calibration);
  const encodeSlope = (SLOPE_ENCODINGS[calibration.slopeEncoding] ?? SLOPE_ENCODINGS.times6).encode;
  const params = [];
  for (const key of BAND_KEYS) {
    const b = eq.bands[key];
    const third = BAND_INFO[key].kind === 'cut' ? encodeSlope(b.slope) : b.gain;
    params.push(b.on ? 1 : 0, b.freq, third, b.q);
  }
  params.push(eq.outputGain, ...DEFAULT_EXTRAS);

  const size = HEADER_BYTES + params.length * 4 + TRAILER.length;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, size, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, params.length + 1, true);
  for (let i = 0; i < MAGIC.length; i++) bytes[12 + i] = MAGIC.charCodeAt(i);
  view.setUint32(20, PLUGIN_ID, true);
  view.setUint32(24, 0, true);
  params.forEach((v, i) => view.setFloat32(HEADER_BYTES + i * 4, storable(v), true));
  bytes.set(TRAILER, HEADER_BYTES + params.length * 4);
  return bytes;
}

/**
 * Decodes a Channel EQ .pst (older 220- and 236-byte variants included).
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {{ eq: ReturnType<typeof flatEq>, paramCount: number, extras: number[] }}
 */
export function decodeChannelEq(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < HEADER_BYTES + EQ_PARAMS * 4) throw new PstError('File is too short to be a Channel EQ preset.');
  const magic = String.fromCharCode(...bytes.subarray(12, 20));
  if (magic !== MAGIC) throw new PstError('Not a Logic Pro plug-in preset.');
  if (view.getUint32(20, true) !== PLUGIN_ID) throw new PstError('This preset is for a different plug-in, not Channel EQ.');
  const paramCount = view.getUint32(8, true) - 1;
  if (HEADER_BYTES + paramCount * 4 > bytes.length || paramCount < EQ_PARAMS) throw new PstError('Preset header is inconsistent.');

  const p = Array.from({ length: paramCount }, (_, i) => view.getFloat32(HEADER_BYTES + i * 4, true));
  const eq = flatEq();
  BAND_KEYS.forEach((key, i) => {
    const [on, freq, third, q] = p.slice(i * 4, i * 4 + 4);
    const band = eq.bands[key];
    band.on = on >= 0.5;
    band.freq = round(freq, 2);
    band.q = round(q, 3);
    if (BAND_INFO[key].kind === 'cut') band.slope = Math.round(third * SLOPE_UNIT);
    else band.gain = round(third, 2);
  });
  eq.outputGain = round(p[32], 2);
  return { eq, paramCount, extras: p.slice(EQ_PARAMS) };
}

const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;

/** A safe file name for a preset: Logic shows the name without the extension in its menu. */
export function presetFileName(name) {
  const clean = String(name).normalize('NFC').replace(/[/\\:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${clean || 'Channel EQ'}.pst`;
}
