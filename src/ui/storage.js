/** Remembers the viewer's settings. Storage can be missing or blocked, so every access is guarded. */
import { DEFAULT_SETTINGS, sanitizeSettings } from '../core/profiles.js';

const KEY = 'mixdown-report:settings:v1';

export function loadSettings() {
  try {
    return sanitizeSettings(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private mode or storage disabled: settings just won't persist.
  }
}

const PREDICTIONS_KEY = 'mixdown-report:predictions:v1';
const MAX_PREDICTIONS = 10;
const nameKey = (name) => String(name).toLowerCase();

/** Remembers the prediction for an exported master EQ, by mix file name (most recent first). */
export function savePrediction(prediction) {
  try {
    const all = JSON.parse(localStorage.getItem(PREDICTIONS_KEY) ?? '[]').filter((p) => nameKey(p.name) !== nameKey(prediction.name));
    localStorage.setItem(PREDICTIONS_KEY, JSON.stringify([prediction, ...all].slice(0, MAX_PREDICTIONS)));
  } catch { /* storage unavailable */ }
}

/** The saved prediction for a mix file name, or the most recent one when `name` is omitted. */
export function loadPrediction(name) {
  try {
    const all = JSON.parse(localStorage.getItem(PREDICTIONS_KEY) ?? '[]');
    return (name === undefined ? all[0] : all.find((p) => nameKey(p.name) === nameKey(name))) ?? null;
  } catch {
    return null;
  }
}

const CALIBRATION_KEY = 'mixdown-report:logic-calibration:v1';

/** The measured Channel EQ correction in use, or null. */
export function loadCalibration() {
  try {
    const c = JSON.parse(localStorage.getItem(CALIBRATION_KEY) ?? 'null');
    return c && c.version === 1 ? c : null;
  } catch {
    return null;
  }
}

export function saveCalibration(calibration) {
  try {
    if (calibration) localStorage.setItem(CALIBRATION_KEY, JSON.stringify(calibration));
    else localStorage.removeItem(CALIBRATION_KEY);
  } catch { /* storage unavailable */ }
}

const CALIBRATION_RESULT_KEY = 'mixdown-report:logic-calibration-result:v1';
const CALIBRATION_PANEL_KEY = 'mixdown-report:calibration-panel:v1';

/** Whether the calibration panel was hidden: true, false, or null when the user never chose. */
export function loadCalibrationPanelHidden() {
  try {
    const v = localStorage.getItem(CALIBRATION_PANEL_KEY);
    return v === null ? null : v === 'hidden';
  } catch {
    return null;
  }
}

export function saveCalibrationPanelHidden(hidden) {
  try {
    localStorage.setItem(CALIBRATION_PANEL_KEY, hidden ? 'hidden' : 'shown');
  } catch { /* storage unavailable */ }
}

/** The last Channel EQ measurement (chart, table and verdict), so it can be shown again after a reload. */
export function loadCalibrationResult() {
  try {
    return JSON.parse(localStorage.getItem(CALIBRATION_RESULT_KEY) ?? 'null');
  } catch {
    return null;
  }
}

export function saveCalibrationResult(measurement) {
  try {
    localStorage.setItem(CALIBRATION_RESULT_KEY, JSON.stringify(measurement));
  } catch { /* storage unavailable or full */ }
}

const RELEASE_KEY = 'mixdown-report:release:v1';

/** The file types last ticked in Release files. */
export function loadReleaseSpecs() {
  try {
    const specs = JSON.parse(localStorage.getItem(RELEASE_KEY) ?? 'null')?.specs;
    return Array.isArray(specs) ? specs.filter((s) => typeof s === 'string') : null;
  } catch {
    return null;
  }
}

export function saveReleaseSpecs(specs) {
  try {
    localStorage.setItem(RELEASE_KEY, JSON.stringify({ specs }));
  } catch { /* storage unavailable or full */ }
}
