import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, bandDeviations, meterStates } from '../src/core/evaluate.js';
import { GENRES } from '../src/core/profiles.js';
import { bandIndex, fakeAnalysis } from './helpers.js';

const ids = (ev) => ev.findings.map((f) => f.id);
const MIX = { stage: 'mix', genre: 'pop', target: 'streaming' };
const MASTER = { stage: 'master', genre: 'pop', target: 'streaming' };

test('a clean mix that matches the genre curve has no findings', () => {
  const ev = evaluate(fakeAnalysis(), MIX);
  assert.deepEqual(ids(ev), []);
  assert.ok(ev.ok.includes('Headroom'));
  assert.ok(ev.deviations.every((d) => Math.abs(d) < 1e-9));
});

test('deviations ignore overall level and compare shape only', () => {
  const louder = GENRES.pop.curve.map((v) => v + 20);
  assert.deepEqual(bandDeviations(louder, GENRES.pop.curve).map((d) => Math.round(d * 1e6) / 1e6), [0, 0, 0, 0, 0, 0, 0]);
});

test('muddy low mids are reported with track-level steps in a mix and a master EQ move in a master', () => {
  const bands = [...GENRES.pop.curve];
  bands[bandIndex('lowmid')] += 6;
  const mix = evaluate(fakeAnalysis({ bands }), MIX);
  const f = mix.findings.find((x) => x.id === 'band-lowmid-high');
  assert.ok(f, 'finding present');
  assert.equal(f.severity, 'warning');
  assert.match(f.steps[0], /sweep/i);
  const master = evaluate(fakeAnalysis({ bands, integrated: -14, truePeakDb: -1.2, plr: 12.8 }), MASTER);
  assert.match(master.findings.find((x) => x.id === 'band-lowmid-high').steps[0], /Bell 300 Hz, −3 dB/);
  assert.ok(master.chain[0].settings.some((s) => s.startsWith('Bell 300 Hz')));
});

test('very large band deviations are critical', () => {
  const bands = [...GENRES.pop.curve];
  bands[bandIndex('upmid')] += 10;
  assert.equal(evaluate(fakeAnalysis({ bands }), MIX).findings[0].severity, 'critical');
});

test('a reference track tightens the tolerance', () => {
  const bands = [...GENRES.pop.curve];
  bands[bandIndex('pres')] += 2.6;
  assert.ok(!ids(evaluate(fakeAnalysis({ bands }), MIX)).includes('band-pres-high'));
  const ref = fakeAnalysis();
  assert.ok(ids(evaluate(fakeAnalysis({ bands }), MIX, { reference: ref })).includes('band-pres-high'));
});

test('dark top end in a lossy file becomes a note about the format', () => {
  const bands = [...GENRES.pop.curve];
  bands[bandIndex('air')] -= 8;
  const ev = evaluate(fakeAnalysis({ bands }), MIX, { file: { lossy: true } });
  assert.ok(ids(ev).includes('air-lossy'));
  assert.ok(!ids(ev).includes('band-air-low'));
});

test('mix stage: headroom, limiting and clipping', () => {
  assert.ok(ids(evaluate(fakeAnalysis({ truePeakDb: -0.2 }), MIX)).includes('mix-headroom'));
  assert.ok(ids(evaluate(fakeAnalysis({ plr: 7 }), MIX)).includes('mix-limited'));
  const clipped = evaluate(fakeAnalysis({ clippedRuns: 12, truePeakDb: 0.4 }), MIX);
  assert.equal(clipped.findings[0].id, 'clipping');
  assert.ok(!ids(clipped).includes('mix-headroom'), 'clipping replaces the headroom warning');
});

test('master stage: loudness against target, true peak and over-limiting', () => {
  const quiet = evaluate(fakeAnalysis({ integrated: -18, truePeakDb: -1.2 }), MASTER);
  assert.ok(ids(quiet).includes('master-quiet'));
  assert.match(quiet.chain[2].settings[0], /\+4\.0 dB/);
  const onTarget = evaluate(fakeAnalysis({ integrated: -14.4, truePeakDb: -1.1, plr: 13.3 }), MASTER);
  assert.ok(onTarget.ok.includes('Loudness on target'));
  assert.ok(ids(evaluate(fakeAnalysis({ integrated: -14, truePeakDb: 0.3 }), MASTER)).includes('master-true-peak'));
  const loud = evaluate(fakeAnalysis({ integrated: -8, truePeakDb: -1, plr: 6 }), MASTER);
  assert.ok(ids(loud).includes('master-loud'));
  assert.ok(ids(loud).includes('master-crushed'));
  assert.match(loud.chain[1].settings[0], /Skip it/);
});

test('stereo problems', () => {
  assert.equal(evaluate(fakeAnalysis({ correlation: -0.3 }), MIX).findings[0].id, 'phase');
  assert.ok(ids(evaluate(fakeAnalysis({ correlation: 0.1 }), MIX)).includes('phase-wide'));
  const lowSides = evaluate(fakeAnalysis({ lowCorrelation: 0.5, lowSideDb: -5 }), MASTER);
  assert.ok(ids(lowSides).includes('low-end-sides'));
  assert.ok(lowSides.chain[0].settings.some((s) => s.includes('Processing: Side')));
  assert.ok(ids(evaluate(fakeAnalysis({ widthDb: -25 }), MIX)).includes('narrow'));
  assert.ok(ids(evaluate(fakeAnalysis({ widthDb: -1 }), MIX)).includes('wide'));
  assert.ok(ids(evaluate(fakeAnalysis({ balanceDb: -2 }), MIX)).includes('balance'));
});

test('mono files skip stereo checks', () => {
  const ev = evaluate(fakeAnalysis({ channelCount: 1, correlation: null, lowCorrelation: null, widthDb: null, balanceDb: null }), MIX);
  assert.deepEqual(ids(ev), ['mono-file']);
  assert.equal(meterStates(fakeAnalysis({ channelCount: 1 }), ev).width, '');
});

test('findings are sorted most severe first', () => {
  const ev = evaluate(fakeAnalysis({ clippedRuns: 3, widthDb: -25, plr: 7 }), MIX);
  const ranks = ev.findings.map((f) => ({ critical: 0, warning: 1, note: 2 })[f.severity]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
});

test('unknown settings fall back to defaults', () => {
  const ev = evaluate(fakeAnalysis(), { stage: 'bogus', genre: '__proto__', target: 'nope' });
  assert.deepEqual(ev.settings, { stage: 'mix', genre: 'pop', target: 'streaming' });
});
