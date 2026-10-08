import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeMp3, id3v23 } from '../src/core/codecs/mp3.js';
import { mp3Info } from '../src/core/codecs/mp3-info.js';
import { prepareDelivery } from '../src/core/delivery.js';
import { sine } from './helpers.js';

const tone = (seconds, fs = 44100) => {
  const n = Math.round(seconds * fs);
  return [Int32Array.from({ length: n }, (_, i) => Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / fs))), Int32Array.from({ length: n }, (_, i) => Math.round(8000 * Math.sin((2 * Math.PI * 660 * i) / fs)))];
};

test('MP3 export is 320 kbps constant bitrate, 44.1 kHz stereo, with an ID3 tag', () => {
  const bytes = encodeMp3(tone(5), { sampleRate: 44100, title: 'Song' });
  const info = mp3Info(bytes);
  assert.equal(info.id3, true);
  assert.deepEqual(info.bitrates, [320]);
  assert.equal(info.constantBitrate, true);
  assert.equal(info.sampleRate, 44100);
  assert.notEqual(info.mode, 'mono');
  assert.ok(Math.abs(info.durationSeconds - 5) < 0.1, `duration ${info.durationSeconds}`);
  const kbps = ((bytes.length * 8) / 5) / 1000;
  assert.ok(kbps > 315 && kbps < 330, `${kbps} kbps`);
});

test('ID3v2.3 tags store Unicode text as UTF-16 with a syncsafe size', () => {
  const tag = id3v23({ TIT2: 'Prüfung', TPE1: '' });
  assert.equal(new TextDecoder().decode(tag.subarray(0, 3)), 'ID3');
  assert.equal(tag[3], 3);
  const size = (tag[6] << 21) | (tag[7] << 14) | (tag[8] << 7) | tag[9];
  assert.equal(size, tag.length - 10);
  assert.equal(new TextDecoder().decode(tag.subarray(10, 14)), 'TIT2');
  const body = tag.subarray(20);
  assert.deepEqual([...body.subarray(0, 3)], [1, 0xff, 0xfe]);
  assert.equal(new TextDecoder('utf-16le').decode(body.subarray(3)), 'Prüfung');
  assert.ok(!new TextDecoder('latin1').decode(tag).includes('TPE1'), 'empty frames are left out');
});

test('mp3Info rejects data that is not MP3', () => {
  const info = mp3Info(new Uint8Array(4000));
  assert.equal(info.frames, 0);
});

test('delivery can produce the RouteNote MP3', async () => {
  const x = sine({ freq: 440, dbfs: -3, seconds: 3, fs: 48000 });
  const { bytes, report } = await prepareDelivery([x, x], 48000, { spec: 'routenote-mp3', title: 'Song' });
  assert.equal(report.format, 'mp3');
  assert.equal(report.sampleRate, 44100);
  assert.equal(report.kbps, 320);
  assert.equal(report.md5, null);
  assert.deepEqual(mp3Info(bytes).bitrates, [320]);
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('MP3 decodes cleanly in ffmpeg with the expected format and tags', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdown-'));
  try {
    const file = join(dir, 'a.mp3');
    writeFileSync(file, encodeMp3(tone(4), { sampleRate: 44100, title: 'Prüfung' }));
    const decode = spawnSync('ffmpeg', ['-v', 'error', '-err_detect', 'crccheck+bitstream+buffer', '-i', file, '-f', 'null', '-']);
    assert.equal(decode.status, 0, decode.stderr.toString());
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels,bit_rate:format_tags=title', '-of', 'json', file]);
    const info = JSON.parse(probe.stdout.toString());
    assert.equal(info.streams[0].codec_name, 'mp3');
    assert.equal(info.streams[0].sample_rate, '44100');
    assert.equal(info.streams[0].channels, 2);
    assert.equal(info.streams[0].bit_rate, '320000');
    assert.equal(info.format.tags.title, 'Prüfung');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
