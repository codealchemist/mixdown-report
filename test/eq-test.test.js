import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/core/analyze.js';
import { evaluate } from '../src/core/evaluate.js';
import { suggestMasterEq } from '../src/core/eq/mastering.js';
import { buildEq, cloneEq } from '../src/core/eq/channel-eq.js';
import { eqSections } from '../src/core/eq/response.js';
import { applySections } from '../src/core/dsp/biquad.js';
import { checkPrediction, makePrediction, testEq } from '../src/core/eq/eq-test.js';
import { fakeAnalysis, noiseSource, pinkNoise } from './helpers.js';

const FS = 44100;
const SETTINGS = { stage: 'mix', genre: 'pop', target: 'streaming' };

/** Pink noise coloured to be muddy and dull: a clear, measurable tonal problem. */
function muddyMix(seconds = 12) {
  const n = FS * seconds;
  const left = pinkNoise(n, { seed: 1 });
  const right = pinkNoise(n, { seed: 2 });
  const tiny = noiseSource(3);
  const chs = [left, Float32Array.from(left, (v, i) => 0.9 * v + 0.1 * right[i] + 0.001 * tiny())];
  const colour = eqSections(buildEq([{ type: 'peak', freq: 300, gain: 7, q: 0.9 }, { type: 'highShelf', freq: 9000, gain: -6, q: 0.71 }, { type: 'peak', freq: 2800, gain: -4, q: 1 }]).eq, FS);
  for (const c of chs) applySections(c, colour);
  return chs;
}

const measure = (chs) => {
  const analysis = analyze(chs.map((c) => Float32Array.from(c)), FS);
  return { analysis, evaluation: evaluate(analysis, SETTINGS) };
};
const render = (chs, eq) => {
  const out = chs.map((c) => Float32Array.from(c));
  const sections = eqSections(eq, FS);
  for (const c of out) applySections(c, sections);
  return out;
};

test('end to end: the suggested master EQ, rendered and re-measured, moves the mix toward the target at the same loudness', () => {
  const mix = muddyMix();
  const before = measure(mix);

  // Without compensation: the app's loudness estimate matches the full measurement
  const raw = suggestMasterEq(before.evaluation, { analysis: before.analysis, keepLoudness: false });
  const rawResult = testEq(before, measure(render(mix, raw.eq)));
  assert.ok(Math.abs(raw.loudnessChange - rawResult.loudnessChange) < 0.2, `estimate ${raw.loudnessChange} vs measured ${rawResult.loudnessChange}`);

  // With "Keep loudness": closer to the target, nothing worse, loudness unchanged
  const { eq } = suggestMasterEq(before.evaluation, { analysis: before.analysis, keepLoudness: true });
  const result = testEq(before, measure(render(mix, eq)));
  assert.equal(result.verdict, 'better', JSON.stringify(result.messages));
  assert.ok(result.rmsAfter < result.rmsBefore - 1, `${result.rmsBefore} → ${result.rmsAfter}`);
  assert.ok(!result.bands.some((b) => b.status === 'worse'));
  assert.ok(Math.abs(result.loudnessChange) < 0.2, `loudness kept: ${result.loudnessChange}`);
});

test('test verdicts: worse, mixed and no change', () => {
  const tolerance = 3;
  const ev = (deviations) => ({ deviations, tolerance, basis: 'the Pop curve' });
  const a = (integrated = -18, truePeakDb = -4) => ({ integrated, truePeakDb });
  const before = { analysis: a(), evaluation: ev([0, 5, 0, 0, 0, 0, 0]) };
  assert.equal(testEq(before, { analysis: a(), evaluation: ev([0, 8, 0, 0, 0, 0, 0]) }).verdict, 'worse');
  assert.equal(testEq(before, { analysis: a(), evaluation: ev([0, 0, 0, 0, 0, -4, 0]) }).verdict, 'mixed');
  assert.equal(testEq(before, { analysis: a(), evaluation: ev([0, 4.9, 0, 0, 0, 0, 0]) }).verdict, 'no-change');
  const loud = testEq(before, { analysis: a(-15, 0.4), evaluation: ev([0, 1, 0, 0, 0, 0, 0]) });
  assert.ok(loud.messages.some((m) => m.text.includes('Keep loudness')));
  assert.ok(loud.messages.some((m) => m.severity === 'critical' && m.text.includes('limiter')));
});

test('checking a Logic bounce against the prediction diagnoses what happened', () => {
  const mix = muddyMix(10);
  const before = measure(mix);
  const { eq } = suggestMasterEq(before.evaluation, { analysis: before.analysis });
  const predicted = measure(render(mix, eq));
  const prediction = makePrediction({ name: 'song.wav', before, after: predicted, eq });
  const titles = (r) => r.diagnosis.map((d) => d.title).join(' | ');

  // Logic applied it as predicted
  const ok = checkPrediction(prediction, measure(render(mix, eq)));
  assert.ok(ok.applied > 0.9 && ok.applied < 1.1, `applied ${ok.applied}`);
  assert.match(titles(ok), /as predicted/);

  // Forgot to load it, or bypassed
  const missing = checkPrediction(prediction, before);
  assert.ok(Math.abs(missing.applied) < 0.1);
  assert.match(titles(missing), /doesn't seem to be in this bounce/);
  assert.doesNotMatch(titles(missing), /Some bands differ/, 'no filter-shape blame when the EQ is missing');

  // Loaded "inverted": every gain flipped
  const flipped = cloneEq(eq);
  for (const b of Object.values(flipped.bands)) if (b.gain !== undefined) b.gain = -b.gain;
  assert.match(titles(checkPrediction(prediction, measure(render(mix, flipped)))), /opposite way/);

  // Applied twice (another EQ doing the same, or sharper filters)
  assert.match(titles(checkPrediction(prediction, measure(render(render(mix, eq), eq)))), /much stronger/);
});

test('a check flags peaks that point to the EQ sitting after the limiter', () => {
  const ev = { deviations: [0, 0, 0, 0, 0, 0, 0], tolerance: 3, basis: 'the Pop curve' };
  const prediction = makePrediction({ name: 'x', before: { analysis: { integrated: -14, truePeakDb: -1 }, evaluation: ev }, after: { analysis: { integrated: -14, truePeakDb: -1 }, evaluation: ev }, eq: null });
  const actual = { analysis: fakeAnalysis({ integrated: -14, truePeakDb: 0.6 }), evaluation: ev };
  assert.ok(checkPrediction(prediction, actual).diagnosis.some((d) => /after the limiter/.test(d.text)));
});
