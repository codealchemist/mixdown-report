#!/usr/bin/env node
/**
 * Renders the link-preview image and app icons into src/ with headless Chrome (no dependencies).
 *
 *   npm run images                      writes src/og-image.png, apple-touch-icon.png, icon-192.png, icon-512.png
 *   CHROME=/path/to/chrome npm run images
 *
 * Re-run after changing the brand colours, the logo or the tagline below.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(fileURLToPath(new URL('../src/', import.meta.url)));
const BG = '#10161b';
const PANEL = '#172027';
const LINE = '#29353f';
const INK = '#e2e9ee';
const MUTED = '#93a3af';
const TEAL = '#4fbfc8';
const ORANGE = '#f0a35e';

const CHROME_PATHS = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

/** The four level bars from favicon.svg, drawn into a square of `size` with `inset` of padding on each side. */
function bars(size, inset) {
  const s = (size - 2 * inset) / 20; // favicon bars span x 5–24.5, y 4–27 of 32; normalised to a 20-unit box
  const bar = (x, y, h) => `<rect x="${inset + x * s}" y="${inset + y * s}" width="${3 * s}" height="${h * s}" rx="${s}" fill="${TEAL}"/>`;
  return [bar(0.25, 14, 6), bar(5.75, 9.5, 10.5), bar(11.25, 4.5, 15.5), bar(16.75, 2, 18)].join('');
}

const iconHtml = (size) => `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:${BG}}svg{display:block}</style>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${BG}"/>${bars(size, size * 0.22)}
</svg>`;

