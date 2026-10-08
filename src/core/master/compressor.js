/**
 * Stereo-linked feed-forward "glue" compressor: RMS detector, soft knee, attack/release smoothing in dB.
 * The threshold is set from the song itself so the loudest passages get a chosen amount of gain reduction.
 */

const DETECTOR_MS = 10;

/** Detector level in dB per sample (stereo-linked RMS). */
function detectorLevels(channels, fs) {
  const n = channels[0].length;
  const coeff = Math.exp(-1 / ((DETECTOR_MS / 1000) * fs));
  const out = new Float32Array(n);
  let ms = 0;
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (const c of channels) p += c[i] * c[i];
    ms = coeff * ms + (1 - coeff) * (p / channels.length);
    out[i] = 10 * Math.log10(ms + 1e-12);
  }
  return out;
}

/** Gain reduction (dB, ≥ 0) for a level, with a soft knee. */
function gainReduction(level, threshold, ratio, knee) {
  const over = level - threshold;
  const slope = 1 - 1 / ratio;
  if (over <= -knee / 2) return 0;
  if (over >= knee / 2) return over * slope;
  return (slope * (over + knee / 2) ** 2) / (2 * knee);
}

/**
 * @param {Float32Array[]} channels processed in place
 * @param {number} fs
 * @param {{ ratio?: number, attackMs?: number, releaseMs?: number, kneeDb?: number, targetReductionDb?: number }} options
 *   targetReductionDb: reduction on the loudest 10 % of the song; the threshold is derived from it
 * @returns {{ thresholdDb: number, ratio: number, averageReductionDb: number, maxReductionDb: number }}
 */
export function compress(channels, fs, { ratio = 2, attackMs = 30, releaseMs = 200, kneeDb = 6, targetReductionDb = 1.5 } = {}) {
  const levels = detectorLevels(channels, fs);
  // Level exceeded 10 % of the time, ignoring silence
  const audible = levels.filter((l) => l > -70);
  if (!audible.length || targetReductionDb <= 0) return { thresholdDb: 0, ratio, averageReductionDb: 0, maxReductionDb: 0 };
  const step = Math.max(1, Math.floor(audible.length / 20000));
  const sample = [];
  for (let i = 0; i < audible.length; i += step) sample.push(audible[i]);
  sample.sort((a, b) => a - b);
  const loud = sample[Math.floor(sample.length * 0.9)];
  const threshold = loud - targetReductionDb / (1 - 1 / ratio);

  const attack = Math.exp(-1 / ((attackMs / 1000) * fs));
  const release = Math.exp(-1 / ((releaseMs / 1000) * fs));
  let gr = 0, sum = 0, max = 0;
  const n = levels.length;
  for (let i = 0; i < n; i++) {
    const target = gainReduction(levels[i], threshold, ratio, kneeDb);
    gr = target > gr ? attack * gr + (1 - attack) * target : release * gr + (1 - release) * target;
    const g = 10 ** (-gr / 20);
    for (const c of channels) c[i] *= g;
    sum += gr;
    if (gr > max) max = gr;
  }
  return { thresholdDb: threshold, ratio, averageReductionDb: sum / n, maxReductionDb: max };
}
