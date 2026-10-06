/** Long-term average spectrum in third octaves, split into mid (centre) and side energy. */
import { createFFT } from './fft.js';
import { BANDS, THIRD_OCTAVES } from './profiles.js';
import { powerToDb } from './format.js';

const FFT_SIZE = 16384;
const MAX_FRAMES = 320;
const FLOOR_DB = 90; // levels more than this below the loudest band are clamped
const WIDTH_FLOOR_DB = -40;

/**
 * @param {Float32Array[]} channels
 * @param {number} fs
 * @param {(fraction: number) => void} [onProgress]
 */
export function measureSpectrum(channels, fs, onProgress = () => {}) {
  const N = FFT_SIZE;
  const len = channels[0].length;
  const L = channels[0];
  const R = channels[1] ?? channels[0];
  const fft = createFFT(N);
  const window = new Float64Array(N);
  for (let i = 0; i < N; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

  const midPower = new Float64Array(N / 2 + 1);
  const sidePower = new Float64Array(N / 2 + 1);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const frames = len <= N ? 1 : Math.min(MAX_FRAMES, Math.floor((len - N) / (N / 4)) + 1);
  const hop = frames > 1 ? (len - N) / (frames - 1) : 0;

  for (let f = 0; f < frames; f++) {
    const start = Math.round(f * hop);
    // Mid in the real part and side in the imaginary part: one FFT yields both spectra.
    for (let i = 0; i < N; i++) {
      const j = start + i;
      if (j < len) {
        re[i] = 0.5 * (L[j] + R[j]) * window[i];
        im[i] = 0.5 * (L[j] - R[j]) * window[i];
      } else {
        re[i] = 0;
        im[i] = 0;
      }
    }
    fft(re, im);
    for (let k = 1; k <= N / 2; k++) {
      const nk = (N - k) % N;
      const mr = re[k] + re[nk], mi = im[k] - im[nk];
      const sr = re[k] - re[nk], si = im[k] + im[nk];
      midPower[k] += (mr * mr + mi * mi) / 4;
      sidePower[k] += (sr * sr + si * si) / 4;
    }
    if (f % 16 === 15) onProgress(f / frames);
  }

  const binHz = fs / N;
  const nyquist = fs / 2;
  const thirds = THIRD_OCTAVES.map((fc) => {
    const lo = fc * 2 ** (-1 / 6);
    const hi = fc * 2 ** (1 / 6);
    if (hi > nyquist) return { fc, mid: 0, side: 0, level: -Infinity };
    let a = Math.ceil(lo / binHz);
    let b = Math.floor(hi / binHz);
    if (b < a) a = b = Math.round(fc / binHz); // band narrower than one bin
    let mid = 0, side = 0;
    for (let k = Math.max(1, a); k <= Math.min(b, N / 2); k++) {
      mid += midPower[k];
      side += sidePower[k];
    }
    return { fc, mid, side, level: powerToDb((mid + side) / frames) };
  });

  const top = Math.max(...thirds.map((t) => t.level).filter(Number.isFinite));
  for (const t of thirds) if (Number.isFinite(t.level)) t.level = Math.max(t.level, top - FLOOR_DB);

  const bands = BANDS.map((b) => {
    const inBand = thirds.filter((t) => t.fc >= b.lo && t.fc < b.hi && Number.isFinite(t.level));
    if (!inBand.length) return -Infinity;
    return powerToDb(inBand.reduce((s, t) => s + 10 ** (t.level / 10), 0) / inBand.length);
  });

  const result = { thirds, bands, lowCorrelation: null, lowSideDb: null, widthDb: null };
  if (channels.length === 2) {
    const sum = (pred) => thirds.filter(pred).reduce((acc, t) => [acc[0] + t.mid, acc[1] + t.side], [0, 0]);
    const [lowMid, lowSide] = sum((t) => t.fc <= 100); // third octaves up to ~112 Hz
    result.lowCorrelation = lowMid + lowSide > 0 ? (lowMid - lowSide) / (lowMid + lowSide) : 1;
    result.lowSideDb = Math.max(WIDTH_FLOOR_DB, powerToDb(lowSide) - powerToDb(lowMid));
    const [wMid, wSide] = sum((t) => t.fc >= 160 && t.fc <= 16000);
    result.widthDb = Math.max(WIDTH_FLOOR_DB, powerToDb(wSide) - powerToDb(wMid));
  }
  onProgress(1);
  return result;
}
