import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFFT } from '../src/core/fft.js';
import { measureSpectrum } from '../src/core/spectrum.js';
import { analyze, AnalysisError } from '../src/core/analyze.js';
import { BANDS } from '../src/core/profiles.js';
import { FS, bandIndex, negate, sine } from './helpers.js';

test('FFT puts a cosine in the right bin', () => {
  const n = 64;
  const fft = createFFT(n);
  const re = Float64Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * 5 * i) / n));
  const im = new Float64Array(n);
  fft(re, im);
  const mags = Array.from(re, (r, k) => Math.hypot(r, im[k]));
  assert.ok(Math.abs(mags[5] - n / 2) < 1e-9);
  assert.ok(Math.abs(mags[n - 5] - n / 2) < 1e-9);
  assert.ok(mags.every((m, k) => k === 5 || k === n - 5 || m < 1e-9));
});

test('FFT rejects sizes that are not powers of two', () => {
  assert.throws(() => createFFT(100), RangeError);
});

for (const [freq, id] of [[40, 'sub'], [120, 'low'], [350, 'lowmid'], [1000, 'mid'], [3000, 'upmid'], [6000, 'pres'], [11000, 'air']]) {
  test(`a ${freq} Hz tone lands in the ${id} band`, () => {
    const x = sine({ freq, seconds: 3 });
    const { bands } = measureSpectrum([x, x], FS);
    const loudest = bands.indexOf(Math.max(...bands));
    assert.equal(BANDS[loudest].id, id);
  });
}

test('in-phase stereo is centred; out-of-phase stereo is all side', () => {
  const x = sine({ freq: 60, seconds: 3 });
  const centred = measureSpectrum([x, x], FS);
  assert.ok(centred.lowCorrelation > 0.99);
  const sides = measureSpectrum([x, negate(x)], FS);
  assert.ok(sides.lowCorrelation < -0.99);
});

test('analyze combines all measurements and rejects unusable input', () => {
  const x = sine({ dbfs: -10, seconds: 4 });
  const a = analyze([x, x], FS);
  assert.equal(a.channelCount, 2);
  assert.ok(Math.abs(a.duration - 4) < 1e-9);
  assert.ok(Math.abs(a.plr - (a.truePeakDb - a.integrated)) < 1e-9);
  assert.equal(a.bands.length, BANDS.length);
  assert.ok(a.bands[bandIndex('mid')] > a.bands[bandIndex('air')]);
  assert.throws(() => analyze([new Float32Array(FS)], FS), AnalysisError); // silent
  assert.throws(() => analyze([new Float32Array(100)], FS), AnalysisError); // too short
  assert.throws(() => analyze([], FS), AnalysisError);
});

test('analyze reports progress from 0 to 1', () => {
  const x = sine({ seconds: 2 });
  const seen = [];
  analyze([x, x], FS, { onProgress: (_label, f) => seen.push(f) });
  assert.ok(seen.length >= 3);
  assert.ok(seen.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= seen[i - 1])));
  assert.equal(seen.at(-1), 1);
});
