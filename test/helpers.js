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

/** Deterministic white noise in −1…1 (xorshift32; safe in 32-bit integer arithmetic). */
export function noiseSource(seed = 0x12345678) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

/** Pink noise (Paul Kellet's filter): equal energy per octave, so flat in third-octave analysis. */
export function pinkNoise(length, { seed, gain = 0.05 } = {}) {
  const rnd = noiseSource(seed);
  const out = new Float32Array(length);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < length; i++) {
    const w = rnd();
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * gain;
    b6 = w * 0.115926;
  }
  return out;
}

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
