/**
 * Masters an unlimited mix: tone EQ → glue compression → true-peak limiter driven to a loudness target.
 * Pure and offline; runs in the render worker.
 */
import { eqSections } from '../eq/response.js';
import { eqLines } from '../eq/channel-eq.js';
import { applySections } from '../dsp/biquad.js';
import { measureLoudness } from '../loudness.js';
import { measureLevels } from '../levels.js';
import { CHARACTERS, toneEq } from './tone.js';
import { compress } from './compressor.js';
import { limit } from './limiter.js';

const LIMITER_MARGIN = 0.1; // dB under the ceiling, for meter differences and later conversion
const MAX_ITERATIONS = 5;

/**
 * @param {Float32Array[]} channels the mix (not modified)
 * @param {number} fs
 * @param {{ deviations: number[], character?: string, strength?: number, targetLufs?: number, ceilingDb?: number, onProgress?: Function }} options
 */
export function masterMix(channels, fs, { deviations, character = 'balanced', strength = 0.6, targetLufs = -14, ceilingDb = -1, onProgress = () => {} }) {
  const settings = CHARACTERS[character] ?? CHARACTERS.balanced;
  let chs = channels.slice(0, 2).map((c) => Float32Array.from(c));
  if (chs.length === 1) chs = [chs[0], Float32Array.from(chs[0])];
  const before = measureLoudness(chs, fs).integrated;

  onProgress('Shaping the tone', 0.05);
  const tone = toneEq(deviations, character, strength);
  const sections = eqSections(tone.eq, fs);
  for (const c of chs) applySections(c, sections);

  onProgress('Glue compression', 0.2);
  const glue = compress(chs, fs, settings.glue);

  // Drive the limiter until integrated loudness lands on the target. Limiting lowers loudness a little,
  // so each pass corrects the input gain by what's still missing.
  const afterGlue = measureLoudness(chs, fs).integrated;
  let inputGainDb = targetLufs - afterGlue;
  let out, limiter, loudness = -Infinity;
  for (let pass = 0; pass < MAX_ITERATIONS; pass++) {
    onProgress('Limiting to your loudness target', 0.3 + 0.6 * (pass / MAX_ITERATIONS));
    out = chs.map((c) => Float32Array.from(c));
    limiter = limit(out, fs, { ceilingDb: ceilingDb - LIMITER_MARGIN, inputGainDb });
    loudness = measureLoudness(out, fs).integrated;
    const error = targetLufs - loudness;
    if (Math.abs(error) < 0.1 || inputGainDb > 30) break;
    inputGainDb += error;
  }

  onProgress('Final checks', 0.95);
  let levels = measureLevels(out);
  let trimDb = 0;
  if (levels.truePeakDb > ceilingDb) {
    trimDb = ceilingDb - levels.truePeakDb - 0.02;
    const g = 10 ** (trimDb / 20);
    for (const c of out) for (let i = 0; i < c.length; i++) c[i] *= g;
    levels = measureLevels(out);
    loudness = measureLoudness(out, fs).integrated;
  }

  const warnings = [];
  const BAND_NAMES = ['sub', 'bass', 'low mids', 'mids', 'upper mids', 'presence', 'air'];
  const large = deviations.map((d, i) => ({ d, name: BAND_NAMES[i] })).filter((x) => Math.abs(x.d) > 6);
  if (large.length) warnings.push(`Large tonal differences (${large.map((x) => `${x.name} ${x.d > 0 ? '+' : '−'}${Math.abs(x.d).toFixed(1)} dB`).join(', ')}) are best fixed in the mix; mastering moves them only part of the way.`);
  if (limiter.averageReductionDb > 3) warnings.push(`The limiter is working hard (${limiter.averageReductionDb.toFixed(1)} dB on average). Expect less punch; a lower loudness target will sound more open.`);
  if (limiter.maxReductionDb > 8) warnings.push(`Peaks are reduced by up to ${limiter.maxReductionDb.toFixed(1)} dB. Check drum hits for dulling or distortion.`);
  if (Math.abs(loudness - targetLufs) > 0.5) warnings.push(`Reached ${loudness.toFixed(1)} LUFS instead of ${targetLufs} LUFS.`);

  onProgress('Done', 1);
  return {
    channels: out,
    report: {
      character,
      characterName: settings.name,
      strength,
      targetLufs,
      ceilingDb,
      tone: { lines: eqLines(tone.eq), wanted: tone.wanted, predicted: tone.predicted },
      glue,
      limiter: { ...limiter, inputGainDb },
      loudnessBefore: before,
      loudnessAfter: loudness,
      truePeakDb: levels.truePeakDb,
      trimDb,
      warnings,
    },
  };
}
