/**
 * Turns an Analysis into ranked findings and a Logic Pro mastering chain.
 * Each rule is a small function that reads the shared context and reports findings,
 * so rules can be added, removed or tested on their own.
 */
import { BAND_ADVICE } from './advice.js';
import { BANDS, GENRES, TARGETS, THRESHOLDS as T, sanitizeSettings } from './profiles.js';
import { MINUS, gentleMove, median, num, signed } from './format.js';

/** @typedef {'critical'|'warning'|'note'} Severity */
/**
 * @typedef {object} Finding
 * @property {string} id stable identifier, useful for tests and analytics
 * @property {Severity} severity
 * @property {string} area
 * @property {string} title
 * @property {string} detail
 * @property {string[]} steps Logic Pro instructions
 */

export const SEVERITY = Object.freeze({
  critical: { label: 'Fix first', rank: 0 },
  warning: { label: 'Improve', rank: 1 },
  note: { label: 'Note', rank: 2 },
});

/** Band deviations from the comparison curve, aligned by their median so only shape is compared. */
export function bandDeviations(bands, comparison) {
  const diffs = bands.map((v, i) => v - comparison[i]);
  const offset = median(diffs);
  return diffs.map((d) => (Number.isFinite(d) ? d - offset : 0));
}

/* ---------- rules ---------- */

function tonalBalance(ctx) {
  const { stage, tolerance, deviations, basis, file } = ctx;
  BANDS.forEach((band, i) => {
    const d = deviations[i];
    if (Math.abs(d) <= tolerance) return ctx.ok(`${band.name} balance`);
    if (band.id === 'air' && d < 0 && file.lossy) {
      return ctx.add({
        id: 'air-lossy', severity: 'note', area: 'Tonal balance', title: 'Top end is low, possibly from the file format',
        detail: `Air is ${num(-d)} dB below ${basis}. Lossy files (MP3, AAC) often cut everything above 16 kHz. Bounce a WAV and check again before EQ-ing.`,
        steps: [],
      });
    }
    const advice = BAND_ADVICE[band.id][d > 0 ? 'high' : 'low'];
    const move = advice.eq(gentleMove(d));
    ctx.eqMoves.push(move);
    ctx.add({
      id: `band-${band.id}-${d > 0 ? 'high' : 'low'}`,
      severity: Math.abs(d) > tolerance + T.severeMargin ? 'critical' : 'warning',
      area: `Tonal balance · ${band.range}`,
      title: advice.title,
      detail: `${band.name} is ${num(Math.abs(d))} dB ${d > 0 ? 'above' : 'below'} ${basis}. ${advice.why}`,
      steps: stage === 'mix'
        ? advice.mix
        : [`Channel EQ on the Stereo Out: ${move}. Mastering EQ moves should stay gentle; if this doesn't fix it, go back to the mix.`],
    });
  });
}

function clipping(ctx) {
  const { a, stage } = ctx;
  if (!a.clippedRuns) return;
  ctx.add({
    id: 'clipping', severity: 'critical', area: 'Level', title: 'The bounce is clipping',
    detail: `Found ${a.clippedRuns} flat-topped run${a.clippedRuns > 1 ? 's' : ''} of samples at the peak level. Clipped peaks are audible distortion and can't be undone after bouncing.`,
    steps: stage === 'mix'
      ? [
          'Look for red peak indicators on every channel strip, bus and the Stereo Out; click them to reset and play the loudest section.',
          'If you have no plugins on the Stereo Out, lower its fader. If you do, add the Gain plugin as the first insert and lower it until peaks sit around −6 dBFS.',
          'Bounce again with Normalize set to Off.',
        ]
      : ['Lower Gain on the Adaptive Limiter until the overs stop, or check whether a plugin after the limiter is boosting level.', 'Turn on True Peak Detection in the Adaptive Limiter.'],
  });
}

