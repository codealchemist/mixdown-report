import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureLevels, truePeak, countClippedRuns } from '../src/core/levels.js';
import { FS, negate, sine } from './helpers.js';

test('true peak finds an inter-sample peak the samples miss', () => {
  // fs/4 sine at 45° phase: every sample sits at ±0.707, the waveform peaks at 1.0
  const x = sine({ freq: FS / 4, dbfs: 0, seconds: 1, phase: Math.PI / 4 });
  const r = measureLevels([x]);
  assert.ok(Math.abs(r.samplePeakDb + 3.01) < 0.05, `sample peak ${r.samplePeakDb}`);
  assert.ok(Math.abs(r.truePeakDb) < 0.3, `true peak ${r.truePeakDb}`);
});

test('true peak equals sample peak for a low-frequency sine', () => {
  const x = sine({ freq: 100, dbfs: -6, seconds: 1 });
  const peak = Math.max(...x.map(Math.abs));
  assert.ok(Math.abs(truePeak(x, peak) - peak) < 0.002);
});

test('clipping detection counts flat tops and ignores clean audio', () => {
  const clean = sine({ dbfs: -0.1, seconds: 1 });
  assert.equal(countClippedRuns([clean], Math.max(...clean.map(Math.abs))), 0);
  const clipped = sine({ dbfs: 6, seconds: 1, freq: 100 }).map((v) => Math.max(-1, Math.min(1, v)));
  assert.ok(countClippedRuns([clipped], 1) >= 100); // two flat tops per cycle
});

test('correlation and balance', () => {
  const x = sine({ seconds: 1 });
  assert.ok(Math.abs(measureLevels([x, x]).correlation - 1) < 1e-6);
  assert.ok(Math.abs(measureLevels([x, negate(x)]).correlation + 1) < 1e-6);
  const quieter = x.map((v) => v / 2);
  assert.ok(Math.abs(measureLevels([x, quieter]).balanceDb - 6.02) < 0.05);
  assert.equal(measureLevels([x]).correlation, null);
});

test('DC offset', () => {
  const x = sine({ seconds: 1 }).map((v) => v + 0.01);
  assert.ok(Math.abs(measureLevels([x]).dcOffset - 0.01) < 1e-4);
});
