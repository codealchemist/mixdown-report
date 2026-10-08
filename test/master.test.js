import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySections } from '../src/core/dsp/biquad.js';
import { eqResponse, eqSections } from '../src/core/eq/response.js';
import { buildEq } from '../src/core/eq/channel-eq.js';
import { compress } from '../src/core/master/compressor.js';
import { limit } from '../src/core/master/limiter.js';
import { CHARACTERS, toneEq } from '../src/core/master/tone.js';
import { masterMix } from '../src/core/master/chain.js';
import { measureLevels } from '../src/core/levels.js';
import { measureLoudness } from '../src/core/loudness.js';
import { sine } from './helpers.js';

const FS = 44100;
const close = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} expected ${b} ±${tol}, got ${a}`);
const rmsDb = (x, from = 0) => {
  let s = 0;
  for (let i = from; i < x.length; i++) s += x[i] * x[i];
  return 10 * Math.log10(s / (x.length - from));
};

/** Kick-like hits on every beat plus tones and noise: high crest factor, a hard case for limiting. */
function testMix(seconds = 12, gain = 1) {
  const n = FS * seconds;
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / FS, beat = t % 0.5;
    const s = 0.5 * Math.exp(-beat * 30) * Math.sin(2 * Math.PI * 60 * beat) + 0.12 * Math.sin(2 * Math.PI * 220 * t) + 0.06 * Math.sin(2 * Math.PI * 3300 * t) + 0.04 * rnd();
    L[i] = s * gain;
    R[i] = (0.9 * s + 0.02 * rnd()) * gain;
  }
  return [L, R];
}

test('filtering a sine through the EQ matches the predicted response', () => {
  const eq = buildEq([{ type: 'peak', freq: 1000, gain: 6, q: 1 }, { type: 'highShelf', freq: 8000, gain: -4, q: 0.71 }]).eq;
  const sections = eqSections(eq, FS);
  for (const f of [200, 1000, 12000]) {
    const x = sine({ freq: f, dbfs: -20, seconds: 1, fs: FS });
    const before = rmsDb(x, 4000);
    applySections(x, sections);
    close(rmsDb(x, 4000) - before, eqResponse(eq, [f], FS)[0], 0.05, `${f} Hz`);
  }
});

test('glue compressor reaches its target reduction on the loudest passages and leaves quiet ones alone', () => {
  const n = FS * 6;
  const quiet = 0.05, loud = 0.5;
  const x = Float32Array.from({ length: n }, (_, i) => (i < n / 2 ? quiet : loud) * Math.sin((2 * Math.PI * 200 * i) / FS));
  const y = Float32Array.from(x);
  const r = compress([y], FS, { ratio: 2, targetReductionDb: 2, kneeDb: 0 });
  close(rmsDb(x, n - FS) - rmsDb(y, n - FS), 2, 0.3, 'loud part');
  close(rmsDb(x.subarray(FS, n / 2 - FS)) - rmsDb(y.subarray(FS, n / 2 - FS)), 0, 0.05, 'quiet part');
  assert.equal(r.ratio, 2);
});

test('limiter holds the true-peak ceiling, including a peak in the first milliseconds', () => {
  const [L, R] = testMix(10, 2.8);
  L[3] = 1.5;
  const r = limit([L, R], FS, { ceilingDb: -1 });
  const levels = measureLevels([L, R]);
  assert.ok(levels.samplePeakDb <= -0.999, `sample peak ${levels.samplePeakDb}`);
  assert.ok(levels.truePeakDb <= -0.95, `true peak ${levels.truePeakDb}`);
  assert.ok(r.maxReductionDb >= 20 * Math.log10(1.5) + 1 - 0.05, 'at least the reduction the spike needs');
});

test('limiter leaves audio below the ceiling untouched', () => {
  const x = sine({ freq: 440, dbfs: -6, seconds: 1, fs: FS });
  const y = Float32Array.from(x);
  const r = limit([y], FS, { ceilingDb: -1 });
  assert.deepEqual(y, x);
  assert.equal(r.maxReductionDb, 0);
});

test('tone EQ: flat when the mix already matches; boosts and cuts follow the deviations', () => {
  const flat = toneEq([0, 0, 0, 0, 0, 0, 0], 'balanced', 0.6);
  assert.ok(Object.entries(flat.eq.bands).every(([k, b]) => k === 'lowCut' || !b.on));

  const muddy = toneEq([0, 0, 5, 0, 0, 0, -3], 'balanced', 1);
  assert.ok(muddy.predicted[2] < -3, 'low mids cut');
  assert.ok(muddy.predicted[6] > 2, 'air boosted');
  const bands = Object.values(muddy.eq.bands).filter((b) => b.on && b.gain);
  assert.ok(bands.every((b) => Math.abs(b.gain) <= 4.5), 'filters stay within ±4.5 dB');

  const none = toneEq([3, -2, 4, 0, 0, 0, 0], 'balanced', 0);
  assert.ok(Object.entries(none.eq.bands).every(([k, b]) => k === 'lowCut' || !b.on), 'strength 0 = no tone change');
});

test('characters tilt the tone in their direction', () => {
  const zero = [0, 0, 0, 0, 0, 0, 0];
  const warm = toneEq(zero, 'warm', 1).predicted;
  const bright = toneEq(zero, 'bright', 1).predicted;
  assert.ok(warm[1] > 0.5 && warm[6] < -1, 'warm: more bass, less air');
  assert.ok(bright[6] > 1 && bright[0] < 0.1, 'bright: more air');
  for (const c of Object.values(CHARACTERS)) assert.equal(c.tilt.length, 7);
});

test('mastering reaches the loudness target under the true-peak ceiling', () => {
  const mix = testMix(15, 0.6);
  const before = mix.map((c) => Float32Array.from(c));
  const { channels, report } = masterMix(mix, FS, { deviations: [0, 0, 0, 0, 0, 0, 0], character: 'punchy', targetLufs: -12, ceilingDb: -1 });
  close(measureLoudness(channels, FS).integrated, -12, 0.3, 'loudness');
  assert.ok(measureLevels(channels).truePeakDb <= -1 + 0.01);
  assert.deepEqual(mix, before, 'input untouched');
  assert.equal(report.characterName, 'Punchy');
  assert.ok(report.limiter.inputGainDb > 0);
});

test('mastering warns about large tonal differences and handles mono', () => {
  const mono = [testMix(8, 0.5)[0]];
  const { channels, report } = masterMix(mono, FS, { deviations: [0, 0, 9, 0, 0, 0, 0], targetLufs: -14, ceilingDb: -1 });
  assert.equal(channels.length, 2);
  assert.ok(report.warnings.some((w) => w.includes('low mids')));
});
