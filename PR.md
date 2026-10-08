## Link previews, app icons and Netlify deploy

Makes shared links to https://mixdownreport.netlify.app look good, and adds a one-command production deploy.

**Changes**
- **Link previews:**
  - Open Graph and X/Twitter tags with a 1200×630 share image that ends with a "Try it free" button;
  - DAW-neutral title and description, sized for search results and phone previews;
  - a canonical URL and light/dark theme colours.
- **App icons:** an Apple touch icon and 192/512 px PNG icons, listed in a new web manifest so the app can be added to phone home screens and installed.
- **`npm run images`:** redraws the share image and icons with headless Chrome. It has no dependencies.
- **`npm run deploy`:** runs the checks and tests, then publishes `src/` to Netlify production.
- **Node 24:**
  - the `test` script now passes test files to `node --test`, as Node 22 and later require;
  - the dev server serves `.webmanifest` with the right content type, and a Netlify `_headers` file does the same in production.
- Version bumped to 1.1.1.

**Testing**
- `npm run verify` passes on Node 18 and 24: syntax check plus 115 tests.
- In the browser, the tags, manifest and images load with the right content types, with no Content Security Policy errors.
- Deployed to production with `npm run deploy`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
