/**
 * A file the user picked, kept so it can be read again after it changes on disk.
 *
 * A plain File is a snapshot: Chromium refuses to read it once the file on disk changes.
 * Where the File System Access API exists (Chrome, Edge), the source also keeps a
 * FileSystemFileHandle, which always returns the current version and lets us tell
 * whether it changed. Other browsers fall back to re-reading the original File.
 */
export class FileSource {
  #file;
  #handle;

  /**
   * @param {File} file
   * @param {FileSystemFileHandle|null} [handle]
   */
  constructor(file, handle = null) {
    this.#file = file;
    this.#handle = handle;
    this.name = file.name;
    this.lastModified = file.lastModified;
    this.size = file.size;
  }

  /** True when reads return the current version on disk and changes can be detected. */
  get tracksDisk() {
    return this.#handle !== null;
  }

  /**
   * Returns the current file. Throws (usually NotReadableError) when the browser can't read it again.
   * @returns {Promise<File>}
   */
  async read() {
    if (this.#handle) return this.#handle.getFile();
    await this.#file.slice(0, 1).arrayBuffer(); // fails fast if the snapshot is no longer readable
    return this.#file;
  }

  /** True when `file` is known to be identical to the version this source last loaded. */
  isUnchanged(file) {
    return this.tracksDisk && file.lastModified === this.lastModified && file.size === this.size;
  }

  /** A source for a newer version of the same file, keeping the handle. */
  withFile(file) {
    return new FileSource(file, this.#handle);
  }
}

const AUDIO_TYPES = [{ description: 'Audio', accept: { 'audio/*': ['.wav', '.aif', '.aiff', '.mp3', '.m4a', '.flac'] } }];

export const canPickWithHandle = () => typeof globalThis.showOpenFilePicker === 'function';

/**
 * Opens the system file picker and keeps a handle to the chosen file.
 * Rejects with AbortError when the user cancels.
 */
export async function pickFile() {
  const [handle] = await globalThis.showOpenFilePicker({ types: AUDIO_TYPES, multiple: false });
  return new FileSource(await handle.getFile(), handle);
}

/**
 * Reads the first dropped file, with a handle when the browser offers one.
 * Must be called synchronously inside the drop handler: the DataTransfer empties afterwards.
 * @param {DataTransfer|null} dataTransfer
 * @returns {Promise<FileSource|null>}
 */
export function sourceFromDrop(dataTransfer) {
  const item = [...(dataTransfer?.items ?? [])].find((i) => i.kind === 'file');
  const file = item?.getAsFile() ?? dataTransfer?.files?.[0];
  if (!file) return Promise.resolve(null);
  const pending = typeof item?.getAsFileSystemHandle === 'function'
    ? item.getAsFileSystemHandle().catch(() => null)
    : Promise.resolve(null);
  return pending.then((handle) => new FileSource(file, handle?.kind === 'file' ? handle : null));
}
