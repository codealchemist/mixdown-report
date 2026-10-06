/** Runs every measurement on decoded audio. Pure: no DOM or Web Audio, so it works in a Worker and in Node. */
import { measureLevels } from './levels.js';
import { measureLoudness } from './loudness.js';
import { measureSpectrum } from './spectrum.js';

/**
 * @typedef {object} Analysis
 * @property {number} sampleRate
 * @property {number} duration seconds
 * @property {number} channelCount 1 or 2
 * @property {number} samplePeakDb
 * @property {number} truePeakDb
 * @property {number} rmsDb
 * @property {number} crestDb
 * @property {number} dcOffset
 * @property {number} clippedRuns
 * @property {number|null} correlation
 * @property {number|null} balanceDb positive = left louder
 * @property {number} integrated LUFS
 * @property {number} momentaryMax LUFS
 * @property {number[]} shortTerm LUFS, one value per shortTermStep
 * @property {number} shortTermStart seconds
 * @property {number} shortTermStep seconds
 * @property {number} shortTermMax LUFS
 * @property {number} loudnessRange LU
 * @property {number} plr peak-to-loudness ratio, dB
 * @property {{fc:number, mid:number, side:number, level:number}[]} thirds
 * @property {number[]} bands average third-octave level per BANDS entry, dB
 * @property {number|null} lowCorrelation below ~120 Hz
 * @property {number|null} lowSideDb side relative to mid below ~120 Hz
 * @property {number|null} widthDb side relative to mid, 160 Hz–16 kHz
 */

export class AnalysisError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AnalysisError';
  }
}

/**
 * @param {Float32Array[]} channels one or two channels of equal length; extra channels are ignored
 * @param {number} sampleRate
 * @param {{ onProgress?: (label: string, fraction: number) => void }} [options]
 * @returns {Analysis}
 */
export function analyze(channels, sampleRate, { onProgress = () => {} } = {}) {
  const chs = channels.slice(0, 2);
  if (!chs.length || !chs[0].length) throw new AnalysisError('The file contains no audio.');
  if (chs.length === 2 && chs[0].length !== chs[1].length) throw new AnalysisError('Channels have different lengths.');
  if (chs[0].length < sampleRate * 0.5) throw new AnalysisError('The file is shorter than half a second.');

  onProgress('Measuring peaks', 0.02);
  const levels = measureLevels(chs);
  if (!Number.isFinite(levels.samplePeakDb) || levels.samplePeakDb < -150) throw new AnalysisError('The file is silent.');

  onProgress('Measuring loudness', 0.3);
  const loudness = measureLoudness(chs, sampleRate);

  onProgress('Measuring spectrum', 0.45);
  const spectrum = measureSpectrum(chs, sampleRate, (f) => onProgress('Measuring spectrum', 0.45 + 0.55 * f));

  return {
    sampleRate,
    duration: chs[0].length / sampleRate,
    channelCount: chs.length,
    ...levels,
    ...loudness,
    plr: levels.truePeakDb - loudness.integrated,
    ...spectrum,
  };
}