function mixLevels(ctx) {
  const { a } = ctx;
  if (!a.clippedRuns && a.truePeakDb > T.mixHeadroom) {
    const reduce = Math.ceil(a.truePeakDb + 6);
    ctx.add({
      id: 'mix-headroom', severity: 'warning', area: 'Headroom', title: 'Not enough headroom for mastering',
      detail: `Peaks reach ${num(a.truePeakDb)} dBTP. Mastering works best with peaks between −6 and −3 dBFS.`,
      steps: [
        `If the Stereo Out has no plugins, lower its fader by about ${reduce} dB. If it has plugins, add the Gain plugin as its first insert at ${MINUS}${reduce} dB.`,
        "This doesn't change your balance; it only moves the whole mix down.",
      ],
    });
  } else if (a.truePeakDb <= T.mixHeadroom) ctx.ok('Headroom');

  if (a.plr < T.mixLimitedPlr) {
    ctx.add({
      id: 'mix-limited', severity: 'warning', area: 'Dynamics', title: 'The mix already sounds limited',
      detail: `Peak-to-loudness ratio is ${num(a.plr)} dB. Unmastered mixes usually sit above 12 dB. A limiter on the mix bus leaves less room for mastering.`,
      steps: [
        'Bypass any Adaptive Limiter, Limiter or Mastering Assistant on the Stereo Out before you bounce the mix.',
        "Keep a gentle glue compressor if it's part of your sound, and note its settings.",
      ],
    });
  } else ctx.ok('Dynamics');
}

function masterLevels(ctx) {
  const { a, target } = ctx;
  const diff = a.integrated - target.lufs;
  const streaming = target.lufs <= -14;
  if (Math.abs(diff) <= T.loudnessWindow) ctx.ok('Loudness on target');
  else if (diff < 0) {
    ctx.add({
      id: 'master-quiet', severity: 'warning', area: 'Loudness', title: `Quieter than the ${target.name} target`,
      detail: `Integrated loudness is ${num(a.integrated)} LUFS, ${num(-diff)} LU under the ${num(target.lufs, 0)} LUFS target.${streaming ? ' Streaming services turn quiet songs up only partly (Spotify stops at the true-peak limit), so it may sound quieter than other tracks in a playlist.' : ''}`,
      steps: [
        `Adaptive Limiter on the Stereo Out: raise Gain by about ${num(-diff)} dB.`,
        "Play the whole song through the Loudness Meter plugin and fine-tune until Integrated reads within ±0.5 LU of the target.",
      ],
    });
  } else {
    ctx.add({
      id: 'master-loud', severity: streaming ? 'note' : 'warning', area: 'Loudness', title: `Louder than the ${target.name} target`,
      detail: `Integrated loudness is ${num(a.integrated)} LUFS, ${num(diff)} LU over the target. ${streaming ? `The platform will turn it down by about ${num(diff)} dB, so the extra limiting only costs punch.` : 'It may sound squashed next to other releases.'}`,
      steps: [`Lower Gain on the Adaptive Limiter by about ${num(diff)} dB, or pick a louder target if that's the sound you want.`],
    });
  }

  if (a.truePeakDb > target.truePeak + 0.1) {
    ctx.add({
      id: 'master-true-peak', severity: 'critical', area: 'True peak', title: 'True peak is over the ceiling',
      detail: `True peak reaches ${num(a.truePeakDb)} dBTP; the target ceiling is ${num(target.truePeak)} dBTP. Peaks between samples distort on playback and after MP3/AAC encoding.`,
      steps: [`Adaptive Limiter: set Out Ceiling to ${num(target.truePeak)} dB and turn on True Peak Detection.`, 'Make sure no plugin comes after the limiter on the Stereo Out.'],
    });
  } else ctx.ok('True peak');

  if (a.plr < T.masterCrushedPlr) {
    ctx.add({
      id: 'master-crushed', severity: 'warning', area: 'Dynamics', title: 'Heavily limited',
      detail: `Peak-to-loudness ratio is ${num(a.plr)} dB. Below about 8 dB, drums lose impact and the master can sound flat.`,
      steps: ['Lower Adaptive Limiter Gain by 2–3 dB and compare loudness-matched.', 'Let a glue compressor do 1–2 dB of the work before the limiter.'],
    });
  } else ctx.ok('Dynamics');
}

