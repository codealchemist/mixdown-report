/** Minimal PCM WAV writer (16- or 24-bit), for test signals that Logic imports without conversion. */

/**
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {16|24} [bits]
 * @returns {Uint8Array}
 */
export function encodeWav(channels, sampleRate, bits = 24) {
  const n = channels[0].length;
  const ch = channels.length;
  const bytesPer = bits / 8;
  const dataSize = n * ch * bytesPer;
  const out = new Uint8Array(44 + dataSize);
  const view = new DataView(out.buffer);
  const tag = (o, s) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); tag(8, 'WAVE');
  tag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, ch, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * ch * bytesPer, true);
  view.setUint16(32, ch * bytesPer, true); view.setUint16(34, bits, true);
  tag(36, 'data'); view.setUint32(40, dataSize, true);
  const scale = 2 ** (bits - 1);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (const c of channels) {
      const v = Math.max(-scale, Math.min(scale - 1, Math.round(c[i] * scale)));
      if (bits === 16) view.setInt16(o, v, true);
      else { view.setUint16(o, v & 0xffff, true); view.setInt8(o + 2, v >> 16); }
      o += bytesPer;
    }
  }
  return out;
}
