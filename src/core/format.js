/** Number and text formatting shared by the UI and the plain-text report. */

export const MINUS = '−';

/** Formats a number with a typographic minus, or an en dash when not finite. */
export function num(x, digits = 1) {
  if (!Number.isFinite(x)) return '–';
  const s = Math.abs(x).toFixed(digits);
  return x < 0 && Number(s) !== 0 ? MINUS + s : s;
}

/** Like `num` but always shows the sign of non-zero values. */
export function signed(x, digits = 1) {
  if (!Number.isFinite(x)) return '–';
  const s = Math.abs(x).toFixed(digits);
  if (Number(s) === 0) return s;
  return (x > 0 ? '+' : MINUS) + s;
}

/** Half of a deviation, rounded to 0.5 dB and clamped to 0.5–3 dB: a gentle corrective EQ move. */
export function gentleMove(deviation) {
  return Math.max(0.5, Math.min(3, Math.round(Math.abs(deviation)) / 2));
}

/** Median of the finite values; 0 when there are none. */
export function median(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Seconds as m:ss. */
export function formatTime(seconds) {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Replaces typographic minus signs with ASCII hyphens for plain-text output. */
export function asciiMinus(text) {
  return text.replaceAll(MINUS, '-');
}

export const toDb = (linear) => 20 * Math.log10(linear || 1e-12);
export const powerToDb = (power) => 10 * Math.log10(power || 1e-30);
