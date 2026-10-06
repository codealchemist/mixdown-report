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
