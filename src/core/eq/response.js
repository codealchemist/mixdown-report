/**
 * Digital filter design (RBJ Audio EQ Cookbook) for a Channel EQ model.
 * The same coefficients drive the predicted curves and the in-browser preview (IIRFilterNode),
 * so what you see is what you hear. Logic's own filter shapes differ slightly; this is an approximation.
 */
import { BAND_KEYS, BAND_INFO } from './channel-eq.js';
import { kWeightingCoefficients } from '../loudness.js';

/** @typedef {{ b: number[], a: number[] }} Section normalised so a[0] = 1 */

const norm = (b, a) => ({ b: b.map((v) => v / a[0]), a: a.map((v) => v / a[0]) });

function peaking(fs, f0, gain, q) {
  const A = 10 ** (gain / 40), w = (2 * Math.PI * f0) / fs, alpha = Math.sin(w) / (2 * q), c = Math.cos(w);
  return norm([1 + alpha * A, -2 * c, 1 - alpha * A], [1 + alpha / A, -2 * c, 1 - alpha / A]);
}

function shelf(fs, f0, gain, q, high) {
  const A = 10 ** (gain / 40), w = (2 * Math.PI * f0) / fs, alpha = Math.sin(w) / (2 * q), c = Math.cos(w), s = 2 * Math.sqrt(A) * alpha;
  if (high) {
    return norm(
      [A * (A + 1 + (A - 1) * c + s), -2 * A * (A - 1 + (A + 1) * c), A * (A + 1 + (A - 1) * c - s)],
      [A + 1 - (A - 1) * c + s, 2 * (A - 1 - (A + 1) * c), A + 1 - (A - 1) * c - s],
    );
  }
  return norm(
    [A * (A + 1 - (A - 1) * c + s), 2 * A * (A - 1 - (A + 1) * c), A * (A + 1 - (A - 1) * c - s)],
    [A + 1 + (A - 1) * c + s, -2 * (A - 1 + (A + 1) * c), A + 1 + (A - 1) * c - s],
  );
}

function pass2(fs, f0, q, high) {
  const w = (2 * Math.PI * f0) / fs, alpha = Math.sin(w) / (2 * q), c = Math.cos(w);
  const b = high ? [(1 + c) / 2, -(1 + c), (1 + c) / 2] : [(1 - c) / 2, 1 - c, (1 - c) / 2];
  return norm(b, [1 + alpha, -2 * c, 1 - alpha]);
}

function pass1(fs, f0, high) {
  const k = Math.tan((Math.PI * f0) / fs);
  return high ? norm([1, -1, 0], [1 + k, k - 1, 0]) : norm([k, k, 0], [1 + k, k - 1, 0]);
}

/** Butterworth Q values for each second-order section of an order-n filter. */
function butterworthQs(order) {
  const qs = [];
  for (let k = 0; k < Math.floor(order / 2); k++) qs.push(1 / (2 * Math.cos((Math.PI * (2 * k + 1)) / (2 * order))));
  return qs;
}

/** A cut filter of `slope` dB/Oct; the band's Q shapes the first section (Q 0.71 = Butterworth). */
function cut(fs, f0, slope, q, high) {
  const order = Math.max(1, Math.round(slope / 6));
  const sections = butterworthQs(order).map((bq, i) => pass2(fs, f0, i === 0 ? bq * (q / Math.SQRT1_2) : bq, high));
  if (order % 2) sections.push(pass1(fs, f0, high));
  return sections;
}

/**
 * Second-order sections for every active band, plus Channel EQ's output gain as a final gain stage.
 * @param {ReturnType<import('./channel-eq.js').flatEq>} eq
 * @param {number} fs
 * @returns {Section[]}
 */
export function eqSections(eq, fs) {
  const nyquistSafe = (f) => Math.min(f, fs * 0.45);
  const out = [];
  for (const key of BAND_KEYS) {
    const b = eq.bands[key];
    if (!b.on) continue;
    const f = nyquistSafe(b.freq);
    switch (BAND_INFO[key].kind) {
      case 'cut': out.push(...cut(fs, f, b.slope, b.q, key === 'lowCut')); break;
      case 'shelf': if (b.gain) out.push(shelf(fs, f, b.gain, b.q, key === 'highShelf')); break;
      default: if (b.gain) out.push(peaking(fs, f, b.gain, b.q));
    }
  }
  if (eq.outputGain) out.push({ b: [10 ** (eq.outputGain / 20), 0, 0], a: [1, 0, 0] }); // Channel EQ's output gain
  return out;
}

function sectionMagnitude({ b, a }, w) {
  const re = (c) => c[0] + c[1] * Math.cos(w) + c[2] * Math.cos(2 * w);
  const im = (c) => -(c[1] * Math.sin(w) + c[2] * Math.sin(2 * w));
  return Math.hypot(re(b), im(b)) / Math.hypot(re(a), im(a));
}

/**
 * Magnitude response in dB at each frequency, including output gain.
 * @param {number[]} freqs Hz
 */
export function eqResponse(eq, freqs, fs = 48000) {
  const sections = eqSections(eq, fs);
  return freqs.map((f) => {
    const w = (2 * Math.PI * Math.min(f, fs / 2 - 1)) / fs;
    let mag = 1;
    for (const s of sections) mag *= sectionMagnitude(s, w);
    return 20 * Math.log10(mag || 1e-12); // includes output gain (last section)
  });
}

/**
 * Level change the EQ causes on a given spectrum: power-weighted across third octaves.
 * Used to level-match the before/after preview.
 * @param {{ fc: number, mid: number, side: number }[]} thirds
 */
export function eqLevelChange(eq, thirds, fs = 48000) {
  const usable = thirds.filter((t) => t.mid + t.side > 0);
  if (!usable.length) return eq.outputGain;
  const gains = eqResponse(eq, usable.map((t) => t.fc), fs);
  let before = 0, after = 0;
  usable.forEach((t, i) => {
    const p = t.mid + t.side;
    before += p;
    after += p * 10 ** (gains[i] / 10);
  });
  return 10 * Math.log10(after / before);
}

/**
 * Estimated change in integrated loudness (LU) the EQ causes on a given spectrum: like eqLevelChange,
 * but each third octave is weighted by the K-filter that loudness meters use.
 */
export function eqLoudnessChange(eq, thirds, fs = 48000) {
  const usable = thirds.filter((t) => t.mid + t.side > 0 && t.fc < fs / 2);
  if (!usable.length) return eq.outputGain;
  const { shelf, highPass } = kWeightingCoefficients(fs);
  const kSections = [{ b: [shelf.b0, shelf.b1, shelf.b2], a: [1, shelf.a1, shelf.a2] }, { b: [1, -2, 1], a: [1, highPass.a1, highPass.a2] }];
  const gains = eqResponse(eq, usable.map((t) => t.fc), fs);
  let before = 0, after = 0;
  usable.forEach((t, i) => {
    const w = (2 * Math.PI * t.fc) / fs;
    const k = kSections.reduce((m, s) => m * sectionMagnitude(s, w), 1);
    const p = (t.mid + t.side) * k * k;
    before += p;
    after += p * 10 ** (gains[i] / 10);
  });
  return 10 * Math.log10(after / before);
}

/** Log-spaced frequencies for drawing curves. */
export function curveFrequencies(points = 160, lo = 20, hi = 20000) {
  return Array.from({ length: points }, (_, i) => lo * (hi / lo) ** (i / (points - 1)));
}
