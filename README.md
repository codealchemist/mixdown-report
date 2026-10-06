# Mixdown Report

A browser app that analyzes a mix or master bounced from Logic Pro and recommends fixes using Logic's built-in plugins.

Audio is analyzed entirely in the browser and never uploaded. The project has **no dependencies**: the app is plain JavaScript modules, the dev server uses Node's `http` module, and the tests use Node's built-in test runner.

## Quick start

Requires Node.js 18.17 or newer (only for the local server and tests; the app itself is static).

```bash
cd ~/dev/mixdown-report
npm start
```

Open http://localhost:8000 and press Ctrl+C in the terminal to stop the server. There is nothing to install: `npm install` isn't needed.

The app must be served over HTTP. Opening `src/index.html` directly from disk won't work, because browsers block ES modules and Web Workers on `file://` pages.

| Command | What it does |
| --- | --- |
| `npm start` | Serves `src/` at http://localhost:8000. Set `PORT=3000` for another port, or `HOST=0.0.0.0` to reach it from other devices on your network. |
| `npm test` | Runs the unit tests (DSP accuracy, rules, header parsing, report). |
| `npm run check` | Syntax-checks every file and confirms every relative import exists. |
| `npm run verify` | Runs `check`, then `test`. Use it before committing or deploying. |

## Deploying to the web

`src/` is the complete site: no build step. Upload that folder to any static host:

- **GitHub Pages:** push the repo, then in Settings > Pages publish from a GitHub Actions workflow that uploads `src/`, or copy `src/` into a `docs/` folder and publish from it.
- **Netlify:** drag the `src` folder onto https://app.netlify.com/drop, or set the publish directory to `src`.
- **Cloudflare Pages / Vercel:** no build command; output directory `src`.
- **Any web server:** serve `src/` with `.js` files as `text/javascript`.

The page sets a strict Content Security Policy in a `<meta>` tag. If your host lets you set headers, sending the same policy as a header (plus `frame-ancestors 'none'`) is stronger.

## What it measures

- **Loudness:** integrated loudness (ITU-R BS.1770-4 / EBU R128 gating), true peak with 4x oversampling, loudness range (EBU Tech 3342), peak-to-loudness ratio, short-term loudness over time.
- **Level problems:** flat-topped clipping and DC offset.
- **Tonal balance:** long-term third-octave spectrum and seven ranges (sub to air), compared with an approximate genre curve or a reference track you load. Curves are level-matched, so only the shape is compared.
- **Stereo:** correlation, low-end centering below about 120 Hz, side-vs-centre width, left/right balance.

From those it produces ranked fixes with step-by-step Logic Pro settings, a suggested Stereo Out mastering chain, and a plain-text report to copy.

## Project structure

```
src/                     the deployable site
  index.html             page shell, CSP
  styles.css             design tokens (light and dark) and layout
  main.js                entry point: app state, input wiring, rendering
  core/                  pure logic, no DOM or Web Audio (runs in browser, worker and Node)
    analyze.js           runs every measurement; defines the Analysis shape
    loudness.js          K-weighting, gating, short-term loudness, loudness range
    levels.js            peaks, true peak, clipping, DC, correlation, balance
    spectrum.js          third-octave mid/side spectrum and band levels
    fft.js               radix-2 FFT
    evaluate.js          rules that turn an Analysis into findings and a mastering chain
    advice.js            per-band Logic Pro advice text
    profiles.js          bands, genre curves, loudness targets, rule thresholds
    series.js            chart data preparation
    report.js            plain-text report
    sniff.js             WAV/AIFF header parsing (sample rate, bit depth)
    format.js            number formatting helpers
  audio/                 browser audio
    decode.js            decodes files at their own sample rate
    file-source.js       keeps picked files (with a handle where supported) so they can be reloaded
    analysis-client.js   runs analyses in Web Workers, one per slot, with cancellation
    demo.js              renders the example loop shown on first load
  workers/
    analyze.worker.js    worker wrapper around core/analyze.js
  ui/
    dom.js               small element builder (no innerHTML)
    view.js              renders meters, bands, findings and chain
    charts.js            canvas spectrum and loudness charts
    storage.js           remembers settings in localStorage
scripts/
  serve.js               zero-dependency static dev server
  check.js               syntax and import checker
test/                    node:test suites
```

### Design decisions

- **Pure core.** Everything in `src/core/` takes plain arrays and numbers and returns plain objects. It has no access to the DOM or Web Audio, so it can run in a Worker and be tested in Node with synthetic signals.
- **Analysis off the main thread.** Decoding needs Web Audio, which only exists on the main thread; the decoded samples are then transferred (not copied) to a Web Worker. Each slot (mix, reference) has its own worker, so both can run at once, and loading a new file cancels the previous job.
- **Rules as small functions.** `evaluate.js` runs a list of independent rules over a shared context. Each finding has a stable `id`, which the tests use. To add a check, write a rule and append it to `RULES`.
- **One source of truth for options.** Genres, targets and stages live in `profiles.js`; the dropdowns are generated from them, and saved settings are validated against them.
- **Safe rendering.** The UI builds elements with `textContent` and the DOM API instead of HTML strings, so file names can't inject markup and the page runs under a CSP with no inline scripts or styles.
- **Tunable thresholds.** Every number the rules compare against is in `THRESHOLDS` in `profiles.js`.

## Using it

1. Bounce from Logic Pro: File > Bounce > Project or Section (⌘B). Choose PCM, WAVE or AIFF, 24-bit, same sample rate as the project, Normalize off, Dithering none. For a mix headed to mastering, bypass anything on the Stereo Out.
2. Drop the bounce on **Your mix**.
3. Optionally drop a released song in the same style on **Reference track**. This is more reliable than the built-in genre curves.
4. Choose **Stage**, **Genre** and **Release on**.
5. Work through **What to fix**, then bounce again to the same file name in Logic.
6. Click **Reload mix** (or press **R**) to re-analyze. The meters show what changed since the last analysis, for example "+1.2 since last".

### How reloading works

Browsers normally give a page a one-time snapshot of a file. In Chrome and Edge the app instead keeps a file handle (File System Access API) when you click the drop zone or drag a file in, so **Reload mix** always reads the current bounce and can tell you when the file hasn't changed yet. In Safari and Firefox it reads the file again where the browser allows; if the browser refuses, the app asks you to choose the file again.

## Supported browsers and files

- Current Chrome, Edge, Safari and Firefox (module workers are required).
- WAV and AIFF are recommended (16-bit, 24-bit or 32-bit float). MP3, AAC/M4A and FLAC work where the browser can decode them. Lossy files usually lose content above 16 kHz, which the app flags instead of recommending EQ.
- Files up to 1 GB.

## Limits

- Genre curves are approximations of typical releases. Treat them as a starting point.
- Measurements show where a mix differs from a target; they don't judge taste. Listen before and after every change, matched in loudness.
- Loudness targets: Spotify/YouTube/Tidal −14 LUFS and −1 dBTP; Apple Music −16 LUFS and −1 dBTP; CD/download −9 LUFS and −0.3 dBTP; club −7 LUFS and −0.3 dBTP.
