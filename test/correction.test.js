import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/core/analyze.js';
import { evaluate } from '../src/core/evaluate.js';
import { suggestMasterEq } from '../src/core/eq/mastering.js';
import { combineCorrection, inverseOf, replacementSections, replacementLoudnessChange } from '../src/core/eq/correction.js';
import { bandResponse } from '../src/core/eq/fit.js';
import { buildEq } from '../src/core/eq/channel-eq.js';
import { eqSections } from '../src/core/eq/response.js';
import { applySections } from '../src/core/dsp/biquad.js';
import { measureLoudness } from '../src/core/loudness.js';
import { testEq } from '../src/core/eq/eq-test.js';
import { pinkNoise } from './helpers.js';

const FS = 44100;
const SETTINGS = { stage: 'mix', genre: 'pop', target: 'streaming' };
const close = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} expected ${b} ±${tol}, got ${a}`);
const render = (chs, sections) => chs.map((c) => applySections(Float32Array.from(c), sections));
const measure = (chs) => { const analysis = analyze(chs.map((c) => Float32Array.from(c)), FS); return { analysis, evaluation: evaluate(analysis, SETTINGS) }; };

function colouredMix(seconds = 10) {
  const l = pinkNoise(FS * seconds, { seed: 4 });
  const colour = eqSections(buildEq([{ type: 'peak', freq: 300, gain: 6, q: 0.9 }, { type: 'highShelf', freq: 9000, gain: -5, q: 0.71 }]).eq, FS);
  return render([l, Float32Array.from(l)], colour);
}

const correction = (() => {
  const eq = buildEq([{ type: 'lowCut', freq: 20, slope: 24 }, { type: 'lowShelf', freq: 50, gain: -2.5, q: 0.71 }, { type: 'peak', freq: 300, gain: -3, q: 1 }, { type: 'highShelf', freq: 10000, gain: 2, q: 0.71 }]).eq;
  eq.outputGain = 1.2;
  return eq;
})();

test('the inverse of a correction cancels its bells, shelves and output gain exactly', () => {
  const x = pinkNoise(FS * 2, { seed: 1 });
  const withoutCut = { ...correction, bands: { ...correction.bands, lowCut: { ...correction.bands.lowCut, on: false } } };
  const [y] = render(render([x], eqSections(withoutCut, FS)), eqSections(inverseOf(correction), FS));
  let err = 0;
  for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(y[i] - x[i]));
  assert.ok(err < 1e-4, `max sample error ${err}`);
});

test('replacing a correction with itself changes nothing', () => {
  const x = pinkNoise(FS * 2, { seed: 2 });
  const [y] = render([x], replacementSections(correction, correction, FS));
  let err = 0;
  for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(y[i] - x[i]));
  assert.ok(err < 1e-4, `max sample error ${err}`);
  assert.equal(replacementLoudnessChange(correction, correction, [{ fc: 1000, mid: 1, side: 0 }], FS), 0);
});

test('combining adds the new adjustment to the existing correction, band by band', () => {
  const before = bandResponse(correction);
  const after = bandResponse(combineCorrection(correction, [0, 0, 1.5, 0, 0, 0, -1]));
  close(after[2] - before[2], 1.5, 0.4, 'low mids');
  close(after[6] - before[6], -1, 0.4, 'air');
  for (const i of [3, 4]) close(after[i], before[i], 0.6, `band ${i} barely moves`);
  assert.deepEqual(combineCorrection(correction, [0, 0, 0, 0, 0, 0, 0]), correction, 'no adjustment keeps the correction as it is');
});

test('second round: the updated correction replaces the first, never stacks', () => {
  const mix = colouredMix();
  const round1 = measure(mix);
  const first = suggestMasterEq(round1.evaluation, { analysis: round1.analysis });
  assert.equal(first.mode, 'new');

  // The user loads correction 1 and bounces again
  const bounce2 = render(mix, eqSections(first.eq, FS));
  const round2 = measure(bounce2);
  const second = suggestMasterEq(round2.evaluation, { analysis: round2.analysis, current: first.eq });
  assert.equal(second.mode, 'update');

  // Testing "replace correction 1 with correction 2" on bounce 2 equals applying correction 2 to the original mix
  const replaced = render(bounce2, replacementSections(second.eq, first.eq, FS));
  const direct = render(mix, eqSections(second.eq, FS));
  let err = 0, peak = 0;
  for (let i = 1000; i < mix[0].length; i++) { err = Math.max(err, Math.abs(replaced[0][i] - direct[0][i])); peak = Math.max(peak, Math.abs(direct[0][i])); }
  assert.ok(err < peak * 1e-3, `replacement matches applying correction 2 directly (error ${err} of ${peak})`);

  // And it keeps loudness: the replacement doesn't change how loud the bounce is
  close(measureLoudness(replaced, FS).integrated, round2.analysis.integrated, 0.3, 'loudness kept');

  // The second round moves the tone further toward the target, or keeps it there
  const result = testEq(round2, measure(replaced));
  assert.notEqual(result.verdict, 'worse');
});
