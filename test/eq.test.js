import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BAND_KEYS, buildEq, eqLines, flatEq, moveText, normalizeEq } from '../src/core/eq/channel-eq.js';
import { eqLevelChange, eqResponse } from '../src/core/eq/response.js';
import { PARAM_COUNT, PstError, decodeChannelEq, encodeChannelEq, presetFileName } from '../src/core/eq/pst.js';
import { suggestMasterEq } from '../src/core/eq/mastering.js';
import { suggestTrackEq } from '../src/core/eq/track-eq.js';
import { INSTRUMENTS, filterInstruments, guessInstrument } from '../src/core/eq/instruments.js';
import { evaluate } from '../src/core/evaluate.js';
import { BANDS, GENRES } from '../src/core/profiles.js';
import { bandIndex, fakeAnalysis } from './helpers.js';

const close = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} expected ${b} ±${tol}, got ${a}`);
const MIX = { stage: 'mix', genre: 'pop', target: 'streaming' };

/** An evaluation of a mix with muddy low mids (+6 dB) and too much sub (+7 dB). */
function muddyEvaluation() {
  const bands = [...GENRES.pop.curve];
  bands[bandIndex('lowmid')] += 6;
  bands[bandIndex('sub')] += 7;
  return evaluate(fakeAnalysis({ bands }), MIX);
}

/* ---------- model ---------- */

test('buildEq places cuts, shelves and bells into Logic slots in frequency order', () => {
  const { eq, dropped } = buildEq([
    { type: 'peak', freq: 3000, gain: 2, q: 1 },
    { type: 'lowCut', freq: 80, slope: 18 },
    { type: 'peak', freq: 300, gain: -3, q: 1.2 },
    { type: 'highShelf', freq: 10000, gain: 1.5 },
  ]);
  assert.deepEqual(dropped, []);
  assert.deepEqual(eqLines(eq), ['Low Cut: 80 Hz, 18 dB/Oct', 'Band 3: 300 Hz, −3 dB, Q 1.2', 'Band 4: 3 kHz, +2 dB, Q 1.0', 'High Shelf: 10 kHz, +1.5 dB, Q 0.71']);
  assert.equal(eq.bands.peak3.on, false);
});

test('buildEq merges nearby bells, keeps the higher low cut and drops the smallest fifth bell', () => {
  const merged = buildEq([{ type: 'peak', freq: 250, gain: -2, q: 1.5 }, { type: 'peak', freq: 300, gain: -3, q: 1.2 }]).eq;
  assert.equal(merged.bands.peak1.gain, -5);
  assert.ok(merged.bands.peak1.freq > 250 && merged.bands.peak1.freq < 300);
  assert.equal(merged.bands.peak2.on, false);

  assert.equal(buildEq([{ type: 'lowCut', freq: 80 }, { type: 'lowCut', freq: 120 }]).eq.bands.lowCut.freq, 120);

  const five = [100, 400, 1600, 6400, 12800].map((freq, i) => ({ type: 'peak', freq, gain: i === 2 ? 0.5 : 3, q: 1 }));
  const { eq, dropped } = buildEq(five);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].freq, 1600);
  assert.deepEqual(['peak1', 'peak2', 'peak3', 'peak4'].map((k) => eq.bands[k].freq), [100, 400, 6400, 12800]);
});

test('buildEq caps combined gain', () => {
  const { eq } = buildEq([{ type: 'peak', freq: 300, gain: -5, q: 1 }, { type: 'peak', freq: 310, gain: -5, q: 1 }], { maxGain: 6 });
  assert.equal(eq.bands.peak1.gain, -6);
});

test('normalizeEq clamps into Logic ranges and snaps slopes', () => {
  const eq = flatEq();
  eq.bands.peak1.gain = 40;
  eq.bands.peak1.freq = 5;
  eq.bands.lowCut.slope = 20;
  const n = normalizeEq(eq);
  assert.equal(n.bands.peak1.gain, 24);
  assert.equal(n.bands.peak1.freq, 20);
  assert.equal(n.bands.lowCut.slope, 18);
});

test('moveText reads like Logic settings', () => {
  assert.equal(moveText({ type: 'peak', freq: 300, gain: -3, q: 1 }), 'Bell 300 Hz, −3 dB, Q 1.0');
  assert.equal(moveText({ type: 'highShelf', freq: 12000, gain: 2.5, q: 0.71 }), 'High Shelf 12 kHz, +2.5 dB, Q 0.71');
  assert.equal(moveText({ type: 'lowCut', freq: 20, slope: 24 }), 'Low Cut 20 Hz, 24 dB/Oct');
});

/* ---------- response ---------- */

test('bell, shelf and cut responses have the expected shapes', () => {
  const bell = buildEq([{ type: 'peak', freq: 1000, gain: -6, q: 1 }]).eq;
  const [atCentre, far] = eqResponse(bell, [1000, 50]);
  close(atCentre, -6, 0.01, 'bell centre');
  close(far, 0, 0.1, 'bell far away');

  const shelf = buildEq([{ type: 'highShelf', freq: 5000, gain: 4, q: 0.71 }]).eq;
  const [low, high] = eqResponse(shelf, [100, 18000]);
  close(low, 0, 0.1, 'shelf below');
  close(high, 4, 0.3, 'shelf above');

  const cut = buildEq([{ type: 'lowCut', freq: 100, slope: 12, q: 0.71 }]).eq;
  const [at, octaveBelow, above] = eqResponse(cut, [100, 50, 2000]);
  close(at, -3, 0.2, 'Butterworth −3 dB point');
  close(octaveBelow - at, -9, 1.5, '12 dB/Oct slope');
  close(above, 0, 0.1, 'passband');

  const gain = { ...flatEq(), outputGain: -2 };
  close(eqResponse(gain, [1000])[0], -2, 1e-9, 'output gain');
});

test('level change weights the EQ by where the energy is', () => {
  const thirds = [{ fc: 100, mid: 1, side: 0 }, { fc: 1000, mid: 1e-6, side: 0 }];
  const lowCut = buildEq([{ type: 'peak', freq: 100, gain: -6, q: 1 }]).eq;
  close(eqLevelChange(lowCut, thirds), -6, 0.2, 'energy at 100 Hz');
  const highCut = buildEq([{ type: 'peak', freq: 1000, gain: -6, q: 1 }]).eq;
  close(eqLevelChange(highCut, thirds), 0, 0.2, 'no energy at 1 kHz');
});

/* ---------- .pst ---------- */

test('encoded presets have the Channel EQ header, parameter block and trailer', () => {
  const bytes = encodeChannelEq(flatEq());
  const view = new DataView(bytes.buffer);
  assert.equal(bytes.length, 240);
  assert.equal(view.getUint32(0, true), 240);
  assert.equal(view.getUint32(4, true), 1);
  assert.equal(view.getUint32(8, true), PARAM_COUNT + 1);
  assert.equal(new TextDecoder().decode(bytes.subarray(12, 20)), 'GAMETSPP');
  assert.equal(view.getUint32(20, true), 236);
  assert.deepEqual([...bytes.subarray(232)], [0x78, 0x38, 0x50, 0x4c, 8, 0, 0, 0]);
});

test('band parameters are stored as [on, freq, gain or slope ÷ 6, Q] in Logic order', () => {
  const { eq } = buildEq([{ type: 'lowCut', freq: 37, slope: 18 }, { type: 'peak', freq: 456, gain: 4.5, q: 2.3 }]);
  eq.outputGain = -1.5;
  const view = new DataView(encodeChannelEq(eq).buffer);
  const p = (i) => view.getFloat32(28 + i * 4, true);
  assert.deepEqual([p(0), p(1), p(2), p(3)].map((v) => Math.round(v * 100) / 100), [1, 37, 3, 0.71]);
  assert.deepEqual([p(8), p(9), p(10)].map((v) => Math.round(v * 100) / 100), [1, 456, 4.5]);
  close(p(11), 2.3, 1e-6);
  assert.equal(p(32), -1.5);
});

test('presets round-trip through encode and decode', () => {
  const { eq } = buildEq([
    { type: 'lowCut', freq: 37, slope: 18 }, { type: 'lowShelf', freq: 61, gain: 2.5, q: 0.9 },
    { type: 'peak', freq: 123, gain: -3.5, q: 1.7 }, { type: 'peak', freq: 3456, gain: 6, q: 1.2 },
    { type: 'highShelf', freq: 9876, gain: -1, q: 0.6 }, { type: 'highCut', freq: 15432, slope: 36 },
  ]);
  eq.outputGain = -1.5;
  const { eq: back, paramCount } = decodeChannelEq(encodeChannelEq(eq));
  assert.equal(paramCount, PARAM_COUNT);
  assert.deepEqual(back, eq);
});

test('decodes older, shorter Channel EQ presets', () => {
  // Older Logic versions write 46 parameters (220 bytes): same band layout, fewer display settings.
  const full = encodeChannelEq(buildEq([{ type: 'peak', freq: 560, gain: -8, q: 0.71 }]).eq);
  const old = new Uint8Array(220);
  old.set(full.subarray(0, 28 + 46 * 4));
  old.set(full.subarray(232), 212);
  const view = new DataView(old.buffer);
  view.setUint32(0, 220, true);
  view.setUint32(8, 47, true);
  const { eq, paramCount } = decodeChannelEq(old);
  assert.equal(paramCount, 46);
  assert.equal(eq.bands.peak1.freq, 560);
  assert.equal(eq.bands.peak1.gain, -8);
});

test('rejects files that are not Channel EQ presets', () => {
  assert.throws(() => decodeChannelEq(new Uint8Array(10)), PstError);
  const other = encodeChannelEq(flatEq());
  new DataView(other.buffer).setUint32(20, 201, true); // another plug-in
  assert.throws(() => decodeChannelEq(other), /different plug-in/);
  const bad = encodeChannelEq(flatEq());
  bad[12] = 0x58;
  assert.throws(() => decodeChannelEq(bad), /Not a Logic Pro/);
});

test('preset file names are safe on macOS', () => {
  assert.equal(presetFileName('Synth bass / 808'), 'Synth bass - 808.pst');
  assert.equal(presetFileName('  Lead:Vox  '), 'Lead-Vox.pst');
  assert.equal(presetFileName(''), 'Channel EQ.pst');
});

/* ---------- suggestions ---------- */

test('master EQ: rumble filter plus closed-loop tonal moves, with notes for what a preset cannot do', () => {
  const ev = muddyEvaluation();
  const { eq, wanted, predicted, notes } = suggestMasterEq(ev);
  assert.equal(eqLines(eq)[0], 'Low Cut: 20 Hz, 24 dB/Oct');
  // Each corrected band gets what it asked for (half its difference) despite overlapping filters
  wanted.forEach((w, i) => { if (w) close(predicted[i], w, 0.4, `band ${i}`); });
  assert.ok(wanted[bandIndex('lowmid')] < 0 && wanted[bandIndex('sub')] < 0);
  // Bands that weren't flagged move little
  wanted.forEach((w, i) => { if (!w) assert.ok(Math.abs(predicted[i]) <= 1.5, `band ${i} moved ${predicted[i]}`); });
  assert.ok(notes.some((n) => n.includes('fix the tracks first')));

  const sides = evaluate(fakeAnalysis({ lowCorrelation: 0.4, lowSideDb: -4 }), MIX);
  assert.ok(suggestMasterEq(sides).notes.some((n) => n.includes('Side')));
});

test('master EQ keeps loudness by setting Channel EQ output gain', () => {
  const ev = muddyEvaluation();
  // Pink-ish spectrum: equal power per third octave
  const thirds = [25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000].map((fc) => ({ fc, mid: 1, side: 0 }));
  const analysis = { thirds, sampleRate: 48000 };
  const kept = suggestMasterEq(ev, { analysis });
  assert.ok(kept.loudnessChange < -0.3, 'the cuts lower loudness');
  close(kept.eq.outputGain, -kept.loudnessChange, 0.06, 'output gain compensates');
  assert.equal(suggestMasterEq(ev, { analysis, keepLoudness: false }).eq.outputGain, 0);
});

test('track EQ without an analysis is the instrument starting point', () => {
  const { eq, moves } = suggestTrackEq('leadvocal', null);
  assert.ok(moves.every((m) => m.origin === 'base'));
  assert.equal(eq.bands.lowCut.freq, 90);
});

test('track EQ adds fixes for mix problems the instrument contributes to', () => {
  const ev = muddyEvaluation();
  const guitar = suggestTrackEq('eguitardist', ev);
  const mudFix = guitar.moves.find((m) => m.origin === 'mix' && m.type === 'peak');
  assert.ok(mudFix && mudFix.gain < 0 && mudFix.reason.includes('low mids'));
  assert.ok(guitar.eq.bands.lowCut.freq > 90, 'too much sub raises the guitar low cut');
  // Instruments that don't contribute to a problem are left alone
  const hats = suggestTrackEq('hihat', ev);
  assert.ok(hats.moves.every((m) => m.origin === 'base'));
});

test('a mix fix overrides an opposite starting-point move nearby', () => {
  const kick = suggestTrackEq('kick', muddyEvaluation());
  assert.ok(!kick.moves.some((m) => m.origin === 'base' && m.type === 'peak' && m.freq === 60), 'kick no longer boosts 60 Hz when the mix has too much sub');
  for (const key of ['peak1', 'peak2', 'peak3', 'peak4']) assert.ok(Math.abs(kick.eq.bands[key].gain) <= 6);
});

test('every instrument produces a valid preset for any mix problem', () => {
  const allProblems = evaluate(fakeAnalysis({ bands: [12, 12, 12, -12, 12, -12, 12] }), MIX);
  for (const inst of INSTRUMENTS) {
    for (const ev of [null, allProblems]) {
      const { eq } = suggestTrackEq(inst.id, ev);
      const back = decodeChannelEq(encodeChannelEq(eq)).eq;
      for (const key of BAND_KEYS) {
        const b = back.bands[key];
        assert.ok(b.freq >= 20 && b.freq <= 20000, `${inst.id} ${key} freq`);
        if (b.gain !== undefined) assert.ok(Math.abs(b.gain) <= 6, `${inst.id} ${key} gain ${b.gain}`);
      }
    }
    for (const fix of inst.fixes) assert.ok(BANDS.some((b) => fix === `${b.id}:high` || fix === `${b.id}:low`), `${inst.id} fix ${fix}`);
  }
});

/* ---------- instrument lookup ---------- */

test('quick filter ranks name and alias matches first', () => {
  assert.equal(filterInstruments('dist')[0].id, 'eguitardist');
  assert.equal(filterInstruments('vox')[0].id, 'leadvocal');
  assert.equal(filterInstruments('808')[0].id, 'synthbass');
  assert.equal(filterInstruments('kick')[0].id, 'kick');
  assert.equal(filterInstruments('hh')[0].id, 'hihat');
  assert.equal(filterInstruments('').length, INSTRUMENTS.length);
  assert.deepEqual(filterInstruments('zzzz'), []);
  assert.ok(filterInstruments('guitar').slice(0, 3).every((i) => i.group === 'Guitars'));
});

test('track names map to instruments', () => {
  const cases = {
    'guitar-solo-L': 'eguitardist', 'guitar-solo2-R': 'eguitardist', 'guitar-1-L': 'eguitarclean', 'Gtr AC': 'aguitar',
    'Lead Vox 2': 'leadvocal', 'BGV stack': 'backingvocals', '808 sub': 'synthbass', 'Bass DI': 'bassguitar',
    Overheads: 'overheads', 'Kick In': 'kick', Earthshaker: null, '': null,
  };
  for (const [name, id] of Object.entries(cases)) assert.equal(guessInstrument(name), id, name);
});
