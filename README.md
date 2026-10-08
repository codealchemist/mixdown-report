# Mixdown Report

A browser app that analyzes a mix or master bounced from Logic Pro, recommends fixes using Logic's built-in plugins, exports Channel EQ presets (master and per track), masters a mix in the browser, and creates verified release files (FLAC or MP3 320) for distributors such as RouteNote.

Audio is processed entirely in the browser and never uploaded. There's nothing to install: the app is plain JavaScript modules, the dev server uses Node's `http` module, and the tests use Node's built-in test runner. The one third-party component is the LAME MP3 encoder, vendored as a single unmodified file (see [Credits and licences](#credits-and-licences)) and loaded only when you export an MP3.

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
| `npm test` | Runs the unit tests (DSP accuracy, codecs, mastering, rules, presets). If ffmpeg is installed, FLAC and MP3 output is also cross-checked with it. |
| `npm run check` | Syntax-checks every file and confirms every relative import exists. |
| `npm run verify` | Runs `check`, then `test`. Use it before committing or deploying. |
| `npm run pst -- file.pst [more.pst]` | Prints Channel EQ presets as bands and raw parameters side by side; marks parameters that differ. |
| `npm run calibration` | Writes the calibration preset into Logic's Channel EQ presets (`Mixdown Report` submenu) for checking the format. |

## Deploying to the web

`src/` is the complete site: no build step. Upload that folder to any static host:

- **GitHub Pages:** push the repo, then in Settings > Pages publish from a GitHub Actions workflow that uploads `src/`, or copy `src/` into a `docs/` folder and publish from it.
- **Netlify:** `npm run deploy` runs the checks and tests, then publishes `src/` to production with the [Netlify CLI](https://docs.netlify.com/cli/get-started/) (`npm install -g netlify-cli`). The first time, run `netlify login` and `netlify link` (or `netlify sites:create`) to choose the site. You can also drag the `src` folder onto https://app.netlify.com/drop.
- **Cloudflare Pages / Vercel:** no build command; output directory `src`.
- **Any web server:** serve `src/` with `.js` files as `text/javascript`.

Link previews (Slack, iMessage, WhatsApp, X, LinkedIn) use the Open Graph tags in `src/index.html` and `src/og-image.png` (1200×630). They point at https://mixdownreport.netlify.app, so update the `og:url`, `og:image`, `twitter:image` and canonical URLs if the site moves. `npm run images` redraws the share image and the app icons (`apple-touch-icon.png`, `icon-192.png`, `icon-512.png`) with headless Chrome; set `CHROME=/path/to/chrome` if it isn't found.

The page sets a strict Content Security Policy in a `<meta>` tag. If your host lets you set headers, sending the same policy as a header (plus `frame-ancestors 'none'`) is stronger.

## What it measures

- **Loudness:** integrated loudness (ITU-R BS.1770-4 / EBU R128 gating), true peak with 4x oversampling, loudness range (EBU Tech 3342), peak-to-loudness ratio, short-term loudness over time.
- **Level problems:** flat-topped clipping and DC offset.
- **Tonal balance:** long-term third-octave spectrum and seven ranges (sub to air), compared with an approximate genre curve or a reference track you load. Curves are level-matched, so only the shape is compared.
- **Stereo:** correlation, low-end centering below about 120 Hz, side-vs-centre width, left/right balance.

From those it produces ranked fixes with step-by-step Logic Pro settings, a suggested Stereo Out mastering chain, and a plain-text report to copy.

## EQ presets for Logic Pro

- **Correction EQ.** The Stereo Out suggestion is a *correction on top of your bounce*, not a whole master EQ. The app measures the bounce as it is, including any EQ already on your Stereo Out, so the correction goes into **one extra Channel EQ named "Mixdown correction"**, after your own master EQ and before any compressor, limiter or Mastering Assistant. Never load it into your own EQ: a preset replaces all of a plugin's settings. The correction is a 20 Hz rumble filter plus gentle moves (half the measured difference, fitted against the combined response so filters don't stack). **Keep loudness** sets its output gain so it doesn't change integrated loudness. Preview it with **Play from the loudest part** and **EQ on/off** (B); the tonal-balance chart shows the predicted result.
- **Updated, never stacked.** The app remembers the correction you exported for each song. When you bounce again with it in place, the app detects it and suggests the **updated whole correction**: load it into the same "Mixdown correction" EQ, replacing its settings. It shows what changed compared with the current correction, and the test, preview and loudness matching all compute "replace the old correction", not "add another".
- **Test before you download.** **Test on the mix** applies the EQ to the whole mix in the background and measures the result like a bounce: each range's distance to the target, loudness and true peak, with a verdict (closer to target, mixed, worse, little change). Downloading always uses a fresh test, and a "worse" result needs a second click.
- **Measure Logic's Channel EQ.** A one-time calibration: download a 30-second test noise and the calibration preset, play the noise through Channel EQ in Logic, bounce it and drop the bounce in. The app divides the bounce's spectrum by the noise's to get Channel EQ's exact response, checks every band loaded, and finds how Logic interprets Q, gain, cut slopes and cut resonance compared with the app's model. The result is **Ready to use**, **Partly usable** (bells and shelves are corrected but a cut slope is unclear; slopes are written as before) or **Can't be used**. Using it doesn't change how EQs are suggested or tested; each exported preset is converted so Logic plays exactly the curve tested here. Any later check that points to a filter mismatch offers this measurement.
- **Check what Logic did.** Downloading saves the test as a prediction for that mix file. Load the preset into the "Mixdown correction" EQ, bounce to the same file name and reload: the app compares the bounce with the prediction and says whether Logic applied the EQ as predicted, whether it seems missing or bypassed, whether it acted the opposite way or much stronger (preset or filter-shape mismatch), or whether peaks suggest it sits after the limiter.
- **Track EQs.** Add your tracks with the quick filter (type `dist`, `vox`, `808`, `oh`… and press Enter), or drop your `.logicx` project to suggest them. Each track gets an instrument's corrective starting point plus fixes for problems the mix analysis found that this instrument usually causes (for example a low-mid cut on guitars and pads when the mix is muddy). Open a track to see why each band is there, or edit it. Download one preset, or **Download all** as a .zip with a `Mixdown Report` folder and install notes.
- **Installing.** Copy the presets (or the `Mixdown Report` folder) into `~/Music/Audio Music Apps/Plug-In Settings/Channel EQ/`, then choose them from Channel EQ's Setting menu.

