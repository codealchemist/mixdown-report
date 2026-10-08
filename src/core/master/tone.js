/**
 * Tone shaping for mastering: moves the mix's tonal balance toward a target (genre curve or
 * reference track) plus a "character" tilt, with broad, musical filters.
 */
import { BANDS } from '../profiles.js';
import { fitEq } from '../eq/fit.js';

/** Characters: tilt (dB per band, added to the target) and glue-compressor settings. */
export const CHARACTERS = Object.freeze({
  balanced: {
    name: 'Balanced',
    description: 'Even tone that follows your genre curve or reference.',
    tilt: [0, 0, 0, 0, 0, 0, 0],
    glue: { ratio: 2, attackMs: 30, releaseMs: 200, targetReductionDb: 1.5 },
  },
  warm: {
    name: 'Warm',
    description: 'Fuller lows, softer top. Suits acoustic, soul and ballads.',
    tilt: [1, 1.5, 0.5, 0, -0.5, -1.5, -2.5],
    glue: { ratio: 1.5, attackMs: 50, releaseMs: 300, targetReductionDb: 1.5 },
  },
  bright: {
    name: 'Bright',
    description: 'More presence and air; vocals and cymbals forward. Suits pop.',
    tilt: [-0.5, 0, -0.5, 0, 0.5, 1.5, 2.5],
    glue: { ratio: 2, attackMs: 20, releaseMs: 150, targetReductionDb: 1.5 },
  },
  punchy: {
    name: 'Punchy',
    description: 'Tighter low mids, more kick and snare attack. Suits rock, hip-hop and EDM.',
    tilt: [1.5, 1, -1, 0, 1, 0.5, 0],
    glue: { ratio: 3, attackMs: 30, releaseMs: 120, targetReductionDb: 2 },
  },
});

/** One broad filter per band. */
const BAND_FILTERS = {
  sub: { type: 'lowShelf', freq: 55, q: 0.71 },
  low: { type: 'peak', freq: 110, q: 0.9 },
  lowmid: { type: 'peak', freq: 330, q: 0.9 },
  mid: { type: 'peak', freq: 1000, q: 0.7 },
  upmid: { type: 'peak', freq: 2800, q: 0.9 },
  pres: { type: 'peak', freq: 5600, q: 0.9 },
  air: { type: 'highShelf', freq: 10000, q: 0.71 },
};

const MAX_CORRECTION = 4; // dB per band, as asked of the filters
const DEADBAND = 0.4; // dB: smaller corrections are left out
const RUMBLE = { type: 'lowCut', freq: 20, slope: 24, q: 0.71 };

/**
 * @param {number[]} deviations mix minus target per band (from evaluate), shape only
 * @param {keyof typeof CHARACTERS} character
 * @param {number} strength 0–1: how far toward the target to move
 * @returns {{ eq: object, wanted: number[], predicted: number[] }}
 */
export function toneEq(deviations, character = 'balanced', strength = 0.6) {
  const tilt = CHARACTERS[character]?.tilt ?? CHARACTERS.balanced.tilt;
  const moves = BANDS.map((b, i) => {
    const c = (tilt[i] - deviations[i]) * strength;
    const wanted = Math.abs(c) < DEADBAND ? 0 : Math.max(-MAX_CORRECTION, Math.min(MAX_CORRECTION, c));
    return { ...BAND_FILTERS[b.id], band: i, wanted };
  });
  const { eq, wanted, predicted } = fitEq(moves, { base: [RUMBLE], maxFilterGain: 4.5, compensation: 1.5 });
  return { eq, wanted, predicted };
}
