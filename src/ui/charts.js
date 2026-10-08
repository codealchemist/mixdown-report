/** Canvas charts. They take prepared series and only draw; colours come from CSS tokens. */
import { MINUS, formatTime, num } from '../core/format.js';
import { curveFrequencies, eqResponse } from '../core/eq/response.js';

const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function theme() {
  return {
    ink: token('--ink'),
    muted: token('--muted'),
    line: token('--line'),
    accent: token('--accent'),
    band: token('--accent-soft'),
    eq: token('--eq'),
    ref: token('--file-ref'),
    mono: `11px ${token('--f-mono') || 'monospace'}`,
  };
}

/** Sizes the canvas backing store to its CSS box at device pixel ratio. */
function prepare(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { c, width: rect.width, height: rect.height };
}

const tickLabel = (v) => (v > 0 ? '+' : v < 0 ? MINUS : '') + Math.abs(v);

function strokePath(c, pts, x, y) {
  c.beginPath();
  pts.forEach(([px, py], i) => (i ? c.lineTo(x(px), y(py)) : c.moveTo(x(px), y(py))));
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ fc: number, mix: number, comparison: number, withEq?: number }[]} series withEq: predicted mix after the master EQ
 * @param {number} tolerance dB
 * @param {{ reference?: boolean }} [options] reference: the comparison is a reference file, drawn in its colour
 */
export function drawSpectrum(canvas, series, tolerance, { reference = false } = {}) {
  const { c, width: W, height: H } = prepare(canvas);
  const t = theme();
  if (!series.length) return;
  const values = series.flatMap((p) => [p.mix, p.comparison, p.withEq]).filter(Number.isFinite);
  const yMax = Math.min(30, Math.ceil((Math.max(...values) + 3) / 6) * 6);
  const yMin = Math.max(-48, Math.floor((Math.min(...values) - 3) / 6) * 6);
  const pad = { l: 38, r: 10, t: 8, b: 24 };
  const x = (f) => pad.l + (Math.log(f / 20) / Math.log(1000)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + ((yMax - v) / (yMax - yMin)) * (H - pad.t - pad.b);

  c.font = t.mono;
  c.lineWidth = 1;
  c.strokeStyle = t.line;
  c.fillStyle = t.muted;
  c.textAlign = 'right';
  c.textBaseline = 'middle';
  for (let v = yMin; v <= yMax; v += 6) {
    c.beginPath(); c.moveTo(pad.l, y(v) + 0.5); c.lineTo(W - pad.r, y(v) + 0.5); c.stroke();
    c.fillText(tickLabel(v), pad.l - 6, y(v));
  }
  c.textAlign = 'center';
  c.textBaseline = 'top';
  for (const [f, label] of [[50, '50'], [100, '100'], [200, '200'], [500, '500'], [1000, '1k'], [2000, '2k'], [5000, '5k'], [10000, '10k']]) {
    c.beginPath(); c.moveTo(x(f) + 0.5, pad.t); c.lineTo(x(f) + 0.5, H - pad.b); c.stroke();
    c.fillText(label, x(f), H - pad.b + 6);
  }
  c.textAlign = 'left';
  c.fillText('dB', 4, pad.t);

  const cmp = series.filter((p) => Number.isFinite(p.comparison));
  if (cmp.length > 1) {
    c.beginPath();
    cmp.forEach((p, i) => (i ? c.lineTo(x(p.fc), y(p.comparison + tolerance)) : c.moveTo(x(p.fc), y(p.comparison + tolerance))));
    for (let i = cmp.length - 1; i >= 0; i--) c.lineTo(x(cmp[i].fc), y(cmp[i].comparison - tolerance));
    c.closePath();
    c.fillStyle = t.band;
    c.fill();
    strokePath(c, cmp.map((p) => [p.fc, p.comparison]), x, y);
    c.setLineDash([5, 4]);
    c.strokeStyle = reference ? t.ref : t.muted;
    c.lineWidth = 1.5;
    c.stroke();
    c.setLineDash([]);
  }

  if (series.some((p) => Number.isFinite(p.withEq))) {
    strokePath(c, series.map((p) => [p.fc, p.withEq]), x, y);
    c.strokeStyle = t.eq;
    c.lineWidth = 2;
    c.setLineDash([2, 3]);
    c.stroke();
    c.setLineDash([]);
  }

  strokePath(c, series.map((p) => [p.fc, p.mix]), x, y);
  c.strokeStyle = t.accent;
  c.lineWidth = 2.25;
  c.lineJoin = 'round';
  c.stroke();
  c.fillStyle = t.accent;
  for (const p of series) {
    c.beginPath();
    c.arc(x(p.fc), y(p.mix), 2.2, 0, Math.PI * 2);
    c.fill();
  }
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ t: number, v: number }[]} series short-term loudness
 * @param {{ duration: number, integrated: number, target?: number }} marks
 */