### The preset format

Apple doesn't document `.pst` files. The format was mapped from Logic's own factory and user presets, building on [Robert Heaton's reverse engineering](https://robertheaton.com/2017/07/17/reverse-engineering-logic-pro-synth-files/), and is described in [docs/pst-format.md](docs/pst-format.md). Presets are written from scratch, not copied from Apple's. The cut-slope encoding and how Logic's filters respond to Q and gain are measured by "Measure Logic's Channel EQ" in the app, which corrects exports if needed. The Mid/Side Processing setting isn't identified yet, so exports always use stereo processing.

## Mastering in the browser

**Master in the browser** turns an unmastered mix into a master:

1. **Tone:** broad EQ that moves the mix toward your genre curve or reference track, tilted by a character: **Balanced**, **Warm** (fuller lows, softer top), **Bright** (presence and air) or **Punchy** (tighter low mids, more attack). **Tone strength** sets how far to go; 0% only sets loudness.
2. **Glue compression:** stereo-linked RMS compressor whose threshold is set from the song, so the loudest passages get about 1.5–2 dB of reduction.
3. **True-peak limiter:** 4x-oversampled peak detection, 2 ms look-ahead and smooth release, driven until integrated loudness hits your **Release on** target (for example −14 LUFS) with peaks under the target ceiling (−1 dBTP).

The result shows loudness, true peak, dynamics and tone for mix and master side by side, warns when the limiter works hard or a tonal problem is too big to fix in mastering, and plays mix and master in sync with an instant A/B switch at matched loudness.

Start from an unlimited mix: mastering a file that's already limited limits it twice, and the app warns when it detects that. Logic's Mastering Assistant is a good comparison: bounce it, load it here, and compare both at matched loudness.

## Release files

**Release files** creates the file a distributor asks for, from the loaded file as is or from the master made here:

- **RouteNote FLAC** (recommended): 16-bit, 44.1 kHz, stereo, lossless. Stores make their streaming versions from an exact copy.
- **RouteNote MP3**: 320 kbps constant bitrate, 44.1 kHz, stereo, with an ID3 tag.
- **FLAC 24-bit** at the original sample rate, for archiving.

The pipeline converts to 44.1 kHz with a high-quality windowed-sinc resampler (passband flat to 20 kHz, aliasing below −90 dB), turns mono into stereo, optionally keeps the true peak at −1 dBTP (with extra headroom for MP3, since encoding raises peaks), and dithers to 16-bit (TPDF; skipped when the audio is already exactly 16-bit).

Then the finished file is checked the way a store would: the browser decodes it, a FLAC's decoded audio must match the file's own MD5 bit for bit, an MP3's frame headers must show 320 kbps constant bitrate, and the decoded audio is re-measured for loudness and true peak.

RouteNote's requirements: stereo FLAC or MP3 320 kbps, 16-bit, 44.1 kHz; WAV isn't accepted.

**Several files at once.** Tick any mix of audio (the loaded file, the master made here) and file types; the app makes every combination one after the other, for example the master as FLAC and as MP3 in one go. Each file shows up as soon as it's finished, with its checks (collapsed; click a file or "Show checks" to expand or collapse them) and its own **Download** button. **Stop** keeps the files already made. When there's more than one file:

- **Save all to a folder…** (Chrome and Edge) writes them straight into a folder you pick, asking before it replaces files with the same names.
- **Download all (.zip)** works in every browser.

The ticked file types are remembered for next time.

### Suggesting tracks from a Logic project

Logic's main project file is an undocumented binary format that doesn't store renamed track names as plain text, so it isn't read. Instead the app reads `Alternatives/000/MetaData.plist` (a standard binary plist) inside the `.logicx` package:

- Recordings are named after their track (`guitar-solo-L #39.wav`), which reveals audio tracks reliably.
- Sampler instruments (Drum Kit Designer, orchestral samples) reveal some software-instrument tracks.
- Recordings in the project folder but not on the timeline are offered unticked.
- Software-instrument tracks without samples (most synths) can't be detected; add them with the quick filter.

Drag the `.logicx` project onto the Track EQs box (Chrome, Edge, Safari, Firefox), or choose its `MetaData.plist` (right-click the project › Show Package Contents › Alternatives › 000).

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
    sniff.js             WAV/AIFF/FLAC header parsing (sample rate, bit depth)
    delivery.js          release file pipeline: stereo, resample, peak safety, dither, encode
    render-jobs.js       render jobs (deliver, master) shared by the worker and the fallback
    dsp/
      resample.js        Kaiser-windowed sinc resampler (exact polyphase for 48 → 44.1 kHz)
      dither.js          TPDF dither and integer conversion
      biquad.js          applies filter sections to whole buffers
    codecs/
      flac.js            FLAC encoder (fixed predictors, Rice coding, stereo decorrelation, CRCs, MD5)
      md5.js             MD5 for FLAC's audio checksum
      wav.js             PCM WAV writer (test noise)
      mp3.js             MP3 encoding through LAME, plus ID3v2.3 tags
      mp3-info.js        MP3 frame-header reader used to verify exports
    master/
      tone.js            tone EQ toward a target, characters
      compressor.js      glue compressor
      limiter.js         true-peak look-ahead limiter
      chain.js           tone → glue → limiter to a loudness target
    format.js            number formatting helpers
    plist.js             binary property list reader
    zip.js               ZIP writer (stored) with CRC-32
    logic-project.js     track suggestions from a project's MetaData.plist
    eq/
      channel-eq.js      Channel EQ model; places moves into Logic's eight band slots
      response.js        biquad design and frequency response (curves and preview share it)
      pst.js             .pst preset encoder/decoder and the calibration preset
      mastering.js       correction EQ suggestion (closed-loop, loudness-safe, updates an existing one)
      correction.js      the correction-EQ approach: combining rounds, testing a replacement
      fit.js             fits overlapping filters to the wanted change per band
      eq-test.js         judges a tested EQ and checks a later bounce against the prediction
      calibration.js     test noise, response measurement, fitting Logic's behaviour, export correction
      instruments.js     instrument library, quick filter and track-name matching
      track-eq.js        per-track EQ: starting point plus fixes for the mix
  audio/                 browser audio
    decode.js            decodes files at their own sample rate
    file-source.js       keeps picked files (with a handle where supported) so they can be reloaded
    file-memory.js       remembers the mix and reference between visits (IndexedDB)
    job-runner.js        runs jobs in module Web Workers, one per slot, with cancellation
    ab-player.js         synced mix/master playback with instant switching
    demo.js              renders the example loop shown on first load
    eq-preview.js        level-matched A/B playback through the master EQ
  workers/
    analyze.worker.js    worker wrapper around core/analyze.js
    render.worker.js     worker for mastering and release files
  ui/
    dom.js               small element builder (no innerHTML)
    view.js              renders meters, bands, findings and chain
    charts.js            canvas spectrum, loudness and EQ curves
    storage.js           remembers settings in localStorage
    eq-section.js        master EQ and track EQ panels, export, project import
    eq-editor.js         editable eight-band table
    instrument-picker.js quick-filter combobox and grouped instrument select
    project-file.js      finds MetaData.plist in a dropped .logicx folder
    download.js          file downloads
    master-section.js    mastering panel and A/B
    release-section.js   release files panel and file verification
    calibration-section.js  "Measure Logic's Channel EQ" panel
    tabs.js              tab bar: keyboard, #address, status badges
  vendor/lamejs/         LAME MP3 encoder (vendored, unmodified, LGPL) with provenance notes
scripts/
  serve.js               zero-dependency static dev server
  check.js               syntax and import checker
  pst.js                 inspect and compare .pst presets
  calibration.js         install the calibration preset
docs/
  pst-format.md          Channel EQ preset format and how to verify it
test/                    node:test suites (fixtures/ holds a synthetic MetaData.plist;
                         flac-decoder.js is a small decoder that proves FLAC output is lossless)
```

### Design decisions

- **Pure core.** Everything in `src/core/` takes plain arrays and numbers and returns plain objects. It has no access to the DOM or Web Audio, so it can run in a Worker and be tested in Node with synthetic signals.
- **Heavy work off the main thread.** Decoding needs Web Audio, which only exists on the main thread; the decoded samples are then transferred (not copied) to Web Workers for analysis, mastering and encoding. `JobRunner` gives each slot its own worker, so jobs run in parallel, and starting a new job in a slot cancels the old one.
- **Verify, don't assume.** Every exported file is decoded by the browser and re-checked before it's offered for download. The test suite proves the FLAC encoder lossless with its own decoder and, when available, ffmpeg.
- **Rules as small functions.** `evaluate.js` runs a list of independent rules over a shared context. Each finding has a stable `id`, which the tests use. To add a check, write a rule and append it to `RULES`.
- **One source of truth for options.** Genres, targets and stages live in `profiles.js`; the dropdowns are generated from them, and saved settings are validated against them.
- **Safe rendering.** The UI builds elements with `textContent` and the DOM API instead of HTML strings, so file names can't inject markup and the page runs under a CSP with no inline scripts or styles.
- **Tunable thresholds.** Every number the rules compare against is in `THRESHOLDS` in `profiles.js`.
- **What you see is what you hear.** The EQ curves, the predicted spectrum and the audio preview all use the same filter coefficients (`response.js`), so the preview matches the picture. Logic's own filters differ slightly in shape; the exported preset carries Logic's parameters, not these approximations.
- **Moves, then slots.** Suggestions are lists of moves with reasons. `buildEq` places them into Channel EQ's fixed bands, merging nearby bells and dropping the smallest when there are more than four, so every rule can stay simple.

## Using it

The app is split into tabs: Files, Analysis, What to fix, Correction EQ, Track EQs, Calibrate, Master, Release and Help. Each tab fits a laptop screen without scrolling; long lists (findings, the mastering chain) open one item at a time. The open tab is kept in the address (`#release`, `#eq`…), so reloading or bookmarking reopens it. Arrow keys, Home and End move between tabs. Badges show the number of fixes (red when something needs fixing first), how many track presets you have, "On" when a calibration is in use, and "Ready" once a master or release file exists.

Under the tab bar, coloured pills name the files the open tab works on: teal for your mix, violet for the reference track (also its line on the tonal balance chart), pink for the master made here. The label says the file's role in that tab (Source, Reference, Result), so Release shows every file ticked for export and Calibrate shows that it uses its own test noise. A dashed pill means there is no file, for example the genre curve standing in for a missing reference.


1. Bounce from Logic Pro: File > Bounce > Project or Section (⌘B). Choose PCM, WAVE or AIFF, 24-bit, same sample rate as the project, Normalize off, Dithering none. For a mix headed to mastering, bypass anything on the Stereo Out.
2. Drop the bounce on **Your mix**.
3. Optionally drop a released song in the same style on **Reference track**. This is more reliable than the built-in genre curves.
4. Choose **Stage**, **Genre** and **Release on**.
5. Work through **What to fix**, then bounce again to the same file name in Logic.
6. Click **Reload mix** (or press **R**) to re-analyze. The button sits at the right of the app header, so it works from any tab and keeps you where you are. The meters show what changed since the last analysis, for example "+1.2 since last".

### Remembering your files

The last mix and reference are remembered in this browser (IndexedDB) and reopened when you come back, so a page reload doesn't lose them. Nothing is uploaded.

- **Chrome and Edge:** only a link to the file is stored, not a copy, and reopening reads the current version on disk. After the browser restarts it may ask once: click **Restore file** in the bar under the file boxes.
- **Safari and Firefox:** these can't keep links to files, so a copy is stored. Very large files may not fit; the bar says so.
- **Forget files** clears what's stored and goes back to the example. **Remove reference** forgets the reference.

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

## Credits and licences

- MP3 files are encoded with [LAME](https://lame.sourceforge.net) through its JavaScript port [lamejs](https://github.com/zhuker/lamejs) (package `@breezystack/lamejs` 1.2.7), licensed under the LGPL. It's kept as a separate, unmodified file in `src/vendor/lamejs/`; see `VENDOR.md` there for the source and checksum.
- Everything else, including the FLAC encoder, resampler, limiter and analysis, is written for this project.
