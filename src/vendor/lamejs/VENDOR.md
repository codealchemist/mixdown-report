# Vendored: LAME MP3 encoder (JavaScript port)

| | |
| --- | --- |
| Package | [`@breezystack/lamejs`](https://www.npmjs.com/package/@breezystack/lamejs) 1.2.7, a maintained fork of [zhuker/lamejs](https://github.com/zhuker/lamejs) |
| File | `dist/lamejs.js` (ES module build), unmodified |
| SHA-256 | `1c5f944911ccf2f6e29ab36c2e568363210ab16f50c0d76077060f40ecf91d28` |
| Licence | LGPL-3.0 (see `LICENSE`) |
| Upstream | LAME, https://lame.sourceforge.net |

Mixdown Report uses LAME to encode MP3 files. Under the LGPL it is kept as a separate, unmodified file and loaded only by the MP3 worker (`src/workers/mp3.worker.js`). Changes to LAME itself must be released under the LGPL.

To update: `npm pack @breezystack/lamejs@<version>`, copy `package/dist/lamejs.js` here, update the version and checksum above, and run `npm run verify`.
