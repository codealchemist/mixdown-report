/**
 * Judging EQs by their measured result:
 * - testEq: compares the mix with the mix rendered through a proposed EQ (both fully analyzed).
 * - checkPrediction: compares a new bounce from Logic with what the test predicted, to catch a
 *   preset that loaded differently, an EQ placed after the limiter, or Logic's filters behaving differently.
 */
import { BANDS } from '../profiles.js';
import { num, signed } from '../format.js';

const WORSE_MARGIN = 1; // dB further from the target before a band counts as worse
const rms = (values) => Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length);

/**
 * @param {{ analysis: object, evaluation: object }} before the mix
 * @param {{ analysis: object, evaluation: object }} after the mix rendered through the EQ
 */
export function testEq(before, after) {
  const tolerance = before.evaluation.tolerance;
  const bands = BANDS.map((b, i) => {
    const d0 = before.evaluation.deviations[i];
    const d1 = after.evaluation.deviations[i];
    const change = Math.abs(d1) - Math.abs(d0);
    const status = Math.abs(d1) <= tolerance ? (Math.abs(d0) <= tolerance ? 'ok' : 'fixed')
      : change <= -0.5 ? 'better'
        : change >= WORSE_MARGIN ? 'worse' : 'same';
    return { id: b.id, name: b.name, before: d0, after: d1, status };
  });
  const rmsBefore = rms(before.evaluation.deviations);
  const rmsAfter = rms(after.evaluation.deviations);
  const worse = bands.filter((b) => b.status === 'worse');
  const improved = bands.filter((b) => b.status === 'better' || b.status === 'fixed');
  const verdict = worse.length && rmsAfter >= rmsBefore - 0.2 ? 'worse'
    : worse.length ? 'mixed'
      : rmsAfter < rmsBefore - 0.3 ? 'better' : 'no-change';

  const loudnessChange = after.analysis.integrated - before.analysis.integrated;
  const truePeakChange = after.analysis.truePeakDb - before.analysis.truePeakDb;
  const messages = [];
  const say = (severity, text) => messages.push({ severity, text });
  if (verdict === 'better') say('good', `Closer to the target: ${improved.length} of ${BANDS.length} bands improve and none gets worse. Overall distance ${num(rmsBefore)} → ${num(rmsAfter)} dB.`);
  if (verdict === 'mixed') say('warning', `Mixed result: ${improved.map((b) => b.name).join(', ') || 'no band'} improve, but ${worse.map((b) => b.name).join(', ')} get${worse.length === 1 ? 's' : ''} worse.`);
  if (verdict === 'worse') say('critical', `Further from the target: ${worse.map((b) => b.name).join(', ')} get${worse.length === 1 ? 's' : ''} worse. Don't use this EQ as it is.`);
  if (verdict === 'no-change') say('note', 'The tone barely changes; this EQ is safe but does little.');
  if (Math.abs(loudnessChange) > 0.5) say('warning', `Loudness changes by ${signed(loudnessChange)} LU. Turn on "Keep loudness" so the preset's output gain cancels it.`);
  if (truePeakChange > 0.5) say('warning', `Peaks rise by ${num(truePeakChange)} dB, so the limiter after this EQ will work harder.`);
  if (after.analysis.truePeakDb > 0) say('critical', `Peaks reach ${signed(after.analysis.truePeakDb)} dBTP after the EQ. In Logic, keep a limiter after it on the Stereo Out.`);

  return { verdict, bands, rmsBefore, rmsAfter, loudnessChange, truePeakChange, truePeakAfter: after.analysis.truePeakDb, messages };
}

/** What to remember when a tested preset is exported, to check the next bounce against. */
export function makePrediction({ name, before, after, eq }) {
  const pick = ({ analysis, evaluation }) => ({ deviations: evaluation.deviations, integrated: analysis.integrated, truePeakDb: analysis.truePeakDb });
  return { name, createdAt: Date.now(), eq, tolerance: before.evaluation.tolerance, before: pick(before), after: pick(after) };
}

