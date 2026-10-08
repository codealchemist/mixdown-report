/**
 * Finds MetaData.plist in a dropped Logic Pro project (.logicx is a folder package),
 * or accepts the MetaData.plist file itself.
 */
import { parseBinaryPlist } from '../core/plist.js';

export class ProjectFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProjectFileError';
  }
}

const entryFile = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));
const childEntries = (dir) => new Promise((resolve, reject) => {
  const reader = dir.createReader();
  const all = [];
  const next = () => reader.readEntries((batch) => (batch.length ? (all.push(...batch), next()) : resolve(all)), reject);
  next();
});
const child = async (dir, name) => (await childEntries(dir)).find((e) => e.name === name) ?? null;

/** Reads MetaData.plist from the first alternative of a project folder entry. */
async function metadataFromProjectEntry(dir) {
  const alternatives = await child(dir, 'Alternatives');
  if (!alternatives?.isDirectory) throw new ProjectFileError(`${dir.name} doesn't look like a Logic Pro project (no Alternatives folder).`);
  const versions = (await childEntries(alternatives)).filter((e) => e.isDirectory).sort((a, b) => a.name.localeCompare(b.name));
  for (const version of versions) {
    const meta = await child(version, 'MetaData.plist');
    if (meta?.isFile) return entryFile(meta);
  }
  throw new ProjectFileError(`No MetaData.plist found in ${dir.name}.`);
}

/**
 * Must be called synchronously inside the drop handler.
 * @param {DataTransfer} dataTransfer
 * @returns {Promise<{ name: string, meta: Record<string, any> }>}
 */
export function readDroppedProject(dataTransfer) {
  const item = [...(dataTransfer?.items ?? [])].find((i) => i.kind === 'file');
  const entry = item?.webkitGetAsEntry?.() ?? null;
  const file = item?.getAsFile() ?? null;
  return (async () => {
    if (entry?.isDirectory) return { name: entry.name.replace(/\.logicx$/i, ''), meta: parseBinaryPlist(await (await metadataFromProjectEntry(entry)).arrayBuffer()) };
    if (file) return readProjectFile(file);
    throw new ProjectFileError('Drop a Logic Pro project (.logicx) or its MetaData.plist.');
  })();
}

/** Reads a MetaData.plist chosen with a file input. */
export async function readProjectFile(file) {
  if (/\.logicx$/i.test(file.name)) throw new ProjectFileError('This browser gave the project as a single file. Drag the .logicx project onto the drop area instead.');
  try {
    return { name: /^MetaData\.plist$/i.test(file.name) ? 'your project' : file.name, meta: parseBinaryPlist(await file.arrayBuffer()) };
  } catch {
    throw new ProjectFileError(`${file.name} isn't a Logic Pro MetaData.plist file.`);
  }
}
