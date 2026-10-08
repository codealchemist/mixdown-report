/**
 * Model of Logic Pro's Channel EQ: eight bands in Logic's order plus output gain.
 * Moves (a cut, shelf or bell with a reason) are placed into the fixed band slots by `buildEq`.
 */
import { MINUS } from '../format.js';

/** Band slots in Logic's left-to-right order. Logic numbers them 1–8 in its interface. */
export const BAND_KEYS = Object.freeze(['lowCut', 'lowShelf', 'peak1', 'peak2', 'peak3', 'peak4', 'highShelf', 'highCut']);
export const PEAK_KEYS = Object.freeze(['peak1', 'peak2', 'peak3', 'peak4']);

export const BAND_INFO = Object.freeze({
  lowCut: { label: 'Low Cut', kind: 'cut' },
  lowShelf: { label: 'Low Shelf', kind: 'shelf' },
  peak1: { label: 'Band 3', kind: 'peak' },
  peak2: { label: 'Band 4', kind: 'peak' },
  peak3: { label: 'Band 5', kind: 'peak' },
  peak4: { label: 'Band 6', kind: 'peak' },
  highShelf: { label: 'High Shelf', kind: 'shelf' },
  highCut: { label: 'High Cut', kind: 'cut' },
});

/** Cut filter slopes Logic offers, in dB per octave. */
export const SLOPES = Object.freeze([6, 12, 18, 24, 36, 48]);

export const LIMITS = Object.freeze({ freq: [20, 20000], gain: [-24, 24], q: [0.1, 100], outputGain: [-24, 24] });

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const nearestSlope = (s) => SLOPES.reduce((best, x) => (Math.abs(x - s) < Math.abs(best - s) ? x : best), SLOPES[0]);

/**
 * Logic's default band positions with every band switched off and at 0 dB,
 * so an exported preset shows only the bands the app actually uses.
 */
export function flatEq() {
  return {
    outputGain: 0,
    bands: {
      lowCut: { on: false, freq: 20, slope: 12, q: 0.71 },
      lowShelf: { on: false, freq: 75, gain: 0, q: 1 },
      peak1: { on: false, freq: 100, gain: 0, q: 0.6 },
      peak2: { on: false, freq: 250, gain: 0, q: 0.3 },
      peak3: { on: false, freq: 1040, gain: 0, q: 0.41 },
      peak4: { on: false, freq: 2500, gain: 0, q: 0.2 },
      highShelf: { on: false, freq: 7500, gain: 0, q: 1 },
      highCut: { on: false, freq: 20000, slope: 24, q: 0.71 },
    },
  };
}

export const cloneEq = (eq) => ({ outputGain: eq.outputGain, bands: Object.fromEntries(BAND_KEYS.map((k) => [k, { ...eq.bands[k] }])) });

/** Clamps every value into Logic's ranges and snaps cut slopes to the slopes Logic offers. */
export function normalizeEq(eq) {
  const out = cloneEq(eq);
  out.outputGain = clamp(Number(out.outputGain) || 0, LIMITS.outputGain);
  for (const key of BAND_KEYS) {
    const b = out.bands[key];
    b.on = Boolean(b.on);
    b.freq = clamp(Number(b.freq) || 1000, LIMITS.freq);
    b.q = clamp(Number(b.q) || 0.71, LIMITS.q);
    if (BAND_INFO[key].kind === 'cut') b.slope = nearestSlope(Number(b.slope) || 12);
    else b.gain = clamp(Number(b.gain) || 0, LIMITS.gain);
  }
  return out;
}

/**
 * @typedef {object} Move
 * @property {'lowCut'|'highCut'|'lowShelf'|'highShelf'|'peak'} type
 * @property {number} freq Hz
 * @property {number} [gain] dB (shelves and bells)
 * @property {number} [q]
 * @property {number} [slope] dB/Oct (cuts)
 * @property {string} [reason] why the move is there, shown to the user
 */

const MERGE_RATIO = 1.5; // bells closer than this frequency ratio are merged into one

/**
 * Places moves into Channel EQ slots. Cuts keep the more aggressive setting, shelves and
 * nearby bells are combined (capped at ±maxGain dB), and when more than four bells remain the smallest are dropped.
 * @param {Move[]} moves
 * @returns {{ eq: ReturnType<typeof flatEq>, dropped: Move[] }}
 */