/**
 * Compares a new bounce with the prediction.
 * @param {ReturnType<typeof makePrediction>} prediction
 * @param {{ analysis: object, evaluation: object }} actual
 */
export function checkPrediction(prediction, actual) {
  const { before, after } = prediction;
  const measured = actual.evaluation.deviations;
  const bands = BANDS.map((b, i) => ({
    name: b.name,
    before: before.deviations[i],
    predicted: after.deviations[i],
    measured: measured[i],
    gap: measured[i] - after.deviations[i],
  }));
  // How much of the predicted tone change shows up in the bounce: 1 = all of it, 0 = none
  const predictedChange = bands.map((b) => b.predicted - b.before);
  const actualChange = bands.map((b) => b.measured - b.before);
  const norm = predictedChange.reduce((s, c) => s + c * c, 0);
  const applied = norm > 0.25 ? predictedChange.reduce((s, c, i) => s + c * actualChange[i], 0) / norm : null;
  const toneGap = rms(bands.map((b) => b.gap));
  const offBands = bands.filter((b) => Math.abs(b.gap) > 2);
  const peakGap = actual.analysis.truePeakDb - after.truePeakDb;
  const loudnessGap = actual.analysis.integrated - after.integrated;

  const diagnosis = [];
  const say = (severity, title, text, calibrate = false) => diagnosis.push({ severity, title, text, calibrate });
  if (toneGap <= 1) {
    say('good', 'Logic applied the EQ as predicted', `The tone of this bounce is within ${num(toneGap)} dB of the prediction on average.`);
  } else if (applied !== null && applied < 0) {
    say('critical', 'The tone moved the opposite way', 'If you loaded the preset into your own master EQ, its settings were replaced: restore them and use a separate "Mixdown correction" EQ. Otherwise the preset loaded differently than written; measure Logic\'s Channel EQ to find out which bands.', true);
  } else if (applied !== null && applied < 0.3) {
    say('critical', "The EQ doesn't seem to be in this bounce", 'Check that the "Mixdown correction" Channel EQ is on the Stereo Out with the preset loaded and not bypassed, and that you bounced after loading it.');
  } else if (applied !== null && applied > 1.5) {
    say('warning', 'The EQ acts much stronger than predicted', 'Another EQ may be adding to it (Mastering Assistant also shapes the tone), or Logic\'s filters are sharper than the app\'s model. Bypass other tone processing and compare again, or measure Logic\'s Channel EQ.', true);
  } else if (applied !== null && applied < 0.7) {
    say('warning', 'Only part of the EQ shows up', 'Other changes since the export (mix moves, plugins) may be pulling the tone back, or Logic\'s filters are gentler than the app\'s model. Measuring Logic\'s Channel EQ tells you which.', true);
  }
  const eqPresent = applied === null || applied >= 0.3; // otherwise the gaps are explained above
  if (toneGap > 1 && offBands.length && eqPresent) {
    say('warning', 'Some bands differ from the prediction', `${offBands.map((b) => `${b.name} ${signed(b.gap)} dB`).join(', ')}. If you didn't change the mix, Logic's filter shapes differ from the app's model in these ranges; measure Logic's Channel EQ to correct it. If you loaded the preset into your own master EQ instead of a separate one, your EQ's settings were replaced.`, true);
  }
  if (peakGap > 1 && actual.analysis.truePeakDb > -0.5) {
    say('critical', 'Peaks are much higher than predicted', 'The EQ may sit after the limiter. Put Channel EQ first on the Stereo Out, before any compressor, limiter or Mastering Assistant.');
  }
  if (toneGap <= 1.5 && Math.abs(loudnessGap) > 2) {
    say('warning', `${loudnessGap < 0 ? 'Quieter' : 'Louder'} than predicted by ${num(Math.abs(loudnessGap))} LU`, 'The tone matches, so check Channel EQ\'s output gain and the limiter\'s gain after it.');
  }
  return { bands, applied, toneGap, peakGap, loudnessGap, diagnosis };
}
