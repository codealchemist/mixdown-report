import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileSource, sourceFromDrop } from '../src/audio/file-source.js';

/** Minimal File stand-in. `readable: false` mimics Chromium's NotReadableError after the file changes on disk. */
function fakeFile({ name = 'mix.wav', lastModified = 1000, size = 100, readable = true } = {}) {
  return {
    name, lastModified, size,
    slice: () => ({
      arrayBuffer: async () => {
        if (!readable) throw Object.assign(new Error('changed'), { name: 'NotReadableError' });
        return new ArrayBuffer(1);
      },
    }),
  };
}

/** Handle stand-in whose current file can be swapped, like a bounce being overwritten. */
function fakeHandle(file) {
  return { kind: 'file', current: file, getFile() { return Promise.resolve(this.current); } };
}

test('with a handle, read returns the current version on disk and detects changes', async () => {
  const first = fakeFile();
  const handle = fakeHandle(first);
  const source = new FileSource(first, handle);
  assert.equal(source.tracksDisk, true);
  assert.equal(source.isUnchanged(await source.read()), true);

  const rebounced = fakeFile({ lastModified: 2000, size: 120 });
  handle.current = rebounced;
  const read = await source.read();
  assert.equal(read, rebounced);
  assert.equal(source.isUnchanged(read), false);

  const next = source.withFile(read);
  assert.equal(next.tracksDisk, true);
  assert.equal(next.lastModified, 2000);
  assert.equal(next.isUnchanged(await next.read()), true);
});

test('without a handle, read returns the original file and never claims it is unchanged', async () => {
  const file = fakeFile();
  const source = new FileSource(file);
  assert.equal(source.tracksDisk, false);
  assert.equal(await source.read(), file);
  assert.equal(source.isUnchanged(file), false); // can't know, so always re-analyze
});

test('without a handle, a snapshot the browser can no longer read rejects', async () => {
  const source = new FileSource(fakeFile({ readable: false }));
  await assert.rejects(source.read(), { name: 'NotReadableError' });
});

test('drops keep a handle when the browser provides one', async () => {
  const file = fakeFile();
  const handle = fakeHandle(file);
  const withHandle = await sourceFromDrop({ items: [{ kind: 'file', getAsFile: () => file, getAsFileSystemHandle: async () => handle }], files: [file] });
  assert.equal(withHandle.tracksDisk, true);

  const plain = await sourceFromDrop({ items: [{ kind: 'file', getAsFile: () => file }], files: [file] });
  assert.equal(plain.tracksDisk, false);
  assert.equal(plain.name, 'mix.wav');

  const failing = await sourceFromDrop({ items: [{ kind: 'file', getAsFile: () => file, getAsFileSystemHandle: async () => { throw new Error('denied'); } }], files: [file] });
  assert.equal(failing.tracksDisk, false);

  assert.equal(await sourceFromDrop({ items: [{ kind: 'string' }], files: [] }), null);
  assert.equal(await sourceFromDrop(null), null);
});