export function drawLoudness(canvas, series, { duration, integrated, target }) {
  const { c, width: W, height: H } = prepare(canvas);
  const t = theme();
  if (!series.length) {
    c.fillStyle = t.muted;
    c.font = t.mono;
    c.fillText('Track is shorter than 3 seconds.', 10, H / 2);
    return;
  }
  const floor = -60;
  const values = series.map((p) => (Number.isFinite(p.v) ? Math.max(p.v, floor) : floor));
  const marks = [integrated, ...(target != null ? [target] : [])].filter(Number.isFinite);
  const visible = values.concat(marks).filter((v) => v > Math.max(floor, integrated - 20));
  const yMax = Math.ceil((Math.max(...visible) + 2) / 3) * 3;
  const yMin = Math.max(floor, Math.floor((Math.min(...visible) - 3) / 3) * 3);
  const pad = { l: 38, r: 10, t: 8, b: 22 };
  const x = (s) => pad.l + (s / duration) * (W - pad.l - pad.r);
  const y = (v) => pad.t + ((yMax - Math.max(yMin, Math.min(yMax, v))) / (yMax - yMin)) * (H - pad.t - pad.b);

  c.font = t.mono;
  c.strokeStyle = t.line;
  c.fillStyle = t.muted;
  c.lineWidth = 1;
  c.textAlign = 'right';
  c.textBaseline = 'middle';
  const stepY = yMax - yMin > 18 ? 6 : 3;
  for (let v = yMax; v >= yMin; v -= stepY) {
    c.beginPath(); c.moveTo(pad.l, y(v) + 0.5); c.lineTo(W - pad.r, y(v) + 0.5); c.stroke();
    c.fillText(tickLabel(v), pad.l - 6, y(v));
  }
  const stepT = duration > 240 ? 60 : duration > 90 ? 30 : duration > 30 ? 10 : 5;
  c.textAlign = 'center';
  c.textBaseline = 'top';
  for (let s = 0; s <= duration; s += stepT) c.fillText(formatTime(s), x(s), H - pad.b + 6);

  strokePath(c, series.map((p, i) => [p.t, values[i]]), x, y);
  c.strokeStyle = t.accent;
  c.lineWidth = 1.75;
  c.lineJoin = 'round';
  c.stroke();

  const hline = (v, label, color) => {
    c.setLineDash([5, 4]);
    c.strokeStyle = color;
    c.lineWidth = 1.25;
    c.beginPath(); c.moveTo(pad.l, y(v)); c.lineTo(W - pad.r, y(v)); c.stroke();
    c.setLineDash([]);
    c.fillStyle = color;
    c.textAlign = 'right';
    c.textBaseline = 'bottom';
    c.fillText(label, W - pad.r - 2, y(v) - 3);
  };
  hline(integrated, `Integrated ${num(integrated)}`, t.muted);
  if (target != null && Math.abs(target - integrated) > 0.8) hline(target, `Target ${num(target, 0)}`, t.ink);
}

/**
 * Channel EQ response curve.
 * @param {HTMLCanvasElement} canvas
 * @param {object} eq Channel EQ model
 * @param {{ range?: number, compact?: boolean }} [options] range: ± dB shown; compact: no labels (track rows)
 */
