/**
 * The suggested correction EQ for the Stereo Out: closed-loop and loudness-safe.
 * It corrects what is in the bounce, so it goes on a separate Channel EQ after the user's own
 * master EQ (see correction.js). When a correction is already in the bounce, the suggestion is
 * the updated whole correction, to replace that EQ's settings.
 */
import { fitEq, bandResponse } from './fit.js';
import { eqLoudnessChange } from './response.js';
import { combineCorrection, replacementLoudnessChange } from './correction.js';

export const SUBSONIC_CUT = Object.freeze({ type: 'lowCut', freq: 20, slope: 24, q: 0.71, reason: 'Removes inaudible rumble below 20 Hz that wastes limiter headroom' });

const MAX_FILTER_GAIN = 4; // dB: mastering moves stay gentle even when compensating for overlap

/**
 * @param {ReturnType<typeof import('../evaluate.js').evaluate>} evaluation
 * @param {{ analysis?: object|null, keepLoudness?: boolean, current?: object|null }} [options]
 *   keepLoudness: set Channel EQ's output gain so the EQ doesn't change integrated loudness
 *   current: the correction EQ already in this bounce; the result then replaces it
 * @returns {{ eq: object, mode: 'new'|'update', unchanged: boolean, moves: object[], wanted: number[], change: number[], loudnessChange: number, notes: string[] }}
 */
export function suggestMasterEq(evaluation, { analysis = null, keepLoudness = true, current = null } = {}) {
  // Each tonal finding asks for half its difference (at most 3 dB); the fit makes the combined
  // filters deliver that per band instead of over-cutting where neighbouring filters overlap.
  const requested = evaluation.masterMoves.map((m) => ({ ...m, wanted: m.gain }));
  const fitted = fitEq(requested, { base: [SUBSONIC_CUT], maxFilterGain: MAX_FILTER_GAIN, compensation: 1 });

  let eq, loudnessChange, change;
  if (current) {
    eq = combineCorrection(current, fitted.wanted);
    const now = bandResponse(current);
    change = bandResponse(eq).map((v, i) => v - now[i]);
    loudnessChange = analysis ? replacementLoudnessChange(eq, current, analysis.thirds, analysis.sampleRate) : 0;
    if (keepLoudness && Math.abs(loudnessChange) >= 0.1) eq.outputGain = Math.round((current.outputGain - loudnessChange) * 10) / 10;
  } else {
    eq = fitted.eq;
    change = fitted.predicted;
    loudnessChange = analysis ? eqLoudnessChange(eq, analysis.thirds, analysis.sampleRate) : 0;
    if (keepLoudness && Math.abs(loudnessChange) >= 0.1) eq.outputGain = Math.round(-loudnessChange * 10) / 10;
  }
  const unchanged = Boolean(current) && fitted.wanted.every((w) => !w);

  const notes = [];
  if (evaluation.findings.some((f) => f.id === 'low-end-sides')) {
    notes.push("Low end isn't centered. That needs Channel EQ's Processing menu set to Side with a Low Cut at 120 Hz, which a preset can't include yet.");
  }
  if (fitted.moves.filter((m) => m.type === 'peak' && m.gain).length > 4) notes.push('Channel EQ has four bell bands, so the smallest correction was left out.');
  if (evaluation.stage === 'mix' && requested.length) notes.push('This is a mix, so fix the tracks first; use the correction EQ only for what remains.');
  return { eq, mode: current ? 'update' : 'new', unchanged, moves: [SUBSONIC_CUT, ...fitted.moves], wanted: fitted.wanted, predicted: change, change, loudnessChange, notes };
}
