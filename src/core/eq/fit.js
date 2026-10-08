/**
 * Fits broad EQ moves so the EQ's average response per band matches what's wanted.
 *
 * Neighbouring filters overlap, so setting each one to its own band's correction over- or
 * under-shoots. This refines the gains against the combined response. Each filter stays on the
 * side of its own correction (a boost never becomes a cut) and may exceed it only a little,
 * so filters can't fight each other with large opposing gains.
 */
import { BANDS, THIRD_OCTAVES } from '../profiles.js';
import { buildEq } from './channel-eq.js';
import { eqResponse } from './response.js';

const BAND_THIRDS = BANDS.map((b) => THIRD_OCTAVES.filter((f) => f >= b.lo && f < b.hi && f <= 16000));

/** Average response (power-averaged over the band's third octaves, in dB) of an EQ in each band. */
export function bandResponse(eq, fs = 48000) {
  return BAND_THIRDS.map((freqs) => {
    const gains = eqResponse(eq, freqs, fs);
    return 10 * Math.log10(gains.reduce((s, g) => s + 10 ** (g / 10), 0) / gains.length) - eq.outputGain;
  });
}

/**
 * @param {Array<import('./channel-eq.js').Move & { band: number, wanted: number }>} moves one per band to correct; gain is ignored
 * @param {{ base?: import('./channel-eq.js').Move[], maxFilterGain?: number, compensation?: number, iterations?: number }} [options]
 *   base: moves that are always included unchanged (for example a rumble filter)
 * @returns {{ eq: object, moves: object[], wanted: number[], predicted: number[] }}
 */
export function fitEq(moves, { base = [], maxFilterGain = 4.5, compensation = 1.5, iterations = 8 } = {}) {
  const wanted = BANDS.map((_, i) => moves.find((m) => m.band === i)?.wanted ?? 0);
  const active = moves.filter((m) => m.wanted).map((m) => ({ ...m, gain: m.wanted }));
  const build = () => buildEq([...base, ...active.filter((m) => m.gain)]).eq;

  let eq = build();
  for (let i = 0; i < iterations; i++) {
    const got = bandResponse(eq);
    let worst = 0;
    for (const m of active) {
      const error = m.wanted - got[m.band];
      worst = Math.max(worst, Math.abs(error));
      const cap = Math.min(maxFilterGain, Math.abs(m.wanted) + compensation);
      const g = m.gain + 0.8 * error;
      m.gain = m.wanted > 0 ? Math.min(cap, Math.max(0, g)) : Math.max(-cap, Math.min(0, g));
      m.gain = Math.round(m.gain * 10) / 10;
    }
    eq = build();
    if (worst < 0.1) break;
  }
  return { eq, moves: active, wanted, predicted: bandResponse(eq) };
}
