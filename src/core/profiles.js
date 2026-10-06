/**
 * Reference data: frequency bands, genre balance curves and loudness targets.
 * Single source of truth for both the analysis and the UI controls.
 */

/** ISO third-octave centre frequencies (Hz) used for the spectrum. */
export const THIRD_OCTAVES = Object.freeze([
  25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000,
  1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
]);

/** The seven ranges the tonal-balance rules work with. `hi` is exclusive. */
export const BANDS = Object.freeze([
  { id: 'sub', name: 'Sub', range: '20–60 Hz', lo: 20, hi: 60 },
  { id: 'low', name: 'Bass', range: '60–250 Hz', lo: 60, hi: 250 },
  { id: 'lowmid', name: 'Low mids', range: '250–500 Hz', lo: 250, hi: 500 },
  { id: 'mid', name: 'Mids', range: '0.5–2 kHz', lo: 500, hi: 2000 },
  { id: 'upmid', name: 'Upper mids', range: '2–4 kHz', lo: 2000, hi: 4000 },
  { id: 'pres', name: 'Presence', range: '4–8 kHz', lo: 4000, hi: 8000 },
  { id: 'air', name: 'Air', range: '8–16 kHz', lo: 8000, hi: 16500 },
]);

/** Geometric centre of each band, for interpolating genre curves. */
export const BAND_CENTERS = Object.freeze(BANDS.map((b) => Math.sqrt(b.lo * b.hi)));

/**
 * Average third-octave level per band in dB, relative to the mids.
 * Approximations of typical commercial releases; a reference track is more accurate.
 * `assistant` is the suggested Mastering Assistant character.
 */
export const GENRES = Object.freeze({
  pop: { name: 'Pop', curve: [4, 7, 3, 0, -5, -8, -13], assistant: 'Clean' },
  hiphop: { name: 'Hip-hop / R&B', curve: [9, 9, 3, 0, -6, -9, -14], assistant: 'Punch' },
  edm: { name: 'Electronic / EDM', curve: [8, 8, 2, 0, -4, -7, -11], assistant: 'Punch' },
  rock: { name: 'Rock / Metal', curve: [2, 6, 4, 0, -4, -7, -13], assistant: 'Valve' },
  acoustic: { name: 'Acoustic / Jazz / Folk', curve: [-3, 3, 3, 0, -5, -9, -15], assistant: 'Transparent' },
});

/** Delivery targets: integrated loudness (LUFS) and true-peak ceiling (dBTP). */
export const TARGETS = Object.freeze({
  streaming: { name: 'Spotify, YouTube, Tidal', lufs: -14, truePeak: -1 },
  apple: { name: 'Apple Music', lufs: -16, truePeak: -1 },
  loud: { name: 'CD / download', lufs: -9, truePeak: -0.3 },
  club: { name: 'Club / DJ', lufs: -7, truePeak: -0.3 },
});

export const STAGES = Object.freeze({
  mix: { name: 'Mix, before mastering' },
  master: { name: 'Finished master' },
});

export const DEFAULT_SETTINGS = Object.freeze({ stage: 'mix', genre: 'pop', target: 'streaming' });

/** Thresholds used by the rules. Kept together so they are easy to tune. */
export const THRESHOLDS = Object.freeze({
  toleranceGenre: 3, // dB a band may differ from a genre curve
  toleranceReference: 2, // dB a band may differ from a reference track
  severeMargin: 4, // dB beyond tolerance that makes a band issue severe
  loudnessWindow: 1, // LU around the loudness target counted as on target
  mixHeadroom: -1, // dBTP; mixes peaking above this lack headroom
  mixLimitedPlr: 9, // dB; mixes below this look already limited
  masterCrushedPlr: 7, // dB; masters below this are heavily limited
  skipGlueCompPlr: 8, // dB; skip the glue compressor below this
  lraLow: 3, // LU
  lraHigh: 14, // LU
  corrCritical: 0,
  corrWide: 0.2,
  lowCorr: 0.85, // correlation below 120 Hz
  widthNarrow: -18, // dB side vs centre
  widthWide: -3,
  balance: 1, // dB left/right difference
  dcOffset: 0.002, // linear
});

/** Returns valid settings, falling back to defaults for unknown values. */
export function sanitizeSettings(input) {
  const s = input && typeof input === 'object' ? input : {};
  return {
    stage: Object.hasOwn(STAGES, s.stage) ? s.stage : DEFAULT_SETTINGS.stage,
    genre: Object.hasOwn(GENRES, s.genre) ? s.genre : DEFAULT_SETTINGS.genre,
    target: Object.hasOwn(TARGETS, s.target) ? s.target : DEFAULT_SETTINGS.target,
  };
}
