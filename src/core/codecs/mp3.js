/**
 * MP3 encoding with LAME (vendored, LGPL, see src/vendor/lamejs/VENDOR.md), plus an ID3v2.3 tag.
 * Loaded on demand so the encoder isn't downloaded until someone exports an MP3.
 */
import { Mp3Encoder } from '../../vendor/lamejs/lamejs.js';

const FRAME = 1152; // samples per MPEG-1 Layer III frame

/** ID3v2.3 tag with UTF-16 text frames (title, artist, encoder). */
export function id3v23(tags) {
  const frames = [];
  for (const [id, value] of Object.entries(tags)) {
    if (!value) continue;
    const text = String(value);
    const body = new Uint8Array(1 + 2 + text.length * 2);
    body[0] = 1; // UTF-16 with BOM
    body[1] = 0xff;
    body[2] = 0xfe;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      body[3 + i * 2] = c & 0xff;
      body[4 + i * 2] = c >> 8;
    }
    const frame = new Uint8Array(10 + body.length);
    for (let i = 0; i < 4; i++) frame[i] = id.charCodeAt(i);
    new DataView(frame.buffer).setUint32(4, body.length, false);
    frame.set(body, 10);
    frames.push(frame);
  }
  const size = frames.reduce((n, f) => n + f.length, 0);
  const tag = new Uint8Array(10 + size);
  tag.set([0x49, 0x44, 0x33, 3, 0, 0]); // "ID3", v2.3.0, no flags
  for (let i = 0; i < 4; i++) tag[6 + i] = (size >> (21 - 7 * i)) & 0x7f; // syncsafe size
  let o = 10;
  for (const f of frames) { tag.set(f, o); o += f.length; }
  return tag;
}

/**
 * @param {Int32Array[]} pcm one or two channels of 16-bit samples
 * @param {{ sampleRate: number, kbps?: number, title?: string, artist?: string, onProgress?: (f: number) => void }} options
 * @returns {Uint8Array}
 */
export function encodeMp3(pcm, { sampleRate, kbps = 320, title = '', artist = '', onProgress = () => {} }) {
  const channels = pcm.length;
  const encoder = new Mp3Encoder(channels, sampleRate, kbps);
  const parts = [id3v23({ TIT2: title, TPE1: artist, TSSE: 'Mixdown Report (LAME)' })];
  const n = pcm[0].length;
  const chunk = FRAME * 64;
  const left = new Int16Array(chunk);
  const right = new Int16Array(chunk);
  for (let start = 0; start < n; start += chunk) {
    const end = Math.min(n, start + chunk);
    const len = end - start;
    for (let i = 0; i < len; i++) {
      left[i] = pcm[0][start + i];
      if (channels > 1) right[i] = pcm[1][start + i];
    }
    const out = channels > 1 ? encoder.encodeBuffer(left.subarray(0, len), right.subarray(0, len)) : encoder.encodeBuffer(left.subarray(0, len));
    if (out.length) parts.push(Uint8Array.from(out));
    onProgress(end / n);
  }
  const tail = encoder.flush();
  if (tail.length) parts.push(Uint8Array.from(tail));

  const total = parts.reduce((s, p) => s + p.length, 0);
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { bytes.set(p, o); o += p.length; }
  return bytes;
}