export function drawEqCurve(canvas, eq, { range = 12, compact = false } = {}) {
  const { c, width: W, height: H } = prepare(canvas);
  const t = theme();
  const pad = compact ? { l: 2, r: 2, t: 2, b: 2 } : { l: 34, r: 10, t: 8, b: 22 };
  const freqs = curveFrequencies(compact ? 80 : 200);
  const gains = eqResponse(eq, freqs);
  const peak = Math.max(range, ...gains.map((g) => Math.min(24, Math.abs(g)) + 1));
  const x = (f) => pad.l + (Math.log(f / 20) / Math.log(1000)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + ((peak - Math.max(-peak, Math.min(peak, v))) / (2 * peak)) * (H - pad.t - pad.b);

  c.lineWidth = 1;
  c.strokeStyle = t.line;
  c.beginPath(); c.moveTo(pad.l, y(0) + 0.5); c.lineTo(W - pad.r, y(0) + 0.5); c.stroke();
  if (!compact) {
    c.font = t.mono;
    c.fillStyle = t.muted;
    c.textAlign = 'right';
    c.textBaseline = 'middle';
    const step = peak > 12 ? 6 : 3;
    for (let v = -Math.floor(peak / step) * step; v <= peak; v += step) {
      if (v) { c.beginPath(); c.moveTo(pad.l, y(v) + 0.5); c.lineTo(W - pad.r, y(v) + 0.5); c.stroke(); }
      c.fillText(tickLabel(v), pad.l - 6, y(v));
    }
    c.textAlign = 'center';
    c.textBaseline = 'top';
    for (const [f, label] of [[50, '50'], [100, '100'], [200, '200'], [500, '500'], [1000, '1k'], [2000, '2k'], [5000, '5k'], [10000, '10k']]) {
      c.beginPath(); c.moveTo(x(f) + 0.5, pad.t); c.lineTo(x(f) + 0.5, H - pad.b); c.stroke();
      c.fillText(label, x(f), H - pad.b + 6);
    }
  }
  c.beginPath();
  freqs.forEach((f, i) => (i ? c.lineTo(x(f), y(gains[i])) : c.moveTo(x(f), y(gains[i]))));
  c.lineTo(x(freqs.at(-1)), y(0));
  c.lineTo(x(freqs[0]), y(0));
  c.closePath();
  c.fillStyle = t.band;
  c.fill();
  c.beginPath();
  freqs.forEach((f, i) => (i ? c.lineTo(x(f), y(gains[i])) : c.moveTo(x(f), y(gains[i]))));
  c.strokeStyle = t.eq;
  c.lineWidth = compact ? 1.5 : 2;
  c.lineJoin = 'round';
  c.stroke();
}

/**
 * Calibration curves: Logic's measured response, the app's model before correction, and after.
 * @param {HTMLCanvasElement} canvas
 * @param {{ freqs: number[], measured: number[], modelBefore: number[], modelAfter: number[] }} curves
 */
export function drawCalibration(canvas, { freqs, measured, modelBefore, modelAfter }) {
  const { c, width: W, height: H } = prepare(canvas);
  const t = theme();
  const all = [...measured, ...modelBefore, ...modelAfter].filter(Number.isFinite);
  const top = Math.ceil((Math.max(...all) + 1) / 3) * 3;
  const bottom = Math.max(-30, Math.floor((Math.min(...all) - 1) / 3) * 3);
  const pad = { l: 34, r: 10, t: 8, b: 22 };
  const x = (f) => pad.l + (Math.log(f / 20) / Math.log(1000)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + ((top - Math.max(bottom, Math.min(top, v))) / (top - bottom)) * (H - pad.t - pad.b);
  c.font = t.mono;
  c.lineWidth = 1;
  c.strokeStyle = t.line;
  c.fillStyle = t.muted;
  c.textAlign = 'right';
  c.textBaseline = 'middle';
  const step = top - bottom > 18 ? 6 : 3;
  for (let v = bottom; v <= top; v += step) {
    c.beginPath(); c.moveTo(pad.l, y(v) + 0.5); c.lineTo(W - pad.r, y(v) + 0.5); c.stroke();
    c.fillText(tickLabel(v), pad.l - 6, y(v));
  }
  c.textAlign = 'center';
  c.textBaseline = 'top';
  for (const [f, label] of [[50, '50'], [100, '100'], [200, '200'], [500, '500'], [1000, '1k'], [2000, '2k'], [5000, '5k'], [10000, '10k']]) {
    c.beginPath(); c.moveTo(x(f) + 0.5, pad.t); c.lineTo(x(f) + 0.5, H - pad.b); c.stroke();
    c.fillText(label, x(f), H - pad.b + 6);
  }
  const line = (values, color, width, dash) => {
    c.beginPath();
    freqs.forEach((f, i) => (i ? c.lineTo(x(f), y(values[i])) : c.moveTo(x(f), y(values[i]))));
    c.strokeStyle = color;
    c.lineWidth = width;
    c.setLineDash(dash);
    c.stroke();
    c.setLineDash([]);
  };
  line(modelBefore, t.muted, 1.5, [5, 4]);
  line(measured, t.accent, 2.25, []);
  line(modelAfter, t.eq, 2, [2, 3]);
}
