#!/usr/bin/env node
/**
 * Zero-dependency static server for local use.
 * ES modules and workers don't load from file:// URLs, so the app needs to be served over HTTP.
 *
 *   npm start               serves src/ on http://localhost:8000
 *   PORT=3000 npm start     another port
 *   HOST=0.0.0.0 npm start  reachable from other devices on your network
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../src/', import.meta.url)));
const PORT = Number(process.env.PORT) || 8000;
const HOST = process.env.HOST || '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

/** Maps a URL path to a file inside ROOT, or null if it escapes it. */
function resolvePath(urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(urlPath, 'http://localhost').pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = resolve(ROOT, `.${pathname}`);
  return file === ROOT || file.startsWith(ROOT + sep) ? file : null;
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
  const file = resolvePath(req.url ?? '/');
  if (!file) return send(res, 400, 'Bad request');
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    send(res, 404, 'Not found');
  }
  console.log(`${res.statusCode} ${req.method} ${req.url}`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') console.error(`Port ${PORT} is in use. Try: PORT=${PORT + 1} npm start`);
  else console.error(error);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '127.0.0.1' || HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`Mixdown Report: http://${shown}:${PORT}  (Ctrl+C to stop)`);
});
