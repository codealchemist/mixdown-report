/**
 * Suggests tracks from a Logic Pro project's Alternatives/000/MetaData.plist.
 *
 * Logic's main project data (ProjectData) is an undocumented binary format that does not store
 * renamed track names as plain text, so it isn't read. MetaData.plist is a standard plist and lists
 * the project's recordings, which Logic names after their track ("guitar-solo-L #39.wav"), plus the
 * sampler instruments in use. That reveals audio tracks reliably; software-instrument tracks only
 * appear when they use a recognisable sampler instrument (for example Drum Kit Designer).
 */
import { guessInstrument } from './eq/instruments.js';

/** Recording file name to track name: strips folder, extension, take numbers and copy suffixes. */
export function trackNameFromFile(path) {
  return String(path)
    .split('/').pop()
    .replace(/\.(wav|aif|aiff|caf|mp3|m4a)$/i, '')
    .replace(/\s+#\d+(?:\.\d+)?$/, '') // "guitar-1-L #87" or "#30.1"
    .replace(/(?:_\d+)+$/, '') // "Set 8_4"
    .replace(/\b(Set|Take|Comp)\s+\d+$/i, '$1') // "Multitrack Set 10" → "Multitrack Set"
    .trim();
}

/** Sampler paths match on file and folder names; Logic's numbered category folders ("09 Strings") are ignored. */
const samplerLabel = (path) => String(path).split('/').slice(-3).filter((part) => !/^\d\d\s/.test(part)).join('/');

const SKIP = /\b(bounce|bounced|mixdown|mix|master|stem|stems|no guitar|instrumental)\b/i; // bounces dropped into the project

const SAMPLER_HINTS = [
  [/Drum Kit Designer|Drummer|Drum Kits?\b/i, 'Drums (Drum Kit Designer)', 'drumbus'],
  [/Cellos?|\bVC[-_]/i, 'Cellos', 'cello'],
  [/Violins?|Violas?|Strings/i, 'Strings', 'strings'],
  [/Piano/i, 'Piano', 'piano'],
  [/Brass|Trumpet|Trombone|Horn/i, 'Brass', 'brass'],
  [/Flute|Clarinet|Oboe|Woodwind/i, 'Woodwinds', 'woodwinds'],
  [/Bass/i, 'Bass', 'bassguitar'],
];

/**
 * @param {Record<string, any>} meta parsed MetaData.plist
 * Sources: 'recording' (on the timeline), 'sampler' (a recognised sampler instrument) and
 * 'unused' (recordings in the project folder that aren't on the timeline: less certain).
 * @returns {{ tracks: { name: string, instrumentId: string|null, source: 'recording'|'sampler'|'unused', files: number }[], trackCount: number|null, sampleRate: number|null, tempo: number|null }}
 */
export function suggestTracksFromMetadata(meta) {
  if (!meta || typeof meta !== 'object') throw new Error('Project metadata is empty.');
  const byName = new Map();
  const addRecordings = (files, source) => {
    for (const file of Array.isArray(files) ? files : []) {
      const name = trackNameFromFile(file);
      if (!name || SKIP.test(name)) continue;
      const key = name.toLowerCase();
      const entry = byName.get(key) ?? { name, instrumentId: guessInstrument(name), source, files: 0 };
      if (entry.source === source) entry.files++;
      byName.set(key, entry);
    }
  };
  addRecordings(meta.AudioFiles, 'recording');
  addRecordings(meta.UnusedAudioFiles, 'unused');

  const sampler = (Array.isArray(meta.SamplerInstrumentsFiles) ? meta.SamplerInstrumentsFiles : []).map(samplerLabel);
  for (const [pattern, name, instrumentId] of SAMPLER_HINTS) {
    const count = sampler.filter((f) => pattern.test(f)).length;
    if (!count || byName.has(name.toLowerCase())) continue;
    if ([...byName.values()].some((t) => t.source === 'sampler' && t.instrumentId === instrumentId)) continue;
    byName.set(name.toLowerCase(), { name, instrumentId, source: 'sampler', files: count });
  }
  const order = { recording: 0, sampler: 1, unused: 2 };
  const tracks = [...byName.values()].sort((a, b) => order[a.source] - order[b.source] || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return {
    tracks,
    trackCount: Number.isFinite(meta.NumberOfTracks) ? meta.NumberOfTracks : null,
    sampleRate: Number.isFinite(meta.SampleRate) ? meta.SampleRate : null,
    tempo: Number.isFinite(meta.BeatsPerMinute) ? meta.BeatsPerMinute : null,
  };
}
