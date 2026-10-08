import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDENTITY, fitCalibration, logicBehaviour, measureResponse, testSignal, toLogicParams, TEST_SIGNAL } from '../src/core/eq/calibration.js';
import { CALIBRATION_EQ, decodeChannelEq, encodeChannelEq } from '../src/core/eq/pst.js';
import { buildEq, cloneEq } from '../src/core/eq/channel-eq.js';
import { eqResponse, eqSections, curveFrequencies } from '../src/core/eq/response.js';
import { applySections } from '../src/core/dsp/biquad.js';
import { resample } from '../src/core/dsp/resample.js';
import { encodeWav } from '../src/core/codecs/wav.js';
import { sniffHeader } from '../src/core/sniff.js';

const close = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} expected ${b} ±${tol}, got ${a}`);
const DIFFERENT = { ...IDENTITY, bellQ: 1.4, bellGain: 0.9, shelfQ: 0.75, shelfGain: 1.1 };
const rawCalibrationPreset = () => decodeChannelEq(encodeChannelEq(CALIBRATION_EQ)).eq;

/** Plays the test noise through a simulated Logic with `behaviour`, as a bounce at `fs`. */
function bounce(raw, behaviour, fs = 48000, faderDb = 0) {
  let x = testSignal();
  if (fs !== TEST_SIGNAL.sampleRate) x = resample(x, TEST_SIGNAL.sampleRate, fs);
  const y = Float32Array.from(x);
  applySections(y, eqSections(logicBehaviour(raw, behaviour), fs));
  const g = 10 ** (faderDb / 20);
  for (let i = 0; i < y.length; i++) y[i] *= g;
  return [y, y];
}

test('the test signal is deterministic, 30 s at 48 kHz, peaking at −6 dBFS', () => {
  const a = testSignal();
  assert.equal(a.length, 48000 * 30);
  assert.deepEqual(a.subarray(48000, 48100), testSignal().subarray(48000, 48100));
  close(20 * Math.log10(a.reduce((m, v) => Math.max(m, Math.abs(v)), 0)), -6, 0.05);
});

test('measuring a bounce through a known EQ recovers its response', () => {
  const raw = rawCalibrationPreset();
  const m = measureResponse(bounce(raw, IDENTITY), 48000);
  const expected = eqResponse(raw, m.freqs, 48000);
  const err = Math.sqrt(m.db.reduce((s, d, i) => s + (d - expected[i]) ** 2, 0) / m.db.length);
  assert.ok(err < 0.3, `rms ${err} dB`);
});

test('calibration confirms a Logic that matches the model', () => {
  const raw = rawCalibrationPreset();
  const r = fitCalibration(measureResponse(bounce(raw, IDENTITY, 48000, -0.7), 48000), raw, 48000);
  assert.equal(r.quality, 'good');
  assert.equal(r.usable, true);
  for (const k of ['bellQ', 'bellGain', 'shelfQ', 'shelfGain']) close(r.calibration[k], 1, 0.06, k);
  close(r.offsetDb, -0.7, 0.15, 'fader offset is reported, not fitted into the EQ');
});

test('calibration recovers a different Logic behaviour, also from a 44.1 kHz bounce', () => {
  const raw = rawCalibrationPreset();
  for (const fs of [48000, 44100]) {
    const r = fitCalibration(measureResponse(bounce(raw, DIFFERENT, fs), fs), raw, fs);
    assert.equal(r.usable, true, JSON.stringify(r.messages));
    close(r.calibration.bellQ, 1.4, 0.1, `${fs} bellQ`);
    close(r.calibration.bellGain, 0.9, 0.05, `${fs} bellGain`);
    close(r.calibration.shelfQ, 0.75, 0.1, `${fs} shelfQ`);
    close(r.calibration.shelfGain, 1.1, 0.08, `${fs} shelfGain`);
    assert.ok(r.rmsAfter < 0.2 && r.rmsBefore > 0.3, `${r.rmsBefore} → ${r.rmsAfter}`);
  }
});

test('calibration flags a band that did not load', () => {
  const raw = rawCalibrationPreset();
  const broken = cloneEq(raw);
  broken.bands.peak2.on = false; // Logic ignored the 456 Hz band
  let x = testSignal();
  const y = Float32Array.from(x);
  applySections(y, eqSections(broken, 48000));
  const r = fitCalibration(measureResponse([y, y], 48000), raw, 48000);
  assert.equal(r.usable, false);
  assert.ok(r.bandChecks.find((b) => b.key === 'peak2').missing);
  assert.ok(r.messages.some((m) => m.severity === 'critical' && m.text.includes('456')));
});

test('with a calibration, exported presets make Logic produce the intended shape', () => {
  const intended = buildEq([
    { type: 'lowCut', freq: 30, slope: 18 },
    { type: 'peak', freq: 300, gain: -3, q: 1 },
    { type: 'peak', freq: 3000, gain: 2, q: 1.2 },
    { type: 'highShelf', freq: 10000, gain: 2.5, q: 0.71 },
  ]).eq;
  const freqs = curveFrequencies(120);
  const want = eqResponse(intended, freqs);
  const inLogic = (bytes) => eqResponse(logicBehaviour(decodeChannelEq(bytes).eq, DIFFERENT), freqs);
  const maxErr = (got) => Math.max(...got.map((g, i) => Math.abs(g - want[i])));

  assert.ok(maxErr(inLogic(encodeChannelEq(intended))) > 0.4, 'uncalibrated presets are off in this Logic');
  assert.ok(maxErr(inLogic(encodeChannelEq(intended, { calibration: DIFFERENT }))) < 0.05, 'calibrated presets match');
  assert.deepEqual(toLogicParams(intended, IDENTITY), intended);
});

test('WAV writer produces 24-bit PCM that sniffs correctly', () => {
  const x = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 10) * 0.5);
  const wav = encodeWav([x, x], 48000, 24);
  assert.equal(wav.length, 44 + 1000 * 2 * 3);
  assert.deepEqual(sniffHeader(wav.buffer), { format: 'WAV', sampleRate: 48000, bitDepth: 24 });
  const view = new DataView(wav.buffer);
  const sample = (view.getUint16(44 + 3 * 6, true) | (view.getInt8(44 + 3 * 6 + 2) << 16)) / 2 ** 23;
  close(sample, x[3], 1e-6);
});

test('a cut that measures steeper than written is a shape note, not a problem', () => {
  const raw = rawCalibrationPreset();
  // Like the user's Logic: the 18 dB/Oct Low Cut fits the model's 24 dB/Oct curve better
  const logicEq = logicBehaviour(raw, { ...IDENTITY, bellQ: 1.3 });
  logicEq.bands.lowCut.slope = 24;
  const y = Float32Array.from(testSignal());
  applySections(y, eqSections(logicEq, 48000));
  const r = fitCalibration(measureResponse([y, y], 48000), raw, 48000);
  assert.equal(r.status, 'ready');
  assert.equal(r.usable, true);
  close(r.calibration.bellQ, 1.3, 0.1, 'bell correction');
  assert.ok(r.messages.some((m) => m.severity === 'note' && m.text.includes('Low Cut at 18 dB/Oct is steeper')));
});

test('the Low Cut resonance (cut Q) is measured and exported', () => {
  const raw = rawCalibrationPreset();
  const r = fitCalibration(measureResponse(bounce(raw, { ...IDENTITY, cutQ: 0.7 }), 48000), raw, 48000);
  assert.equal(r.status, 'ready');
  close(r.calibration.cutQ, 0.7, 0.08, 'cut Q');
  const stored = decodeChannelEq(encodeChannelEq(CALIBRATION_EQ, { calibration: r.calibration })).eq;
  close(logicBehaviour(stored, { ...IDENTITY, cutQ: 0.7 }).bands.lowCut.q, CALIBRATION_EQ.bands.lowCut.q, 0.06, 'Logic plays the intended cut Q');
});

test('presets store values so Logic\'s truncating display shows them exactly', () => {
  const bytes = encodeChannelEq(CALIBRATION_EQ);
  const view = new DataView(bytes.buffer);
  const q = (band) => view.getFloat32(28 + band * 16 + 12, true);
  assert.ok(q(1) >= 0.9, `low shelf Q stored as ${q(1)}`); // shows "0.90", not "0.89"
  assert.ok(q(4) >= 0.8, `band 5 Q stored as ${q(4)}`);
  assert.ok(Math.abs(q(1) - 0.9) < 1e-6);
  assert.equal(decodeChannelEq(bytes).eq.bands.lowShelf.q, 0.9);
});
