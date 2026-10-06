/**
 * Reads format, sample rate and bit depth from WAV and AIFF headers.
 * Browsers resample on decode, so the original rate is needed to decode at the file's own rate.
 * @param {ArrayBuffer} buffer
 * @returns {{ format?: string, sampleRate?: number, bitDepth?: number }}
 */
export function sniffHeader(buffer) {
  const view = new DataView(buffer);
  const size = buffer.byteLength;
  const tag = (o) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
  if (size < 12) return {};

  try {
    if (tag(0) === 'RIFF' && tag(8) === 'WAVE') {
      for (let o = 12; o + 8 <= size;) {
        const id = tag(o);
        const chunk = view.getUint32(o + 4, true);
        if (id === 'fmt ' && o + 24 <= size) {
          return { format: 'WAV', sampleRate: view.getUint32(o + 12, true), bitDepth: view.getUint16(o + 22, true) };
        }
        o += 8 + chunk + (chunk & 1);
      }
    }
    if (tag(0) === 'FORM' && (tag(8) === 'AIFF' || tag(8) === 'AIFC')) {
      for (let o = 12; o + 8 <= size;) {
        const id = tag(o);
        const chunk = view.getUint32(o + 4, false);
        if (id === 'COMM' && o + 26 <= size) {
          // Sample rate is an 80-bit IEEE extended float: 15-bit exponent, 64-bit mantissa.
          const exponent = view.getUint16(o + 16, false) & 0x7fff;
          const mantissaHigh = view.getUint32(o + 18, false);
          return {
            format: tag(8),
            sampleRate: Math.round(mantissaHigh * 2 ** (exponent - 16383 - 31)),
            bitDepth: view.getUint16(o + 14, false),
          };
        }
        o += 8 + chunk + (chunk & 1);
      }
    }
  } catch {
    // Truncated or malformed header: let the browser's decoder decide.
  }
  return {};
}