function loudnessRange(ctx) {
  const { a, settings } = ctx;
  if (a.loudnessRange < T.lraLow && a.duration > 30) {
    ctx.add({
      id: 'lra-low', severity: 'note', area: 'Dynamics', title: 'Very little loudness variation',
      detail: `Loudness range is ${num(a.loudnessRange)} LU. Verses and choruses sit at almost the same level, which can make a song feel static.`,
      steps: ['Automate verses down 1–2 dB against choruses, or ease off bus compression.'],
    });
  }
  if (a.loudnessRange > T.lraHigh && settings.genre !== 'acoustic') {
    ctx.add({
      id: 'lra-high', severity: 'note', area: 'Dynamics', title: 'Large loudness swings',
      detail: `Loudness range is ${num(a.loudnessRange)} LU. Quiet sections may get lost in cars and on earbuds.`,
      steps: ['Use volume automation to bring quiet sections up, then a gentle bus Compressor (Vintage VCA, 2:1, 30 ms attack, Auto release) for 1–2 dB of glue.'],
    });
  }
}

function stereo(ctx) {
  const { a, stage } = ctx;
  if (a.channelCount < 2) {
    return ctx.add({ id: 'mono-file', severity: 'note', area: 'Stereo', title: 'File is mono', detail: 'Stereo checks were skipped. Bounce as Interleaved stereo to check width and phase.', steps: [] });
  }
  if (a.correlation < T.corrCritical) {
    ctx.add({
      id: 'phase', severity: 'critical', area: 'Stereo', title: 'Left and right partly cancel each other',
      detail: `Correlation is ${signed(a.correlation, 2)}. In mono (phone speakers, club systems, Bluetooth speakers) parts of the mix will disappear.`,
      steps: [
        'Insert the Gain plugin on the Stereo Out and enable Mono. Solo tracks one at a time; the one that thins out or vanishes is out of phase.',
        'For sources recorded with two mics, use Phase Invert on one side in the Gain plugin, or nudge one region by a few samples.',
        'Reduce wide effects (Stereo Spread, chorus, very short delays) on that track.',
      ],
    });
  } else if (a.correlation < T.corrWide) {
    ctx.add({
      id: 'phase-wide', severity: 'warning', area: 'Stereo', title: 'Very wide; may collapse in mono',
      detail: `Correlation is ${signed(a.correlation, 2)}. Check the mix in mono.`,
      steps: ['Insert the Gain plugin on the Stereo Out, enable Mono and listen for elements that drop out.', 'Lower Stereo Spread or chorus amounts on pads and synths.'],
    });
  } else ctx.ok('Phase');

  if (a.lowCorrelation < T.lowCorr) {
    ctx.add({
      id: 'low-end-sides', severity: 'warning', area: 'Stereo · low end', title: "Low end isn't centered",
      detail: `Below 120 Hz the side signal is ${num(a.lowSideDb)} dB relative to the center. Off-center bass loses punch in mono and wastes headroom.`,
      steps: stage === 'mix'
        ? ['Pan kick, bass and 808 to center, and turn down any stereo width or unison spread on bass synth patches.', "On stereo bass tracks, insert Direction Mixer and set Spread to 0, or use the Gain plugin's Mono button."]
        : ['Channel EQ on the Stereo Out: set its Processing menu to Side, then enable Low Cut at 120 Hz, 24 dB/Oct. The low end becomes mono; the highs keep their width.'],
    });
  } else ctx.ok('Low end centered');

  if (a.widthDb < T.widthNarrow) {
    ctx.add({
      id: 'narrow', severity: 'note', area: 'Stereo', title: 'Mix is nearly mono',
      detail: `Side signal is ${num(a.widthDb)} dB under the center. A little width helps separation.`,
      steps: ['Pan doubled guitars and backing vocals left and right.', 'Add Stereo Spread or a short stereo reverb (ChromaVerb, Room) to pads and keys, not to kick or bass.'],
    });
  } else if (a.widthDb > T.widthWide) {
    ctx.add({
      id: 'wide', severity: 'warning', area: 'Stereo', title: 'Very wide stereo image',
      detail: `Side signal is only ${num(Math.abs(a.widthDb))} dB under the center. The middle (vocal, kick, snare) may feel weak.`,
      steps: ['Check stereo widener plugins and reduce their amount.', 'Make sure the lead vocal, kick, snare and bass are panned center.'],
    });
  } else ctx.ok('Stereo width');

  if (Math.abs(a.balanceDb) > T.balance) {
    const side = a.balanceDb > 0 ? 'left' : 'right';
    ctx.add({
      id: 'balance', severity: 'warning', area: 'Stereo', title: `Mix leans ${side}`,
      detail: `The ${side} channel is ${num(Math.abs(a.balanceDb))} dB louder overall.`,
      steps: ['Check that lead vocal, kick, snare and bass are panned center.', 'Balance hard-panned pairs (double-tracked guitars, overheads) so both sides peak at a similar level.'],
    });
  }
}

