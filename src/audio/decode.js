/** Decodes an audio file with Web Audio at the file's own sample rate. */
import { sniffHeader } from '../core/sniff.js';

const LOSSY = new Set(['mp3', 'm4a', 'aac', 'ogg', 'opus', 'webm']);
const MIN_RATE = 8000;
const MAX_RATE = 192000;
export const MAX_FILE_BYTES = 1024 ** 3; // 1 GB: about 50 minutes of 96 kHz/32-bit stereo

export class DecodeError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'DecodeError';
  }
}

/** Copies up to two channels out of an AudioBuffer so they can be transferred to a worker. */
export function channelsOf(audioBuffer, max = 2) {
  const n = Math.min(audioBuffer.numberOfChannels, max);
  return Array.from({ length: n }, (_, c) => audioBuffer.getChannelData(c).slice());
}

/**
 * @param {File} file
 * @returns {Promise<{ channels: Float32Array[], sampleRate: number, meta: { format: string, bitDepth: number, lossy: boolean } }>}
 */
export async function decodeFile(file) {
  if (file.size > MAX_FILE_BYTES) throw new DecodeError(`${file.name} is larger than 1 GB. Bounce a shorter section or a lower sample rate.`);
  const extension = (file.name.split('.').pop() || '').toLowerCase();
  const bytes = await file.arrayBuffer();
  const header = sniffHeader(bytes);
  const rate = Math.min(MAX_RATE, Math.max(MIN_RATE, header.sampleRate || 48000));
  let audio;
  try {
    audio = await new OfflineAudioContext(1, 1, rate).decodeAudioData(bytes);
  } catch (error) {
    throw new DecodeError(`Couldn't read ${file.name}. Bounce it from Logic as a WAV or AIFF file and try again.`, error);
  }
  return {
    channels: channelsOf(audio),
    sampleRate: audio.sampleRate,
    meta: { format: header.format || extension.toUpperCase(), bitDepth: header.bitDepth || 0, lossy: LOSSY.has(extension) },
  };
}
