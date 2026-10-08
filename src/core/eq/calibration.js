/**
 * Calibration against Logic's real Channel EQ.
 *
 * 1. The app writes a test noise file (pink noise, deterministic, so the app can regenerate it exactly).
 * 2. In Logic, the noise plays through Channel EQ with a known preset and is bounced.
 * 3. measureResponse() divides the bounce's spectrum by the noise's spectrum: that is Channel EQ's
 *    frequency response. Using power spectra makes it independent of timing and latency.
 * 4. fitCalibration() finds how Logic interprets the stored values compared with the app's filter
 *    model (Q and gain scaling for bells and shelves, the cut-slope encoding) and checks every band.
 * 5. toLogicParams() then converts each exported preset so Logic reproduces the intended shape.
 */
import { BAND_INFO, BAND_KEYS, SLOPES, cloneEq, normalizeEq } from './channel-eq.js';
import { eqResponse } from './response.js';
import { createFFT } from '../fft.js';

/**
 * How a cut slope (dB/Oct) is stored in the preset: dB/Oct ÷ 6. Found in Logic's own presets and confirmed
 * in Logic 11's display (the calibration preset shows 18 and 36 dB/Oct as written).
 */
export const SLOPE_ENCODINGS = Object.freeze({
  times6: { encode: (slope) => slope / 6, decode: (value) => Math.round(value * 6) },
});
const slopeEncoding = (cal) => SLOPE_ENCODINGS[cal?.slopeEncoding] ?? SLOPE_ENCODINGS.times6;

/** No correction: the app's model is assumed to match Logic. */
export const IDENTITY = Object.freeze({ version: 1, bellQ: 1, bellGain: 1, shelfQ: 1, shelfGain: 1, cutQ: 1, slopeEncoding: 'times6' });

const kind = (key) => BAND_INFO[key].kind;
const isBell = (key) => kind(key) === 'peak';

/**
 * What Logic actually does with a preset's stored values, expressed in the app's filter model.
 * @param {object} raw EQ as stored in the preset (cut slopes decoded with the standard ×6 mapping)
 * @param {typeof IDENTITY} cal
 */
export function logicBehaviour(raw, cal = IDENTITY) {
  const eq = cloneEq(raw);
  for (const key of BAND_KEYS) {
    const b = eq.bands[key];
    if (kind(key) === 'cut') {
      b.slope = slopeEncoding(cal).decode(SLOPE_ENCODINGS.times6.encode(b.slope));
      b.q *= cal.cutQ ?? 1;
    } else {
      b.q *= isBell(key) ? cal.bellQ : cal.shelfQ;
      b.gain *= isBell(key) ? cal.bellGain : cal.shelfGain;
    }
  }
  return eq;
}

/**
 * The values to store so Logic reproduces `eq` (the inverse of logicBehaviour for bells and shelves).
 * Cut slopes stay in dB/Oct; the preset encoder applies the slope encoding.
 */
export function toLogicParams(eq, cal = IDENTITY) {
  const out = cloneEq(eq);
  for (const key of BAND_KEYS) {
    const b = out.bands[key];
    if (kind(key) === 'cut') {
      b.q /= cal.cutQ ?? 1;
      continue;
    }
    b.q /= isBell(key) ? cal.bellQ : cal.shelfQ;
    b.gain /= isBell(key) ? cal.bellGain : cal.shelfGain;
  }
  return normalizeEq(out);
}

/* ---------- test signal ---------- */

export const TEST_SIGNAL = Object.freeze({ sampleRate: 48000, seconds: 30, seed: 0x5eed1e55, peakDb: -6 });

/** Deterministic stereo pink noise (identical channels). Regenerated for every measurement. */
export function testSignal({ sampleRate = TEST_SIGNAL.sampleRate, seconds = TEST_SIGNAL.seconds, seed = TEST_SIGNAL.seed } = {}) {
  const n = Math.round(sampleRate * seconds);
  let s = seed >>> 0 || 1;
  const x = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, peak = 0;
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    const w = ((s >>> 0) / 4294967296) * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    x[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    peak = Math.max(peak, Math.abs(x[i]));
  }
  const g = 10 ** (TEST_SIGNAL.peakDb / 20) / peak;
  // Half-second fades so the file starts and ends without clicks
  const fade = Math.round(sampleRate * 0.5);
  for (let i = 0; i < n; i++) x[i] *= g * Math.min(1, i / fade, (n - 1 - i) / fade);
  return x;
}

