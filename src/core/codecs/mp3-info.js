/** Reads MP3 frame headers to confirm bitrate, sample rate and channel mode of an encoded file. */

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const RATES_V1 = [44100, 48000, 32000, 0];
const MODES = ['stereo', 'joint stereo', 'dual channel', 'mono'];

/**
 * @param {Uint8Array} bytes
 * @returns {{ frames: number, bitrates: number[], sampleRate: number, mode: string, constantBitrate: boolean, id3: boolean, durationSeconds: number }}
 */
export function mp3Info(bytes) {
  let o = 0;
  const id3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
  if (id3) o = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]);
  const bitrates = new Set();
  let frames = 0, sampleRate = 0, mode = '';
  while (o + 4 <= bytes.length) {
    const h = (bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3];
    const sync = (h >>> 21) === 0x7ff;
    const mpeg1 = ((h >>> 19) & 3) === 3;
    const layer3 = ((h >>> 17) & 3) === 1;
    const bitrate = BITRATES_V1_L3[(h >>> 12) & 15];
    const rate = RATES_V1[(h >>> 10) & 3];
    if (!sync || !mpeg1 || !layer3 || !bitrate || !rate) {
      if (frames === 0) { o++; continue; } // skip junk before the first frame
      break;
    }
    const padding = (h >>> 9) & 1;
    const length = Math.floor((144000 * bitrate) / rate) + padding;
    bitrates.add(bitrate);
    sampleRate = rate;
    mode = MODES[(h >>> 6) & 3];
    frames++;
    o += length;
  }
  return {
    frames,
    bitrates: [...bitrates],
    sampleRate,
    mode,
    constantBitrate: bitrates.size === 1,
    id3,
    durationSeconds: sampleRate ? (frames * 1152) / sampleRate : 0,
  };
}
