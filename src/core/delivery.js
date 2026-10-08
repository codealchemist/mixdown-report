/**
 * Prepares a mix or master for a distributor: stereo, the required sample rate and bit depth,
 * optional true-peak safety, then lossless encoding. Pure; runs in the render worker and in Node.
 */
import { resample } from './dsp/resample.js';
import { quantize } from './dsp/dither.js';
import { truePeak } from './levels.js';
import { encodeFlac } from './codecs/flac.js';
import { toDb } from './format.js';

/** Upload specs. RouteNote accepts stereo FLAC or MP3 320 kbps, 16-bit, 44.1 kHz, and no WAV. */
export const DELIVERY_SPECS = Object.freeze({
  'routenote-flac': { name: 'RouteNote · FLAC 16-bit / 44.1 kHz (recommended)', format: 'flac', sampleRate: 44100, bits: 16 },
  'routenote-mp3': { name: 'RouteNote · MP3 320 kbps / 44.1 kHz', format: 'mp3', sampleRate: 44100, bits: 16, kbps: 320 },
  'flac-24': { name: 'FLAC 24-bit, original sample rate (archive)', format: 'flac', sampleRate: null, bits: 24 },
});

/**
 * Name for a finished release file: the song, which version of it, and what the file is.
 * releaseFileName({ song: 'Song', variant: 'master', report }) -> "Song (master) (44.1k 16-bit).flac"
 * @param {{ song: string, variant?: string|null, report: { format: string, kbps?: number, sampleRate: number, bits: number } }} file
 */
export function releaseFileName({ song, variant = null, report }) {
  const what = report.format === 'mp3' ? `${report.kbps} kbps` : `${report.sampleRate / 1000}k ${report.bits}-bit`;
  return `${song}${variant ? ` (${variant})` : ''} (${what}).${report.format}`;
}

/** Name for a zip of a song's release files. */
export const releaseZipName = (song) => `${song} (release files).zip`;

const MP3_MARGIN = 0.5; // dB: MP3 encoding raises peaks slightly, so lossy exports keep extra headroom

const peakOf = (channels) => Math.max(...channels.map((c) => truePeak(c, c.reduce((m, v) => Math.max(m, Math.abs(v)), 0))));

/**
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {{ spec?: keyof typeof DELIVERY_SPECS, ceilingDb?: number|null, title?: string, onProgress?: (label: string, f: number) => void }} options
 *   ceilingDb: turn the file down so its true peak stays at or below this (null = never change level)
 */
export async function prepareDelivery(channels, sampleRate, { spec = 'routenote-flac', ceilingDb = null, title = '', onProgress = () => {} } = {}) {
  const target = DELIVERY_SPECS[spec];
  if (!target) throw new Error(`Unknown delivery spec: ${spec}`);
  const outRate = target.sampleRate ?? sampleRate;
  const notes = [];

  let chs = channels.slice(0, 2);
  if (chs.length === 1) {
    chs = [chs[0], chs[0]];
    notes.push('The source is mono; it was written as two identical channels because stores require stereo.');
  }

  if (outRate !== sampleRate) {
    chs = chs.map((c, i) => resample(c, sampleRate, outRate, (f) => onProgress(`Converting to ${outRate / 1000} kHz`, (i + f) / chs.length * 0.5)));
    notes.push(`Converted from ${sampleRate / 1000} kHz to ${outRate / 1000} kHz.`);
  } else {
    chs = chs.map((c) => Float32Array.from(c));
  }

  onProgress('Checking peaks', 0.5);
  let peakDb = toDb(peakOf(chs));
  let gainDb = 0;
  const ceiling = ceilingDb != null && target.format === 'mp3' ? ceilingDb - MP3_MARGIN : ceilingDb;
  if (ceiling != null && peakDb > ceiling) {
    gainDb = ceiling - peakDb - 0.05; // a little margin for the dither
    const g = 10 ** (gainDb / 20);
    for (const c of chs) for (let i = 0; i < c.length; i++) c[i] *= g;
    peakDb += gainDb;
    notes.push(target.format === 'mp3'
      ? `Turned down ${Math.abs(gainDb).toFixed(2)} dB to ${ceiling} dBTP before encoding, because MP3 encoding raises peaks slightly.`
      : `Turned down ${Math.abs(gainDb).toFixed(2)} dB so the true peak stays under ${ceilingDb} dBTP.`);
  }

  onProgress(`Writing ${target.bits}-bit audio`, 0.55);
  const { channels: pcm, clipped, dithered } = quantize(chs, target.bits);
  if (dithered) notes.push(`Dithered to ${target.bits}-bit.`);
  else notes.push(`The audio was already ${target.bits}-bit, so it was copied exactly with no dither.`);

  let bytes;
  if (target.format === 'mp3') {
    onProgress('Encoding MP3', 0.6);
    const { encodeMp3 } = await import('./codecs/mp3.js'); // loads the LAME encoder only when needed
    bytes = encodeMp3(pcm, { sampleRate: outRate, kbps: target.kbps, title, onProgress: (f) => onProgress('Encoding MP3', 0.6 + 0.4 * f) });
    notes.push(`Encoded as MP3 at ${target.kbps} kbps with LAME.`);
  } else {
    onProgress('Encoding FLAC', 0.6);
    bytes = encodeFlac(pcm, { sampleRate: outRate, bitsPerSample: target.bits, tags: { TITLE: title }, onProgress: (f) => onProgress('Encoding FLAC', 0.6 + 0.4 * f) });
  }

  return {
    bytes,
    report: {
      spec,
      format: target.format,
      sampleRate: outRate,
      sourceSampleRate: sampleRate,
      bits: target.bits,
      channels: 2,
      samples: pcm[0].length,
      truePeakDb: peakDb,
      gainDb,
      clipped,
      dithered,
      kbps: target.kbps ?? null,
      md5: target.format === 'flac' ? flacMd5(bytes) : null,
      notes,
    },
  };
}

/** The audio MD5 stored in a FLAC file's STREAMINFO block, as hex. */
export function flacMd5(bytes) {
  return [...bytes.subarray(26, 42)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