/** A stylised tonal-balance chart: the mix, the target curve and its tolerance band. */
function chart(w, h) {
  const target = [0.62, 0.5, 0.42, 0.4, 0.43, 0.5, 0.6, 0.72];
  const mix = [0.7, 0.42, 0.33, 0.38, 0.47, 0.49, 0.66, 0.8];
  const x = (i) => 30 + (i * (w - 60)) / (target.length - 1);
  const y = (v) => 20 + v * (h - 70);
  const path = (vals, dy = 0) => vals.map((v, i) => {
    if (!i) return `M${x(i)},${y(v) + dy}`;
    const cx = (x(i - 1) + x(i)) / 2;
    return `C${cx},${y(vals[i - 1]) + dy} ${cx},${y(v) + dy} ${x(i)},${y(v) + dy}`;
  }).join(' ');
  const grid = [0, 1, 2, 3, 4].map((i) => `<line x1="30" x2="${w - 30}" y1="${20 + (i * (h - 70)) / 4}" y2="${20 + (i * (h - 70)) / 4}" stroke="${LINE}" stroke-width="1"/>`).join('');
  const labels = ['SUB', 'BASS', 'LOW', 'MIDS', 'UPPER', 'PRES', 'AIR'];
  const devs = [2.4, -1.6, -0.8, 0.6, -0.4, 1.8, 0.9];
  const bw = (w - 60) / labels.length;
  const barsRow = labels.map((l, i) => {
    const d = devs[i];
    const tone = Math.abs(d) > 2 ? '#f07463' : Math.abs(d) > 1.2 ? '#e2a64b' : '#62c48d';
    return `<rect x="${30 + i * bw + 6}" y="${h - 34}" width="${bw - 12}" height="8" rx="2" fill="${tone}" opacity="0.9"/>
      <text x="${30 + i * bw + bw / 2}" y="${h - 8}" fill="${MUTED}" font-size="13" text-anchor="middle" font-family="Barlow Condensed, Arial Narrow, sans-serif" letter-spacing="1.5">${l}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    ${grid}
    <path d="${path(target)}" fill="none" stroke="${TEAL}" stroke-width="52" stroke-linecap="round" opacity="0.1"/>
    <path d="${path(target)}" fill="none" stroke="${MUTED}" stroke-width="2.5" stroke-dasharray="8 7"/>
    <path d="${path(mix.map((v, i) => (v + target[i]) / 2), 0)}" fill="none" stroke="${ORANGE}" stroke-width="2.5" stroke-dasharray="3 5"/>
    <path d="${path(mix)}" fill="none" stroke="${TEAL}" stroke-width="4" stroke-linecap="round"/>
    ${barsRow}
  </svg>`;
}

const ogHtml = () => `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=IBM+Plex+Sans:wght@400;500&family=JetBrains+Mono:wght@500&display=block">
<style>
  html,body{margin:0;width:1200px;height:630px;overflow:hidden;background:${BG};color:${INK}}
  body{font-family:"IBM Plex Sans",-apple-system,"Helvetica Neue",sans-serif;position:relative}
  .glow{position:absolute;inset:0;background:radial-gradient(900px 500px at 85% 20%, rgba(79,191,200,.16), transparent 60%),radial-gradient(700px 400px at 10% 110%, rgba(240,163,94,.10), transparent 60%)}
  .wrap{position:absolute;inset:0;padding:64px 72px;display:grid;grid-template-columns:1fr 470px;gap:48px;align-items:center}
  .brand{display:flex;align-items:center;gap:20px;margin-bottom:34px}
  h1{margin:0;font-family:"Barlow Condensed","Arial Narrow",sans-serif;font-weight:700;font-size:84px;line-height:.9;letter-spacing:.05em;text-transform:uppercase}
  p{margin:0;font-size:29px;line-height:1.38;color:${INK};max-width:560px}
  p b{color:${TEAL};font-weight:500}
  .tags{display:flex;gap:10px;flex-wrap:wrap;margin-top:34px}
  .tag{font-family:"Barlow Condensed","Arial Narrow",sans-serif;font-weight:600;font-size:20px;letter-spacing:.12em;text-transform:uppercase;padding:6px 14px;border-radius:999px;border:1.5px solid ${LINE};color:${MUTED}}
  .url{position:absolute;left:72px;bottom:50px;font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:22px;color:${TEAL}}
  .card{background:${PANEL};border:1.5px solid ${LINE};border-radius:18px;padding:22px 18px 14px}
  .card .k{font-family:"Barlow Condensed","Arial Narrow",sans-serif;font-weight:600;font-size:18px;letter-spacing:.14em;color:${MUTED};margin:0 0 8px 14px;text-transform:uppercase}
  .meters{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:${LINE};border:1.5px solid ${LINE};border-radius:14px;overflow:hidden;margin-top:16px}
  .m{background:${PANEL};padding:12px 16px;border-left:4px solid #62c48d}
  .m.w{border-left-color:#e2a64b}
  .m .v{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:26px;font-weight:500}
  .m .v small{font-size:14px;color:${MUTED};margin-left:4px}
  .m .l{font-family:"Barlow Condensed","Arial Narrow",sans-serif;font-size:14px;letter-spacing:.12em;color:${MUTED};text-transform:uppercase}
</style>
<div class="glow"></div>
<div class="wrap">
  <div>
    <div class="brand">
      <svg width="64" height="64" viewBox="0 0 64 64">${bars(64, 4)}</svg>
      <h1>Mixdown<br>Report</h1>
    </div>
    <p>Drop a bounce from <b>any DAW</b>. Get mix fixes, EQ presets, a master and <span style="white-space:nowrap">release-ready</span> FLAC &amp; MP3.</p>
    <div class="tags"><span class="tag">Loudness</span><span class="tag">Tonal balance</span><span class="tag">Stereo</span><span class="tag">Runs in your browser</span></div>
  </div>
  <div>
    <div class="card"><div class="k">Tonal balance</div>${chart(434, 250)}</div>
    <div class="meters">
      <div class="m"><div class="l">Loudness</div><div class="v">−14.0<small>LUFS</small></div></div>
      <div class="m"><div class="l">True peak</div><div class="v">−1.0<small>dBTP</small></div></div>
      <div class="m w"><div class="l">Range</div><div class="v">6.8<small>LU</small></div></div>
    </div>
  </div>
</div>
<div class="url">mixdownreport.netlify.app</div>`;

const chrome = CHROME_PATHS.find((p) => existsSync(p));
if (!chrome) {
  console.error('Chrome or Chromium not found. Set CHROME=/path/to/chrome and run again.');
  process.exit(1);
}

/**
 * Headless Chrome writes the screenshot but doesn't always exit afterwards, so wait for the file
 * to appear and stop changing, then end Chrome and its helper processes (its own process group).
 */
function screenshot(args, out, timeoutMs = 60_000) {
  rmSync(out, { force: true });
  const child = spawn(chrome, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const end = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ } };
  return new Promise((resolveShot, reject) => {
    const started = Date.now();
    let lastSize = -1;
    const poll = setInterval(() => {
      const size = existsSync(out) ? statSync(out).size : -1;
      if (size > 0 && size === lastSize) finish(null);
      else if (Date.now() - started > timeoutMs) finish(new Error(`Chrome didn't write ${out} within ${timeoutMs / 1000} s.\n${stderr}`));
      lastSize = size;
    }, 250);
    child.on('exit', (code) => { if (!existsSync(out)) finish(new Error(`Chrome exited (${code}) without writing ${out}.\n${stderr}`)); });
    function finish(error) {
      clearInterval(poll);
      end();
      if (error) reject(error); else resolveShot();
    }
  });
}

const tmp = mkdtempSync(join(tmpdir(), 'mixdown-images-'));
const jobs = [
  { file: 'og-image.png', width: 1200, height: 630, html: ogHtml() },
  { file: 'apple-touch-icon.png', width: 180, height: 180, html: iconHtml(180) },
  { file: 'icon-192.png', width: 192, height: 192, html: iconHtml(192) },
  { file: 'icon-512.png', width: 512, height: 512, html: iconHtml(512) },
];
try {
  for (const { file, width, height, html } of jobs) {
    const page = join(tmp, file.replace(/\.png$/, '.html'));
    writeFileSync(page, html);
    const out = join(OUT, file);
    await screenshot([
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${join(tmp, 'profile')}`, '--force-device-scale-factor=1',
      `--window-size=${width},${height}`, '--virtual-time-budget=5000', `--screenshot=${out}`, `file://${page}`,
    ], out);
    console.log(`wrote src/${file} (${width}×${height})`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
