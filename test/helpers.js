/** Signal generators and fixtures shared by the tests. */
import { BANDS } from '../src/core/profiles.js';

export const FS = 48000;

/** A sine wave with peak amplitude `dbfs`. */
export function sine({ freq = 997, dbfs = -20, seconds = 5, fs = FS, phase = 0 } = {}) {
  const amp = 10 ** (dbfs / 20);
  const out = new Float32Array(Math.round(seconds * fs));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / fs + phase);
  return out;
}

export function concat(...parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export const negate = (x) => x.map((v) => -v);

/** A plausible analysis of a clean stereo mix; override fields to trigger individual rules. */
export function fakeAnalysis(overrides = {}) {
  return {
    sampleRate: 48000, duration: 180, channelCount: 2,
    samplePeakDb: -4, truePeakDb: -3.8, rmsDb: -20, crestDb: 16, dcOffset: 0, clippedRuns: 0,
    correlation: 0.6, balanceDb: 0.2,
    integrated: -18, momentaryMax: -12, shortTerm: [-19, -18, -17], shortTermStart: 3, shortTermStep: 0.1, shortTermMax: -15,
    loudnessRange: 7, plr: 14.2,
    thirds: [], bands: [4, 7, 3, 0, -5, -8, -13], // matches the pop curve exactly
    lowCorrelation: 0.98, lowSideDb: -25, widthDb: -10,
    ...overrides,
  };
}

export const bandIndex = (id) => BANDS.findIndex((b) => b.id === id);
