/**
 * Remembers the mix and reference files between page reloads, in this browser only (IndexedDB).
 *
 * Where the browser gives file handles (Chrome, Edge) only the handle is stored: no copy, and a
 * restore reads the current version on disk. After a reload the browser may require one click to
 * allow reading again. Elsewhere a copy of the file is stored, since there is no other way to keep it.
 */
import { FileSource } from './file-source.js';

const DB_NAME = 'mixdown-report';
const STORE = 'files';
export const SLOTS = Object.freeze(['mix', 'ref']);

let opening = null;
function database() {
  if (!globalThis.indexedDB) return Promise.reject(new Error('This browser has no storage for files.'));
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return opening;
}

async function transaction(mode, run) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = run(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * @typedef {{ kind: 'handle', handle: FileSystemFileHandle, name: string, savedAt: number }
 *   | { kind: 'copy', file: File, name: string, savedAt: number }} Remembered
 */

/** Stores the file for `slot`. Returns false when the browser refuses (no storage, or the file is too large). */
export async function rememberFile(slot, source, file) {
  const record = source.handle
    ? { kind: 'handle', handle: source.handle, name: file.name, savedAt: Date.now() }
    : { kind: 'copy', file, name: file.name, savedAt: Date.now() };
  try {
    await transaction('readwrite', (store) => store.put(record, slot));
    return true;
  } catch (error) {
    console.warn(`Couldn't remember ${file.name}:`, error);
    return false;
  }
}

/** @returns {Promise<Remembered|null>} */
export async function recallFile(slot) {
  try {
    return (await transaction('readonly', (store) => store.get(slot))) ?? null;
  } catch {
    return null;
  }
}

export async function forgetFiles(slots = SLOTS) {
  try {
    await transaction('readwrite', (store) => { for (const slot of slots) store.delete(slot); });
  } catch { /* nothing stored */ }
}

/** True when reopening needs the user's permission first (a click). */
export async function needsPermission(record) {
  if (record.kind !== 'handle' || typeof record.handle.queryPermission !== 'function') return false;
  return (await record.handle.queryPermission({ mode: 'read' })) !== 'granted';
}

/**
 * Reopens a remembered file. With `ask`, requests read permission (must run inside a click).
 * @returns {Promise<FileSource>}
 */
export async function reopen(record, { ask = false } = {}) {
  if (record.kind === 'copy') return new FileSource(record.file);
  if (await needsPermission(record)) {
    if (!ask || (await record.handle.requestPermission({ mode: 'read' })) !== 'granted') {
      throw Object.assign(new Error(`Permission to read ${record.name} wasn't given.`), { name: 'NotAllowedError' });
    }
  }
  try {
    return new FileSource(await record.handle.getFile(), record.handle);
  } catch (error) {
    throw Object.assign(new Error(`${record.name} is no longer where it was (moved, renamed or deleted). Choose it again.`), { name: 'NotFoundError', cause: error });
  }
}
