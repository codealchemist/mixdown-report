/** Per-track Channel EQ suggestions: an instrument's starting point plus fixes for what the mix analysis found. */
import { BANDS } from '../profiles.js';
import { gentleMove, signed } from '../format.js';
import { buildEq } from './channel-eq.js';
import { INSTRUMENT_BY_ID } from './instruments.js';

const LOW_CUT_RAISE = 1.3; // non-bass parts raise their low cut by this factor when the mix has too much low end
const LOW_CUT_MAX = 300;
const MAX_TRACK_GAIN = 6; // dB per band: corrective, not creative
const OPPOSING_RATIO = 2; // an octave: a fix overrides an opposite starting-point move this close
const MAX_FIX = 2; // dB a single mix problem adds on one track; several tracks share the fix

/** How each mix problem is addressed on a contributing track. `amount` is a positive dB value. */
const FIX_MOVES = {
  'sub:high': (amount, inst) => (inst.lowEnd ? { type: 'lowShelf', freq: 45, gain: -amount } : 'raiseLowCut'),
  'sub:low': (amount, inst) => (inst.lowEnd ? { type: 'peak', freq: 50, gain: amount, q: 1.2 } : null),
  'low:high': (amount, inst) => (inst.lowEnd ? { type: 'peak', freq: 120, gain: -amount, q: 1 } : 'raiseLowCut'),
  'low:low': (amount, inst) => (inst.lowEnd ? { type: 'peak', freq: 90, gain: amount, q: 1 } : null),
  'lowmid:high': (amount) => ({ type: 'peak', freq: 300, gain: -amount, q: 1.2 }),
  'lowmid:low': (amount) => ({ type: 'peak', freq: 250, gain: amount, q: 1 }),
  'mid:high': (amount) => ({ type: 'peak', freq: 900, gain: -amount, q: 1.4 }),
  'mid:low': (amount) => ({ type: 'peak', freq: 1200, gain: amount, q: 1 }),
  'upmid:high': (amount) => ({ type: 'peak', freq: 3000, gain: -amount, q: 1.8 }),
  'upmid:low': (amount) => ({ type: 'peak', freq: 3000, gain: amount, q: 1.2 }),
  'pres:high': (amount) => ({ type: 'peak', freq: 6500, gain: -amount, q: 1.5 }),
  'pres:low': (amount) => ({ type: 'highShelf', freq: 5000, gain: amount, q: 0.71 }),
  'air:high': (amount) => ({ type: 'highShelf', freq: 10000, gain: -amount, q: 0.71 }),
  'air:low': (amount) => ({ type: 'highShelf', freq: 11000, gain: amount, q: 0.71 }),
};

/** Mix problems found by an evaluation, as `${bandId}:${'high'|'low'}` with their deviation. */
export function mixProblems(evaluation) {
  return BANDS.flatMap((band, i) => {
    const d = evaluation.deviations[i];
    if (Math.abs(d) <= evaluation.tolerance) return [];
    if (band.id === 'air' && d < 0 && evaluation.findings.some((f) => f.id === 'air-lossy')) return [];
    return [{ key: `${band.id}:${d > 0 ? 'high' : 'low'}`, band, deviation: d }];
  });
}

/**
 * @param {string} instrumentId
 * @param {ReturnType<typeof import('../evaluate.js').evaluate>|null} evaluation null for the starting point only
 */
export function suggestTrackEq(instrumentId, evaluation) {
  const inst = INSTRUMENT_BY_ID[instrumentId];
  if (!inst) throw new Error(`Unknown instrument: ${instrumentId}`);
  const moves = inst.base.map((m) => ({ ...m, origin: 'base' }));
  const notes = [];

  for (const problem of evaluation ? mixProblems(evaluation) : []) {
    if (!inst.fixes.includes(problem.key)) continue;
    const amount = Math.min(MAX_FIX, gentleMove(problem.deviation));
    const reason = `Mix ${problem.band.name.toLowerCase()} ${signed(problem.deviation)} dB vs ${evaluation.basis}`;
    const move = FIX_MOVES[problem.key](amount, inst);
    if (move === 'raiseLowCut') {
      const current = moves.find((m) => m.type === 'lowCut');
      if (current) moves.push({ ...current, freq: Math.min(LOW_CUT_MAX, Math.round(current.freq * LOW_CUT_RAISE)), reason, origin: 'mix' });
    } else if (move) {
      moves.push({ q: 0.71, ...move, reason, origin: 'mix' });
    }
    if (inst.notes?.[problem.key]) notes.push(inst.notes[problem.key]);
  }

  // A starting-point boost loses to a mix fix that cuts nearby (and the other way round):
  // if the mix already has too much there, the track shouldn't add more.
  const fixes = moves.filter((m) => m.origin === 'mix' && m.gain);
  const conflicts = (m) => m.origin === 'base' && m.gain
    && fixes.some((f) => Math.sign(f.gain) !== Math.sign(m.gain) && Math.max(f.freq, m.freq) / Math.min(f.freq, m.freq) <= OPPOSING_RATIO);
  const kept = moves.filter((m) => !conflicts(m));

  const { eq, dropped } = buildEq(kept, { maxGain: MAX_TRACK_GAIN });
  if (dropped.length) notes.push(`${dropped.length} smaller move${dropped.length > 1 ? 's were' : ' was'} left out because Channel EQ has four bell bands.`);
  return { instrument: inst, eq, moves: kept, notes };
}
