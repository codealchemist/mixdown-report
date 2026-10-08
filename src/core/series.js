/** Prepares chart data from an Analysis. Pure, so the charts only draw. */
import { BAND_CENTERS } from './profiles.js';
import { median } from './format.js';
import { eqResponse } from './eq/response.js';

const SPECTRUM_MAX_HZ = 16000;
const ALIGN_LO = 31.5;
const ALIGN_HI = 12500;

/** Linear interpolation of a per-band curve on a log-frequency axis. */
export function interpolateCurve(curve, fc) {
  const x = Math.log(fc);
  const xs = BAND_CENTERS.map(Math.log);
  if (x <= xs[0]) return curve[0];
  if (x >= xs[xs.length - 1]) return curve[curve.length - 1];
  for (let i = 0; i < xs.length - 1; i++) {
    if (x <= xs[i + 1]) {
      const u = (x - xs[i]) / (xs[i + 1] - xs[i]);
      return curve[i] + u * (curve[i + 1] - curve[i]);
    }
  }
  return 0;
}

/**
 * Mix and comparison curves in third octaves, level-matched and set so the comparison reads 0 dB at 1 kHz.
 * With `eq`, adds `withEq`: the mix as it would measure after that EQ (replacing `replacing`, when given).
 * @returns {{ fc: number, mix: number, comparison: number, withEq?: number }[]}
 */
export function spectrumSeries(analysis, evaluation, reference = null, eq = null, replacing = null) {
  const points = analysis.thirds.filter((t) => Number.isFinite(t.level) && t.fc <= SPECTRUM_MAX_HZ);
  const comparisonAt = (fc) => {
    if (!reference) return interpolateCurve(evaluation.genre.curve, fc);
    const r = reference.thirds.find((t) => t.fc === fc);
    return r && Number.isFinite(r.level) ? r.level : NaN;
  };
  const offset = median(points.filter((p) => p.fc >= ALIGN_LO && p.fc <= ALIGN_HI).map((p) => p.level - comparisonAt(p.fc)));
  const base = comparisonAt(1000);
  const freqs = points.map((p) => p.fc);
  const eqGains = eq ? eqResponse(eq, freqs, analysis.sampleRate).map((g) => g - eq.outputGain) : null;
  const oldGains = eq && replacing ? eqResponse(replacing, freqs, analysis.sampleRate).map((g) => g - replacing.outputGain) : null;
  return points.map((p, i) => ({
    fc: p.fc,
    mix: p.level - offset - base,
    comparison: comparisonAt(p.fc) - base,
    ...(eqGains ? { withEq: p.level - offset - base + eqGains[i] - (oldGains ? oldGains[i] : 0) } : {}),
  }));
}

/** Short-term loudness as time/value pairs. */
export function loudnessSeries(analysis) {
  return analysis.shortTerm.map((v, i) => ({ t: analysis.shortTermStart + i * analysis.shortTermStep, v }));
}