export function buildEq(moves, { outputGain = 0, maxGain = 12 } = {}) {
  const limit = (g) => Math.max(-maxGain, Math.min(maxGain, g));
  const eq = flatEq();
  eq.outputGain = outputGain;
  const dropped = [];
  const peaks = [];

  for (const m of moves) {
    if (m.type === 'lowCut' || m.type === 'highCut') {
      const band = eq.bands[m.type];
      const steeper = m.type === 'lowCut' ? !band.on || m.freq > band.freq : !band.on || m.freq < band.freq;
      if (steeper) Object.assign(band, { on: true, freq: m.freq, slope: m.slope ?? 12, q: m.q ?? 0.71 });
    } else if (m.type === 'lowShelf' || m.type === 'highShelf') {
      const band = eq.bands[m.type];
      if (band.on) band.gain = limit(band.gain + m.gain);
      else Object.assign(band, { on: true, freq: m.freq, gain: limit(m.gain), q: m.q ?? 0.71 });
    } else {
      const near = peaks.find((p) => Math.max(p.freq, m.freq) / Math.min(p.freq, m.freq) < MERGE_RATIO);
      if (near) {
        const weight = Math.abs(near.gain) + Math.abs(m.gain) || 1;
        near.freq = Math.round(Math.exp((Math.log(near.freq) * Math.abs(near.gain) + Math.log(m.freq) * Math.abs(m.gain)) / weight));
        near.gain += m.gain;
        near.q = Math.max(near.q, m.q ?? 1);
      } else peaks.push({ freq: m.freq, gain: m.gain, q: m.q ?? 1, source: m });
    }
  }

  const kept = peaks
    .filter((p) => Math.abs(p.gain) >= 0.25)
    .sort((a, b) => Math.abs(b.gain) - Math.abs(a.gain));
  for (const p of kept.slice(PEAK_KEYS.length)) dropped.push(p.source);
  kept.slice(0, PEAK_KEYS.length)
    .sort((a, b) => a.freq - b.freq)
    .forEach((p, i) => Object.assign(eq.bands[PEAK_KEYS[i]], { on: true, freq: p.freq, gain: Math.round(limit(p.gain) * 10) / 10, q: p.q }));

  return { eq: normalizeEq(eq), dropped };
}

/* ---------- text ---------- */

/** "300 Hz", "2.5 kHz", or exact hertz ("1789 Hz") when kHz would round the value. */
export function formatFreq(hz) {
  const f = Math.round(hz);
  if (f < 1000 || f % 100 !== 0) return `${f} Hz`;
  return `${f / 1000} kHz`;
}

export const formatGain = (g) => {
  const v = Math.round(Math.abs(g) * 10) / 10;
  return v === 0 ? '0' : `${g > 0 ? '+' : MINUS}${v}`;
};

export const formatQ = (q) => (Number.isInteger(q) ? q.toFixed(1) : String(Math.round(q * 100) / 100));

const TYPE_LABEL = { lowCut: 'Low Cut', highCut: 'High Cut', lowShelf: 'Low Shelf', highShelf: 'High Shelf', peak: 'Bell' };

/** One move as Logic users would read it, e.g. "Bell 300 Hz, −3 dB, Q 1.0". */
export function moveText(m) {
  if (m.type === 'lowCut' || m.type === 'highCut') return `${TYPE_LABEL[m.type]} ${formatFreq(m.freq)}, ${m.slope ?? 12} dB/Oct`;
  return `${TYPE_LABEL[m.type]} ${formatFreq(m.freq)}, ${formatGain(m.gain)} dB, Q ${formatQ(m.q ?? 1)}`;
}

/** One band of a built EQ as text, or null when the band is off. */
export function bandText(key, band) {
  if (!band.on) return null;
  const { label, kind } = BAND_INFO[key];
  if (kind === 'cut') return `${label}: ${formatFreq(band.freq)}, ${band.slope} dB/Oct`;
  return `${label}: ${formatFreq(band.freq)}, ${formatGain(band.gain)} dB, Q ${formatQ(band.q)}`;
}

/** All active bands as text lines, in Logic's order. */
export const eqLines = (eq) => [
  ...BAND_KEYS.map((k) => bandText(k, eq.bands[k])).filter(Boolean),
  ...(eq.outputGain ? [`Gain: ${formatGain(eq.outputGain)} dB`] : []),
];
