/**
 * Reader for Apple binary property lists ("bplist00"), enough for Logic's MetaData.plist.
 * Supports null, booleans, integers, reals, dates, data, ASCII/UTF-16 strings, UIDs, arrays and dictionaries.
 */

export class PlistError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlistError';
  }
}

const MAX_DEPTH = 64;

/** @param {ArrayBuffer|Uint8Array} input */
export function parseBinaryPlist(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 40 || String.fromCharCode(...bytes.subarray(0, 8)) !== 'bplist00') throw new PlistError('Not a binary property list.');

  const trailer = bytes.length - 32;
  const offsetSize = bytes[trailer + 6];
  const refSize = bytes[trailer + 7];
  const objectCount = readUint(view, trailer + 8, 8);
  const topObject = readUint(view, trailer + 16, 8);
  const tableOffset = readUint(view, trailer + 24, 8);
  if (![1, 2, 4, 8].includes(offsetSize) || ![1, 2, 4, 8].includes(refSize) || tableOffset + objectCount * offsetSize > trailer) {
    throw new PlistError('Property list trailer is invalid.');
  }
  const offsets = Array.from({ length: objectCount }, (_, i) => readUint(view, tableOffset + i * offsetSize, offsetSize));

  const parse = (ref, depth) => {
    if (depth > MAX_DEPTH || ref >= objectCount) throw new PlistError('Property list is malformed.');
    let o = offsets[ref];
    const marker = bytes[o];
    const type = marker >> 4;
    let info = marker & 0x0f;
    o += 1;
    const length = () => {
      if (info !== 0x0f) return info;
      const size = 1 << (bytes[o] & 0x0f);
      const n = readUint(view, o + 1, size);
      o += 1 + size;
      return n;
    };
    switch (type) {
      case 0x0: return info === 0x8 ? false : info === 0x9 ? true : null;
      case 0x1: return readInt(view, o, 1 << info);
      case 0x2: return info === 2 ? view.getFloat32(o) : view.getFloat64(o);
      case 0x3: return new Date(Date.UTC(2001, 0, 1) + view.getFloat64(o) * 1000);
      case 0x4: { const n = length(); return bytes.slice(o, o + n); }
      case 0x5: { const n = length(); return String.fromCharCode(...bytes.subarray(o, o + n)); }
      case 0x6: {
        const n = length();
        let s = '';
        for (let i = 0; i < n; i++) s += String.fromCharCode(view.getUint16(o + i * 2));
        return s;
      }
      case 0x8: return { uid: readUint(view, o, info + 1) };
      case 0xa: {
        const n = length();
        return Array.from({ length: n }, (_, i) => parse(readUint(view, o + i * refSize, refSize), depth + 1));
      }
      case 0xd: {
        const n = length();
        const out = {};
        for (let i = 0; i < n; i++) {
          const key = parse(readUint(view, o + i * refSize, refSize), depth + 1);
          const value = parse(readUint(view, o + (n + i) * refSize, refSize), depth + 1);
          if (typeof key === 'string' && key !== '__proto__') out[key] = value;
        }
        return out;
      }
      default: throw new PlistError(`Unsupported property list object type 0x${type.toString(16)}.`);
    }
  };
  return parse(topObject, 0);
}

function readUint(view, offset, size) {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + view.getUint8(offset + i);
  return v;
}

function readInt(view, offset, size) {
  if (size === 8) return Number(view.getBigInt64(offset));
  return readUint(view, offset, size);
}
