/**
 * The correction EQ approach.
 *
 * The app never edits the user's own master EQ. It suggests one extra Channel EQ, the
 * "Mixdown correction", inserted after the user's master EQ and before any compressor or limiter.
 * The suggestion corrects what is in the bounce, so it always sits on top of whatever is already there.
 *
 * When the user bounces again with the correction in place, the new adjustment is folded into the
 * existing correction and the user replaces that EQ's settings. There is never a second correction EQ.
 */
import { BANDS } from '../profiles.js';
import { BAND_ADVICE } from '../advice.js';
import { BAND_KEYS, BAND_INFO, cloneEq } from './channel-eq.js';
import { fitEq, bandResponse } from './fit.js';
import { eqResponse, eqSections } from './response.js';
import { kWeightingCoefficients } from '../loudness.js';

export const CORRECTION_NAME = 'Mixdown correction';
const MAX_TOTAL = 6; // dB per band for the whole correction, however many rounds it took
const RUMBLE = { type: 'lowCut', freq: 20, slope: 24, q: 0.71 };

/**
 * The correction after this round: the correction already in the bounce plus the new adjustment.
 * @param {object} current the correction EQ the user has loaded (as exported)
 * @param {number[]} adjustment wanted change per band from this bounce (dB)
 */
export function combineCorrection(current, adjustment) {
  if (adjustment.every((a) => !a)) return cloneEq(current);
  const now = bandResponse(current);
  const moves = BANDS.map((band, i) => {
    const total = Math.max(-MAX_TOTAL, Math.min(MAX_TOTAL, now[i] + adjustment[i]));
    if (Math.abs(total) < 0.4) return null;
    const template = BAND_ADVICE[band.id][total > 0 ? 'low' : 'high'].master; // 'low' advice boosts, 'high' cuts
    return { ...template, band: i, wanted: total, reason: `Correction ${total > 0 ? '+' : ''}${total.toFixed(1)} dB in ${band.name.toLowerCase()}` };
  }).filter(Boolean);
  const { eq } = fitEq(moves, { base: [current.bands.lowCut.on ? { ...current.bands.lowCut, type: 'lowCut' } : RUMBLE], maxFilterGain: MAX_TOTAL, compensation: 1 });
  eq.outputGain = current.outputGain;
  return eq;
}

/** Removes the old correction's bells and shelves (exact inverse) so a replacement can be tested on a bounce that contains it. */
export function inverseOf(eq) {
  const inv = cloneEq(eq);
  for (const key of BAND_KEYS) {
    const b = inv.bands[key];
    if (BAND_INFO[key].kind === 'cut') b.on = false; // cuts can't be undone; replacements keep the same rumble filter
    else b.gain = -b.gain;
  }
  inv.outputGain = -eq.outputGain;
  return inv;
}

/** Filter sections that turn a bounce made with `current` into one made with `next` instead. */
export function replacementSections(next, current, fs) {
  const nextWithoutSameCuts = cloneEq(next);
  for (const key of ['lowCut', 'highCut']) {
    const a = next.bands[key], b = current.bands[key];
    if (a.on && b.on && a.freq === b.freq && a.slope === b.slope) nextWithoutSameCuts.bands[key].on = false; // already in the bounce
  }
  return [...eqSections(inverseOf(current), fs), ...eqSections(nextWithoutSameCuts, fs)];
}

/** Loudness change (LU) of replacing `current` with `next`, estimated on a spectrum that already includes `current`. */
export function replacementLoudnessChange(next, current, thirds, fs) {
  const usable = thirds.filter((t) => t.mid + t.side > 0 && t.fc < fs / 2);
  if (!usable.length) return 0;
  const { shelf, highPass } = kWeightingCoefficients(fs);
  const freqs = usable.map((t) => t.fc);
  const a = eqResponse(next, freqs, fs);
  const b = eqResponse(current, freqs, fs);
  const mag = (c, w) => Math.hypot(c[0] + c[1] * Math.cos(w) + c[2] * Math.cos(2 * w), c[1] * Math.sin(w) + c[2] * Math.sin(2 * w));
  let before = 0, after = 0;
  usable.forEach((t, i) => {
    const w = (2 * Math.PI * t.fc) / fs;
    const k = (mag([shelf.b0, shelf.b1, shelf.b2], w) / mag([1, shelf.a1, shelf.a2], w)) * (mag([1, -2, 1], w) / mag([1, highPass.a1, highPass.a2], w));
    const p = (t.mid + t.side) * k * k;
    before += p;
    after += p * 10 ** ((a[i] - b[i]) / 10);
  });
  return 10 * Math.log10(after / before);
}