function dcOffset(ctx) {
  if (Math.abs(ctx.a.dcOffset) <= T.dcOffset) return;
  ctx.add({ id: 'dc-offset', severity: 'note', area: 'Level', title: 'DC offset', detail: 'The waveform is shifted off zero, which wastes headroom.', steps: ['Channel EQ Low Cut at 20 Hz on the Stereo Out, or on the track that causes it.'] });
}

function referenceComparison(ctx) {
  const { a, reference: r, stage } = ctx;
  if (!r) return;
  if (r.channelCount === 2 && a.channelCount === 2 && Math.abs(a.widthDb - r.widthDb) > 4) {
    const wider = a.widthDb > r.widthDb;
    ctx.add({
      id: 'ref-width', severity: 'note', area: 'Reference', title: `${wider ? 'Wider' : 'Narrower'} than your reference`,
      detail: `Side level is ${num(a.widthDb)} dB vs ${num(r.widthDb)} dB on the reference.`,
      steps: [wider ? 'Reduce stereo wideners, or bring center elements up.' : 'Pan supporting parts wider and add stereo ambience to pads and backing vocals.'],
    });
  }
  if (stage === 'master' && Math.abs(a.integrated - r.integrated) > 2) {
    ctx.add({
      id: 'ref-loudness', severity: 'note', area: 'Reference', title: `${a.integrated > r.integrated ? 'Louder' : 'Quieter'} than your reference`,
      detail: `${num(a.integrated)} LUFS vs ${num(r.integrated)} LUFS on the reference.`, steps: [],
    });
  }
}

const levels = (c) => (c.stage === 'mix' ? mixLevels(c) : masterLevels(c));

/** Rule order breaks ties within a severity: technical faults first, then tone, then context. */
export const RULES = Object.freeze([clipping, levels, stereo, dcOffset, tonalBalance, loudnessRange, referenceComparison]);

/* ---------- mastering chain ---------- */

