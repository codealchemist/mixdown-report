import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sniffHeader } from '../src/core/sniff.js';
import { reportText } from '../src/core/report.js';
import { evaluate } from '../src/core/evaluate.js';
import { interpolateCurve, loudnessSeries, spectrumSeries } from '../src/core/series.js';
import { GENRES } from '../src/core/profiles.js';
import { formatTime, gentleMove, median, num, signed } from '../src/core/format.js';
import { fakeAnalysis } from './helpers.js';

function wavHeader({ rate = 96000, bits = 24, channels = 2 } = {}) {
  const b = new ArrayBuffer(44);
  const v = new DataView(b);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, rate, true); v.setUint32(28, (rate * channels * bits) / 8, true); v.setUint16(32, (channels * bits) / 8, true); v.setUint16(34, bits, true);
  str(36, 'data'); v.setUint32(40, 0, true);
  return b;
}

function aiffHeader() {
  const b = new ArrayBuffer(38);
  const v = new DataView(b);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'FORM'); v.setUint32(4, 30); str(8, 'AIFF');
  str(12, 'COMM'); v.setUint32(16, 18); v.setUint16(20, 2); v.setUint32(22, 0); v.setUint16(26, 16);
  [0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0].forEach((byte, i) => v.setUint8(28 + i, byte)); // 44100 as 80-bit float
  return b;
}

test('reads sample rate and bit depth from WAV and AIFF headers', () => {
  assert.deepEqual(sniffHeader(wavHeader()), { format: 'WAV', sampleRate: 96000, bitDepth: 24 });
  assert.deepEqual(sniffHeader(aiffHeader()), { format: 'AIFF', sampleRate: 44100, bitDepth: 16 });
});

test('unknown or truncated headers return nothing', () => {
  assert.deepEqual(sniffHeader(new ArrayBuffer(4)), {});
  assert.deepEqual(sniffHeader(new TextEncoder().encode('ID3 this is an mp3 file').buffer), {});
  assert.deepEqual(sniffHeader(wavHeader().slice(0, 30)), {});
});

test('formatting helpers', () => {
  assert.equal(num(-3.04), '−3.0');
  assert.equal(num(-0.04), '0.0');
  assert.equal(signed(2), '+2.0');
  assert.equal(signed(-0.5, 2), '−0.50');
  assert.equal(num(NaN), '–');
  assert.equal(formatTime(125.4), '2:05');
  assert.equal(median([3, 1, 2, NaN]), 2);
  assert.equal(gentleMove(5), 2.5);
  assert.equal(gentleMove(20), 3);
  assert.equal(gentleMove(0.2), 0.5);
});

test('genre curve interpolation passes through band centres and clamps at the ends', () => {
  const curve = GENRES.pop.curve;
  assert.equal(interpolateCurve(curve, 10), curve[0]);
  assert.equal(interpolateCurve(curve, 20000), curve.at(-1));
  assert.ok(Math.abs(interpolateCurve(curve, 1000) - curve[3]) < 1e-9);
});

test('chart series', () => {
  const thirds = [100, 1000, 10000].map((fc, i) => ({ fc, mid: 1, side: 0, level: [-10, -20, -30][i] }));
  const a = fakeAnalysis({ thirds });
  const ev = evaluate(a, { stage: 'mix', genre: 'pop', target: 'streaming' });
  const s = spectrumSeries(a, ev);
  assert.equal(s.length, 3);
  assert.equal(s[1].comparison, 0);
  assert.deepEqual(loudnessSeries(a).map((p) => p.t), [3, 3.1, 3.2]);
});

test('plain-text report lists findings and the chain with ASCII minus signs', () => {
  const a = fakeAnalysis({ truePeakDb: -0.3, plr: 17.7 });
  const ev = evaluate(a, { stage: 'mix', genre: 'pop', target: 'streaming' });
  const text = reportText(a, ev, { name: 'song.wav', referenceName: 'ref.wav' });
  assert.match(text, /^MIXDOWN REPORT: song\.wav/);
  assert.match(text, /Reference: ref\.wav/);
  assert.match(text, /\[Improve\] Not enough headroom for mastering/);
  assert.match(text, /1\. Channel EQ/);
  assert.match(text, /4\. Loudness Meter/);
  assert.ok(!text.includes('−'));
});
