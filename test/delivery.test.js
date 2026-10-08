import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resample } from '../src/core/dsp/resample.js';
import { quantize, isOnGrid } from '../src/core/dsp/dither.js';
import { Md5, md5Hex } from '../src/core/codecs/md5.js';
import { crc8, crc16, encodeFlac } from '../src/core/codecs/flac.js';
import { prepareDelivery, flacMd5, releaseFileName, releaseZipName } from '../src/core/delivery.js';
import { measureLevels } from '../src/core/levels.js';
import { decodeFlac } from './flac-decoder.js';
import { sine } from './helpers.js';

const close = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} expected ${b} ±${tol}, got ${a}`);
const peakDb = (x, skip = 2000) => {
  let p = 0;
  for (let i = skip; i < x.length - skip; i++) p = Math.max(p, Math.abs(x[i]));
  return 20 * Math.log10(p);
};

/** Deterministic test music: tones, noise, digital silence, a full-scale burst and a partial last frame. */
function testPcm(n = 44100 * 3 + 777) {
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
  const L = new Int32Array(n), R = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const m = 9000 * Math.sin(i / 20) + 5000 * Math.sin(i / 3.1);
    L[i] = Math.round(m + 600 * rnd());
    R[i] = Math.round(0.7 * m + 600 * rnd());
  }
  L.fill(0, 5000, 14000); R.fill(0, 5000, 14000);
  for (let i = 30000; i < 34000; i++) { L[i] = rnd() > 0 ? 32767 : -32768; R[i] = rnd() > 0 ? 32767 : -32768; }
  return [L, R];
}

/* ---------- checksums ---------- */

test('MD5 matches the standard algorithm, including chunked input', () => {
  for (const s of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'x'.repeat(1000)]) {
    assert.equal(md5Hex(new TextEncoder().encode(s)), createHash('md5').update(s).digest('hex'), `length ${s.length}`);
  }
  const big = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 31) & 255);
  const m = new Md5();
  for (let i = 0; i < big.length; i += 777) m.update(big.subarray(i, i + 777));
  assert.equal(Buffer.from(m.digest()).toString('hex'), createHash('md5').update(big).digest('hex'));
});

test('FLAC CRC-8 and CRC-16 match their standard check values', () => {
  const check = new TextEncoder().encode('123456789');
  assert.equal(crc8(check), 0xf4); // CRC-8, poly 0x07
  assert.equal(crc16(check), 0xfee8); // CRC-16/BUYPASS, poly 0x8005
});

/* ---------- FLAC ---------- */

test('FLAC encoding is lossless and the stream metadata is correct', () => {
  const pcm = testPcm();
  const bytes = encodeFlac(pcm, { sampleRate: 44100, tags: { TITLE: 'Test ü' } });
  const d = decodeFlac(bytes);
  assert.equal(d.sampleRate, 44100);
  assert.equal(d.bps, 16);
  assert.equal(d.channels.length, 2);
  assert.equal(d.total, pcm[0].length);
  assert.equal(d.frames, Math.ceil(pcm[0].length / 4096));
  assert.deepEqual(d.channels[0], pcm[0]);
  assert.deepEqual(d.channels[1], pcm[1]);
  assert.equal(d.tags.TITLE, 'Test ü');
  assert.equal(d.tags.vendor, 'Mixdown Report');
  // STREAMINFO MD5 = MD5 of interleaved 16-bit little-endian samples
  const raw = Buffer.alloc(pcm[0].length * 4);
  for (let i = 0; i < pcm[0].length; i++) { raw.writeInt16LE(pcm[0][i], i * 4); raw.writeInt16LE(pcm[1][i], i * 4 + 2); }
  assert.equal(d.md5, createHash('md5').update(raw).digest('hex'));
  assert.ok(bytes.length < raw.length * 0.9, 'compresses');
});

test('FLAC handles mono, 24-bit, silence and very short files', () => {
  const mono = [Int32Array.from({ length: 5000 }, (_, i) => Math.round(1000 * Math.sin(i / 7)))];
  assert.deepEqual(decodeFlac(encodeFlac(mono, { sampleRate: 48000 })).channels[0], mono[0]);

  const deep = [Int32Array.from({ length: 9000 }, (_, i) => Math.round(8_000_000 * Math.sin(i / 9))), Int32Array.from({ length: 9000 }, (_, i) => -8_388_608 + (i % 3))];
  const d24 = decodeFlac(encodeFlac(deep, { sampleRate: 96000, bitsPerSample: 24 }));
  assert.equal(d24.bps, 24);
  assert.deepEqual(d24.channels, deep);

  const silent = [new Int32Array(10000), new Int32Array(10000)];
  const s = encodeFlac(silent, { sampleRate: 44100 });
  assert.ok(s.length < 300, `silence compresses to almost nothing (${s.length} bytes)`);
  assert.deepEqual(decodeFlac(s).channels, silent);

  const tiny = [Int32Array.from([1, -2, 3]), Int32Array.from([0, 0, 1])];
  assert.deepEqual(decodeFlac(encodeFlac(tiny, { sampleRate: 44100 })).channels, tiny);
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('FLAC decodes bit-exact in ffmpeg with CRC checks on', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  const pcm = testPcm();
  const dir = mkdtempSync(join(tmpdir(), 'mixdown-'));
  try {
    writeFileSync(join(dir, 'a.flac'), encodeFlac(pcm, { sampleRate: 44100 }));
    const r = spawnSync('ffmpeg', ['-v', 'error', '-err_detect', 'crccheck+bitstream+buffer+explode', '-i', join(dir, 'a.flac'), '-f', 's16le', '-y', join(dir, 'a.raw')]);
    assert.equal(r.status, 0, r.stderr.toString());
    const raw = readFileSync(join(dir, 'a.raw'));
    for (let i = 0; i < pcm[0].length; i += 997) {
      assert.equal(raw.readInt16LE(i * 4), pcm[0][i]);
      assert.equal(raw.readInt16LE(i * 4 + 2), pcm[1][i]);
    }
    assert.equal(raw.length, pcm[0].length * 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- resampling and dither ---------- */

test('resampling keeps the audio band and removes what would alias', () => {
  const tone = sine({ freq: 1000, dbfs: -6, seconds: 1, fs: 48000 });
  const y = resample(tone, 48000, 44100);
  assert.equal(y.length, 44100);
  close(peakDb(y), -6, 0.01, '1 kHz level');
  close(peakDb(resample(sine({ freq: 18000, dbfs: -6, seconds: 1, fs: 48000 }), 48000, 44100)), -6, 0.1, '18 kHz level');
  assert.ok(peakDb(resample(sine({ freq: 23000, dbfs: -6, seconds: 1, fs: 48000 }), 48000, 44100)) < -80, '23 kHz is removed');
  close(peakDb(resample(sine({ freq: 1000, dbfs: -6, seconds: 1, fs: 44100 }), 44100, 96000)), -6, 0.01, 'upsampling');
  assert.deepEqual(resample(tone, 48000, 48000), tone);
});

test('dither is added only when needed and stays at the 16-bit noise floor', () => {
  const exact = [Float32Array.from([0, 0.5, -1, 1234 / 32768])];
  assert.ok(isOnGrid(exact, 16));
  const q = quantize(exact, 16);
  assert.equal(q.dithered, false);
  assert.deepEqual([...q.channels[0]], [0, 16384, -32768, 1234]);

  const quiet = [Float32Array.from({ length: 48000 }, (_, i) => 0.00001 * Math.sin(i / 10))];
  const d = quantize(quiet, 16);
  assert.equal(d.dithered, true);
  const rms = Math.sqrt(d.channels[0].reduce((s, v, i) => s + (v - quiet[0][i] * 32768) ** 2, 0) / 48000);
  assert.ok(rms > 0.3 && rms < 0.75, `TPDF error ≈ 0.5 LSB rms, got ${rms}`);

  assert.equal(quantize([Float32Array.from([1.2, -1.5, 0.2])], 16).clipped, 2);
});

/* ---------- delivery ---------- */

test('delivery: 48 kHz float mix becomes a 16-bit 44.1 kHz stereo FLAC', async () => {
  const x = sine({ freq: 440, dbfs: -3, seconds: 2, fs: 48000 });
  const { bytes, report } = await prepareDelivery([x, x], 48000, { spec: 'routenote-flac' });
  const d = decodeFlac(bytes);
  assert.equal(d.sampleRate, 44100);
  assert.equal(d.bps, 16);
  assert.equal(d.channels.length, 2);
  assert.equal(report.sampleRate, 44100);
  assert.equal(report.dithered, true);
  assert.equal(report.clipped, 0);
  assert.equal(report.md5, flacMd5(bytes));
  assert.equal(report.md5, d.md5);
  close(peakDb(Float32Array.from(d.channels[0], (v) => v / 32768)), -3, 0.05, 'level kept');
});

test('delivery: true-peak ceiling turns the file down only when needed', async () => {
  const hot = sine({ freq: 440, dbfs: -0.2, seconds: 1, fs: 44100 });
  const { report, bytes } = await prepareDelivery([hot, hot], 44100, { ceilingDb: -1 });
  assert.ok(report.gainDb < -0.75 && report.gainDb > -1);
  const out = decodeFlac(bytes).channels.map((c) => Float32Array.from(c, (v) => v / 32768));
  assert.ok(measureLevels(out).truePeakDb <= -0.99);

  const safe = sine({ freq: 440, dbfs: -3, seconds: 1, fs: 44100 });
  assert.equal((await prepareDelivery([safe, safe], 44100, { ceilingDb: -1 })).report.gainDb, 0);
});

test('delivery: an existing 16-bit 44.1 kHz file is copied exactly, and mono becomes stereo', async () => {
  const ints = Int32Array.from({ length: 30000 }, (_, i) => Math.round(9000 * Math.sin(i / 13)));
  const float = Float32Array.from(ints, (v) => v / 32768);
  const { bytes, report } = await prepareDelivery([float], 44100);
  const d = decodeFlac(bytes);
  assert.equal(report.dithered, false);
  assert.deepEqual(d.channels[0], ints);
  assert.deepEqual(d.channels[1], ints);
  assert.ok(report.notes.some((n) => n.includes('mono')));
});

test('release file names say the song, its version and the file type', () => {
  assert.equal(releaseFileName({ song: 'Song', report: { format: 'flac', sampleRate: 44100, bits: 16 } }), 'Song (44.1k 16-bit).flac');
  assert.equal(releaseFileName({ song: 'Song', variant: 'master', report: { format: 'flac', sampleRate: 48000, bits: 24 } }), 'Song (master) (48k 24-bit).flac');
  assert.equal(releaseFileName({ song: 'Song (v2)', variant: 'master', report: { format: 'mp3', kbps: 320, sampleRate: 44100, bits: 16 } }), 'Song (v2) (master) (320 kbps).mp3');
  assert.equal(releaseZipName('Song (v2)'), 'Song (v2) (release files).zip');
});