/* ---------- measurement ---------- */

const FFT_SIZE = 16384; // 2.9 Hz bins at 48 kHz, for the mids and highs
const FFT_SIZE_LOW = 65536; // 0.7 Hz bins, for the lows, where third-octave bands are only a few Hz wide
const LOW_SPLIT_HZ = 300;

/** Welch power spectral density (power per Hz), using only frames where the signal is present. */
function psd(x, fs, N = FFT_SIZE) {
  const fft = createFFT(N);
  const w = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const wPower = w.reduce((s, v) => s + v * v, 0);
  const hop = N / 4;
  const frames = [];
  for (let start = 0; start + N <= x.length; start += hop) {
    let e = 0;
    for (let i = 0; i < N; i++) e += x[start + i] * x[start + i];
    frames.push({ start, e });
  }
  const loudest = frames.reduce((m, f) => Math.max(m, f.e), 0);
  const active = frames.filter((f) => f.e > loudest * 1e-3); // within 30 dB of the loudest frame
  const re = new Float64Array(N), im = new Float64Array(N);
  const sum = new Float64Array(N / 2 + 1);
  for (const { start } of active) {
    for (let i = 0; i < N; i++) { re[i] = x[start + i] * w[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k <= N / 2; k++) sum[k] += re[k] * re[k] + im[k] * im[k];
  }
  const scale = 1 / (active.length * fs * wPower);
  return { density: sum.map((v) => v * scale), binHz: fs / N, seconds: ((active.length - 1) * hop + N) / fs };
}

/** Log-spaced analysis frequencies (1/24 octave). */
export function measurementFrequencies(maxHz) {
  const out = [];
  for (let f = 25; f <= maxHz; f *= 2 ** (1 / 24)) out.push(f);
  return out;
}

/** Density around f: averaged over a 1/24-octave band, or interpolated between bins when the band is narrower than a bin. */
function smoothAt(spec, f) {
  const lo = f * 2 ** (-1 / 48), hi = f * 2 ** (1 / 48);
  const a = Math.ceil(lo / spec.binHz), b = Math.floor(hi / spec.binHz);
  if (b - a >= 1) {
    let s = 0;
    for (let k = a; k <= b; k++) s += spec.density[k];
    return s / (b - a + 1);
  }
  const k = f / spec.binHz;
  const i = Math.floor(k);
  return spec.density[i] + (k - i) * (spec.density[i + 1] - spec.density[i]);
}

/**
 * Channel EQ's response from a bounce of the test signal.
 * @param {Float32Array[]} bounce decoded bounce channels
 * @param {number} fs bounce sample rate
 * @returns {{ freqs: number[], db: number[], activeSeconds: number }}
 */
export function measureResponse(bounce, fs) {
  const mid = Float32Array.from(bounce[0], (v, i) => (bounce.length > 1 ? 0.5 * (v + bounce[1][i]) : v));
  const ref = testSignal();
  const out = psd(mid, fs);
  if (out.seconds < 10) throw new Error('The bounce is too short or mostly silent. Bounce the whole 30-second test noise.');
  const outLow = psd(mid, fs, FFT_SIZE_LOW);
  const refHigh = psd(ref, TEST_SIGNAL.sampleRate);
  const refLow = psd(ref, TEST_SIGNAL.sampleRate, FFT_SIZE_LOW);
  const freqs = measurementFrequencies(Math.min(18000, 0.45 * Math.min(fs, TEST_SIGNAL.sampleRate)));
  const db = freqs.map((f) => (f < LOW_SPLIT_HZ
    ? 10 * Math.log10(smoothAt(outLow, f) / smoothAt(refLow, f))
    : 10 * Math.log10(smoothAt(out, f) / smoothAt(refHigh, f))));
  return { freqs, db, activeSeconds: out.seconds };
}

/* ---------- fitting ---------- */

const geometric = (lo, hi, steps) => Array.from({ length: steps }, (_, i) => lo * (hi / lo) ** (i / (steps - 1)));
const Q_STEPS = geometric(0.4, 2.5, 41);
const GAIN_STEPS = geometric(0.7, 1.4, 29);

function residual(measured, model, fs) {
  const predicted = eqResponse(model, measured.freqs, fs);
  const diff = measured.db.map((m, i) => m - predicted[i]);
  const offset = diff.reduce((s, d) => s + d, 0) / diff.length;
  const rms = Math.sqrt(diff.reduce((s, d) => s + (d - offset) ** 2, 0) / diff.length);
  return { rms, offset, predicted };
}

/**
 * @param {{ freqs: number[], db: number[] }} measured from measureResponse
 * @param {object} raw the preset that was used, as stored (decodeChannelEq output)
 * @param {number} fs bounce sample rate
 */
export function fitCalibration(measured, raw, fs) {
  const params = { bellQ: 1, bellGain: 1, shelfQ: 1, shelfGain: 1, cutQ: 1 };
  const slopes = { lowCut: raw.bands.lowCut.slope, highCut: raw.bands.highCut.slope };
  const has = (test) => BAND_KEYS.some((k) => raw.bands[k].on && test(k));
  const usesBells = has((k) => isBell(k) && raw.bands[k].gain);
  const usesShelves = has((k) => kind(k) === 'shelf' && raw.bands[k].gain);
  const cuts = ['lowCut', 'highCut'].filter((k) => raw.bands[k].on);

  const model = () => {
    const eq = logicBehaviour(raw, { ...IDENTITY, ...params });
    eq.bands.lowCut.slope = slopes.lowCut;
    eq.bands.highCut.slope = slopes.highCut;
    return eq;
  };
  const score = () => residual(measured, model(), fs).rms;
  const before = residual(measured, raw, fs);

  const search = (obj, key, candidates) => {
    let best = obj[key], bestScore = score();
    for (const c of candidates) {
      obj[key] = c;
      const s = score();
      if (s < bestScore - 1e-6) { best = c; bestScore = s; }
    }
    obj[key] = best;
  };
  for (let round = 0; round < 3; round++) {
    for (const cut of cuts) search(slopes, cut, SLOPES);
    if (cuts.length) search(params, 'cutQ', Q_STEPS);
    if (usesBells) { search(params, 'bellQ', Q_STEPS); search(params, 'bellGain', GAIN_STEPS); }
    if (usesShelves) { search(params, 'shelfQ', Q_STEPS); search(params, 'shelfGain', GAIN_STEPS); }
  }

  // The slope encoding is known, so a cut that fits another slope better is a shape difference
  // near its corner. Keep the written slope unless another one fits clearly better.
  const SLOPE_MARGIN = 0.05; // dB of average fit
  for (const cut of cuts) {
    const best = slopes[cut];
    const fitted = score();
    slopes[cut] = raw.bands[cut].slope;
    const prevQ = params.cutQ;
    search(params, 'cutQ', Q_STEPS);
    if (score() > fitted + SLOPE_MARGIN) { slopes[cut] = best; params.cutQ = prevQ; }
  }
  const after = residual(measured, model(), fs);
  const observed = cuts.map((k) => ({ key: k, label: BAND_INFO[k].label, preset: raw.bands[k].slope, slope: slopes[k] }));

  // Band by band: does each band show up? A band is missing when the measurement near it fits the
  // corrected model better without that band than with it.
  const fitted = model();
  const nearIdx = (freq, octaves) => measured.freqs.map((f, i) => (Math.abs(Math.log2(f / freq)) <= octaves ? i : -1)).filter((i) => i >= 0);
  const errNear = (curve, idx) => Math.sqrt(idx.reduce((s, i) => s + (measured.db[i] - after.offset - curve[i]) ** 2, 0) / (idx.length || 1));
  const bandChecks = BAND_KEYS.filter((k) => raw.bands[k].on && kind(k) !== 'cut' && Math.abs(raw.bands[k].gain) >= 1).map((key) => {
    const b = raw.bands[key];
    const idx = nearIdx(b.freq, kind(key) === 'shelf' ? 1 : 0.35);
    const without = cloneEq(fitted);
    without.bands[key].on = false;
    const withErr = errNear(after.predicted, idx);
    const withoutErr = errNear(eqResponse(without, measured.freqs, fs), idx);
    const avg = (curve) => idx.reduce((s, i) => s + curve[i], 0) / (idx.length || 1);
    return {
      key, label: BAND_INFO[key].label, freq: b.freq, gain: b.gain,
      measured: avg(measured.db) - after.offset - raw.outputGain,
      intended: avg(eqResponse(raw, measured.freqs, fs)) - raw.outputGain,
      missing: withoutErr < withErr,
    };
  });

  const calibration = { ...IDENTITY, ...params };
  const quality = after.rms <= 0.5 ? 'good' : after.rms <= 1 ? 'fair' : 'poor';
  const missing = bandChecks.filter((b) => b.missing);
  // One verdict: 'ready' (use it) or 'unusable' (don't correct anything).
  const status = quality === 'poor' || missing.length ? 'unusable' : 'ready';

  const messages = [];
  const say = (severity, text) => messages.push({ severity, text });
  if (missing.length) say('critical', `${missing.map((b) => `${b.label} (${b.freq} Hz)`).join(', ')} didn't show up in Logic. The preset may have loaded into the wrong bands; don't rely on exported presets until this is resolved.`);
  if (quality === 'poor') say('critical', `The model can't match Logic's response (${after.rms.toFixed(2)} dB average difference). Check that the bounce contains only the test noise through this preset, with no other plugins.`);
  if (quality === 'good') say('good', `With the correction, the app's model matches Logic within ${after.rms.toFixed(2)} dB on average (${before.rms.toFixed(2)} dB without it).`);
  if (quality === 'fair') say('note', `With the correction, the app's model matches Logic within ${after.rms.toFixed(2)} dB on average (${before.rms.toFixed(2)} dB without it): close enough to use; predictions are slightly approximate.`);
  const shapeDiffs = observed.filter((o) => o.slope !== o.preset);
  if (observed.length && !shapeDiffs.length) say('good', `Cut filters behave as written (${observed.map((o) => `${o.label} ${o.preset} dB/Oct`).join(', ')}).`);
  for (const o of shapeDiffs) {
    say('note', `Logic's ${o.label} at ${o.preset} dB/Oct is ${o.slope > o.preset ? 'steeper' : 'gentler'} near its corner than the app's model of it (closest to the model's ${o.slope} dB/Oct). It loads as written; this only shapes the last octave before the cut.`);
  }
  const changed = (v) => Math.abs(v - 1) > 0.05;
  const parts = [
    changed(params.bellQ) && `bells ${params.bellQ > 1 ? 'narrower' : 'wider'} in Logic (Q ×${params.bellQ.toFixed(2)})`,
    changed(params.bellGain) && `bell gains ×${params.bellGain.toFixed(2)}`,
    changed(params.shelfQ) && `shelf Q ×${params.shelfQ.toFixed(2)}`,
    changed(params.shelfGain) && `shelf gains ×${params.shelfGain.toFixed(2)}`,
    changed(params.cutQ) && `cut-filter Q ×${params.cutQ.toFixed(2)}`,
  ].filter(Boolean);
  if (parts.length) say('note', `What differs from the app's model: ${parts.join(', ')}. Exports compensate for this once you use the calibration.`);
  else say('good', "Logic's filters behave like the app's model: no correction needed.");
  if (Math.abs(after.offset) > 1) say('note', `The bounce is ${Math.abs(after.offset).toFixed(1)} dB ${after.offset > 0 ? 'louder' : 'quieter'} overall than expected (fader or pan not at 0 dB?). This doesn't affect the calibration.`);

  return {
    calibration,
    status,
    usable: status !== 'unusable',
    quality,
    rmsBefore: before.rms,
    rmsAfter: after.rms,
    offsetDb: after.offset,
    slopes,
    cutSlopes: observed,
    bandChecks,
    messages,
    curves: { freqs: measured.freqs, measured: measured.db.map((d) => d - after.offset), modelBefore: eqResponse(raw, measured.freqs, fs), modelAfter: after.predicted },
  };
}
