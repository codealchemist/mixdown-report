/** Plain-text report for notes, email or a collaborator. */
import { BANDS } from './profiles.js';
import { SEVERITY } from './evaluate.js';
import { asciiMinus, num, signed } from './format.js';

/**
 * @param {import('./analyze.js').Analysis} a
 * @param {ReturnType<typeof import('./evaluate.js').evaluate>} ev
 * @param {{ name: string, referenceName?: string }} labels
 */
export function reportText(a, ev, { name, referenceName } = { name: 'Untitled' }) {
  const lines = [];
  lines.push(`MIXDOWN REPORT: ${name}`);
  lines.push(`Stage: ${ev.stage === 'mix' ? 'mix before mastering' : 'finished master'} · Genre: ${ev.genre.name} · Target: ${ev.target.name} (${ev.target.lufs} LUFS, ${ev.target.truePeak} dBTP)`);
  if (referenceName) lines.push(`Reference: ${referenceName}`);
  lines.push('');
  lines.push(`Integrated ${num(a.integrated)} LUFS · True peak ${num(a.truePeakDb)} dBTP · PLR ${num(a.plr)} dB · LRA ${num(a.loudnessRange)} LU`);
  if (a.channelCount === 2) {
    lines.push(`Correlation ${signed(a.correlation, 2)} (below 120 Hz ${signed(a.lowCorrelation, 2)}) · Side vs center ${num(a.widthDb)} dB`);
  }
  lines.push(`Tonal balance vs ${ev.basis}: ${BANDS.map((b, i) => `${b.name} ${signed(ev.deviations[i])}`).join(', ')}`);
  lines.push('');
  if (!ev.findings.length) lines.push('No issues found.');
  for (const f of ev.findings) {
    lines.push(`[${SEVERITY[f.severity].label}] ${f.title}`);
    lines.push(`  ${f.detail}`);
    for (const s of f.steps) lines.push(`  - ${s}`);
  }
  lines.push('');
  lines.push(ev.stage === 'mix' ? 'MASTERING CHAIN (when you master)' : 'MASTERING CHAIN ADJUSTMENTS');
  ev.chain.forEach((step, i) => {
    lines.push(`${i + 1}. ${step.plugin}`);
    for (const s of step.settings) lines.push(`   - ${s}`);
  });
  lines.push('');
  lines.push(ev.assistant);
  return asciiMinus(lines.join('\n'));
}
