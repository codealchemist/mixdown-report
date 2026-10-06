import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureLoudness, gate, powerToLufs } from '../src/core/loudness.js';
import { FS, concat, sine } from './helpers.js';

const close = (actual, expected, tol, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg}: expected ${expected} ±${tol}, got ${actual}`);

test('stereo 997 Hz sine at −23 dBFS reads −23 LUFS (EBU Tech 3341 case 1)', () => {
  const x = sine({ dbfs: -23, seconds: 20 });
  const { integrated } = measureLoudness([x, x], FS);
  close(integrated, -23, 0.1, 'integrated');
});

test('result is independent of sample rate', () => {
  for (const fs of [44100, 48000, 96000]) {
    const x = sine({ dbfs: -23, seconds: 10, fs });
    close(measureLoudness([x, x], fs).integrated, -23, 0.1, `${fs} Hz`);
  }
});

test('mono channel counts once: a −20 dBFS sine reads about −23 LUFS', () => {
  close(measureLoudness([sine({ dbfs: -20, seconds: 10 })], FS).integrated, -23, 0.1, 'mono');
});

test('silence is gated out of integrated loudness', () => {
  const x = concat(sine({ dbfs: -23, seconds: 10 }), new Float32Array(FS * 10));
  close(measureLoudness([x, x], FS).integrated, -23, 0.1, 'with silence');
});

test('loudness range of a 10 LU step is about 10 LU (EBU Tech 3342 style)', () => {
  const x = concat(sine({ dbfs: -20, seconds: 20 }), sine({ dbfs: -30, seconds: 20 }));
  close(measureLoudness([x, x], FS).loudnessRange, 10, 0.5, 'LRA');
});

test('short-term series has one value per 100 ms after the first 3 s', () => {
  const x = sine({ seconds: 10 });
  const r = measureLoudness([x, x], FS);
  assert.equal(r.shortTerm.length, 100 - 30 + 1);
  assert.equal(r.shortTermStart, 3);
});

test('gate returns −Infinity when every block is below −70 LUFS', () => {
  assert.equal(gate([1e-12, 1e-12], 10).loudness, -Infinity);
  assert.equal(powerToLufs(0), -Infinity);
});
