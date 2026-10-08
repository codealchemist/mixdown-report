import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PlistError, parseBinaryPlist } from '../src/core/plist.js';
import { suggestTracksFromMetadata, trackNameFromFile } from '../src/core/logic-project.js';
import { crc32, createZip } from '../src/core/zip.js';

// Synthetic MetaData.plist with the same structure Logic writes (generated with Python's plistlib).
const fixture = readFileSync(new URL('./fixtures/MetaData.plist', import.meta.url));

test('parses binary plists: strings, numbers, booleans, dates, data and Unicode', () => {
  const meta = parseBinaryPlist(fixture);
  assert.equal(meta.NumberOfTracks, 11);
  assert.equal(meta.BeatsPerMinute, 95);
  assert.equal(meta.Version, 2.5);
  assert.equal(meta.HasGrid, false);
  assert.equal(meta.SongKey, 'C');
  assert.equal(meta.Unicode, 'Gitarre über');
  assert.deepEqual([...meta.Blob], [0, 1, 2]);
  assert.equal(meta.Created.toISOString(), '2026-01-02T03:04:05.000Z');
  assert.equal(meta.AudioFiles.length, 7);
});

test('rejects files that are not binary plists', () => {
  assert.throws(() => parseBinaryPlist(new TextEncoder().encode('<?xml version="1.0"?><plist></plist>' + ' '.repeat(40))), PlistError);
  const truncated = fixture.subarray(0, fixture.length - 10);
  assert.throws(() => parseBinaryPlist(truncated));
});

test('recording file names become track names', () => {
  assert.equal(trackNameFromFile('Audio Files/guitar-1-L #87.wav'), 'guitar-1-L');
  assert.equal(trackNameFromFile('Audio Files/guitar-solo-L #30.1.aif'), 'guitar-solo-L');
  assert.equal(trackNameFromFile('Audio Files/Smart Tempo Multitrack Set 8_4.aif'), 'Smart Tempo Multitrack Set');
  assert.equal(trackNameFromFile('Audio Files/Lead Vox.wav'), 'Lead Vox');
});

test('suggests tracks from recordings and sampler instruments, skipping bounces', () => {
  const r = suggestTracksFromMetadata(parseBinaryPlist(fixture));
  const byName = Object.fromEntries(r.tracks.map((t) => [t.name, t]));
  assert.equal(r.trackCount, 11);
  assert.equal(r.tempo, 95);
  assert.equal(byName['Lead Vox'].instrumentId, 'leadvocal');
  assert.equal(byName['Lead Vox'].files, 2, 'unused takes of a used track are not double-counted');
  assert.equal(byName['Lead Vox'].source, 'recording');
  assert.equal(byName['gtr-dist-L'].instrumentId, 'eguitardist');
  assert.equal(byName['guitar-solo2-R'].instrumentId, 'eguitardist');
  assert.equal(byName['Bass DI'].instrumentId, 'bassguitar');
  assert.equal(byName.Earthshaker.instrumentId, null);
  assert.equal(byName['Drums (Drum Kit Designer)'].instrumentId, 'drumbus');
  assert.equal(byName.Cellos.instrumentId, 'cello');
  assert.equal(byName.Strings, undefined, "Logic's '09 Strings' category folder isn't mistaken for violins");
  assert.equal(byName['old take'].source, 'unused');
  assert.equal(byName['Song - mix'], undefined, 'bounces are skipped');
  assert.deepEqual([...new Set(r.tracks.map((t) => t.source))], ['recording', 'sampler', 'unused']);
});

test('CRC-32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('ZIP archives list every entry with correct sizes and checksums', () => {
  const files = [{ name: 'Mixdown Report/Lead vocal.pst', data: new Uint8Array([1, 2, 3]) }, { name: 'Read me.txt', data: 'hello' }];
  const zip = createZip(files, new Date(2026, 0, 2, 3, 4, 6));
  const view = new DataView(zip.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  const end = zip.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 10, true), 2);
  let o = view.getUint32(end + 16, true);
  const names = [];
  for (let i = 0; i < 2; i++) {
    assert.equal(view.getUint32(o, true), 0x02014b50);
    const n = view.getUint16(o + 28, true);
    const name = new TextDecoder().decode(zip.subarray(o + 46, o + 46 + n));
    const data = typeof files[i].data === 'string' ? new TextEncoder().encode(files[i].data) : files[i].data;
    assert.equal(view.getUint32(o + 16, true), crc32(data));
    assert.equal(view.getUint32(o + 24, true), data.length);
    names.push(name);
    o += 46 + n;
  }
  assert.deepEqual(names, files.map((f) => f.name));
});