function masteringChain(ctx) {
  const { a, stage, target, eqMoves } = ctx;
  const lowEndOffCenter = a.channelCount === 2 && a.lowCorrelation < T.lowCorr;
  const gain = target.lufs - a.integrated;
  const eqLines = [
    'Low Cut 20 Hz, 24 dB/Oct',
    ...(stage === 'master' ? eqMoves : eqMoves.map((m) => `${m} (only if the mix fixes don't cover it)`)),
    ...(lowEndOffCenter ? ['Second Channel EQ, Processing: Side, Low Cut 120 Hz'] : []),
    ...(eqMoves.length ? [] : ['No tonal moves needed']),
  ];
  const compressor = stage === 'master' && a.plr < T.skipGlueCompPlr
    ? [`Skip it: the master is already dense (PLR ${num(a.plr)} dB).`]
    : ['Circuit Type: Vintage VCA', 'Ratio 2:1, Attack 30 ms, Release Auto', `Lower Threshold for ${a.loudnessRange > 10 ? '2–3' : '1–2'} dB of gain reduction in the loudest section`, 'Auto Gain off; match the bypassed level with Make Up'];
  const limiterGain = stage === 'master'
    ? `Change Gain by ${signed(gain)} dB from its current setting`
    : gain > 0 ? `Gain: start at about +${num(gain)} dB` : 'Gain: 0 dB (already at or above target)';
  return [
    { plugin: 'Channel EQ', settings: eqLines },
    { plugin: 'Compressor', settings: compressor },
    { plugin: 'Adaptive Limiter', settings: [limiterGain, `Out Ceiling ${num(target.truePeak)} dB`, 'True Peak Detection on'] },
    { plugin: 'Loudness Meter', settings: [`Play the whole song; Integrated should read ${num(target.lufs, 0)} LUFS ±0.5`, 'Bounce and drop the master here to confirm true peak'] },
  ];
}

/**
 * @param {import('./analyze.js').Analysis} analysis
 * @param {{stage?: string, genre?: string, target?: string}} rawSettings
 * @param {{ reference?: import('./analyze.js').Analysis|null, file?: { lossy?: boolean } }} [options]
 */
export function evaluate(analysis, rawSettings, { reference = null, file = {} } = {}) {
  const settings = sanitizeSettings(rawSettings);
  const genre = GENRES[settings.genre];
  const target = TARGETS[settings.target];
  const tolerance = reference ? T.toleranceReference : T.toleranceGenre;
  const comparison = reference ? reference.bands : genre.curve;
  const findings = [];
  const ok = [];
  const ctx = {
    a: analysis, reference, settings, stage: settings.stage, genre, target, tolerance, file,
    deviations: bandDeviations(analysis.bands, comparison),
    basis: reference ? 'your reference' : `the ${genre.name} curve`,
    eqMoves: [],
    add: (f) => findings.push(f),
    ok: (label) => { if (!ok.includes(label)) ok.push(label); },
  };
  for (const rule of RULES) rule(ctx);
  findings.sort((x, y) => SEVERITY[x.severity].rank - SEVERITY[y.severity].rank);

  return {
    settings, genre, target, tolerance,
    stage: settings.stage,
    basis: ctx.basis,
    deviations: ctx.deviations,
    findings,
    ok,
    chain: masteringChain(ctx),
    assistant: `Quicker route: Logic's Mastering Assistant on the Stereo Out. Try Character ${genre.assistant}, set Loudness so the Integrated reading lands on ${num(target.lufs, 0)} LUFS, then bounce and check the result here.`,
  };
}

/** Meter status per tile: 'good' | 'warning' | 'critical' | ''. */
export function meterStates(a, ev) {
  const master = ev.stage === 'master';
  const stereoMissing = a.channelCount < 2;
  return {
    loudness: !master ? '' : Math.abs(a.integrated - ev.target.lufs) <= T.loudnessWindow ? 'good' : 'warning',
    truePeak: master
      ? a.truePeakDb > ev.target.truePeak + 0.1 || a.clippedRuns ? 'critical' : 'good'
      : a.clippedRuns ? 'critical' : a.truePeakDb > T.mixHeadroom ? 'warning' : 'good',
    plr: a.plr < (master ? T.masterCrushedPlr : T.mixLimitedPlr) ? 'warning' : 'good',
    range: a.loudnessRange < T.lraLow || a.loudnessRange > T.lraHigh ? 'warning' : 'good',
    correlation: stereoMissing ? '' : a.correlation < T.corrCritical ? 'critical' : a.correlation < T.corrWide || a.lowCorrelation < T.lowCorr ? 'warning' : 'good',
    width: stereoMissing ? '' : a.widthDb > T.widthWide ? 'warning' : 'good',
  };
}
